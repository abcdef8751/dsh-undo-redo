# dsh-undo-redo

A drop-in DSH plugin for the Web GUI: **unsend and restore conversation
progress.** `/undo` removes your last prompt — and everything the agent did
since it — from what the model can see. `/redo` puts it back. A compact control
in the session header does the same thing without typing.

```
you:   refactor the parser
agent: [20 tool calls, 4 files changed, long answer]

/undo  →  the prompt and all of that work leave the model's context
/redo  →  they come back, unless you already moved on
```

## How an unsend works

A session log is **append-only**, so nothing is destroyed. What `/undo` changes is
the *surface*: the ordered view over the log that produces the model-visible
message history. One `assistant/message` appended with

```js
surfaceOp: { op: 'replace', start, end }
```

shadows that range of surface nodes — the same primitive compaction uses to
replace the history it summarizes. Consequences worth knowing:

| | |
| --- | --- |
| The log | keeps every event; `/undo` only appends |
| The model | loses the unsent stretch **completely** — nothing is left in its place |
| Your transcript | **unchanged** — the client builds it from append-origin events, so unsent messages stay visible to you |

### The context is discarded, not annotated

The replacement node is an `assistant/message` with **empty content**. The
projection rule in `deriveEventMessage` returns `null` for that, so the node
holds the removed range's place in the surface — keeping it addressable for the
next undo and for the guard — while contributing *nothing* to the model's
context. No marker, no notice, no empty turn.

Two constraints make this the only shape that works, and both were found by
running the real components rather than reasoning about them:

- A `user/message` cannot do it. Its projection returns the content verbatim, so
  an empty one would put an empty turn in front of the model.
- A bare `assistant/message` is not legal mid-log. The **token meter** pairs
  every one with the open `step/start` that produced it and throws
  `assistant/message at seq N has no matching step/start event` otherwise. So the
  placeholder is wrapped in a one-step bracket opened under a fresh turn —
  fresh so it can never collide with a real step, and left without a `turn/end`
  because the log already tolerates an unclosed turn (persistence closes a
  crash-orphaned turn on reload) while a stray one could confuse a live loop
  between turns. Restored messages are re-bracketed the same way.

The unsend appends **nothing else**. What the user is told about the action rides
the command result — the harness logs `command/done` itself — never a session
event of this plugin's own invention, because an unknown event type would make
the log unreadable on reload: the persistence read path refuses a type outside
the known vocabulary unless it carries the envelope's `ignorable` marker.

Restoring cannot "unshadow": the surface only moves forward. `/redo` therefore
re-appends the removed messages as fresh nodes at the log tail, and adds exactly
those messages — no commentary.

## The overwrite rule

Redo records the exact surface-node list from right after the unsend. If the
conversation has moved on since — you sent something else, or the agent ran —
that list no longer matches, the frame is dropped, and redo reports that it had
no effect. An undone message only reverses progress until it is overwritten.

The refusal is a normal outcome, not an error: it is the whole point of the
guard, and the control simply stops offering the restore.

## Install

The package is linked into the profile and enabled by one Loader row:

```sh
ln -s ~/dsh/dsh-undo-redo ~/.dsh/profiles/web/node_modules/dsh-undo-redo
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: undo-redo
      name: 'dsh-undo-redo'
```

`node_modules/` inside this package is not an accident: Node resolves a linked
package by its real path, so the peer links there are what let `lib/index.js`
import the *same* `@deepseek-ai/dsh-typert-protocol` instance the host is using.
A second instance would carry its own private marker table and the gateway would
see no Remote methods at all.

`exports` must keep publishing `"./package.json"`. The modules node half detects
the browser half with `require.resolve("<name>/package.json")`, so sealing that
subpath makes the plugin invisible to the browser with no error anywhere.

Adding a Loader row is a boot-time change: restart `dsh web` to activate.

## Behaviour

| Situation | Result |
| --- | --- |
| `/undo` with a prompt on the surface | Prompt and everything after it leave the model's context |
| `/undo` with nothing to unsend | Reported, no change |
| `/undo` while the agent runs | Refused — stop first |
| `/redo` after an unsend, nothing since | Messages restored at the tail |
| `/redo` after conversation moved on | No effect; the frame is dropped |
| Session ends | Its frame is discarded; nothing is persisted |

Tool results are shadowed but not restored: a redo re-appends text only, because
a tool result without its originating call would be an orphan. Assistant tool
calls are dropped for the same reason.

## Two seams worth knowing

| Seam | Why it is needed | Failure mode if it changes |
| --- | --- | --- |
| `ctx.remote.$mount()` with a hand-written descriptor | The client may only call host services through mounted Typert contributions, and only the in-repo build generates those. | `apply` throws at load; the buttons are simply absent. |
| `@Remote` marker replayed by hand | The Host Gateway reaches plugin services only in SRC mode ("endpoints that have never had a strict definition"), which requires a prototype marker. | `undoRedo/execute` answers `invocation-unavailable`. |
| `surfaceOp: { op: 'replace' }` with an empty `assistant/message` | The only mechanism that removes messages from the model's view while leaving nothing behind. | Appends are rejected by the session's surface validator, or the meter throws. |
| A one-step bracket around each placeholder | The token meter requires every `assistant/message` to pair with an open step. | `token meter: assistant/message at seq N has no matching step/start event` on the next measurement. |

One more integration fact the meter enforces: a surface `replace` is priced by an
adjacent shadow-price claim, and **this plugin has no claim event**. The fold
takes its documented zero-delta branch rather than failing, so the meter will not
crash — but it also will not reduce the context figure it reports. The
statistics line is likewise unaffected: see the limitations below.

The client descriptor carries an identity codec. `$mount` requires
`codec.mode === "strict"` and a callable `schema.parse`, and never checks that
the schema came from the generator, so a pass-through validates.

Because the shipped `commands` service already exports `commands/execute`, this
plugin publishes only its own `undoRedo` namespace — a plugin never shadows a
core endpoint that already answers.

## Tests

```sh
node test/host.mjs     # host: SRC discovery, surface rewrite, overwrite rule, guards
node test/client.mjs   # browser: bundle registration, descriptor, control state machine
```

Both are offline. The host test drives the real gateway, the real registry, and a
real `Session`, and asserts that `foldSurface` reproduces the live surface after a
rewrite. Only the `agent` lookup is stubbed, because the real provider sits behind
the whole agent/session stack; the stub reproduces the declaration
(`parameter: "agent"`, `wire: "agentId"`) the plugin's signature depends on.

The browser test loads the real bundle into a bare VM with a small React shim, so
it proves the descriptor and the control's state machine, not pixels.

## Known limitations

- **The transcript does not change.** Undo alters what the model sees, not what
  you see. Unsent messages remain in the log and on screen, because the client
  builds the transcript from append-origin events by design. Removing them from
  the UI means changing `dsh-client-ui-conversation`, not this plugin.
- **The statistics line does not change either.** Turns, steps, tool calls, and
  the token figures under the composer are folded from the raw event log by
  `dsh-session-stats` and the token-meter projection, neither of which consults
  the surface for those numbers. An undone turn is gone from the model's context
  but still counted. This is also a harness change, not a plugin one.
- **Single-level.** One unsend is restorable at a time; a second `/undo` replaces
  the first frame, and the older stretch is no longer separately restorable.
- **Not persisted.** Frames live in memory for the life of the process, so a
  restart mid-way loses the ability to redo. The conversation itself is unharmed.
- **Any new surface content expires the redo**, including an injected context
  notice — the guard compares surface nodes exactly.
