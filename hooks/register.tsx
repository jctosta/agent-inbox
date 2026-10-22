// agent-inbox for Claude Code: a persistent list of what agents are waiting
// on the human for. Claude adds to it with the flag_for_user tool; the human
// sees it in a band above the prompt and clears it with /done or the pane.
// The list lives in one JSON file per project, shared with the pi extension.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiOpenResult } from 'claude-code'

import type { FeedbackState, InboxState } from '../types'
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
  damagedFileError,
  emptyInbox,
  explainPrompt,
  findItem,
  findProjectRoot,
  flagResultText,
  inboxDir,
  inboxPath,
  inert,
  modelSummary,
  openDigest,
  openItems,
  parseInbox,
  parseNumbers,
  reopenItem,
  resolveResultText,
  serializeInbox,
} from '../core/inbox'
import type { AddResult, CloseResult, Inbox, Item, ItemKind } from '../core/inbox'

const PANE = 'agent-inbox'
const PANE_TITLE = 'Waiting on you'
/** Every open asks for a narrow dock: a side panel, not half the window. */
const PANE_OPEN = { id: PANE, title: PANE_TITLE, columns: 48 } as const
const SOURCE = 'claude-code'
const POLL_MS = 3000
const MESSAGE_MS = 5000
const CLOSED_SHOWN = 5

/** Theme keys, so a chip follows the person's light or dark theme. */
const KIND_COLOR: Record<ItemKind, string> = {
  action: 'planMode',
  decision: 'autoAccept',
  review: 'ide',
  secret: 'warning',
  info: 'subtle',
}
const FLAG_TOOL = 'mcp__agent-inbox__flag_for_user'
const RESOLVE_TOOL = 'mcp__agent-inbox__resolve_user_item'

const inboxAtom = atom({ plugin: 'agent-inbox', key: 'inbox' } as const, null)
const compactAtom = atom({ plugin: 'agent-inbox', key: 'isCompact' } as const, false)
const feedbackAtom = atom({ plugin: 'agent-inbox', key: 'feedback' } as const, null)
const closedShownAtom = atom({ plugin: 'agent-inbox', key: 'isClosedShown' } as const, false)

// Module state: a reload starts a fresh environment, so this only caches.
const mem: {
  path: string | undefined
  project: string
  lastMtime: number
  lastContextDigest: string | undefined
  /** Set while the file does not parse: then nothing writes over it. */
  damage: string | undefined
  /** The newest open item number the desktop pane was put up for. */
  newestShown: number
} = {
  path: undefined,
  project: '',
  lastMtime: -1,
  lastContextDigest: undefined,
  damage: undefined,
  newestShown: 0,
}

// ------------------------------------------------------------------ file I/O

async function resolvePath($: EngineInterface): Promise<string> {
  if (mem.path) return mem.path
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const override = await $.env.get('AGENT_INBOX_DIR')
  mem.project = await findProjectRoot(await $.session.root(), p => $.fs.exists(p))
  mem.path = inboxPath(inboxDir(home, override), mem.project)
  return mem.path
}

async function readInbox($: EngineInterface): Promise<Inbox> {
  const file = await resolvePath($)
  if (!(await $.fs.exists(file))) {
    mem.lastMtime = 0
    mem.damage = undefined
    return emptyInbox(mem.project)
  }
  const read = await $.fs.read(file)
  const text = typeof read === 'string' ? read : ''
  mem.lastMtime = (await $.fs.stat(file)).mtimeMs
  mem.damage = damagedFileError(text, file)
  return parseInbox(text, mem.project)
}

async function load($: EngineInterface): Promise<Inbox> {
  const inbox = await readInbox($)
  await update($, inboxAtom, () => inbox as InboxState)
  await showNewItems($, inbox)
  return inbox
}

/** Re-read the file, apply `change`, write it back if it changed, publish. */
// The directory reads each use of $ line by line: keep $ on the line that
// names the function it is passed to.
async function mutate<R extends { inbox: Inbox; ok: boolean }>($: EngineInterface, change: (inbox: Inbox, now: string) => R): Promise<R | { ok: false; inbox: Inbox; error: string }> {
  const current = await readInbox($)
  if (mem.damage) return { ok: false, inbox: current, error: mem.damage }
  const now = new Date(await $.clock.now()).toISOString()
  const result = change(current, now)
  if (result.ok && result.inbox !== current) {
    const file = await resolvePath($)
    await $.fs.write(file, serializeInbox(result.inbox))
    mem.lastMtime = (await $.fs.stat(file)).mtimeMs
  }
  await update($, inboxAtom, () => result.inbox as InboxState)
  await showNewItems($, result.inbox)
  return result
}

