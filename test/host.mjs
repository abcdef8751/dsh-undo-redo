/**
 * Offline test for the host half. Run with: node test/host.mjs
 *
 * Drives the real gateway, the real registry, and a real `Session`, and asserts
 * on the three things that can silently break:
 *
 * 1. SRC discovery — no generated descriptor exists for these endpoints, so the
 *    `@Remote` marker is what routes the browser's call here at all.
 * 2. The surface rewrite — undo must remove the model's context while leaving
 *    the log and the human transcript intact.
 * 3. The overwrite rule — redo refuses once the conversation moves on.
 */

import assert from 'node:assert/strict';
import { bootHost, exchange, surfaceText, transcriptText } from './fixture.mjs';

const { ctx, session, agent, status } = await bootHost();
const gateway = ctx.get('typertGateway');
assert.ok(gateway, 'the gateway must mount');
const service = ctx.get('undoRedo');
assert.ok(service, 'the undo/redo service must mount');

// ── SRC discovery ──────────────────────────────────────────────────────────

assert.equal(gateway.claimsEndpoint('undoRedo/execute'), true, 'execute must be claimed');
assert.equal(gateway.claimsEndpoint('undoRedo/state'), true, 'state must be claimed');

const executeDescriptor = gateway.resolveDescriptor('undoRedo', 'execute', 'undoRedo/execute');
assert.deepEqual(
	executeDescriptor.parameters.map((parameter) => [parameter.name, parameter.wire, parameter.source]),
	[
		['agent', 'agentId', 'lookup'],
		['line', 'line', 'json'],
		['images', 'images', 'json'],
		['action', 'action', 'json']
	],
	'the agent lookup plus three JSON fields are derived from the method source'
);
const stateDescriptor = gateway.resolveDescriptor('undoRedo', 'state', 'undoRedo/state');
assert.deepEqual(
	stateDescriptor.parameters.map((parameter) => parameter.name),
	['agent'],
	'state takes only the resolved agent'
);

/** Call an endpoint the way the browser's wire does. */
const wire = (endpoint, args) =>
	gateway.invoke({
		namespace: endpoint.split('/')[0],
		method: endpoint.split('/')[1],
		args,
		signal: undefined
	});

// ── Undo ───────────────────────────────────────────────────────────────────

exchange(session, 1, 'first question', 'first answer');
exchange(session, 2, 'second question', 'second answer');

assert.deepEqual(
	surfaceText(session),
	['first question', 'first answer', 'second question', 'second answer']
);

const before = session.events.length;
const undone = await wire('undoRedo/execute', {
	agentId: 'session-1',
	line: '/undo',
	images: [],
	action: 'undo'
});

assert.equal(undone.outcome, 'ok', 'undo settles ok');
assert.match(undone.message, /Unsent "second question"/);
const afterUndo = surfaceText(session);
assert.equal(afterUndo.length, 3, 'the model surface shrinks to the first exchange plus one placeholder');
assert.deepEqual(afterUndo.slice(0, 2), ['first question', 'first answer'], 'the first exchange survives');
assert.equal(afterUndo[2], '', 'the placeholder carries NO text at all');

/*
 * The load-bearing guarantee: the unsent stretch leaves nothing behind in the
 * model's context. Not a notice, not an empty turn — nothing.
 */
const ctxAfterUndo = session.deriveMessages().map((m) => `${m.role}:${m.content.map((b) => b.text ?? '').join('')}`);
assert.deepEqual(ctxAfterUndo, ['user:first question', 'assistant:first answer'], 'the model sees only the surviving exchange');
for (const trace of ['second question', 'second answer', 'UNSENT', 'Discarded']) {
	assert.equal(
		JSON.stringify(ctxAfterUndo).includes(trace),
		false,
		`the context must hold no trace of "${trace}"`
	);
}
/* The placeholder is a legal surface node that projects to nothing. */
const tails = session.surface.nodes;
const placeholder = session.events.find((event) => event.seq === tails[tails.length - 1]);
assert.equal(placeholder.type, 'assistant/message', 'the placeholder is an assistant message');
assert.equal(session.deriveEventMessage(placeholder), null, 'and it projects to null for the model');
assert.equal(placeholder.data.message.content.length, 0, 'its content is empty, never a notice');
/* It carries a well-formed step bracket so the token meter can pair it. */
const placeholderIndex = session.events.indexOf(placeholder);
assert.equal(session.events[placeholderIndex - 1].type, 'step/start', 'a step opens before it');
assert.equal(session.events[placeholderIndex + 1].type, 'step/end', 'and closes after it');
assert.equal(undone.state.canUndo, true, 'a further unsend is still possible');
assert.equal(undone.state.canRedo, true, 'the just-removed messages are restorable');
assert.equal(undone.state.redoCount, 2, 'the redo frame holds the prompt and the reply');

assert.ok(session.events.length > before, 'the log only ever grows');
assert.deepEqual(
	transcriptText(session),
	['first question', 'first answer', 'second question', 'second answer'],
	'the human transcript still shows everything that was sent'
);

// A rewritten surface must not break reconstruction from the log.
const { foldSurface } = await import('@deepseek-ai/dsh-session');
const folded = foldSurface(session.events);
assert.deepEqual(folded.nodes, [...session.surface.nodes], 'the fold reproduces the live surface');
assert.equal(folded.replacements.length, 1, 'one replace landed');
assert.equal(folded.replacements[0].shadowedSeqs.length, 2, 'it shadowed exactly two surface nodes');
const shadowedIds = folded.replacements[0].shadowedSeqs.map((seq) => {
	const event = session.events.find((candidate) => candidate.seq === seq);
	return event.type === 'user/message' ? event.data.id : event.data.message.id;
});
assert.deepEqual(shadowedIds, ['u2', 'a2'], 'and they are the second prompt and its reply');

