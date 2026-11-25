import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { decide, initSession } from '../core/decide.ts'
import { parseConfig } from '../core/config.ts'

const HOME = '/users/test'
const USER_FILE = `${HOME}/.claude/souffleur.json`
const PROJECT_FILE = '/work/proj/.claude/souffleur.json'

type World = { statuses: (string | undefined)[]; setId: (id: string) => void; seen: { prompts: { text: string; context?: readonly string[] }[] } }

/** Answers every call the mod makes on `$`; files maps an absolute path to its text, a missing path throws. */
function world(on: On, files: Record<string, string>, opts: { classify?: string; stored?: Record<string, unknown>; skipCompact?: boolean } = {}): World {
  let id = 's1'
  const statuses: (string | undefined)[] = []
  const seen: World['seen'] = { prompts: [] }
  mock.store(on, opts.stored)
  mock.clock(on)
  mock.session(on)
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: '/work/proj' }))
  on('session.repo', () => ({ value: null }))
  on('session.version', () => ({ value: { version: '2.1.332' } }))
  on('env.get', () => ({ value: HOME }))
  on('fs.exists', (_, e) => ({ value: files[e.path] !== undefined }))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('model.classify', () => ({ value: opts.classify ?? 'no-match' }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'souffleur' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    seen.prompts.push({ text: e.text, ...(e.context ? { context: e.context } : {}) })
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('tool.call', () => ({ result: {} }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('session.compact', () => (opts.skipCompact ? { skip: 'vetoed' } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  on('command.run', () => ({}))
  return { statuses, setId: (next) => { id = next }, seen }
}

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never
const start = ($: any) => $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
const skillLoaded = ($: any, skill: string) => $.skill.prompt({ skill, text: 'x', len: 1, head: 'x', tail: 'x' })
const table = async ($: any) => (await $.command.run({ command: 'souffleur', args: '' })).text as string

const ALWAYS = JSON.stringify({ skills: { 'writing-guide': { always: true } } })
const UI = JSON.stringify({
  mode: 'enforce',
  skills: { 'ui-checklist': { need: 'ui', gate: { tools: ['Write'], paths: ['**/*.html'] } } },
  needs: { ui: 'Designing something a user sees.' },
})

test('prompt from composer gets a context block naming missing always skills', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  const r = await $.prompt.submit({ text: 'hello' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
  expect(w.seen.prompts.length).toBe(1)
})

test('prompt with e.command set is passed through unchanged', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  const r = await $.prompt.submit({ text: '/compact', command: { name: 'compact', args: '' } } as never)
  expect(r.context).toBe(undefined)
  expect(r.text).toBe('/compact')
})

test('Write to x.html is denied while ui-checklist is needed and not loaded', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  const r = await $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)
  expect(r.deny).toMatch(/ui-checklist/)
  await skillLoaded($, 'ui-checklist')
  const again = await $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)
  expect(again.deny).toBe(undefined)
})

test('observe mode: Write to x.html passes although ui-checklist is missing', async ($, on) => {
  world(on, { [USER_FILE]: UI.replace('enforce', 'observe') }, { classify: 'match' })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  const r = await $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)
  expect(r.deny).toBe(undefined)
  expect(await table($)).toMatch(/Would have denied/)
})

test('missing config file: no deny, status degraded only if a file was invalid', async ($, on) => {
  const w = world(on, {})
  await start($)
  const r = await $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)
  expect(r.deny).toBe(undefined)
  expect(w.statuses.some((s) => s?.includes('degraded'))).toBe(false)
})

test('invalid project JSON: status line says degraded', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [PROJECT_FILE]: '{ not json' })
  await start($)
  expect(w.statuses.at(-1)).toBe('souffleur: degraded, see /souffleur')
})

test('a hook error passes the event through and shows degraded', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  let fail = false
  let held: unknown
  on('state.get', () => {
    if (fail) {
      fail = false
      return { value: { value: { id: 's1' }, version: 0 } } // a session the core cannot read
    }
    return { value: { value: held, version: 0 } }
  })
  on('state.set', (_, e) => {
    held = e.value
    return { value: { isSet: true, version: 1 } }
  })
  await start($)
  fail = true
  const r = await $.prompt.submit({ text: 'hello there' })
  expect(r.text).toBe('hello there')
  expect(w.statuses.at(-1)).toBe('souffleur: degraded, see /souffleur')
})

test('/souffleur prints the ledger table', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  const text = await table($)
  expect(text).toMatch(/\| Skill \| State \| Since \| Reason \|/)
  expect(text).toMatch(/writing-guide/)
  expect(text).toMatch(/Claude Code 2\.1\.332/)
})

test('session restored from $.store when $.state is empty', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const first = decide(config, initSession(config, 's1', 1, 'startup', '2.1.331'), { type: 'skill', now: 2, skill: 'writing-guide' }).session
  world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s1': first } })
  await start($)
  expect(await table($)).toMatch(/writing-guide \| loaded/)
  const r = await $.prompt.submit({ text: 'carry on' })
  expect(r.context).toBe(undefined)
})

test('compaction marks the skill stale and the next prompt asks for it again', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  await $.session.compact({ trigger: 'manual' })
  const r = await $.prompt.submit({ text: 'after compact' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
})

test('a skipped compaction leaves the ledger alone', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS }, { skipCompact: true })
  await start($)
  await skillLoaded($, 'writing-guide')
  await $.session.compact({ trigger: 'manual' })
  const r = await $.prompt.submit({ text: 'after skip' })
  expect(r.context).toBe(undefined)
})

test('skill loaded by a subagent does not mark the main ledger', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  on('tool.call', { tool: 'Agent' }, async () => {
    await $.tool.call({ tool: 'Skill', skill: 'writing-guide', agentId: 'a1' } as never)
    await skillLoaded($, 'writing-guide')
    return { result: {} }
  })
  await start($)
  await $.tool.call({ tool: 'Agent', prompt: 'skills: writing-guide', description: 'd', subagent_type: 'general-purpose' } as never)
  expect(await table($)).toMatch(/writing-guide \| absent/)
})

test('new session id after clear starts a fresh ledger', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  expect(await table($)).toMatch(/writing-guide \| loaded/)
  await $.command.run({ command: 'clear', args: '' })
  w.setId('s2')
  expect(await table($)).toMatch(/writing-guide \| absent/)
  const r = await $.prompt.submit({ text: 'fresh' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
})

test('the system prompt section names the always-on skills and depends on config only', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  const section = r.sections.find((s: { id: string }) => s.id === 'souffleur')
  expect(section?.scope).toBe('session')
  expect(section?.text).toMatch(/invoke each one with the Skill tool/)
  expect(section?.text).toMatch(/Always-on skills: writing-guide\./)
})