async function flag($: EngineInterface, input: Record<string, unknown>, source: string): Promise<AddResult> {
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

async function close($: EngineInterface, n: number, status: 'done' | 'dropped', by: string, note?: string): Promise<CloseResult> {
  return mutate($, (inbox, now) => closeItem(inbox, n, status, { now, by, note }))
}

async function reopen($: EngineInterface, n: number): Promise<CloseResult> {
  return mutate($, inbox => reopenItem(inbox, n))
}

/** A line of feedback at the top of the pane, gone after a few seconds. */
async function say($: EngineInterface, feedback: FeedbackState): Promise<void> {
  await update($, feedbackAtom, () => feedback)
  $.clock.after(MESSAGE_MS, () => {
    // $.state hands back copies, so the line is told apart by what it says.
    void update($, feedbackAtom, shown =>
      shown?.text === feedback.text && shown.undo === feedback.undo ? null : shown,
    )
  })
}

/** Done or Drop from the pane, said with an Undo that reopens the item. */
async function closeFromPane($: EngineInterface, n: number, status: 'done' | 'dropped'): Promise<void> {
  const r = await close($, n, status, 'you')
  await say($, { text: resolveResultText(r), isError: !r.ok, undo: r.ok ? n : undefined })
}

async function reopenFromPane($: EngineInterface, n: number): Promise<void> {
  const r = await reopen($, n)
  await say($, { text: r.ok ? `#${n} reopened.` : resolveResultText(r), isError: !r.ok })
}

async function openPane($: EngineInterface): Promise<UiOpenResult> {
  return $.ui.open({ ...PANE_OPEN, focus: true, closeOnEscape: true })
}

/** Blocking items first, then in the order they were flagged. */
function urgentFirst(a: Item, b: Item): number {
  return Number(b.blocking) - Number(a.blocking) || a.n - b.n
}

/**
 * `/inbox list`: the open items as markdown, for wherever the pane is out of
 * sight (a phone or browser over Remote Control). The model reads command
 * output too, so item text is quoted inert, as in its own note.
 */
function inboxMarkdown(inbox: Inbox): string {
  const open = openItems(inbox).sort(urgentFirst)
  const [first] = open
  if (first === undefined) return 'Nothing waiting on you.'
  const blocking = open.filter(i => i.blocking).length
  // Two trailing spaces break a line inside an item's paragraph.
  const items = open.map(i =>
    [
      `**#${i.n}${i.blocking ? ' ⚠' : ''} ${inert(i.title)}**`,
      `${KIND_LABEL[i.kind]} · from ${inert(i.source)} · ${ago(i.createdAt)}`,
      ...(i.detail ? [inert(i.detail.split('\n')[0] ?? '')] : []),
    ].join('  \n'),
  )
  return [
    `**${open.length} waiting on you**${blocking > 0 ? ` · ${blocking} blocking` : ''}`,
    ...items,
    `\`/done ${first.n}\` closes it · \`/inbox drop ${first.n}\` drops it · \`/explain ${first.n}\` asks for the steps`,
  ].join('\n\n')
}

/**
 * A desktop has no band that stays put the way the terminal's does, so there
 * the pane comes up by itself whenever an item arrives it has not shown yet.
 * The terminal keeps the band alone; a pane the person closed stays closed
 * until the next new item.
 */
async function showNewItems($: EngineInterface, inbox: Inbox): Promise<void> {
  const newest = Math.max(0, ...openItems(inbox).map(i => i.n))
  if (newest <= mem.newestShown) return
  mem.newestShown = newest
  if ((await $.session.surfaces()).includes('desktop')) await $.ui.open(PANE_OPEN)
}

/** `/explain 3`: a turn in which the agent spells out what #3 needs from the human. */
async function explain($: EngineInterface, args: string): Promise<string | undefined> {
  const [n] = parseNumbers(args)
  if (n === undefined) return 'Usage: /explain N'
  const item = findItem(await load($), n)
  if (!item) return `Not explained: no item #${n}.`
  // A command.run hook may not submit (the turn would wait on the hook), so
  // the prompt goes out on a timer of its own, once the command is done.
  $.clock.after(0, () => {
    void $.prompt.submit({ text: explainPrompt(item) }).catch((err: unknown) =>
      $.ui.toast(`Could not ask about #${n}: ${err instanceof Error ? err.message : String(err)}`),
    )
  })
  return undefined
}

async function pollFile($: EngineInterface): Promise<void> {
  const file = await resolvePath($)
  const mtime = (await $.fs.exists(file)) ? (await $.fs.stat(file)).mtimeMs : 0
  const shown = await read($, inboxAtom)
  if (mtime !== mem.lastMtime || shown === null) await load($)
}

/** `/done 3 4`, `/inbox drop 2`, `/inbox add ...`, `/inbox reopen 5`. */
async function runVerb($: EngineInterface, verb: string, rest: string): Promise<string> {
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
      description: 'What agents are waiting on you for (pane, or list/add/done/drop/reopen/explain N)',
      argumentHint: '[list | add <text> | done N | drop N | reopen N | explain N]',
      immediate: true,
    })
    await $.command.register({
      name: 'explain',
      description: 'Have the agent explain what an inbox item needs from you: /explain 3',
      argumentHint: 'N',
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

  // A desktop that joins after an item arrived gets the pane too.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    const inbox = (await read($, inboxAtom)) as Inbox | null
    if (e.surface === 'desktop' && inbox && openItems(inbox).length > 0) {
      await $.ui.open(PANE_OPEN)
    }
    return r
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
      const opened = await openPane($)
      if (!opened.isPlaced) {
        return { text: `The pane can't show here (${opened.reason}). Run \`/inbox list\` to see the items as text.` }
      }
      // Over Remote Control the pane opens on the CLI's terminal, out of the
      // sight of the phone, browser or desktop that asked.
      if (e.origin.kind === 'bridge') {
        return { text: "Inbox opened on the CLI's terminal. Run `/inbox list` to see the items here." }
      }
      return { text: 'Inbox opened.' }
    }
    const [verb = '', ...rest] = args.split(/\s+/)
    if (verb === 'list') return { text: inboxMarkdown(await load($)) }
    if (verb === 'explain') return { text: await explain($, rest.join(' ')) }
    if (verb === 'add' || verb === 'done' || verb === 'drop' || verb === 'reopen') {
      return { text: await runVerb($, verb, rest.join(' ')) }
    }
    if (/^#?\d/.test(verb)) return { text: await runVerb($, 'done', args) }
    return { text: 'Usage: /inbox [list | add <text> | done N | drop N | reopen N | explain N]' }
  })

  on('command.run', { command: 'explain' }, async ($, e) => ({ text: await explain($, e.args) }))

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
    const feedback = (await read($, feedbackAtom)) as FeedbackState | null
    const isClosedShown = await read($, closedShownAtom)
    const open = openItems(inbox).sort(urgentFirst)
    const closed = inbox.items
      .filter(i => i.status !== 'open')
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
    const blocking = open.filter(i => i.blocking).length
    const { Box, Text, Button } = $.ui.resolve(e)

    // Neither Text nor Box takes a corner radius, and a bordered Box is whole
    // rows tall, so a rounded chip is a small SVG wherever a surface has Svg.
    const chip = (item: Item) => {
      if (e.surface === 'terminal') {
        return (
          <Text size="caption" color={KIND_COLOR[item.kind]}>
            [{KIND_LABEL[item.kind]}]
          </Text>
        )
      }
      const { Svg } = $.ui.resolve(e)
      const pill = chipSvg(item.kind)
      return <Svg source={pill.source} alt={KIND_LABEL[item.kind]} width={pill.width} height={CHIP_HEIGHT} />
    }

    const header = (
      <Text size="footnote" dimColor wrap="truncate-middle">
        {basename(mem.project)}
        {open.length > 0 ? ` · ${open.length} open` : ''}
      </Text>
    )

    const said =
      feedback === null ? null : (
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="footnote" color={feedback.isError ? 'warning' : 'success'}>
              {feedback.isError ? '⚠' : '✓'} {feedback.text}
            </Text>
          </Box>
          {feedback.undo !== undefined && (
            <Button
              key="pane-undo"
              plain
              label="Undo"
              onPress={() => void reopenFromPane($, feedback.undo ?? 0)}
            />
          )}
        </Box>
      )

    const banner =
      blocking === 0 ? null : (
        // A round border in the banner's own color is what rounds its corners.
        <Box
          backgroundColor="diffRemovedDimmed"
          borderStyle="round"
          borderColor="diffRemovedDimmed"
          paddingX={1}
        >
          <Text color="error">
            ⚠ {blocking === 1 ? '1 item blocks an agent' : `${blocking} items block an agent`}
          </Text>
        </Box>
      )

    const cards = open.map(item => (
      <Box
        key={`item-${item.id}`}
        flexDirection="column"
        gap="xs"
        borderStyle="round"
        borderColor={item.blocking ? 'error' : 'subtle'}
        borderDimColor
        paddingX={1}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          {chip(item)}
          <Text size="caption" dimColor wrap="truncate-start">
            #{item.n} · from {item.source} · {ago(item.createdAt)}
          </Text>
        </Box>
        <Text weight="semibold">{item.title}</Text>
        {item.detail !== undefined && (
          <Text size="footnote" dimColor>
            {item.detail}
          </Text>
        )}
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Button
            key={`pane-done-${item.id}`}
            label="Done"
            variant="primary"
            onPress={() => void closeFromPane($, item.n, 'done')}
          />
          <Button
            key={`pane-explain-${item.id}`}
            label="Explain"
            variant="secondary"
            onPress={() => void explain($, String(item.n))}
          />
          <Box flexGrow={1} />
          <Button
            key={`pane-drop-${item.id}`}
            plain
            dimColor
            label="Drop"
            onPress={() => void closeFromPane($, item.n, 'dropped')}
          />
        </Box>
      </Box>
    ))

    const empty =
      open.length > 0 ? null : (
        <Box flexDirection="row" gap="sm">
          <Text size="heading" color="success">
            ✓
          </Text>
          <Box flexDirection="column" flexShrink={1}>
            <Text weight="semibold">Nothing waiting on you</Text>
            <Text size="footnote" dimColor>
              Agents add items here when they need something only you can do.
            </Text>
          </Box>
        </Box>
      )

    // The mobile app draws no text field yet.
    let add = null
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      add = (
        <Input
          key="pane-add"
          placeholder="Add a reminder"
          submitLabel="Add"
          value=""
          onSubmit={value =>
            void flag($, { title: value }, 'you').then(r =>
              say($, r.ok ? { text: `Added #${r.item.n}.`, isError: false } : { text: `Not added: ${r.error}.`, isError: true }),
            )
          }
        />
      )
    }

    const history =
      closed.length === 0 ? null : (
        <Box flexDirection="column" gap="xs">
          <Box flexDirection="row" gap="sm" alignItems="center">
            <Box flexGrow={1}>
              <Text size="footnote" dimColor={!isClosedShown} weight={isClosedShown ? 'semibold' : undefined}>
                {closed.length} closed
              </Text>
            </Box>
            <Button
              key="pane-closed-toggle"
              label={isClosedShown ? 'Hide' : 'Show'}
              variant="secondary"
              onPress={() => void update($, closedShownAtom, shown => !shown)}
            />
          </Box>
          {isClosedShown &&
            closed.slice(0, CLOSED_SHOWN).map(item => (
              <Box key={`closed-${item.id}`} flexDirection="row" gap="sm" alignItems="center">
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text size="footnote" dimColor wrap="truncate-end">
                    {item.status === 'done' ? '✓' : '✕'} #{item.n} {item.title}
                  </Text>
                </Box>
                <Button
                  key={`pane-reopen-${item.id}`}
                  label="Reopen"
                  variant="secondary"
                  onPress={() => void reopenFromPane($, item.n)}
                />
              </Box>
            ))}
          {isClosedShown && closed.length > CLOSED_SHOWN && (
            <Text size="caption" dimColor>
              Shows the last {CLOSED_SHOWN}
            </Text>
          )}
        </Box>
      )

    return (
      <Box flexDirection="column" gap="sm">
        {header}
        {said}
        {banner}
        {empty}
        {cards}
        {add}
        {history}
      </Box>
    )
  })
}

