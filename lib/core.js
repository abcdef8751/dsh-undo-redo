/**
 * dsh-undo-redo — undo/redo engine.
 *
 * Both faces drive this module: the Host commands `/undo` and `/redo` register
 * against it directly, and the Remote endpoints the browser calls delegate here
 * too. Keeping the engine in one place is what makes the header buttons and the
 * slash commands incapable of disagreeing.
 *
 * ## How an unsend works
 *
 * A session log is append-only, so nothing is ever destroyed. What `/undo`
 * changes is the *surface*: the ordered view over the log that produces the
 * model-visible message history. A `user/message` appended with
 * `surfaceOp: { op: 'replace', start, end }` shadows that range of surface
 * nodes, exactly as compaction shadows the history it replaces. The log keeps
 * every event, the human transcript keeps rendering it (the client builds that
 * from append-origin events), and the model stops seeing it.
 *
 * `/undo` therefore shadows the last prompt and everything the agent did after
 * it. `/redo` re-appends those messages as fresh surface nodes at the log tail,
 * which is the only direction the surface can move — there is no "unshadow"
 * operation, so restoring is a re-append, not a rollback.
 *
 * ## Why redo can be refused
 *
 * The redo frame records the exact surface node list from right after the
 * unsend. If the conversation has moved on since, that list no longer matches
 * and the frame is dropped: the undone messages were overwritten, and restoring
 * them under newer work would interleave two branches. That is the rule the
 * feature exists to honour, so refusal is a normal outcome, not an error.
 *
 * @module dsh-undo-redo/core
 */

/** Marker plugin name written into every notice this module appends. */
export const PLUGIN = 'dsh-undo';

/**
 * Per-session redo frames.
 *
 * Keyed by the session id *string*: a `SessionId` is a branded string
 * primitive, and a primitive cannot be used as a WeakMap key. Keying by the
 * string is also what makes `dispose(sessionId)` able to reclaim a frame when
 * the session goes away.
 */
const frames = new Map();

/** Find one logged event by its seq. */
function eventAt(session, seq) {
	for (const event of session.events) {
		if (event.seq === seq) return event;
	}
	return undefined;
}

/** Keep only the text blocks of a content array (tool calls and images cannot be restored faithfully). */
function textOf(blocks) {
	const kept = [];
	if (!Array.isArray(blocks)) return kept;
	for (const block of blocks) {
		if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
			kept.push({ type: 'text', text: block.text });
		}
	}
	return kept;
}

/** Collapse text blocks into one bounded preview line. */
function describe(blocks) {
	const parts = [];
	if (!Array.isArray(blocks)) return '';
	for (const block of blocks) {
		if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
		}
	}
	const joined = parts.join(' ').replace(/\s+/gu, ' ').trim();
	return joined.length > 120 ? `${joined.slice(0, 120)}…` : joined;
}

/**
 * Collect everything from the last real prompt to the end of the surface.
 *
 * Synthesized surface nodes are skipped as messages but still shadowed: the
 * undo notice this module appends is a `plugin`-sourced `user/message`, so a
 * second unsend must not treat it as the user's prompt.
 *
 * @param session - live session.
 * @param nodes - current surface node seqs.
 * @returns the cut index and the restorable entries in surface order.
 */
function collect(session, nodes) {
	let cut = 0;
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const event = eventAt(session, nodes[index]);
		if (event !== undefined && event.type === 'user/message' && event.data.source.kind === 'user') {
			cut = index;
			break;
		}
	}
	const entries = [];
	for (let index = cut; index < nodes.length; index += 1) {
		const seq = nodes[index];
		const event = eventAt(session, seq);
		if (event === undefined) continue;
		if (event.type === 'user/message') {
			const blocks = textOf(event.data.content);
			if (blocks.length === 0) continue;
			entries.push({ seq, kind: 'user', id: String(event.data.id), blocks });
		} else if (event.type === 'assistant/message') {
			const blocks = textOf(event.data.message.content);
			if (blocks.length === 0) continue;
			const source = event.data.message.source;
			entries.push({
				seq,
				kind: 'assistant',
				id: String(event.data.message.id),
				blocks,
				provider: typeof source.provider === 'string' ? source.provider : 'restored',
				model: typeof source.model === 'string' ? source.model : 'restored'
			});
		}
	}
	return { cut, entries };
}

