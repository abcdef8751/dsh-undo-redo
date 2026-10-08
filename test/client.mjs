/**
 * Offline test for the browser half. Run with: node test/client.mjs
 *
 * The bundle is a classic script that only talks to the page through
 * `window.__ModuleLoader__`, so it loads into a bare VM with no DOM. That makes
 * the parts worth testing — the hand-written Remote descriptor, the slot
 * registration, and the control's behaviour against host state — verifiable
 * without a browser.
 *
 * Rendering is exercised through a React stub that runs function components and
 * `useEffect` bodies directly. That cannot prove the control *looks* right, and
 * it is not meant to: it proves the component tree builds and that the state
 * machine issues the right Remote calls.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/**
 * A minimal hook runtime.
 *
 * Hooks are keyed by component function so a nested render (the slot's component
 * rendering `Control`, `Control` rendering `Button`) cannot share a hook cursor.
 * Effects run inline and re-run when their deps change; `pending` collects the
 * resolutions of promises the effects started.
 */
function createReact() {
	const hookState = new Map();
	let current = null;
	let slot = 0;
	const pending = [];

	const React = {
		createElement(type, props, ...children) {
			return { type, props: props ?? {}, children };
		},
		useState(initial) {
			const hooks = hookState.get(current);
			const index = slot++;
			if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial;
			const set = (value) => {
				hooks[index] = typeof value === 'function' ? value(hooks[index]) : value;
			};
			return [hooks[index], set];
		},
		useEffect(effect, deps) {
			const hooks = hookState.get(current);
			const index = slot++;
			const previous = hooks[index];
			const changed =
				previous === undefined ||
				deps === undefined ||
				deps.length !== previous.deps.length ||
				deps.some((value, at) => !Object.is(value, previous.deps[at]));
			if (!changed) return;
			if (previous?.cleanup !== undefined) previous.cleanup();
			if (process.env.DBG === '1') console.error('DBG effect run', current, index, changed);
			hooks[index] = { deps: deps ?? [], cleanup: effect() };
		},
		/**
		 * Render eagerly and recursively, so nested function components are resolved
		 * during the pass rather than when a test later walks the tree. A lazy tree
		 * would hand back a stale snapshot of any component whose state changed since.
		 */
		__render(element) {
			const build = (node) => {
				if (node === null || node === undefined || typeof node !== 'object') return node;
				if (Array.isArray(node)) return node.map(build);
				if (typeof node.type === 'function') {
					const name = node.type.name;
					if (!hookState.has(name)) hookState.set(name, []);
					current = name;
					slot = 0;
					return build(node.type({ ...node.props, children: node.children }));
				}
				return { ...node, children: (node.children ?? []).map(build) };
			};
			return build(element);
		},
		/** Begin a new top-level render pass. */
		__pass() {},
		/**
		 * Drive the microtask queue until nothing new settles.
		 *
		 * A real React render flushes state writes and re-renders; this shim has no
		 * scheduler, so several macrotask turns are what let an effect's `await`
		 * chain finish and its state write become visible to a later pass.
		 */
		async __settle(rounds = 8) {
			for (let round = 0; round < rounds; round += 1) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			pending.length = 0;
		},
		/** Register a promise whose settlement the test should await. */
		__track(promise) {
			pending.push(Promise.resolve(promise).catch(() => {}));
		}
	};
	return React;
}

/** Flat list of elements in a tree, descending through the arrays children arrive in. */
function flatten(node, out = []) {
	if (Array.isArray(node)) {
		for (const item of node) flatten(item, out);
		return out;
	}
	if (node === null || node === undefined || typeof node !== 'object') return out;
	out.push(node);
	flatten(node.children ?? [], out);
	return out;
}

/** Find the first element whose props satisfy a predicate. */
function find(node, predicate) {
	return flatten(node).find((candidate) => candidate.type !== undefined && predicate(candidate)) ?? null;
}

/** Load the bundle the way the page does. */
async function loadBundle() {
	const source = await readFile(bundlePath, 'utf8');
	let record;
	const sandbox = {
		console,
		window: {
			__ModuleLoader__: {
				load(value) {
					record = value;
				}
			}
		}
	};
	sandbox.globalThis = sandbox;
	vm.runInNewContext(source, sandbox, { filename: bundlePath });
	if (record === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load');
	return record;
}

// ── Descriptor and slot registration ───────────────────────────────────────

const record = await loadBundle();
assert.equal(record.id, 'dsh-undo-redo', 'the bundle registers under the package name');

const React = createReact();
const intervals = [];
const effects = [];
const mounted = [];
const executed = [];
let stateValue = { sessionId: 'session-1', idle: true, canUndo: true, canRedo: false, redoCount: 0 };

const ctx = {
	get(name) {
		if (name === 'slots') return slots;
		if (name === 'remote') return remoteFacade;
		if (name === 'remote.undoRedo') return remoteFacade.undoRedo;
		return undefined;
	},
	interval(callback, delay) {
		intervals.push({ callback, delay });
		return () => intervals.splice(intervals.indexOf(callback), 1);
	},
	effect(callback, label) {
		effects.push({ callback, label });
		const disposer = callback();
		return () => {
			if (typeof disposer === 'function') disposer();
		};
	},
};

const remoteFacade = {
		async $mount(contribution) {
			mounted.push(contribution);
			return () => {};
		},
		undoRedo: {
			async state(sessionId) {
				if (process.env.DBG === '1') console.error('DBG remote state called');
				return { ok: true, value: { ...stateValue, sessionId: String(sessionId) } };
			},
			async execute(sessionId, line, images, action) {
				executed.push({ sessionId: String(sessionId), line, images, action });
				stateValue = action === 'undo'
					? { ...stateValue, canUndo: false, canRedo: true, redoCount: 2 }
					: { ...stateValue, canUndo: true, canRedo: false, redoCount: 0 };
				return {
					ok: true,
					value: {
						outcome: 'ok',
						message: action === 'undo' ? 'Unsent the last prompt.' : 'Restored 2 message(s).',
						state: { ...stateValue }
					}
				};
			}
		}
};

/* `apply` reaches the Remote mount through the context property, not ctx.get. */
ctx.remote = remoteFacade;

const registrations = [];const slots = {
	inject(key, callback) {
		registrations.push({ key, callback });
		return () => {};
	},
	register(options, component) {
		registrations.push({ options, component });
		return () => {};
	}
};

const module = { exports: {} };
const exported = record.factory((spec) => {
	if (spec === 'react') return React;
	if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
		return {
			Button: function Button(props) {
				return React.createElement('button', props);
			},
			IconChevronLeftOutline14: function Icon() {
				return React.createElement('svg', {});
			}
		};
	}
	throw new Error(`unexpected require: ${spec}`);
});

