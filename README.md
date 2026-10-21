# agent-inbox

A persistent inbox of the things your coding agents are waiting on **you** for: a secret to set, a decision, a review, a command only you can run. The agent files each one with a `flag_for_user` tool call instead of burying it in a reply. The list then stays pinned above your prompt until you clear it, across turns, `/clear` and new sessions.

There is one list per project, shared by **Claude Code** (as a mod) and **pi** (as an extension). An item flagged in one agent shows up in the other.

```
⚑ 3 waiting on you · 1 blocking · /done N · open · less
✓ #4 Add STRIPE_SECRET_KEY to .env.local
✓ #5 Approve the migration plan in docs/plan.md
✓ #6 Run `make seed` against your local Postgres
```

## How it works

- **`flag_for_user`** (tool): the agent adds an item with a `title`, an optional `detail`, a `kind` (`action`, `decision`, `review`, `secret` or `info`) and `blocking`. Re-flagging an open item with the same title is a no-op.
- **`resolve_user_item`** (tool): the agent closes an item once you say it's handled, or once it verifies that (for example, the env var now exists).
- **Context:** while the open set changes, the agent gets a hidden `<user_inbox>` note beside your next prompt. It only arrives when something changed, so it doesn't break the prompt cache or clutter context.
- **Storage:** `~/.agent-inbox/<project>-<hash>.json`, where the project is the nearest git root above the session's directory. You can override the folder with `AGENT_INBOX_DIR`. The file is plain JSON, so other tools can read it too.
- Each agent polls the file every 3 seconds, so changes from the other agent appear without a restart.

## Commands (both agents)

| Command | What it does |
| --- | --- |
| `/inbox` | Claude Code: opens the pane, with Done/Drop buttons, an Add field and recently closed items with Reopen. pi: lets you pick an item, then Done or Drop. |
| `/done 3` or `/done 3 4` | Mark items done. |
| `/inbox drop 3` | Close an item as no longer needed. |
| `/inbox reopen 3` | Bring a closed item back. |
| `/inbox add <text>` | Add an item yourself. |

In Claude Code the band's `✓` closes an item with one click. Use `ctrl+x tab` to focus the band from the keyboard. In pi the list is a widget above the editor, with a `⚑ N` count in the footer.

## Install

**Claude Code** (CLI and the desktop Code tab, 2.1.287+):

```
/plugin install agent-inbox --marketplace jctosta/agent-inbox
```

or from a shell: `claude plugin install agent-inbox --marketplace jctosta/agent-inbox`. For a local checkout, use `claude --plugin-dir ./agent-inbox`.

**pi:**

```
pi install git:github.com/jctosta/agent-inbox
```

or for a local checkout: `pi install ./agent-inbox`. To try it for one run, use `pi -e ./agent-inbox/pi/index.ts`.

## Layout

```
core/inbox.ts           shared, host-neutral logic: file format, add/close, tool contract
hooks/register.tsx      the Claude Code mod
types/index.d.ts        the mod's $.state contract
pi/index.ts             the pi extension (imports ../core)
tests/inbox.test.tsx    Claude Code tests (claude plugin test)
pi/smoke.ts             pi end-to-end test against pi's scripted faux model
```

## Develop

```
npm install
npm test             # claude plugin test . && tsx pi/smoke.ts
npm run validate     # claude plugin validate .
npm run typecheck:pi
```

## Caveats

- Mods and pi extensions run unsandboxed, with your permissions. This one only reads and writes its own JSON file under `~/.agent-inbox`. It makes no network calls and runs no processes.
- Claude Code's VS Code panel and `claude -p` run the tools but don't draw the band or the pane.
- Writes are read-modify-write on a small file. pi writes atomically. Two agents closing items in the same instant could still race, but the file never ends up half-written from pi's side. If the file stops parsing (a bad hand edit, an interrupted write), neither agent writes over it: changes fail with a message naming the file until you fix or delete it.
