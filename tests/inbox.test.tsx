import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { projectSlug } from '../core/inbox'

const ROOT = '/home/carlos/Dev/healthforge'
const FLAG = 'mcp__agent-inbox__flag_for_user'
const RESOLVE = 'mcp__agent-inbox__resolve_user_item'

const BAND = {
  plugin: 'agent-inbox',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'agent-inbox',
  component: 'Pane',
  requestId: 'agent-inbox',
  props: {
    title: 'Waiting on you',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** The engine beneath the plugin: an in-memory disk and the session's calls. */
function world(on: On, files = new Map<string, string>(), root = ROOT) {
  let tick = 1
  const mtimes = new Map<string, number>()
  const write = (path: string, text: string) => {
    files.set(path, text)
    mtimes.set(path, ++tick)
  }
  for (const path of files.keys()) mtimes.set(path, ++tick)

  mock.env(on, { HOME: '/home/carlos' })
  const clock = mock.clock(on, { now: Date.parse('2026-10-21T21:00:00Z') })
  on('session.root', () => ({ value: root }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__agent-inbox__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    write(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: files.get(e.path)?.length ?? 0, mtimeMs: mtimes.get(e.path) ?? 0, isLink: false },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  // The engine's own drawing, for a site the plugin leaves.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { files, clock, write, toasts }
}

const start = ($: Engine) =>
  $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

// The kit fills in the fields the engine sets (origin, presentation, wait).
const cmd = ($: Engine, command: string, args: string) =>
  $.command.run({ command, args } as Parameters<Engine['command']['run']>[0])
const say = ($: Engine, text: string) =>
  $.prompt.submit({ text } as Parameters<Engine['prompt']['submit']>[0])

function onlyFile(files: Map<string, string>): { path: string; json: any } {
  const [entry] = [...files.entries()].filter(([p]) => p.endsWith('.json'))
  if (!entry) throw new Error('no inbox file written')
  return { path: entry[0], json: JSON.parse(entry[1]) }
}

test('flag_for_user writes the item to the per-project file and dedupes', async ($, on) => {
  const { files, toasts } = world(on)
  await start($)

  const first = await $.tool.call({ tool: FLAG, title: 'Add STRIPE_SECRET_KEY to .env.local', kind: 'secret', blocking: true })
  expect(first.result).toContain('#1')

  const again = await $.tool.call({ tool: FLAG, title: 'add stripe_secret_key to .env.local!' })
  expect(again.result).toContain('Already')
  expect(toasts).toEqual(['Waiting on you: #1 Add STRIPE_SECRET_KEY to .env.local'])

  const { path, json } = onlyFile(files)
  expect(path.startsWith('/home/carlos/.agent-inbox/healthforge-')).toBe(true)
  expect(json.items.length).toBe(1)
  expect(json.items[0].kind).toBe('secret')
  expect(json.items[0].blocking).toBe(true)
  expect(json.items[0].source).toBe('claude-code')
})

test('the band shows open items on every surface and its ✓ closes one', async ($, on) => {
  const { files } = world(on)
  await start($)
  await $.tool.call({ tool: FLAG, title: 'Approve the migration plan', kind: 'decision' })
  await $.tool.call({ tool: FLAG, title: 'Run make seed on your machine' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /2 waiting on you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#1 Approve the migration plan/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const { json } = onlyFile(files)
  await ui.press({ key: `done-${json.items[0].id}` })
  expect(await ui.find({ type: 'Text', text: /1 waiting on you/ })).toBeDefined()
  await ui.unmount()
  expect(onlyFile(files).json.items[0].status).toBe('done')
})

test('/done and /inbox verbs change the list; the band leaves when it is empty', async ($, on) => {
  const { files } = world(on)
  await start($)
  await $.tool.call({ tool: FLAG, title: 'Review PR 42' })
  await $.tool.call({ tool: FLAG, title: 'Call the accountant' })

  const done = await cmd($, 'done', '1 2')
  expect(done.text).toContain('#1 marked done')
  expect(done.text).toContain('#2 marked done')

  const reopened = await cmd($, 'inbox', 'reopen 2')
  expect(reopened.text).toContain('#2 reopened')
  const dropped = await cmd($, 'inbox', 'drop 2')
  expect(dropped.text).toContain('#2 marked dropped')
  const added = await cmd($, 'inbox', 'add Renew the domain')
  expect(added.text).toContain('#3')

  expect(onlyFile(files).json.items.map((i: any) => i.status)).toEqual(['done', 'dropped', 'open'])
  await cmd($, 'done', '3')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /waiting on you/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})

test('Claude hears about open items once per change, beside the prompt', async ($, on) => {
  world(on)
  await start($)

  const quiet = await say($, 'hello')
  expect(quiet.context ?? []).toEqual([])

  await cmd($, 'inbox', 'add Set up the Twilio account')
  const told = await say($, 'next')
  expect((told.context ?? []).join('\n')).toContain('#1 [action] Set up the Twilio account')

  const again = await say($, 'and again')
  expect(again.context ?? []).toEqual([])
})

test('resolve_user_item closes by number and refuses a closed one', async ($, on) => {
  const { files } = world(on)
  await start($)
  await $.tool.call({ tool: FLAG, title: 'Create the S3 bucket' })
  const ok = await $.tool.call({ tool: RESOLVE, n: 1, note: 'bucket exists now' })
  expect(ok.result).toBe('#1 marked done.')
  const twice = await $.tool.call({ tool: RESOLVE, n: 1 })
  expect(twice.result).toContain('already done')
  expect(onlyFile(files).json.items[0].note).toBe('bucket exists now')
})

test('a change another agent writes to the file shows up', async ($, on) => {
  const w = world(on)
  await start($)
  await $.tool.call({ tool: FLAG, title: 'Pick a name for the bucket' })
  const { path, json } = onlyFile(w.files)

  // pi adds an item to the same file.
  json.items.push({ ...json.items[0], id: 'from-pi', n: 2, title: 'Sign the DPA', source: 'pi' })
  json.nextN = 3
  w.write(path, JSON.stringify(json))
  await w.clock.advance(3500)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /2 waiting on you/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /from pi/ })).toBeDefined()
  await ui.press({ key: 'pane-done-from-pi' })
  expect(await ui.find({ type: 'Text', text: /#2 marked done/ })).toBeDefined()
  await ui.input({ key: 'pane-add', text: 'Book the dentist' })
  expect(await ui.find({ type: 'Text', text: /Added #3/ })).toBeDefined()
  await ui.unmount()
})

test('a session started below the git root shares the root\'s list', async ($, on) => {
  const { files } = world(on, new Map([[`${ROOT}/.git`, '']]), `${ROOT}/apps/web`)
  await start($)
  await $.tool.call({ tool: FLAG, title: 'Point the DNS at Vercel' })
  const inboxFiles = [...files.keys()].filter(p => p.endsWith('.json'))
  expect(inboxFiles.length).toBe(1)
  expect(inboxFiles[0]?.includes('/.agent-inbox/healthforge-')).toBe(true)
  expect(JSON.parse(files.get(inboxFiles[0] ?? '') ?? '{}').project).toBe(ROOT)
})

test('titles in other scripts are told apart when deduping', async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({ tool: FLAG, title: '设置密钥' })
  const second = await $.tool.call({ tool: FLAG, title: '审核代码' })
  expect(second.result).toContain('#2')
})

test('a damaged inbox file is left alone, not written over', async ($, on) => {
  const path = `/home/carlos/.agent-inbox/${projectSlug(ROOT)}.json`
  const damaged = '{"version":1,"nextN":4,"items":[{"n":1,"title":"Sign the DPA"'
  const { files } = world(on, new Map([[path, damaged]]))
  await start($)
  const r = await $.tool.call({ tool: FLAG, title: 'Renew the domain' })
  expect(r.result).toContain('not valid JSON')
  expect(files.get(path)).toBe(damaged)
})