/* The bundle runs in a VM realm, so its arrays are copied before comparison. */
assert.deepEqual([...exported.inject], ['remote', 'slots'], 'the client declares its hard dependencies');
await exported.apply(ctx);

assert.equal(mounted.length, 1, 'the Remote contribution is mounted');
const contribution = mounted[0];
assert.equal(contribution.package, 'dsh-undo-redo');
assert.deepEqual(
	[...contribution.descriptors].map((descriptor) => descriptor.id),
	['dsh-undo-redo#undoRedo/execute', 'dsh-undo-redo#undoRedo/state']
);
for (const descriptor of contribution.descriptors) {
	assert.equal(descriptor.service, 'undoRedo', 'the namespace must match the host service key');
	for (const parameter of descriptor.parameters) {
		assert.equal(parameter.codec.mode, 'strict', '$mount requires strict codecs');
		assert.equal(typeof parameter.codec.schema.parse, 'function', 'and a callable parse');
		assert.ok(parameter.codec.typeSymbol.length > 0, 'and a nonempty type symbol');
	}
}
const executeDescriptor = contribution.descriptors[0];
assert.deepEqual(
	[...executeDescriptor.parameters].map((parameter) => [parameter.name, parameter.wire, parameter.source]),
	[
		['agent', 'agentId', 'lookup'],
		['line', 'line', 'json'],
		['images', 'images', 'json'],
		['action', 'action', 'json']
	],
	'the wire fields must match the signature the host derives'
);
assert.equal(
	contribution.descriptors[1].parameters.length,
	1,
	'the state endpoint sends only the session identity'
);

const injectCall = registrations.find((entry) => entry.key === 'conversation.session.header.actions');
assert.ok(injectCall, 'the control must wait for the header action slot');
injectCall.callback();
const registration = registrations.find((entry) => entry.options !== undefined);
assert.deepEqual(
	{ ...registration.options },
	{ name: 'conversation.session.header.actions', id: 'undo-redo', order: 30 },
	'a fresh id keeps the shipped header entries intact'
);

// ── The control ────────────────────────────────────────────────────────────

const renderPass = async () => {
	React.__pass();
	const tree = React.__render(registration.component({ sessionId: 'session-1', ctx }));
	await React.__settle();
	return tree;
};

let tree = await renderPass();

const findButton = (node) => find(node, (element) => element.props?.title !== undefined);

/*
 * The first pass renders with no host state and starts the polling read; the
 * second renders the control that read produced.
 */
const coldButton = findButton(tree);
assert.equal(coldButton.props.disabled, true, 'the control starts inert until the host answers');

tree = await renderPass();
const button = findButton(tree);
assert.ok(button, 'the control renders a button');
assert.equal(button.props.disabled, false, 'undo is live when the host says so');
assert.match(String(button.props.title), /Unsend the last prompt/);

assert.equal(intervals.length > 0, true, 'the control polls host state');
assert.equal(intervals[0].delay, 2000, 'and does so on its own cadence');

button.props.onClick();
/* The shim has no scheduler, so a state write needs an explicit render pass. */
await renderPass();
await React.__settle();
assert.equal(executed.length, 1, 'the click issued one Remote call');
assert.deepEqual(
	{ ...executed[0], images: [...executed[0].images] },
	{ sessionId: 'session-1', line: '/undo', images: [], action: 'undo' }
);

/* The host now reports a pending restore, so the same control flips direction. */
tree = await renderPass();
tree = await renderPass();
const redoButton = findButton(tree);
assert.match(String(redoButton.props.title), /Restore 2 unsent message/, 'the control offers the restore');
assert.equal(redoButton.props.disabled, false, 'and it is live');

redoButton.props.onClick();
await renderPass();
await React.__settle();
assert.equal(executed.length, 2, 'the restore issued one Remote call');
assert.equal(executed[1].action, 'redo', 'and asked for redo');

/* A running agent disables the control without any new host call being needed. */
stateValue = { sessionId: 'session-1', idle: false, canUndo: false, canRedo: false, redoCount: 0 };
tree = await renderPass();
tree = await renderPass();
const whileRunning = findButton(tree);
assert.equal(whileRunning.props.disabled, true, 'the control is inert while the agent runs');

console.log('client OK — descriptor, slot registration, and the control state machine behave');
