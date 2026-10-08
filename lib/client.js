/**
 * dsh-undo-redo — browser half.
 *
 * A compact undo/redo control in the session header's action row, beside the
 * agent-preset chip and job list. It is the discoverable face of the same engine
 * the `/undo` and `/redo` commands drive.
 *
 * Undo and redo are mutually exclusive here — an unsend cannot also have a
 * pending restore — so the pair renders as one control rather than two buttons
 * that are never both live.
 *
 * ## The Remote seam
 *
 * The client may only call host services through mounted Typert contributions,
 * and only the in-repo build generates those. `ctx.remote.$mount()` accepts a
 * hand-written descriptor provided it carries `codec.mode === 'strict'` with a
 * callable `schema.parse`; it never checks that the schema came from the
 * generator, so an identity codec validates and mounts, and the host answers in
 * SRC mode because no strict definition was ever generated for this endpoint.
 *
 * @module dsh-undo-redo/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-undo-redo',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;

		const React = require('react');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		/** Must match the host service key; endpoints are `undoRedo/execute` and `undoRedo/state`. */
		const NAMESPACE = 'undoRedo';

		/** How often the control re-reads host state; it is two integers. */
		const POLL_MS = 2000;

		/**
		 * The generator emits `typeSymbol` plus a real schema, and the registry
		 * only checks that `typeSymbol` is nonempty and `schema.parse` is callable,
		 * so an identity codec round-trips the payload without a Typert build.
		 * @param {string} subject - schema key, unique per descriptor field.
		 * @returns a strict-shaped codec.
		 */
		const strictCodec = (subject) => ({
			mode: 'strict',
			typeSymbol: `dsh-undo-redo#${subject}`,
			schema: { parse: (value) => value }
		});

		/** One lookup parameter resolved host-side, one JSON field. */
		const agentParam = (subject) => ({
			name: 'agent',
			wire: 'agentId',
			source: 'lookup',
			lookup: 'agent',
			codec: strictCodec(subject)
		});

		/**
		 * Contribution mounted into `ctx.remote`. `agent` stays a lookup parameter
		 * so the host resolves the session id to a live Agent; everything else
		 * rides the wire as plain JSON.
		 */
		const CONTRIBUTION = {
			package: 'dsh-undo-redo',
			descriptors: [
				{
					id: 'dsh-undo-redo#undoRedo/execute',
					service: NAMESPACE,
					namespace: NAMESPACE,
					method: 'execute',
					invocation: { kind: 'direct' },
					parameters: [
						agentParam('undoRedo/execute:agent'),
						{ name: 'line', wire: 'line', source: 'json', codec: strictCodec('undoRedo/execute:line') },
						{ name: 'images', wire: 'images', source: 'json', codec: strictCodec('undoRedo/execute:images') },
						{ name: 'action', wire: 'action', source: 'json', codec: strictCodec('undoRedo/execute:action') }
					],
					result: strictCodec('undoRedo/execute:result')
				},
				{
					id: 'dsh-undo-redo#undoRedo/state',
					service: NAMESPACE,
					namespace: NAMESPACE,
					method: 'state',
					invocation: { kind: 'direct' },
					parameters: [agentParam('undoRedo/state:agent')],
					result: strictCodec('undoRedo/state:result')
				}
			]
		};

		/** Read the live Remote namespace, handling a not-yet-mounted host service. */
		const namespaceOf = (ctx) => ctx.get(`remote.${NAMESPACE}`) ?? ctx.get('remote')?.[NAMESPACE];

		/**
		 * Read current undo/redo availability.
		 * @param ctx - client Cordis context.
		 * @param sessionId - session whose state is wanted.
		 * @returns the state, or null when the host half is unavailable.
		 */
		const readState = async (ctx, sessionId) => {
			const remote = namespaceOf(ctx);
			if (remote === undefined) return null;
			const outcome = await remote.state(sessionId);
			if (outcome?.ok !== true) return null;
			return outcome.value ?? null;
		};

		/**
		 * Run one action and return the host's refreshed state.
		 * @param ctx - client Cordis context.
		 * @param sessionId - session to act on.
		 * @param action - 'undo' or 'redo'.
		 * @returns the settled outcome.
		 */
		const runAction = async (ctx, sessionId, action) => {
			const remote = namespaceOf(ctx);
			if (remote === undefined) {
				return { outcome: 'error', message: 'Undo/redo is unavailable: its host service is not mounted.', state: null };
			}
			const outcome = await remote.execute(sessionId, `/${action}`, [], action);
			if (outcome?.ok !== true) {
				return {
					outcome: 'error',
					message: outcome?.error?.message ?? 'Undo/redo failed on the host.',
					state: null
				};
			}
			return outcome.value ?? { outcome: 'ok', message: '', state: null };
		};

		/** A 14px chevron, rotated for the redo direction. */
		const chevron = (rotation) =>
			React.createElement('span', {
				style: { display: 'block', transform: `rotate(${rotation}deg)`, lineHeight: '1' },
			}, React.createElement(primitives.IconChevronLeftOutline14, { size: 14 }));

		/**
		 * The header control for one session.
		 *
		 * `ctx` arrives as a prop rather than through a closure: the component is
		 * defined beside `apply` but rendered by the slot later, and the slot's own
		 * `ctx` is not the one holding this plugin's Remote. Passing the mount-time
		 * context keeps the component's interval and Remote calls on the fiber that
		 * owns them.
		 */
		function Control({ ctx, sessionId: rawSessionId }) {
			const sessionId = String(rawSessionId);
			const [state, setState] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const [tick, setTick] = React.useState(0);
			const [pending, setPending] = React.useState(null);

			/* Poll host state; `tick` re-runs this after an action settles. */
			React.useEffect(() => {
				let live = true;
				readState(ctx, sessionId)
					.then((next) => {
						if (live) setState(next);
					})
					.catch(() => {});
				const stop = ctx.interval(() => {
					readState(ctx, sessionId)
						.then((next) => {
							if (live) setState(next);
						})
						.catch(() => {});
				}, POLL_MS);
				return () => {
					live = false;
					stop();
				};
			}, [sessionId, tick]);

			/* One action per `pending` write; the buttons are disabled while it runs. */
			React.useEffect(() => {
				if (pending === null) return undefined;
				let live = true;
				runAction(ctx, sessionId, pending)
					.then((result) => {
						if (!live) return;
						setNotice(result);
						setPending(null);
						setTick((value) => value + 1);
					})
					.catch((error) => {
						if (!live) return;
						setNotice({
							outcome: 'error',
							message: error instanceof Error ? error.message : String(error),
						});
						setPending(null);
						setTick((value) => value + 1);
					});
				return () => {
					live = false;
				};
			}, [pending, sessionId]);

			/* Clear a failure notice once the state moves on. */
			React.useEffect(() => {
				if (notice?.outcome === 'error' && state?.canUndo === true && notice.state === null) setNotice(null);
			}, [state, notice]);

			const busy = pending !== null || (state !== null && state.idle !== true);
			const canUndo = state?.canUndo === true && busy !== true;
			const canRedo = state?.canRedo === true && busy !== true;
			const onClick = () => setPending(canRedo ? 'redo' : 'undo');

			const title = canRedo
				? `Restore ${String(state?.redoCount ?? 0)} unsent message(s)`
				: canUndo
					? 'Unsend the last prompt and everything the agent did since it'
					: 'Nothing to unsend';
			const tone = notice?.outcome === 'error' ? '--dsw-alias-state-error-primary' : '--dsw-alias-label-secondary';
			const button = React.createElement(primitives.Button, {
				variant: 'toolbar',
				size: 'sm',
				icon: chevron(canRedo ? 180 : 0),
				disabled: canUndo !== true && canRedo !== true,
				title,
				'aria-label': title,
				onClick,
				style: { color: `var(${tone})` },
			});

			/* Only failures earn a visible message; success shows up in the conversation. */
			const children = [button];
			if (notice?.outcome === 'error' && typeof notice.message === 'string' && notice.message !== '') {
				children.push(
					React.createElement('span', {
						key: 'notice',
						role: 'status',
						title: notice.message,
						style: {
							color: 'var(--dsw-alias-state-error-primary)',
							fontSize: '11px',
							maxWidth: '180px',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						},
					}, notice.message)
				);
			}
			return React.createElement('div', {
				style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
			}, children);
		}

		/**
		 * Mount the Remote contribution and the header control.
		 *
		 * @param ctx - client Cordis context.
		 */
		async function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) throw new Error('dsh-undo-redo: the slots service is unavailable');

			const disposeRemote = await ctx.remote.$mount(CONTRIBUTION);
			ctx.effect(() => disposeRemote, 'undo-redo: Remote contribution');

			slots.inject('conversation.session.header.actions', () =>
				slots.register(
					{ name: 'conversation.session.header.actions', id: 'undo-redo', order: 30 },
					(props) => React.createElement(Control, { ...props, ctx })
				)
			);
		}

		exports.apply = apply;
		exports.inject = ['remote', 'slots'];
		return module.exports;
	}
});
