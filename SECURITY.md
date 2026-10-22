# Security policy

## Report a vulnerability

Do not open a public issue for a vulnerability. Use GitHub private vulnerability reporting:

https://github.com/jctosta/agent-inbox/security/advisories/new

Include the host (Claude Code or pi) and its version, the agent-inbox version, and the steps to reproduce the problem.

## Supported versions

Only the latest release gets security fixes.

## Scope

agent-inbox runs on your computer with your permissions. It reads and writes one JSON file for each project in `~/.agent-inbox`, or in `AGENT_INBOX_DIR`. It does not use the network and does not start programs. The "What it touches" section of the README lists everything that it does.

Examples of problems in scope:

- Text in an inbox item that changes the instructions that the coding agent gets.
- A write outside the inbox folder.
- A damaged inbox file that causes data loss.
