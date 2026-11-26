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
  needs: { prose: { for: 'readers', what: 'Writing text people read.' } },
  trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true,
  skills: {
    'terse:terse-mode': { always: true, from: 'user' },
    'writing-guide': { need: 'prose', from: 'user' },
    'writing-check': { need: 'prose', from: 'user' },
  },
}
const fresh = (c: Config = config): Session => ({ ...initSession(c, 's1', T, 'clear'), needs: { prose: { since: T, reason: 'test' } } })
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
  assert.deepEqual(r.lines, ['Souffleur: cut by compaction: writing-guide, writing-check; will ask the model to reload them.'])
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
  assert.deepEqual(r2.lines, ['Souffleur: cut by compaction: writing-guide, writing-check; will ask the model to reload them.'])
  const both = withLedger(r2.session, skillLoaded(skillLoaded(r2.session.ledger, 'writing-guide', T + 3, 'x'), 'writing-check', T + 3, 'x'))
  const r3 = notices(config, r2.session, both)
  assert.deepEqual(r3.lines, ['Souffleur: reloaded: writing-guide, writing-check.'])
  assert.deepEqual(notices(config, r3.session, r3.session).lines, [])
})

test('absent after loaded is no compaction cut', () => {
  const before = loadedBoth()
  const after = withLedger(before, { ...before.ledger, 'writing-guide': { state: 'absent', since: T, reason: '', requests: 0 } })
  assert.deepEqual(notices(config, before, after).lines, [])
})

test('a cut skill that became unavailable does not block reloaded', () => {
  const before = loadedBoth()
  const r1 = notices(config, before, cutOf(before))
  const l = r1.session.ledger
  const next = withLedger(r1.session, {
    ...l,
    'writing-guide': { state: 'unavailable', since: T + 2, reason: '', requests: 2 },
    'writing-check': { ...l['writing-check']!, state: 'loaded' },
  })
  const r2 = notices(config, r1.session, next)
  assert.ok(r2.lines.includes('Souffleur: reloaded: writing-check.'))
  assert.deepEqual(r2.session.noticed?.cut, [])
})

test('a cut again while another is pending names the whole union once', () => {
  const before = loadedBoth()
  const r1 = notices(config, before, cutOf(before))
  const aBack = withLedger(r1.session, skillLoaded(r1.session.ledger, 'writing-guide', T + 2, 'x'))
  const r2 = notices(config, r1.session, aBack)
  assert.deepEqual(r2.lines, [])
  const r3 = notices(config, r2.session, cutOf(r2.session))
  assert.deepEqual(r3.lines, ['Souffleur: cut by compaction: writing-guide, writing-check; will ask the model to reload them.'])
})

test('degraded line drops one trailing period of the error', () => {
  const s: Session = { ...fresh(), errors: ['tool_name missing.'] }
  assert.equal(problemKeys(config, s).get('degraded:tool_name missing.'), 'Souffleur: degraded: tool_name missing. Details: /souffleur.')
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
  assert.deepEqual([...m.keys()], ['degraded:a', 'degraded:tool_name missing', 'version', 'untrusted'])
  assert.equal(m.get('degraded:tool_name missing'), 'Souffleur: degraded: tool_name missing. Details: /souffleur.')
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
  assert.deepEqual(r.session.noticed, { cut: ['writing-guide', 'writing-check'], problems: ['degraded:boom'], told: ['degraded:boom'] })
})

test('a loaded skill that is not needed is not named in the cut line and does not stick', () => {
  const s = { ...fresh(), needs: {} }
  const before = withLedger(s, skillLoaded(skillLoaded(s.ledger, 'terse:terse-mode', T, 'x'), 'writing-guide', T, 'x'))
  const r1 = notices(config, before, cutOf(before))
  assert.deepEqual(r1.lines, ['Souffleur: cut by compaction: terse:terse-mode; will ask the model to reload them.'])
  assert.deepEqual(r1.session.noticed?.cut, ['terse:terse-mode'])
  const back = withLedger(r1.session, skillLoaded(r1.session.ledger, 'terse:terse-mode', T + 2, 'x'))
  assert.deepEqual(notices(config, r1.session, back).lines, ['Souffleur: reloaded: terse:terse-mode.'])
})

test('a name whose need ended leaves the stored cut', () => {
  const before = loadedBoth()
  const r1 = notices(config, before, cutOf(before))
  const gone = { ...r1.session, needs: {} }
  const loadedAlways = withLedger(gone, skillLoaded(gone.ledger, 'terse:terse-mode', T + 2, 'x'))
  const r2 = notices(config, r1.session, loadedAlways)
  assert.deepEqual(r2.session.noticed?.cut, [])
})

