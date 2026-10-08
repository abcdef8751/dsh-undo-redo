/**
 * Shared host fixture: the real gateway, the real undo engine, and a real
 * Session — only the `agent` lookup is stubbed, because the real provider sits
 * behind the whole agent/session stack and the stub reproduces the declaration
 * (`parameter: "agent"`, `wire: "agentId"`) that the plugin's signature depends
 * on.
 */

import { Context } from '@deepseek-ai/cordis';
import { Session } from '@deepseek-ai/dsh-session';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import plugin from "../lib/index.js";

/**
 * One complete turn on the surface: prompt, then a step-bracketed reply.
 *
 * The `turn/start` / `step/start` / `step/end` / `turn/end` envelope is not
 * decoration — the real token meter pairs every `assistant/message` with the
 * open step that produced it and throws without one, so a fixture that skips
 * the envelope cannot exercise the meter at all.
 */
export function exchange(session, turn, prompt, reply) {
	session.append('turn/start', { turn });
	session.append(
		'user/message',
		{ id: `u${String(turn)}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } },
		{ surfaceOp: 'append' }
	);
	session.append('step/start', { turn, step: 1 });
	session.append(
		'assistant/message',
		{
			turn,
			step: 1,
			message: {
				id: `a${String(turn)}`,
				role: 'assistant',
				content: [{ type: 'text', text: reply }],
				source: { kind: 'model', provider: 'test', model: 'test' }
			}
		},
		{ surfaceOp: 'append' }
	);
	session.append('step/end', { turn, step: 1 });
	session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

/** Surface text, in model-visible order. */
export function surfaceText(session) {
	const bySeq = new Map(session.events.map((event) => [event.seq, event]));
	return [...session.surface.nodes].map((seq) => {
		const event = bySeq.get(seq);
		if (event.type === 'user/message') return event.data.content.map((block) => block.text ?? '').join('');
		if (event.type === 'assistant/message') return event.data.message.content.map((block) => block.text ?? '').join('');
		return event.type;
	});
}

/** Human-visible transcript: the append-origin surface events the client renders. */
export function transcriptText(session) {
	return session.events
		.filter((event) => {
			if (event.type !== 'user/message' && event.type !== 'assistant/message') return false;
			return event.surfaceOp === 'append';
		})
		.map((event) => {
			if (event.type === 'user/message') return event.data.content.map((block) => block.text ?? '').join('');
			return event.data.message.content.map((block) => block.text ?? '').join('');
		});
}

/**
 * Boot a host with one live-looking agent over a real Session.
 * @returns the context, the agents Map, the session, and a mutable status holder.
 */
export async function bootHost() {
	const ctx = new Context();
	await ctx.plugin(TypertRegistry);

	const session = Session.create('session-1');
	const status = { current: 'idle' };
	const agent = {
		session,
		get status() {
			return status.current;
		}
	};
	const agents = new Map([['session-1', agent]]);

	ctx.typert.lookups.register('agent', {
		parameter: 'agent',
		wire: 'agentId',
		hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
		wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
		resolve: (sessionId) => agents.get(sessionId)
	});

	await ctx.plugin(CommandRuntime);
	await ctx.plugin(plugin);
	await ctx.plugin(TypertGatewayService);

	return { ctx, agents, session, agent, status, exchange };
}