// ── Redo ───────────────────────────────────────────────────────────────────

const redone = await wire('undoRedo/execute', { agentId: 'session-1', line: '/redo', images: [], action: 'redo' });
assert.equal(redone.outcome, 'ok');
assert.match(redone.message, /Restored 2 message\(s\)/);
const afterRedo = surfaceText(session);
assert.equal(afterRedo.length, 5, 'restoring re-appends both messages after the placeholder');
assert.deepEqual(afterRedo.slice(-2), ['second question', 'second answer'], 'the restored messages land at the tail');
assert.equal(afterRedo[2], '', 'the placeholder stays in place and stays empty');
const ctxAfterRedo = session.deriveMessages().map((m) => `${m.role}:${m.content.map((b) => b.text ?? '').join('')}`);
assert.deepEqual(
	ctxAfterRedo,
	['user:first question', 'assistant:first answer', 'user:second question', 'assistant:second answer'],
	'restoring puts back exactly the messages, and nothing else'
);
assert.equal(redone.state.canRedo, false, 'a restore is not immediately redoable');

// ── The overwrite rule ─────────────────────────────────────────────────────

const undoneAgain = await wire('undoRedo/execute', {
	agentId: 'session-1',
	line: '/undo',
	images: [],
	action: 'undo'
});
assert.equal(undoneAgain.state.canRedo, true, 'the fresh unsend is restorable');

/* The user continues instead of restoring: a new exchange lands after the unsend. */
exchange(session, 3, 'third question', 'third answer');
const afterOverwrite = await wire('undoRedo/state', { agentId: 'session-1' });
assert.equal(afterOverwrite.canRedo, false, 'newer conversation invalidates the redo');

const refused = await wire('undoRedo/execute', { agentId: 'session-1', line: '/redo', images: [], action: 'redo' });
assert.equal(refused.outcome, 'ok', 'a refused redo is a normal outcome, not a failure');
assert.match(refused.message, /Redo had no effect/);
assert.equal(refused.state.canRedo, false, 'the dead frame is dropped rather than retried');

// ── Guards ─────────────────────────────────────────────────────────────────

status.current = 'running';
const whileRunning = await wire('undoRedo/execute', { agentId: 'session-1', line: '/undo', images: [], action: 'undo' });
assert.equal(whileRunning.outcome, 'error', 'undoing mid-turn is refused');
assert.match(whileRunning.message, /running/);
const stateWhileRunning = await wire('undoRedo/state', { agentId: 'session-1' });
assert.equal(stateWhileRunning.canUndo, false, 'the control disables while the agent runs');
status.current = 'idle';

const early = await wire('undoRedo/execute', { agentId: 'session-1', line: '/redo', images: [], action: 'redo' });
assert.match(early.message, /Nothing to redo/, 'an empty stack reports cleanly');

/* An unresolvable session id is refused by the gateway's lookup, not by the service. */
await assert.rejects(
	() => wire('undoRedo/execute', { agentId: 'no-such-session', line: '/undo', images: [], action: 'undo' }),
	/lookup provider "agent" did not resolve/,
	'an unknown session never reaches the service'
);

// ── Command registration ───────────────────────────────────────────────────

const registry = ctx.get('commands');
assert.ok(registry, 'the commands service must be present for apply to have run');
const names = registry.list(agent).map((descriptor) => descriptor.name);
assert.ok(names.includes('undo'), '/undo must be registered');
assert.ok(names.includes('redo'), '/redo must be registered');

/* The slash commands drive the same engine as the Remote endpoints. */
exchange(session, 4, 'fourth question', 'fourth answer');
const viaCommand = await registry.execute(agent, '/undo', [], new AbortController().signal);
assert.equal(viaCommand.result.kind, 'success', '/undo settles as a success');
assert.match(viaCommand.result.text, /Unsent "fourth question"/);
assert.equal(surfaceText(session).at(-1), '', 'the slash command rewrote the same surface, leaving no text');

const redoViaCommand = await registry.execute(agent, '/redo', [], new AbortController().signal);
assert.equal(redoViaCommand.result.kind, 'success', '/redo settles as a success');
assert.match(redoViaCommand.result.text, /Restored 2 message\(s\)/, 'the handler restored the exchange');

// ── The token meter must survive a claimless replace ───────────────────────
/*
 * This plugin has no shadow-price event of its own, so its replace takes the
 * meter's documented zero-delta branch. What must NOT happen is the loud
 * failure reserved for an armed claim over a different range, so the real meter
 * is driven over the rewritten log.
 */
const { Context } = await import('@deepseek-ai/cordis');
const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default;
const meterCtx = new Context();
await meterCtx.plugin(TokenMeter);
const meter = meterCtx.get('tokenMeter');
assert.ok(meter, 'the real token meter must mount');
let measured;
assert.doesNotThrow(() => {
	measured = meter.measure(session);
}, 'a claimless replace must not break the meter');
assert.equal(typeof measured, 'object', 'the meter still reports a measurement');

console.log('host OK — undo, redo, overwrite refusal, guards, SRC discovery, and the slash commands all behave');
