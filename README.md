# dsh-always-queue

Single-session gate for the DeepSeek Harness web GUI.

When your local LLM runs with parallelism 1, you want **exactly one session in
progress at a time** — but the harness, by default, starts a new session
immediately the moment you send it its first message. This plugin closes that
gap entirely on the client side (no dsh source changes, no PR required):

- You start a new session (fresh context), click **send** → the message is
  **queued** (held) and does **not** start. It starts only after the running
  session **completes or pauses** (cancel works too).
- You start yet another new session and send → it is queued behind the first.
- You go back to an old (idle) session and send while another session is
  running → that old session is queued as well.
- Held messages are released **FIFO per session**: the oldest waiting session
  starts first; its own follow-up messages join its normal per-session queue.
  The next session starts only after that one completes or pauses.
- There is **no "send now" / steer affordance for held messages** — that is
  the point of the plugin. The only exits are *remove* and *pull back to the
  composer* (text entries, empty draft).
- **Within the running session, nothing changes**: the default in-session
  message queueing and steer (send-now) behavior is preserved exactly. This
  plugin never shadows the official queue dock or the busy-Enter preference.

## How it works

1. The client plugin wraps the `conversation` service's `send` /
   `sendSession` verbs **at the instance level**: the raw service instance
   is read through cordis's traceable proxy (the `cordis.original` symbol),
   and the two verbs are replaced with gated wrappers on the instance itself.
   That intercepts every read path — both `ctx.get('conversation')` (what
   the composer's send sink uses) and `ctx.conversation` property access —
   with the per-caller context rebinding intact. (The `internal/get`
   waterfall only fires on property access, so a waterfall listener would
   miss the composer sink, which reads the store directly.) A send addressed
   to a session that is **not itself running** is held while any **other**
   session counts as busy.
2. A **claim** marks a session busy from the moment its turn starts — either
   a pass-through send or a plugin release — until the host's `running` flag
   lands in the list snapshot (a 15 s safety valve covers a turn that ends
   before its flag lands). This closes the race where a second session could
   start in the gap before the host confirms the first one is running.
3. Held messages (text plus any attached images, captured as base64) land in
   a per-page queue persisted to `localStorage`, so they survive a reload.
4. A release loop subscribes to the session-list snapshot: when no session
   reports busy (flag or claim), the oldest waiting session's whole batch is
   delivered through `session.prompt` in FIFO order. Failed deliveries retry
   with a backoff and are dropped (with a `console.error`) after 10 attempts.
5. An **additional** `conversation.input.dock` entry (id `always-queue`,
   rendered below the official queue strip) shows the held messages of the
   session you are viewing, with a pulsing "waiting" banner.

## Install

From a directory (development):

```sh
npx @deepseek-ai/dsh plugin --profile web add ./path/to/always-queue -w
```

After publishing to GitHub:

```sh
npx @deepseek-ai/dsh plugin --profile web add <your-username>/dsh-always-queue -w
```

Then restart the web profile (`dsh web`). The plugin is a profile layer:
removing it is `npx @deepseek-ai/dsh plugin --profile web remove dsh-always-queue -w`.

## What it does NOT change

- The official per-session queue dock (in-session message queue) and its
  editing/steer controls — untouched.
- The busy-Enter (queue vs steer) preference — untouched.
- Sessions while no other session is running: the very first send still
  starts immediately, exactly like the default.
- Slash commands are not gated (only plain message sends go through the
  composer sink this plugin wraps).

## Limitations

- Client-side by design: the gate lives in the browser page. Sending to the
  same session from a second client (e.g. the TUI) is not gated.
- Single page/tab is assumed (the queue is per-page, persisted to that
  browser's localStorage).
- Image attachments on held messages are captured as base64 at hold time;
  very large image sets are bounded by the localStorage quota (5 MB) — if the
  quota is hit, persistence degrades to in-memory for that page.

## Build / verify

```sh
npm install
npm run verify   # lint + tests + build + assembly verification
```

Artifacts: `lib/index.js` (node half, no-op) and `lib/client.js` (browser
half, served by the web profile at /plugins/dsh-always-queue/client.js).
`examples/verify-assembly.mjs` re-checks the loader surfaces from a profile
`node_modules` copy.

## License

MIT
