import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initSession } from '../src/core/decide.ts'
import type { Session } from '../src/core/decide.ts'
import { compacted, requested, skillLoaded } from '../src/core/ledger.ts'
import { notices, problemKeys, startNotice } from '../src/core/notices.ts'
import type { Config } from '../src/core/types.ts'

const T = Date.UTC(2026, 10, 26, 8, 0)
const config: Config = {
  mode: 'enforce',
  needs: { prose: 'Writing text people read.' },
  trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true,
  skills: {
    'terse:terse-mode': { always: true, from: 'user' },
    'writing-guide': { need: 'prose', from: 'user' },
    'writing-check': { need: 'prose', from: 'user' },
  },
}
const fresh = (c: Config = config): Session => initSession(c, 's1', T, 'clear')
const withLedger = (s: Session, ledger: Session['ledger']): Session => ({ ...s, ledger })
const loadedBoth = (): Session => {
  const s = fresh()
  return withLedger(s, skillLoaded(skillLoaded(s.ledger, 'writing-guide', T, 'x'), 'writing-check', T, 'x'))
}
const cutOf = (s: Session): Session => withLedger(s, compacted(s.ledger, T + 1))

test('start line set up', () => {
  assert.equal(startNotice(config, fresh(), true, '0.1.0'), 'Souffleur: 0.1.0 · enforce · 1 always-on, 2 on demand.')
  const s = { ...fresh(), proposals: [{}, {}] as unknown as Session['proposals'] }
  assert.equal(startNotice(config, s, true, '0.1.0'), 'Souffleur: 0.1.0 · enforce · 1 always-on, 2 on demand · 2 proposal(s) waiting.')
})

test('start line not set up', () => {
  assert.equal(startNotice(config, fresh(), false, '0.1.0'), 'Souffleur: 0.1.0 · not set up, run /souffleur init.')
})

test('cut after compaction', () => {
  const before = loadedBoth()
  const r = notices(config, before, cutOf(before))
  assert.deepEqual(r.lines, ['Souffleur: cut by compaction: writing-guide, writing-check; asked the model to reload them.'])
  assert.deepEqual(r.session.noticed?.cut, ['writing-guide', 'writing-check'])
})

test('nothing loaded → no cut line', () => {
  const before = fresh()
  assert.deepEqual(notices(config, before, cutOf(before)).lines, [])
})

test('second compaction unions', () => {
  const s = fresh()
  const first = withLedger(s, skillLoaded(s.ledger, 'writing-guide', T, 'x'))
  const r1 = notices(config, first, cutOf(first))
  const reloaded = withLedger(r1.session, skillLoaded(r1.session.ledger, 'writing-check', T + 2, 'x'))
  const r2 = notices(config, reloaded, cutOf(reloaded))
  assert.deepEqual(r2.lines, ['Souffleur: cut by compaction: writing-guide, writing-check; asked the model to reload them.'])
})

test('reloaded once all loaded', () => {
  const before = loadedBoth()
  const r1 = notices(config, before, cutOf(before))
  const part = withLedger(r1.session, skillLoaded(r1.session.ledger, 'writing-guide', T + 2, 'x'))
  assert.deepEqual(notices(config, r1.session, part).lines, [])
  const all = withLedger(part, skillLoaded(part.ledger, 'writing-check', T + 3, 'x'))
  const r3 = notices(config, part, all)
  assert.deepEqual(r3.lines, ['Souffleur: reloaded: writing-guide, writing-check.'])
  assert.deepEqual(r3.session.noticed?.cut, [])
})

test('problem once then back to normal', () => {
  let s = fresh()
  s = withLedger(s, requested(requested(requested(s.ledger, ['writing-guide'], T), ['writing-guide'], T), ['writing-guide'], T))
  assert.equal(s.ledger['writing-guide']?.state, 'unavailable')
  const r1 = notices(config, fresh(), s)
  assert.deepEqual(r1.lines, ['Souffleur: writing-guide did not load after two requests.'])
  const r2 = notices(config, r1.session, r1.session)
  assert.deepEqual(r2.lines, [])
  const ok = withLedger(r2.session, skillLoaded(r2.session.ledger, 'writing-guide', T + 5, 'x'))
  assert.deepEqual(notices(config, r2.session, ok).lines, ['Souffleur: back to normal.'])
})

test('problem keys: degraded, version, untrusted, not installed here', () => {
  const project: Config = { ...config, skills: { ...config.skills, 'p:skill': { need: 'prose', from: 'project' } } }
  const s: Session = { ...fresh(project), errors: ['a', 'tool_name missing'], version: '99.0.0' }
  s.ledger['p:skill'] = { state: 'not installed here', since: T, reason: '', requests: 0 }
  const m = problemKeys(project, s, '/work/x')
  assert.deepEqual([...m.keys()], ['degraded', 'version', 'untrusted'])
  assert.equal(m.get('degraded'), 'Souffleur: degraded: tool_name missing. Details: /souffleur.')
  assert.match(m.get('version')!, /^Souffleur: Running Claude Code 99\.0\.0;/)
  assert.equal(m.get('untrusted'), "Souffleur: this project's skill file is not trusted; its skills are listed only.")
})

test('repeat call with same sessions gives no lines', () => {
  const before = loadedBoth()
  const r1 = notices(config, before, { ...cutOf(before), errors: ['boom'] })
  assert.equal(r1.lines.length, 2)
  const r2 = notices(config, r1.session, r1.session)
  assert.deepEqual(r2.lines, [])
  assert.deepEqual(r2.session.noticed, r1.session.noticed)
})

test('notices false gives no lines', () => {
  const off = { ...config, notices: false }
  const before = loadedBoth()
  const r = notices(off, before, { ...cutOf(before), errors: ['boom'] })
  assert.deepEqual(r.lines, [])
  assert.deepEqual(r.session.noticed, { cut: ['writing-guide', 'writing-check'], problems: ['degraded'] })
})
