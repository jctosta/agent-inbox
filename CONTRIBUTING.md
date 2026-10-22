# Contributing to agent-inbox

This guide tells you how to set up the project, how to test a change, and which rules a change must follow.

## Before you start

- For a bug, open an issue with the bug form. Include the host and its version.
- For a new feature, open an issue with the feature form before you write code. The maintainer can then agree on the scope with you.
- For a small fix, such as a typo, you can open a pull request without an issue.

## Set up the project

You need:

- Node.js 22.18 or later.
- Claude Code 2.1.287 or later, to run the Claude Code tests and the validator.
- pi, only if you change the pi extension and want to try it by hand.

Install the dependencies:

```bash
npm install
```

Do not commit `package-lock.json`. The Claude plugin directory holds a plugin for review when a lockfile is in the plugin folder, and the repository root is the plugin folder.

## Run the checks

Run these commands before you open a pull request. CI runs the same commands.

```bash
npm test
```

```bash
npm run validate
```

```bash
npm run typecheck:pi
```

`npm test` runs the Claude Code tests (`claude plugin test .`) and the pi smoke test (`tsx pi/smoke.ts`). The checks need no login and no network.

## Try a change in a real session

For Claude Code, start a session with the plugin loaded from your copy:

```bash
claude --plugin-dir .
```

After each change, type `/reload-plugins` in that session.

For pi, start pi with the extension from your copy:

```bash
pi -e ./pi/index.ts
```

To keep your own inbox clean, set `AGENT_INBOX_DIR` to a scratch folder before you start the session.

## Rules for code

- Put logic that both hosts use in `core/inbox.ts`. Keep host code in `hooks/register.tsx` (Claude Code) and `pi/index.ts` (pi).
- Add a test for each change in behavior. Claude Code tests go in `tests/inbox.test.tsx`. pi checks go in `pi/smoke.ts`.
- Commit readable source only. Do not commit compiled, minified or binary files.
- In `hooks/register.tsx`, use `$` only as the hook's first parameter and in plain calls such as `$.fs.write(...)`. Do not declare a type or a variable with the name `$`. The Claude plugin directory refuses other uses.
- In a `.tsx` file, do not declare anything with the name `h` or `Fragment`. JSX compiles to calls of these names.
- If a change alters what the plugin reads, writes, sends or changes, update the "What it touches" section of the README in the same pull request. The directory review reads that section.
- Keep the site out of `main`. The site is on the `gh-pages` branch.

## Rules for text

- Write documentation, issues and pull requests in ASD-STE100 Simplified Technical English: active voice, short sentences, one instruction in each sentence, and no contractions.
- Write issue and pull request titles as an instruction: a verb in the imperative, then the object. For example: "Add support for OpenAI Codex".
- In commit messages, tell why the change is necessary, not only what it changes.

## Pull requests

- Keep each pull request to one change.
- Fill in the pull request template.
- All checks in CI must pass.
- The maintainer merges with a squash merge. The title and the description of the pull request become the commit message.

## Labels

Each issue has one type label: `bug`, `enhancement`, `documentation` or `question`. Each issue also has one or more area labels:

| Label | Scope |
| --- | --- |
| `area: core` | The inbox file format and `core/inbox.ts` |
| `area: claude-code` | The Claude Code mod in `hooks/register.tsx` |
| `area: pi` | The pi extension in `pi/` |
| `area: codex` | Support for OpenAI Codex |
| `area: site` | The landing page on the `gh-pages` branch |
| `area: directory` | The listing in the Claude plugin directory |

`on hold` marks an issue that waits on something outside this repository.

## Releases

The maintainer makes the releases:

1. Raise `version` in `.claude-plugin/plugin.json` and in `package.json`. Use the same version in both files.
2. Run the checks.
3. Merge the release pull request.

Installed copies update only when the version changes.
