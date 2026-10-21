// agent-inbox for Claude Code: a persistent list of what agents are waiting
// on the human for. Claude adds to it with the flag_for_user tool; the human
// sees it in a band above the prompt and clears it with /done or the pane.
// The list lives in one JSON file per project, shared with the pi extension.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { InboxState } from '../types'
import {
  FLAG_TOOL_DESCRIPTION,
  FLAG_TOOL_NAME,
  FLAG_TOOL_SCHEMA,
  KIND_LABEL,
  RESOLVE_TOOL_DESCRIPTION,
  RESOLVE_TOOL_NAME,
  RESOLVE_TOOL_SCHEMA,
  addItem,
  closeItem,
  emptyInbox,
  findProjectRoot,
  flagResultText,
  inboxDir,
  inboxPath,
  modelSummary,
  openDigest,
  openItems,
  parseInbox,
  parseNumbers,
  reopenItem,
  resolveResultText,
  serializeInbox,
} from '../core/inbox'
import type { AddResult, CloseResult, Inbox, Item } from '../core/inbox'

const PANE = 'agent-inbox'
const SOURCE = 'claude-code'
const POLL_MS = 3000
const FLAG_TOOL = 'mcp__agent-inbox__flag_for_user'
const RESOLVE_TOOL = 'mcp__agent-inbox__resolve_user_item'

const inboxAtom = atom({ plugin: 'agent-inbox', key: 'inbox' } as const, null)
const compactAtom = atom({ plugin: 'agent-inbox', key: 'isCompact' } as const, false)
const messageAtom = atom({ plugin: 'agent-inbox', key: 'message' } as const, '')

type $ = EngineInterface

// Module state: a reload starts a fresh environment, so this only caches.
const mem: {
  path: string | undefined
  project: string
  lastMtime: number
  lastContextDigest: string | undefined
} = { path: undefined, project: '', lastMtime: -1, lastContextDigest: undefined }

// ------------------------------------------------------------------ file I/O

async function resolvePath($: $): Promise<string> {
  if (mem.path) return mem.path
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const override = await $.env.get('AGENT_INBOX_DIR')
  mem.project = await findProjectRoot(await $.session.root(), p => $.fs.exists(p))
  mem.path = inboxPath(inboxDir(home, override), mem.project)
  return mem.path
}

async function readInbox($: $): Promise<Inbox> {
  const file = await resolvePath($)
  if (!(await $.fs.exists(file))) {
    mem.lastMtime = 0
    return emptyInbox(mem.project)
  }
  const text = await $.fs.read(file)
  mem.lastMtime = (await $.fs.stat(file)).mtimeMs
  return parseInbox(typeof text === 'string' ? text : '', mem.project)
}

async function load($: $): Promise<Inbox> {
  const inbox = await readInbox($)
  await update($, inboxAtom, () => inbox as InboxState)
  return inbox
}

/** Re-read the file, apply `change`, write it back if it changed, publish. */
async function mutate<R extends { inbox: Inbox; ok: boolean }>(
  $: $,
  change: (inbox: Inbox, now: string) => R,
): Promise<R> {
  const current = await readInbox($)
  const now = new Date(await $.clock.now()).toISOString()
  const result = change(current, now)
  if (result.ok && result.inbox !== current) {
    const file = await resolvePath($)
    await $.fs.write(file, serializeInbox(result.inbox))
    mem.lastMtime = (await $.fs.stat(file)).mtimeMs
  }
  await update($, inboxAtom, () => result.inbox as InboxState)
  return result
}

async function flag($: $, input: Record<string, unknown>, source: string): Promise<AddResult> {
  const id = crypto.randomUUID()
  return mutate($, (inbox, now) =>
    addItem(
      inbox,
      {
        title: String(input.title ?? ''),
        detail: typeof input.detail === 'string' ? input.detail : undefined,
        kind: typeof input.kind === 'string' ? input.kind : undefined,
        blocking: input.blocking === true,
      },
      { now, source, id },
    ),
  )
}

async function close(
  $: $,
  n: number,
  status: 'done' | 'dropped',
  by: string,
  note?: string,
): Promise<CloseResult> {
  return mutate($, (inbox, now) => closeItem(inbox, n, status, { now, by, note }))
}

async function reopen($: $, n: number): Promise<CloseResult> {
  return mutate($, inbox => reopenItem(inbox, n))
}

async function say($: $, text: string): Promise<void> {
  await update($, messageAtom, () => text)
}

async function openPane($: $): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Waiting on you', focus: true, closeOnEscape: true })
}

