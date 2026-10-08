/**
 * dsh-undo-redo — Host half.
 *
 * Two things live here: the `/undo` and `/redo` human commands, and the Remote
 * service the browser header control calls. Both drive `./core.js`, so the
 * buttons and the slash commands can never disagree about what the undo stack
 * holds.
 *
 * ## The Remote seam, and why it looks like this
 *
 * A browser half may only reach the host through mounted Typert contributions.
 * Strict mode reads build-time generated descriptors and an out-of-tree package
 * has none, so this service is reached through the gateway's documented SRC
 * fallback: it reflects the method's own parameter names and requires the
 * `@Remote` prototype marker to consider the endpoint at all.
 *
 * `Remote()` is a standard method decorator — TypeScript syntax this
 * plain-JavaScript file cannot spell — so the decorator is invoked by hand
 * against a synthetic decorator context and the initializer it registers is run
 * in the constructor, which is exactly where the compiler would have run it.
 *
 * Parameter names are therefore load-bearing. `agent` is a Typert lookup
 * parameter in SRC mode, so the gateway resolves the browser's session id to the
 * live Agent and the method receives the object. Renaming it, or adding
 * destructuring or a default, breaks the derived signature.
 *
 * Because the shipped `commands` service already exports `commands/execute`,
 * this service deliberately publishes only its own `undoRedo` namespace: a
 * plugin never shadows a core endpoint that already answers.
 *
 * @module dsh-undo-redo
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { forget, redo, run, stateOf, undo } from './core.js';

/** Cordis service key, and therefore the wire namespace: `undoRedo/*`. */
const SERVICE_KEY = 'undoRedo';

/** Collected by the synthetic decorator contexts, replayed against each instance. */
const remoteInitializers = [];

/**
 * Mark one method as Remote at class-definition time.
 *
 * `Remote(name)` in its string form returns the decorator itself. Handing it a
 * context carrying the three fields `addMarkerInitializer` inspects (`name`,
 * `private`, `static`) plus an `addInitializer` sink produces the same private
 * prototype marker a real decorator would install.
 *
 * @param {string} exportName - wire name of the endpoint.
 */
function markRemote(exportName) {
	const decorator = Remote(exportName);
	decorator(undefined, {
		name: exportName,
		private: false,
		static: false,
		addInitializer(initializer) {
			remoteInitializers.push(initializer);
		}
	});
}

markRemote('execute');
markRemote('state');

/**
 * Host capability behind `/undo`, `/redo`, and the session-header control.
 */
export class UndoRedoService extends TypertRemoteService {
	/**
	 * @param ctx - owning Cordis context.
	 */
	constructor(ctx) {
		super(ctx, SERVICE_KEY);
		for (const initializer of remoteInitializers) initializer.call(this);
	}

	/**
	 * Unsend, or restore, for one session.
	 *
	 * `line` is accepted for signature parity with `commands/execute`; this
	 * service ignores it and acts on `action`, so an unknown line is refused
	 * rather than silently treated as an unsend.
	 *
	 * @param agent - Agent resolved from the browser's session id by the gateway.
	 * @param line - slash line the caller meant to run, for diagnostics.
	 * @param images - admitted composer images; always empty for this endpoint.
	 * @param action - `'undo'` or `'redo'`.
	 * @returns `{ outcome, message, state }`.
	 */
	execute(agent, line, images, action) {
		void line;
		void images;
		const result = run(agent, action === 'redo' ? 'redo' : 'undo');
		return { ...result, state: stateOf(agent) };
	}

	/**
	 * Current undo/redo availability.
	 * @param agent - Agent resolved from the browser's session id by the gateway.
	 * @returns the state snapshot.
	 */
	state(agent) {
		return stateOf(agent);
	}
}

/** Client services this plugin needs before it can register anything. */
export const inject = ['commands'];

/**
 * Register the Remote service and the two human commands.
 *
 * The service is mounted as a child of this plugin rather than exported as the
 * package default: a class default export makes Cordis treat the class itself
 * as the whole plugin and never call `apply`, which silently leaves the commands
 * unregistered. One entry point that mounts both is the shape that cannot drift.
 *
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx) {
	ctx.plugin(UndoRedoService);

	const settle = async (invocation, action) => {
		let result;
		try {
			result = action === 'redo' ? redo(invocation.agent) : undo(invocation.agent);
		} catch (error) {
			ctx.logger?.error?.(error);
			result = {
				outcome: 'error',
				message: `undo/redo failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
		try {
			await ctx.get('sessions')?.flush(invocation.agent.session);
		} catch (error) {
			ctx.logger?.error?.(error);
		}
		return { kind: result.outcome === 'error' ? 'error' : 'success', text: result.message };
	};

	ctx.effect(function* () {
		yield ctx.commands.register({
			name: 'undo',
			description: 'Unsend the last prompt and everything the agent did since it',
			handler: (invocation) => settle(invocation, 'undo')
		});
		yield ctx.commands.register({
			name: 'redo',
			description: 'Restore messages unsent by /undo, unless they were overwritten',
			handler: (invocation) => settle(invocation, 'redo')
		});
	});

	/* A frame is only meaningful while its session lives; drop it with the session. */
	ctx.on('session/disposed', (session) => {
		try {
			forget(session.id);
		} catch {
			/* a disposed session must never fail teardown */
		}
	});
}

export default { name: SERVICE_KEY, apply, inject };