/**
 * Build the zero-width node that stands in for a removed stretch.
 *
 * This is the whole trick behind "the context is completely discarded": an
 * `assistant/message` with EMPTY content is a legal surface node that projects
 * to `null` in `deriveEventMessage`, so it holds the replacement's place in the
 * surface — keeping the range addressable for the next undo and for the guard —
 * while contributing nothing to the model's context. Its `source` names this
 * plugin so the node identifies itself to a reader.
 *
 * A `user/message` cannot do this: the projection rule returns user content
 * verbatim, so an empty one would put an empty turn in front of the model.
 *
 * `turn`/`step` must match the bracket opened around this node. The token meter
 * pairs every `assistant/message` with the open `step/start` and throws on a
 * mismatch, so the payload and the bracket are written from one value here.
 *
 * @param count - how many items the node shadows, recorded in the model name.
 * @param turn - turn number of the enclosing bracket.
 * @param step - step number of the enclosing bracket.
 * @returns the replacement message payload.
 */
function shadow(count, turn, step) {
	const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	return {
		turn,
		step,
		message: {
			id: `${PLUGIN}:shadow:${stamp}`,
			role: 'assistant',
			content: [],
			source: { kind: 'model', provider: PLUGIN, model: `unsent-${String(count)}` }
		}
	};
}

/**
 * Open a step bracket in a turn of this plugin's own, before the replacement.
 *
 * A fresh turn keeps the bracket from colliding with any real step: the marker
 * is closed immediately, and the log already tolerates an unclosed turn (the
 * persistence layer closes a crash-orphaned turn on reload), so no `turn/end`
 * is appended — a stray one could confuse a live loop that is between turns.
 *
 * @param session - live session.
 * @returns the turn number the caller must use for the node and the close.
 */
function openBracket(session) {
	let turn = 0;
	for (const event of session.events) {
		if (event.type === 'turn/start' || event.type === 'turn/end') {
			if (typeof event.data.turn === 'number' && event.data.turn > turn) turn = event.data.turn;
		}
	}
	turn += 1;
	session.append('step/start', { turn, step: 1 });
	return turn;
}

/**
 * A short human-readable preview of a prompt, for the command result.
 * @param blocks - content blocks of the unsent prompt.
 * @returns one bounded line.
 */
function preview(blocks) {
	const line = describe(blocks);
	return line.length === 0 ? 'the last prompt' : `"${line}"`;
}

/** Compare two surface node lists by seq. */
function sameNodes(left, right) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/** Current undo/redo availability for one agent. */
export function stateOf(agent) {
	const session = agent.session;
	const frame = frames.get(String(session.id));
	const idle = agent.status === 'idle';
	return {
		sessionId: String(session.id),
		idle,
		canUndo: idle && session.surface.nodes.length > 0,
		canRedo: idle && frame !== undefined && sameNodes([...session.surface.nodes], frame.nodes),
		redoCount: frame === undefined ? 0 : frame.entries.length
	};
}

/**
 * Unsend the last prompt and everything after it.
 *
 * @param agent - live agent whose surface is rewritten.
 * @returns `{ outcome, message }`, where outcome is `'ok'` or `'error'`.
 */