test('a paused session has no cut line', () => {
  const before = { ...loadedBoth(), paused: true }
  const r = notices(config, before, cutOf(before))
  assert.deepEqual(r.lines, [])
  assert.deepEqual(r.session.noticed?.cut, [])
})

test('an untrusted project skill is not named in the cut line', () => {
  const c: Config = { ...config, skills: { ...config.skills, 'writing-guide': { need: 'prose', from: 'project' } } }
  const before = loadedBoth()
  assert.equal(notices(c, before, cutOf(before), '/not/trusted').lines[0], 'Souffleur: cut by compaction: writing-check; will ask the model to reload them.')
})

test('degraded line uses the first line, ASCII only, at most 120 characters', () => {
  const err = `read failed: caf\u00e9 ${'x'.repeat(200)}\nsecond line /home/bob/secret`
  const line = problemKeys(config, { ...fresh(), errors: [err] }).get('degraded:read failed')!
  assert.ok(!line.includes('second line'))
  assert.match(line, /^[\x20-\x7e]+$/)
  assert.match(line, /^Souffleur: degraded: read failed: caf\? x+\.\.\. Details: \/souffleur\.$/)
  assert.ok(line.length <= 'Souffleur: degraded: '.length + 120 + ' Details: /souffleur.'.length)
})

test('a skill excluded in this root is not counted as cut', () => {
  const c: Config = { ...config, skills: { ...config.skills, 'writing-guide': { need: 'prose', from: 'user', notIn: ['/work/p'] } } }
  const s = { ...initSession(c, 's1', T, 'clear'), needs: { prose: { since: T, reason: 'test' } } }
  const before = withLedger(s, skillLoaded(skillLoaded(s.ledger, 'writing-guide', T, 'x'), 'writing-check', T, 'x'))
  assert.deepEqual(notices(c, before, cutOf(before), '/work/p').lines, ['Souffleur: cut by compaction: writing-check; will ask the model to reload them.'])
})

const withErrors = (s: Session, errors: string[]): Session => ({ ...s, errors })

test('a step that fails, clears and fails again 10 times gives one degraded line and one back to normal', () => {
  let s = fresh()
  const lines: string[] = []
  for (let i = 0; i < 10; i++) {
    for (const errors of [['tool.call: boom'], []]) {
      const r = notices(config, s, withErrors(s, errors))
      lines.push(...r.lines)
      s = r.session
    }
  }
  assert.equal(lines.filter((l) => /degraded/.test(l)).length, 1, lines.join('\n'))
  assert.equal(lines.filter((l) => /back to normal/.test(l)).length, 1, lines.join('\n'))
})

test('two failing steps each get a line, and a line names only an error that holds', () => {
  const s0 = fresh()
  const r1 = notices(config, s0, withErrors(s0, ['tool.call: first', 'classifier: second']))
  assert.deepEqual(r1.lines, ['Souffleur: degraded: tool.call: first. Details: /souffleur.', 'Souffleur: degraded: classifier: second. Details: /souffleur.'])
  const r2 = notices(config, r1.session, withErrors(r1.session, ['classifier: second']))
  assert.deepEqual(r2.lines, [], 'tool.call cleared, classifier is still the same problem')
  assert.deepEqual(r2.session.noticed?.problems, ['degraded:classifier'])
  const r3 = notices(config, r2.session, withErrors(r2.session, []))
  assert.deepEqual(r3.lines, ['Souffleur: back to normal.'])
})

test('a step names its newest error', () => {
  const s = { ...fresh(), errors: ['tool.call: old', 'classifier: other', 'tool.call: new'] }
  assert.equal(problemKeys(config, s).get('degraded:tool.call'), 'Souffleur: degraded: tool.call: new. Details: /souffleur.')
})

test('back to normal waits for the last told problem', () => {
  const s0 = fresh()
  const r1 = notices(config, s0, withErrors(s0, ['a: x', 'b: y']))
  const r2 = notices(config, r1.session, withErrors(r1.session, ['b: y']))
  assert.deepEqual(r2.lines, [])
  assert.deepEqual(notices(config, r2.session, withErrors(r2.session, [])).lines, ['Souffleur: back to normal.'])
})

test('a session stored by 0.1.7 (no told list) loads', () => {
  const stored: Session = { ...fresh(), errors: ['tool.call: boom'], noticed: { cut: [], problems: ['degraded'] } }
  const r = notices(config, stored, stored)
  assert.deepEqual(r.session.noticed?.problems.includes('degraded:tool.call'), true)
})
