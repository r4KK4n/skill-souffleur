import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../src/core/config.ts'
import { applyChoice, candidates, options, parsePicks, SETUP_INTRO } from '../src/core/setup.ts'

const config = (user: unknown, project?: unknown) => parseConfig(JSON.stringify(user), project === undefined ? undefined : JSON.stringify(project)).config
const doc = (c: unknown) => c as { mode?: string; skills: Record<string, Record<string, unknown>>; needs: Record<string, string> }

test('options for a plain skill end with Stop', () => {
  const o = options('writing-guide', undefined, 'need')
  assert.equal(o.length, 4)
  assert.equal(o.at(-1), 'Stop')
  assert.ok(!o.includes('Injected by its plugin'))
})

test('options for a plugin skill offer Injected', () => {
  const o = options('terse:terse-mode', undefined, 'start')
  assert.ok(o.includes('Injected by its plugin'))
  assert.ok(!o.includes('Stop'))
  assert.ok(o.length <= 4)
})

test('current choice is listed first, else the recommended one', () => {
  assert.equal(options('writing-guide', 'need', 'start')[0], 'When the task needs it')
  assert.equal(options('writing-guide', undefined, 'start')[0], 'From the start')
  assert.equal(options('writing-guide', undefined, 'none')[0], "Don't watch")
  assert.equal(options('terse:terse-mode', 'injected', 'start')[0], 'Injected by its plugin')
})

test('applyChoice start writes always', () => {
  const r = applyChoice({ mode: 'enforce', trustProjects: ['/w'] }, 'writing-guide', 'start')
  assert.deepEqual(doc(r.config).skills['writing-guide'], { always: true })
  assert.equal(doc(r.config).mode, 'enforce')
  assert.deepEqual((r.config as { trustProjects: string[] }).trustProjects, ['/w'])
})

test('applyChoice on a missing file starts in observe mode', () => {
  assert.equal(doc(applyChoice(undefined, 'writing-guide', 'start').config).mode, 'observe')
})

test('applyChoice injected writes always and startup injected', () => {
  const r = applyChoice({}, 'terse:terse-mode', 'injected')
  assert.deepEqual(doc(r.config).skills['terse:terse-mode'], { always: true, startup: 'injected' })
})

test('applyChoice need reuses a shared key', () => {
  const start = { skills: { 'writing-check': { need: 'prose' } }, needs: { prose: 'Writing text people read.' } }
  const r = applyChoice(start, 'writing-guide', 'need', { key: 'prose', text: 'Writing text people read.' })
  assert.deepEqual(doc(r.config).skills['writing-guide'], { need: 'prose' })
  assert.deepEqual(doc(r.config).needs, { prose: 'Writing text people read.' })
})

test('other text on a shared need forks a new key', () => {
  const start = { skills: { 'writing-check': { need: 'prose' }, 'writing-guide': { need: 'prose' } }, needs: { prose: 'Writing text people read.' } }
  const r = applyChoice(start, 'writing-guide', 'need', { key: 'prose', text: 'Writing a README.' })
  const d = doc(r.config)
  assert.equal(d.skills['writing-check']!.need, 'prose')
  const key = d.skills['writing-guide']!.need as string
  assert.notEqual(key, 'prose')
  assert.match(key, /^[A-Za-z0-9:_-]{1,64}$/)
  assert.equal(d.needs[key], 'Writing a README.')
  assert.equal(d.needs.prose, 'Writing text people read.')
})

test('none removes entry and orphaned need', () => {
  const start = { skills: { 'writing-guide': { need: 'prose' }, 'ui-checklist': { need: 'ui' } }, needs: { prose: 'p', ui: 'u' } }
  const d = doc(applyChoice(start, 'writing-guide', 'none').config)
  assert.deepEqual(Object.keys(d.skills), ['ui-checklist'])
  assert.deepEqual(d.needs, { ui: 'u' })
})

test('none keeps an entry with a gate and says why', () => {
  const entry = { need: 'ui', gate: { tools: ['Write'] } }
  const start = { skills: { 'ui-checklist': entry }, needs: { ui: 'u' } }
  const r = applyChoice(start, 'ui-checklist', 'none')
  assert.deepEqual(r.config, start)
  assert.match(r.note ?? '', /gate or duty/)
})

test('change of kind keeps gate and duty', () => {
  const duty = { after: { tools: ['Write'] }, evidence: { tool: 'Bash' } }
  const start = { skills: { 'ui-checklist': { need: 'ui', gate: { tools: ['Write'] }, duty } }, needs: { ui: 'u' } }
  const d = doc(applyChoice(start, 'ui-checklist', 'start').config)
  assert.deepEqual(d.skills['ui-checklist'], { always: true, gate: { tools: ['Write'] }, duty })
  assert.deepEqual(d.needs, {})
})

test('applyChoice does not change its input', () => {
  const start = { skills: { 'writing-guide': { need: 'prose' } }, needs: { prose: 'p' } }
  const frozen = structuredClone(start)
  applyChoice(start, 'writing-guide', 'none')
  assert.deepEqual(start, frozen)
})

test('candidates order: user, hook, model; project-only is listed, not asked', () => {
  const c = config({ skills: { 'writing-guide': { always: true } } }, { skills: { 'ui-checklist': { always: true } } })
  const got = candidates(c, ['writing-guide', 'ui-checklist', 'writing-check', 'bigtest', 'other-one'], ['writing-check'], ['bigtest', 'not-installed'])
  assert.deepEqual(got, [
    { skill: 'writing-guide', source: 'user' },
    { skill: 'writing-check', source: 'hook' },
    { skill: 'bigtest', source: 'model' },
    { skill: 'ui-checklist', source: 'project' },
  ])
})

test('project-only skill is listed, not asked', () => {
  const c = config({ skills: {} }, { skills: { 'ui-checklist': { always: true } } })
  const got = candidates(c, ['ui-checklist'], [], [])
  assert.deepEqual(got, [{ skill: 'ui-checklist', source: 'project' }])
})

test('parsePicks keeps installed names, reuses existing need keys, caps at 10', () => {
  const installed = ['writing-guide', 'writing-check', 'ui-checklist']
  const raw = 'Sure:\n```json\n' + JSON.stringify({
    skills: [
      { name: 'writing-guide', need: 'prose', needText: 'ignored, prose exists' },
      { name: 'ui-checklist', need: 'ui', needText: 'Building a screen.' },
      { name: 'ghost', need: 'x', needText: 'y' },
      { name: 'writing-check', need: 'bad key!' },
      'junk',
    ],
  }) + '\n```'
  const got = parsePicks(raw, installed, { prose: 'Writing text people read.' })
  assert.deepEqual(got, [
    { skill: 'writing-guide', need: { key: 'prose', text: 'Writing text people read.' } },
    { skill: 'ui-checklist', need: { key: 'ui', text: 'Building a screen.' } },
  ])
  assert.deepEqual(parsePicks('no json', installed, {}), [])
  const many = Array.from({ length: 14 }, (_, i) => `skill-number-${i}`)
  assert.equal(parsePicks(JSON.stringify(many.map((name) => ({ name, need: 'k', needText: 't' }))), many, {}).length, 10)
})

test('SETUP_INTRO names the four answers and points to migrate', () => {
  for (const w of ['From the start', 'Injected by its plugin', 'When the task needs it', "Don't watch", '/souffleur migrate']) assert.ok(SETUP_INTRO.includes(w), w)
  assert.doesNotMatch(SETUP_INTRO, /[–—]/)
})