export function undo(agent) {
	if (agent.status !== 'idle') {
		return { outcome: 'error', message: 'Cannot unsend while the agent is running. Stop it first.' };
	}
	const session = agent.session;
	const nodes = [...session.surface.nodes];
	if (nodes.length === 0) {
		return { outcome: 'ok', message: 'Nothing to unsend: the conversation is empty.' };
	}
	const collected = collect(session, nodes);
	if (collected.cut >= nodes.length) {
		return { outcome: 'ok', message: 'Nothing to unsend: no prompt is on the model-visible surface.' };
	}
	const shadowed = nodes.slice(collected.cut);
	let unsent = 'the last prompt';
	for (const entry of collected.entries) {
		if (entry.kind === 'user') {
			unsent = preview(entry.blocks);
			break;
		}
	}
	/*
	 * The unsend is one step-shaped bracket around one empty message.
	 *
	 * Why the bracket: an `assistant/message` is only legal at a position the
	 * token meter can pair with an open `step/start`. A bare node would be
	 * accepted by the session's own surface validator and then make the meter
	 * throw "assistant/message ... has no matching step/start event" — a failure
	 * that would surface far from here, on the next context measurement. So the
	 * placeholder carries the minimal well-formed step envelope.
	 *
	 * Why nothing else is appended: the tally the user reads rides the command
	 * result (the harness logs `command/done` itself), never a session event of
	 * this plugin's own invention — an unknown event type would make the log
	 * unreadable on reload, because the persistence read path refuses a type
	 * outside the known vocabulary unless it carries the envelope's `ignorable`
	 * marker.
	 */
	const bracket = openBracket(session);
	const event = session.append('assistant/message', shadow(collected.entries.length, bracket, 1), {
		surfaceOp: { op: 'replace', start: shadowed[0], end: shadowed.at(-1) },
		sourceEventSeqs: shadowed
	});
	session.append('step/end', { turn: bracket, step: 1 });
	frames.set(String(session.id), {
		entries: collected.entries,
		markerSeq: event.seq,
		nodes: [...session.surface.nodes]
	});
	const extra = collected.entries.length - 1;
	return {
		outcome: 'ok',
		message:
			`Unsent ${unsent} — removed from the model's context` +
			`${extra > 0 ? ` along with ${String(extra)} further context item(s)` : ''}. ` +
			'The transcript is unchanged; use /redo to restore them while nothing new has been sent.'
	};
}

/**
 * Restore the messages the last unsend removed.
 *
 * @param agent - live agent whose surface is rewritten.
 * @returns `{ outcome, message }`, where outcome is `'ok'` or `'error'`.
 */
export function redo(agent) {
	if (agent.status !== 'idle') {
		return { outcome: 'error', message: 'Cannot restore while the agent is running. Stop it first.' };
	}
	const session = agent.session;
	const key = String(session.id);
	const frame = frames.get(key);
	if (frame === undefined) {
		return { outcome: 'ok', message: 'Nothing to redo: nothing has been unsent in this session.' };
	}
	if (!sameNodes([...session.surface.nodes], frame.nodes)) {
		frames.delete(key);
		return {
			outcome: 'ok',
			message: 'Redo had no effect: the conversation continued past the unsend, so those messages are gone for good.'
		};
	}
	/*
	 * No notice node: restoring must add the messages and nothing else, or the
	 * "context is completely discarded" guarantee would be broken in reverse by
	 * a redo that pads the context with commentary.
	 *
	 * Each restored assistant message is re-bracketed in a fresh turn. Its own
	 * original turn cannot be reused: the step envelope that produced it may
	 * still be open in an outer frame of this restore, and the meter rejects a
	 * step/start that arrives before the previous one ended. Since the meter only
	 * checks the node's turn/step against the OPEN bracket, the restored message
	 * is written with the bracket's numbers rather than its historical ones.
	 */
	for (const entry of frame.entries) {
		if (entry.kind === 'user') {
			session.append(
				'user/message',
				{ id: entry.id, role: 'user', content: entry.blocks, source: { kind: 'user' } },
				{ surfaceOp: 'append' }
			);
			continue;
		}
		const bracket = openBracket(session);
		session.append(
			'assistant/message',
			{
				turn: bracket,
				step: 1,
				message: {
					id: entry.id,
					role: 'assistant',
					content: entry.blocks,
					source: { kind: 'model', provider: entry.provider, model: entry.model }
				}
			},
			{ surfaceOp: 'append' }
		);
		session.append('step/end', { turn: bracket, step: 1 });
	}
	/*
	 * The frame is consumed by the restore. Leaving it in place would report a
	 * redo as still available for a state that has already been restored, so the
	 * control would offer a no-op.
	 */
	frames.delete(key);
	const count = frame.entries.length;
	return {
		outcome: 'ok',
		message:
			`Restored ${String(count)} message(s). ` +
			'They are back on the model-visible surface; /undo can unsend them again.'
	};
}

/** Run one named action against an agent. */
export function run(agent, action) {
	return action === 'redo' ? redo(agent) : undo(agent);
}

/** Forget the redo frame of one session (called when its session is disposed). */
export function forget(sessionId) {
	frames.delete(String(sessionId));
}