const CHIP_HEIGHT = 18

/** Light fill, dark text; and the reverse under a dark scheme. */
const CHIP_PALETTE: Record<ItemKind, { light: [string, string]; dark: [string, string] }> = {
  action: { light: ['#E1F5EE', '#085041'], dark: ['#085041', '#9FE1CB'] },
  decision: { light: ['#EEEDFE', '#3C3489'], dark: ['#3C3489', '#CECBF6'] },
  review: { light: ['#E6F1FB', '#0C447C'], dark: ['#0C447C', '#B5D4F4'] },
  secret: { light: ['#FAEEDA', '#633806'], dark: ['#633806', '#FAC775'] },
  info: { light: ['#F1EFE8', '#444441'], dark: ['#444441', '#D3D1C7'] },
}

/**
 * A rounded, tinted kind chip. An SVG drawn as an image cannot read the
 * theme's keys, so it carries both palettes and picks by color scheme.
 */
function chipSvg(kind: ItemKind): { source: string; width: number } {
  const label = KIND_LABEL[kind]
  // ponytail: width estimated from the label's length at 11px; fine for the five fixed labels.
  const width = Math.round(label.length * 6.6 + 14)
  const { light, dark } = CHIP_PALETTE[kind]
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CHIP_HEIGHT}" viewBox="0 0 ${width} ${CHIP_HEIGHT}">` +
    `<style>rect{fill:${light[0]}}text{fill:${light[1]}}` +
    `@media (prefers-color-scheme: dark){rect{fill:${dark[0]}}text{fill:${dark[1]}}}</style>` +
    `<rect width="${width}" height="${CHIP_HEIGHT}" rx="5"/>` +
    `<text x="${width / 2}" y="12.5" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="11" font-weight="500">${label}</text>` +
    `</svg>`
  return { source, width }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
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
