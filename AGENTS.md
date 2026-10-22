# AGENTS.md

agent-inbox keeps one inbox file for each project. Two hosts use it: a Claude Code mod in `hooks/register.tsx` and a pi extension in `pi/index.ts`. Both hosts use the shared core in `core/inbox.ts`.

Read `CONTRIBUTING.md` before you change code or text. It is the source for the code rules, the text rules and the rules of the Claude plugin directory. This file adds only what an agent needs.

## A change is done when

All three commands pass:

```bash
npm test && npm run validate && npm run typecheck:pi
```

They need no login and no network. A change in behavior also has a test that fails without the change.

## The mod API

The mod API types are the reference for each event, element and prop in `hooks/register.tsx`. The engine writes them to `.claude-plugin/types/claude-code/index.d.ts` when it loads the mod, for example in a session started with `claude --plugin-dir .`. Search that file for a name before you use it.

## Manual tests

Set `AGENT_INBOX_DIR` to a scratch folder before you start a session for a manual test. The inbox in `~/.agent-inbox` belongs to the person who uses this computer, and it holds their real items.

## Git

- Commit to a branch and open a pull request. The Claude plugin directory publishes each commit on `main`, and the `gh-pages` branch holds the website.
- Keep `version` as it is. The maintainer raises it at release time.