async function pollFile($: $): Promise<void> {
  const file = await resolvePath($)
  const mtime = (await $.fs.exists(file)) ? (await $.fs.stat(file)).mtimeMs : 0
  const shown = await read($, inboxAtom)
  if (mtime !== mem.lastMtime || shown === null) await load($)
}

/** `/done 3 4`, `/inbox drop 2`, `/inbox add ...`, `/inbox reopen 5`. */
async function runVerb($: $, verb: string, rest: string): Promise<string> {
  if (verb === 'add') {
    const r = await flag($, { title: rest }, 'you')
    return r.ok ? `Added #${r.item.n}.` : `Not added: ${r.error}.`
  }
  const ns = parseNumbers(rest)
  if (ns.length === 0) {
    return verb === 'done' ? 'Usage: /done N [N…]' : `Usage: /inbox ${verb} N [N…]`
  }
  const lines: string[] = []
  for (const n of ns) {
    if (verb === 'reopen') {
      const r = await reopen($, n)
      lines.push(r.ok ? `#${n} reopened.` : resolveResultText(r))
    } else {
      lines.push(resolveResultText(await close($, n, verb === 'drop' ? 'dropped' : 'done', 'you')))
    }
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------ hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: FLAG_TOOL_NAME,
      description: FLAG_TOOL_DESCRIPTION,
      inputSchema: FLAG_TOOL_SCHEMA as unknown as Record<string, unknown>,
      isDeferred: false,
    })
    await $.tool.register({
      name: RESOLVE_TOOL_NAME,
      description: RESOLVE_TOOL_DESCRIPTION,
      inputSchema: RESOLVE_TOOL_SCHEMA as unknown as Record<string, unknown>,
      isDeferred: false,
    })
    await $.command.register({
      name: 'inbox',
      description: 'What agents are waiting on you for (pane, or add/done/drop/reopen N)',
      argumentHint: '[add <text> | done N | drop N | reopen N]',
      immediate: true,
    })
    await $.command.register({
      name: 'done',
      description: 'Mark inbox items done: /done 3 or /done 3 4',
      argumentHint: 'N [N…]',
      immediate: true,
    })
    await load($)

    // Another agent (pi, a second Claude session) may change the file.
    $.clock.every(POLL_MS, () => {
      void pollFile($).catch(() => undefined)
    })

    return next(e)
  })

  // /clear, /resume and /branch reset $.state: put the inbox back.
  on('classic.SessionStart', async ($, e, next) => {
    mem.lastContextDigest = undefined
    await load($)
    return next(e)
  })

  // -------------------------------------------------------------- tools

  on('tool.call', { tool: FLAG_TOOL }, async ($, e) => {
    const r = await flag($, e as unknown as Record<string, unknown>, SOURCE)
    if (r.ok && !r.isDuplicate) {
      $.ui.toast(`Waiting on you: #${r.item.n} ${r.item.title}`)
      mem.lastContextDigest = openDigest(r.inbox)
    }
    return { result: flagResultText(r, openItems(r.inbox).length) }
  })

  on('tool.call', { tool: RESOLVE_TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const status = input.status === 'dropped' ? 'dropped' : 'done'
    const note = typeof input.note === 'string' ? input.note : undefined
    const r = await close($, Number(input.n), status, SOURCE, note)
    if (r.ok) mem.lastContextDigest = openDigest(r.inbox)
    return { result: resolveResultText(r) }
  })

  // -------------------------------------------------------------- context

  // Tell Claude what is open, only when that changed since it last heard.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const inbox = await load($)
    const digest = openDigest(inbox)
    const isFirst = mem.lastContextDigest === undefined
    if (digest === mem.lastContextDigest || (isFirst && digest === '')) return next(e)
    mem.lastContextDigest = digest
    return next({ ...e, context: [...(e.context ?? []), modelSummary(inbox)] })
  })

  // -------------------------------------------------------------- commands

  on('command.run', { command: 'inbox' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) {
      await load($)
      await openPane($)
      return { text: 'Inbox opened.' }
    }
    const [verb = '', ...rest] = args.split(/\s+/)
    if (verb === 'add' || verb === 'done' || verb === 'drop' || verb === 'reopen') {
      return { text: await runVerb($, verb, rest.join(' ')) }
    }
    if (/^#?\d/.test(verb)) return { text: await runVerb($, 'done', args) }
    return { text: 'Usage: /inbox [add <text> | done N | drop N | reopen N]' }
  })

  on('command.run', { command: 'done' }, async ($, e) => ({
    text: await runVerb($, 'done', e.args),
  }))

  // -------------------------------------------------------------- band

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const inbox = (await read($, inboxAtom)) as Inbox | null
    const open = inbox ? openItems(inbox) : []
    if (open.length === 0) return next(e)

    const isCompact = await read($, compactAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    const blocking = open.filter(i => i.blocking).length
    const room = Math.max(1, Math.min(isCompact ? 1 : 3, e.props.maxRows - 1))
    const width = Math.max(20, e.props.bodyColumns - 6)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="warning" bold>
            ⚑ {open.length} waiting on you
          </Text>
          {blocking > 0 && <Text color="error"> · {blocking} blocking</Text>}
          <Text dimColor> · /done N · </Text>
          <Button key="inbox-open" plain label="open" onPress={() => void openPane($)} />
          <Text dimColor> · </Text>
          <Button
            key="inbox-compact"
            plain
            label={isCompact ? 'more' : 'less'}
            onPress={() => void update($, compactAtom, v => !v)}
          />
        </Box>
        {open.slice(0, room).map(item => (
          <Box key={`row-${item.id}`} flexDirection="row">
            <Button
              key={`done-${item.id}`}
              plain
              label="✓"
              onPress={() => void close($, item.n, 'done', 'you')}
            />
            <Text wrap="truncate-end" color={item.blocking ? 'error' : undefined}>
              {' '}
              {clip(`#${item.n} ${item.title}`, width)}
            </Text>
          </Box>
        ))}
        {open.length > room && <Text dimColor>  +{open.length - room} more</Text>}
      </Box>
    )
  })

  // -------------------------------------------------------------- pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const inbox = ((await read($, inboxAtom)) as Inbox | null) ?? emptyInbox(mem.project)
    const message = await read($, messageAtom)
    const open = openItems(inbox)
    const closed = inbox.items
      .filter(i => i.status !== 'open')
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .slice(0, 5)
    const { Box, Text, Button } = $.ui.resolve(e)

    const rows = (
      <Box flexDirection="column">
        <Text bold>
          {open.length === 0 ? 'Nothing waiting on you.' : `${open.length} waiting on you`}
        </Text>
        <Text dimColor wrap="truncate-middle">
          {mem.project}
        </Text>
        {open.map(item => (
          <Box key={`item-${item.id}`} flexDirection="column" marginTop={1}>
            <Text color={item.blocking ? 'error' : undefined} bold>
              #{item.n} {item.blocking ? '⚠ ' : ''}[{KIND_LABEL[item.kind]}] {item.title}
            </Text>
            {item.detail !== undefined && <Text dimColor>{item.detail}</Text>}
            <Box flexDirection="row">
              <Text dimColor>
                from {item.source} · {ago(item.createdAt)}{'  '}
              </Text>
              <Button
                key={`pane-done-${item.id}`}
                label="Done"
                variant="primary"
                onPress={() =>
                  void close($, item.n, 'done', 'you').then(r => say($, resolveResultText(r)))
                }
              />
              <Text> </Text>
              <Button
                key={`pane-drop-${item.id}`}
                label="Drop"
                onPress={() =>
                  void close($, item.n, 'dropped', 'you').then(r => say($, resolveResultText(r)))
                }
              />
            </Box>
          </Box>
        ))}
      </Box>
    )

    const history =
      closed.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Recently closed</Text>
          {closed.map(item => (
            <Box key={`closed-${item.id}`} flexDirection="row">
              <Text dimColor strikethrough={item.status === 'done'}>
                #{item.n} {item.title}
              </Text>
              <Text dimColor>
                {' '}
                ({item.status} by {item.closedBy ?? '?'}){' '}
              </Text>
              <Button
                key={`pane-reopen-${item.id}`}
                plain
                dimColor
                label="reopen"
                onPress={() =>
                  void reopen($, item.n).then(r =>
                    say($, r.ok ? `#${item.n} reopened.` : resolveResultText(r)),
                  )
                }
              />
            </Box>
          ))}
        </Box>
      )

    const footer = message === '' ? null : <Text color="success">{message}</Text>

    if (e.surface === 'mobile') {
      return (
        <Box flexDirection="column">
          {rows}
          {history}
          {footer}
        </Box>
      )
    }

    const { Input } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rows}
        <Box marginTop={1}>
          <Input
            key="pane-add"
            label="Add"
            placeholder="Something you need to do here"
            submitLabel="add"
            value=""
            onSubmit={value =>
              void flag($, { title: value }, 'you').then(r =>
                say($, r.ok ? `Added #${r.item.n}.` : `Not added: ${r.error}.`),
              )
            }
          />
        </Box>
        {history}
        {footer}
      </Box>
    )
  })
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 60000) return 'just now'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
