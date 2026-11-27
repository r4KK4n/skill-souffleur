import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, initSession } from '../src/core/decide.ts'
import { renderTable, statusLine } from '../src/core/status.ts'
import { problemKeys } from '../src/core/notices.ts'
import type { Action, CoreEvent, Session } from '../src/core/decide.ts'
import type { Config } from '../src/core/types.ts'
import { loadFixture, toCoreEvents } from './fixtures.ts'

const base: Config = {
  mode: 'enforce',
  needs: { prose: { for: 'readers', what: 'Writing text people read.' }, ui: { for: 'users', what: 'Building a screen.' } },
  trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify',
  skills: {
    'writing-guide': { need: 'prose', from: 'user' },
    'writing-check': { need: 'prose', from: 'user' },
    'ui-checklist': {
      need: 'ui',
      from: 'user',
      gate: { tools: ['Write', 'Edit'], paths: ['**/*.html'] },
      duty: {
        after: { tools: ['Write'], paths: ['**/*.html'] },
        evidence: { tool: 'Bash', command: '*ui-checklist*detect*' },
      },
    },
  },
}
const cfg = (patch: Partial<Config> = {}): Config => ({ ...base, ...patch })
const withAlways = cfg({ skills: { 'terse:terse-mode': { always: true, from: 'user' }, ...base.skills } })

let t = 0
const at = () => ++t
const prompt = (text = 'do it', matched: string[] = [], fromUser = true): CoreEvent => ({ type: 'prompt', now: at(), text, fromUser, matched })
const tool = (name: string, extra: Partial<Extract<CoreEvent, { type: 'tool' }>> = {}): CoreEvent => ({ type: 'tool', now: at(), tool: name, ...extra })
const loadSkill = (skill: string): CoreEvent => ({ type: 'skill', now: at(), skill })
const compact = (extra: Partial<Extract<CoreEvent, { type: 'compact' }>> = {}): CoreEvent => ({ type: 'compact', now: at(), phase: 'after', trigger: 'manual', ...extra })
const agentStart = (agentId = 'a1'): CoreEvent => ({ type: 'agentStart', now: at(), agentId })
const agentDone = (agentId = 'a1'): CoreEvent => ({ type: 'agentDone', now: at(), agentId })
const agentsEnded = (ids: string[], now = at()): CoreEvent => ({ type: 'agentsEnded', now, ids })
const command = (args: string): CoreEvent => ({ type: 'command', now: at(), args })

/** Feeds events in order; returns the final session and the actions of each event. */
function run(config: Config, events: CoreEvent[], start?: Session): { s: Session; out: Action[][] } {
  let s = start ?? initSession(config, 'session-1', 0, 'clear')
  const out: Action[][] = []
  for (const e of events) {
    const r = decide(config, s, e)
    s = r.session
    out.push(r.actions)
  }
  return { s, out }
}
const one = (config: Config, events: CoreEvent[], start?: Session) => run(config, events, start).out.at(-1)!
const ctx = (a: Action[]) => a.filter((x) => x.kind === 'context').map((x) => (x as { text: string }).text).join('\n')
const denies = (a: Action[]) => a.filter((x) => x.kind === 'deny')

/** A session with ui-checklist needed and loaded. */
const uiLoaded = (config = base) => run(config, [prompt('screen', ['ui']), loadSkill('ui-checklist')]).s

test('fresh session asks for always skills on first user prompt', () => {
  const a = one(withAlways, [prompt()])
  assert.match(ctx(a), /terse:terse-mode/)
  assert.doesNotMatch(ctx(a), /writing-guide/)
})

test('nothing missing gives no actions', () => {
  const { s } = run(withAlways, [prompt(), loadSkill('terse:terse-mode')])
  assert.deepEqual(one(withAlways, [prompt()], s), [])
})

test('prompt not from user gives no actions', () => {
  const { s, out } = run(base, [prompt('hand-back', ['prose'], false)])
  assert.deepEqual(out[0], [])
  assert.deepEqual(s.needs, {})
})

test('matched need adds its skills to the request', () => {
  const { s, out } = run(withAlways, [prompt('write the docs and a guide for people who read them later', ['prose'])])
  assert.match(ctx(out[0]!), /- writing-guide, writing-check: for texts other people read.*\n- terse:terse-mode: for how you work on this task\./)
  assert.equal(s.needs.prose!.reason, 'need:prose from "write the docs and a guide for people wh"')
})

test('need stays active on a later unrelated prompt', () => {
  const { s } = run(base, [prompt('docs', ['prose']), prompt('thanks', [])])
  assert.ok('prose' in s.needs)
  assert.equal(s.ledger['writing-guide']!.state, 'restoring')
})

test('missing skill is asked twice, then not again and status says not seen after 2 requests', () => {
  const { s, out } = run(base, [prompt('docs', ['prose']), prompt('b'), prompt('c'), prompt('d')])
  assert.match(ctx(out[0]!), /writing-guide/)
  assert.match(ctx(out[1]!), /writing-guide/)
  assert.match(ctx(out[2]!), /^$|^((?!writing-guide).)*$/s)
  assert.deepEqual(out[3], [])
  assert.equal(s.ledger['writing-guide']!.state, 'unavailable')
  assert.equal(s.ledger['writing-guide']!.reason, 'not seen after 2 requests')
})

test('subagent skill load does not mark the main ledger loaded', () => {
  const config = cfg({ skills: { bigtest: { always: true, from: 'user' } } })
  const events = toCoreEvents(loadFixture('subagent'))
  const at1 = events.findIndex((e) => e.type === 'tool' && e.tool === 'Agent') + 1
  const { s, out } = run(config, [...events.slice(0, at1), agentStart(), ...events.slice(at1)])
  assert.equal(s.ledger.bigtest!.state, 'restoring')
  assert.match(ctx(out[1]!), /bigtest/)
  assert.deepEqual(s.liveAgents, ['a1'])
  const done = run(config, [agentDone()], s)
  assert.deepEqual(done.s.liveAgents, [])
})

test('skill load while a subagent runs and without a main Skill call is ignored', () => {
  const { s } = run(base, [prompt('x', ['prose']), tool('Agent', { brief: 'skills: none' }), agentStart(), loadSkill('writing-guide')])
  assert.equal(s.ledger['writing-guide']!.state, 'restoring')
})

test('main Skill call while a subagent runs counts', () => {
  const { s } = run(base, [prompt('x', ['prose']), tool('Agent', { brief: 'skills: none' }), tool('Skill', { skill: 'writing-guide' }), loadSkill('writing-guide')])
  assert.equal(s.ledger['writing-guide']!.state, 'loaded')
  assert.deepEqual(s.mainSkillCalls, [])
})

test('typed /name counts for the main ledger', () => {
  const { s } = run(base, [prompt('x', ['prose']), tool('Agent', { brief: 'skills: none' }), { type: 'typed', now: at(), name: 'writing-guide' }, loadSkill('writing-guide')])
  assert.equal(s.ledger['writing-guide']!.state, 'loaded')
})

test('compaction mid-turn: next tool call gets toolContext once', () => {
  const { s } = run(withAlways, [prompt('x', ['prose']), loadSkill('terse:terse-mode'), loadSkill('writing-guide'), loadSkill('writing-check')])
  const r1 = run(withAlways, [compact(), tool('Read', { path: 'a.ts' }), tool('Read', { path: 'b.ts' })], s)
  assert.equal(r1.out[0]!.length, 0)
  assert.equal(r1.out[1]![0]!.kind, 'toolContext')
  // The readers need is dormant after the compaction: only the always-on skill is asked for.
  const text = (r1.out[1]![0] as { text: string }).text
  assert.match(text, /- terse:terse-mode: for how you work on this task\./)
  assert.doesNotMatch(text, /writing-guide/)
  assert.deepEqual(r1.out[2], [])
})

test('compaction then a prompt: no toolContext afterwards', () => {
  const { s } = run(withAlways, [prompt('x', ['prose']), loadSkill('terse:terse-mode'), compact(), prompt('next')])
  assert.deepEqual(one(withAlways, [tool('Read')], s), [])
})

test('precompute and skipped compactions do not stale', () => {
  const { s } = run(withAlways, [prompt(), loadSkill('terse:terse-mode')])
  const r = run(withAlways, [compact({ trigger: 'precompute' }), compact({ skipped: true }), compact({ phase: 'before' })], s)
  assert.equal(r.s.ledger['terse:terse-mode']!.state, 'loaded')
  assert.equal(r.s.compactedSincePrompt, false)
})

test('subagent compaction does not stale the main ledger', () => {
  const { s } = run(withAlways, [prompt(), loadSkill('terse:terse-mode')])
  const r = run(withAlways, [compact({ agentId: 'agent-1' })], s)
  assert.equal(r.s.ledger['terse:terse-mode']!.state, 'loaded')
})

test('subagent tool call is never gated', () => {
  const { s } = run(base, [prompt('screen', ['ui'])])
  assert.deepEqual(one(base, [tool('Write', { path: 'x.html', agentId: 'agent-1' })], s), [])
})

test('gate denies Write to x.html while ui-checklist is needed and stale, allows after load', () => {
  const s0 = run(base, [prompt('screen', ['ui']), loadSkill('ui-checklist'), compact()]).s
  assert.equal(s0.ledger['ui-checklist']!.state, 'stale')
  const denied = denies(one(base, [tool('Write', { path: 'x.html' })], s0))
  assert.equal(denied.length, 1)
  assert.match((denied[0] as { reason: string }).reason, /ui-checklist.*\/souffleur pause/s)
  const ok = run(base, [loadSkill('ui-checklist'), tool('Write', { path: 'x.html' })], s0)
  assert.deepEqual(ok.out[1], [])
  assert.deepEqual(denies(one(base, [tool('Write', { path: 'x.ts' })], s0)), [])
})

test('a background agent returns from the Agent call, then loads a skill: not main, a gated Write is denied', () => {
  const s0 = run(base, [prompt('screen', ['ui']), tool('Agent', { brief: 'x' }), agentStart()]).s
  const r = run(base, [loadSkill('ui-checklist'), tool('Write', { path: 'x.html' })], s0)
  assert.notEqual(r.s.ledger['ui-checklist']!.state, 'loaded')
  assert.equal(denies(r.out[1]!).length, 1)
})

test('after the agent run ends a load counts for main again', () => {
  const s0 = run(base, [prompt('screen', ['ui']), tool('Agent', { brief: 'x' }), agentStart(), agentDone()]).s
  const r = run(base, [loadSkill('ui-checklist'), tool('Write', { path: 'x.html' })], s0)
  assert.equal(r.s.ledger['ui-checklist']!.state, 'loaded')
  assert.deepEqual(r.out[1], [])
})

test('a main Skill call counts for main while an agent runs', () => {
  const s0 = run(base, [prompt('screen', ['ui']), agentStart()]).s
  const r = run(base, [tool('Skill', { skill: 'ui-checklist' }), loadSkill('ui-checklist')], s0)
  assert.equal(r.s.ledger['ui-checklist']!.state, 'loaded')
})

test('an end without a start or a repeated end leaves other live runs alone', () => {
  const s0 = run(base, [agentStart('a1'), agentStart('a2'), agentDone('zz'), agentDone('a1'), agentDone('a1')]).s
  assert.deepEqual(s0.liveAgents, ['a2'])
  assert.deepEqual(run(base, [agentStart('a1'), agentStart('a1')]).s.liveAgents, ['a1'])
})

test('a main Skill call by the bare name announces the plugin skill key of the load', () => {
  const s0 = run(withAlways, [agentStart()]).s
  const r = run(withAlways, [tool('Skill', { skill: 'terse-mode' }), loadSkill('terse:terse-mode')], s0)
  assert.equal(r.s.ledger['terse:terse-mode']!.state, 'loaded')
  const other = run(withAlways, [loadSkill('terse:terse-mode')], s0)
  assert.notEqual(other.s.ledger['terse:terse-mode']!.state, 'loaded')
})

test('agentsEnded drops the ids the list reports ended and keeps the ones it never named', () => {
  const s = run(base, [agentStart('a1'), agentStart('a2'), agentStart('wf1'), agentsEnded(['a1', 'unknown'])]).s
  assert.deepEqual(s.liveAgents, ['a2', 'wf1'])
  const r = run(base, [prompt('screen', ['ui']), agentStart('a1'), agentsEnded(['a1']), loadSkill('ui-checklist')]).s
  assert.equal(r.ledger['ui-checklist']!.state, 'loaded')
})

test('a load by the plugin key clears the release state and the gate error of a bare ledger key', () => {
  const c = cfg({ skills: { 'terse-mode': { always: true, from: 'user' } }, rules: [{ id: 'r1', source: 'user', before: { tools: ['Write'] }, skill: 'terse-mode' }] as never })
  const s0: Session = { ...initSession(c, 'session-1', 0, 'clear'), turnDenials: { 'terse-mode': 2, other: 1 }, turnTries: ['terse-mode'], errors: ['gate: terse-mode did not load after 3 denials in a turn; calls released'], ruleSkills: [] }
  const s = run(c, [loadSkill('terse:terse-mode')], s0).s
  assert.deepEqual(s.turnDenials, { other: 1 })
  assert.deepEqual(s.turnTries, [])
  assert.deepEqual(s.errors, [])
  assert.deepEqual(s.ruleSkills, ['terse-mode'])
  assert.equal(s.ledger['terse-mode']!.state, 'loaded')
})

test('agentsEnded drops a spawn placeholder only when it is old', () => {
  const s = run(base, [agentStart('spawn:1000:1'), agentStart('spawn:200000:2'), agentsEnded([], 201000)]).s
  assert.deepEqual(s.liveAgents, ['spawn:200000:2'])
})

test('a load of a plugin skill books a bare ledger key; an ambiguous bare name books nothing', () => {
  const c = cfg({ skills: { 'terse-mode': { always: true, from: 'user' } } })
  assert.equal(run(c, [loadSkill('terse:terse-mode')]).s.ledger['terse-mode']!.state, 'loaded')
  const two = cfg({ skills: { 'a:x': { always: true, from: 'user' }, 'b:x': { always: true, from: 'user' } } })
  const r = run(two, [loadSkill('x')]).s
  assert.notEqual(r.ledger['a:x']!.state, 'loaded')
  assert.notEqual(r.ledger['b:x']!.state, 'loaded')
  const exact = cfg({ skills: { 'terse-mode': { always: true, from: 'user' }, 'terse:terse-mode': { always: true, from: 'user' } } })
  const e = run(exact, [loadSkill('terse:terse-mode')]).s
  assert.equal(e.ledger['terse:terse-mode']!.state, 'loaded')
  assert.notEqual(e.ledger['terse-mode']!.state, 'loaded')
})

test('the Agent call itself no longer counts a run', () => {
  const s = run(base, [prompt('x', ['prose']), tool('Agent', { brief: 'x' }), loadSkill('writing-guide')]).s
  assert.equal(s.ledger['writing-guide']!.state, 'loaded')
})

test('gate does nothing while the need is not active and the call is no evidence', () => {
  assert.deepEqual(one(base, [tool('Write', { path: 'x.ts' })]), [])
})

test('paused session is not gated', () => {
  const { s } = run(base, [prompt('screen', ['ui']), command('pause')])
  assert.equal(s.paused, true)
  assert.deepEqual(one(base, [tool('Write', { path: 'x.html' })], s), [])
})

test('unavailable skill is not gated', () => {
  const { s } = run(base, [prompt('screen', ['ui']), prompt('2'), prompt('3')])
  assert.equal(s.ledger['ui-checklist']!.state, 'unavailable')
  assert.deepEqual(one(base, [tool('Write', { path: 'x.html' })], s), [])
})

test('untrusted project gate only records', () => {
  const config = cfg({ skills: { ...base.skills, 'ui-checklist': { ...base.skills['ui-checklist']!, from: 'project' } } })
  const s0 = run(config, [prompt('screen', ['ui'])]).s
  const r = run(config, [tool('Write', { path: 'x.html', root: '/project' })], s0)
  assert.deepEqual(r.out[0], [])
  assert.equal(r.s.observed.length, 1)
  assert.match(r.s.observed[0]!.reason, /ui-checklist/)
  const trusted = cfg({ ...config, trustProjects: ['/project'] })
  const t2 = run(trusted, [tool('Write', { path: 'x.html', root: '/project' })], s0)
  assert.equal(t2.out[0]![0]!.kind, 'deny')
  const noRoot = run(trusted, [tool('Write', { path: 'x.html' })], s0)
  assert.deepEqual(noRoot.out[0], [])
})

test('duty opens on Write x.html, denies next gated Write, closes on Bash ui-checklist detect', () => {
  const s0 = uiLoaded()
  const r = run(base, [
    tool('Write', { path: 'a.html' }),
    tool('Write', { path: 'b.html' }),
    tool('Bash', { command: 'run ui-checklist detect b.html' }),
    tool('Write', { path: 'c.html' }),
  ], s0)
  assert.deepEqual(r.out[0], [])
  assert.equal(r.out[1]![0]!.kind, 'deny')
  assert.match((r.out[1]![0] as { reason: string }).reason, /open duty for ui-checklist \(Write a\.html\)/)
  assert.deepEqual(r.out[2], [])
  assert.deepEqual(r.out[3], [])
  assert.equal(r.s.duties.length, 1)
  assert.equal(r.s.duties[0]!.by, 'Write c.html')
})

const pubCfg = cfg({ skills: { ...base.skills, 'ui-checklist': { ...base.skills['ui-checklist']!, duty: { after: { tools: ['Write', 'Edit', 'Artifact'], paths: ['**/*.html'] }, evidence: { tool: 'Bash', command: '*ui-checklist*detect*' } } } } })

test('a publish after evidence opens no duty, and a second publish neither (#51)', () => {
  const r = run(pubCfg, [
    tool('Write', { path: 'x.html' }),
    tool('Edit', { path: 'x.html' }),
    tool('Bash', { command: 'run ui-checklist detect --json x.html' }),
    tool('Artifact', { path: 'x.html' }),
    tool('Artifact', { path: 'x.html' }),
  ], uiLoaded())
  assert.equal(r.s.duties.length, 0)
  assert.deepEqual(r.out[3], [])
  assert.deepEqual(r.out[4], [])
})

test('a Write opens the duty; the publish after it does not add one (#51)', () => {
  const r = run(pubCfg, [tool('Write', { path: 'x.html' }), tool('Artifact', { path: 'x.html' })], uiLoaded())
  assert.equal(r.s.duties.length, 1)
  assert.ok(r.s.duties[0]!.by.startsWith('Write'))
})

test('a publish never arms a duty; Edit, no evidence, Edit leaves the duty from the Write open (#51)', () => {
  assert.equal(run(pubCfg, [tool('Artifact', { path: 'y.html' })], uiLoaded()).s.duties.length, 0)
  const r = run(pubCfg, [tool('Write', { path: 'x.html' }), tool('Edit', { path: 'x.html' }), tool('Edit', { path: 'x.html' })], uiLoaded())
  assert.equal(r.s.duties.length, 1)
  assert.ok(r.s.duties[0]!.by.startsWith('Write'))
})

test('duty denies once, retry passes', () => {
  const r = run(base, [tool('Write', { path: 'a.html' }), tool('Write', { path: 'b.html' }), tool('Write', { path: 'b.html' })], uiLoaded())
  assert.equal(r.out[1]![0]!.kind, 'deny')
  assert.deepEqual(r.out[2], [])
  assert.equal(r.s.duties.length, 1)
})

test('open duty is listed in the next prompt context', () => {
  const r = run(base, [tool('Write', { path: 'a.html' }), prompt('next')], uiLoaded())
  assert.equal(ctx(r.out[1]!), 'Open duty: ui-checklist (Write a.html).')
})

test('pause stops gate, duty and brief denials', () => {
  const s0 = run(base, [prompt('screen', ['ui']), loadSkill('ui-checklist'), compact(), command('pause')]).s
  const r = run(base, [
    tool('Write', { path: 'a.html' }),
    tool('Write', { path: 'b.html' }),
    tool('Agent', { brief: 'no skills line' }),
  ], s0)
  assert.deepEqual(r.out.flatMap(denies), [])
  assert.deepEqual(r.s.observed, [])
})

test('Agent brief without skills line is denied once, retry passes', () => {
  const { s } = run(base, [prompt('screen', ['ui'])])
  const r = run(base, [tool('Agent', { brief: 'do the thing' }), tool('Agent', { brief: 'do the thing' }), tool('Agent', { brief: 'again' })], s)
  assert.equal(r.out[0]![0]!.kind, 'deny')
  assert.match((r.out[0]![0] as { reason: string }).reason, /Configured skills: .*ui-checklist.*Active needs: ui/)
  assert.deepEqual(r.out[1], [])
  assert.equal(r.out[2]![0]!.kind, 'deny')
})

test('Agent brief with "skills: none" passes', () => {
  const { s } = run(base, [prompt('screen', ['ui'])])
  assert.deepEqual(one(base, [tool('Agent', { brief: 'Fix typo.\nskills: none' })], s), [])
})

test('no active need: Agent brief is not checked', () => {
  assert.deepEqual(one(base, [tool('Agent', { brief: 'whatever' })]), [])
})

test('command need/drop/pause', () => {
  const r = run(base, [command('need ui'), command('drop ui'), command('pause')])
  assert.equal(r.out[0]![0]!.kind, 'reply')
  const on = run(base, [command('need ui')]).s
  assert.ok('ui' in on.needs)
  assert.deepEqual(run(base, [command('drop ui')], on).s.needs, {})
  assert.equal(r.s.paused, true)
})

test('command status replies with the status text', () => {
  const a = one(base, [command('')])
  assert.equal(a[0]!.kind, 'reply')
  assert.equal(one(base, [command('status')])[0]!.kind, 'reply')
})

test('unknown need name in command replies with known needs', () => {
  const a = one(base, [command('need nope')])
  assert.match((a[0] as { text: string }).text, /Known needs: prose, ui/)
  assert.match((one(base, [command('drop nope')])[0] as { text: string }).text, /Known needs: prose, ui/)
})

test('a name from Object.prototype is not a configured need', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const a = one(base, [command(`need ${name}`)])
    assert.match((a[0] as { text: string }).text, /Unknown need/, name)
    assert.match((one(base, [command(`drop ${name}`)])[0] as { text: string }).text, /Unknown need/, name)
  }
  const r = run(base, [command('need constructor')])
  assert.deepEqual(r.s.needs, {})
})

test('replay resume-then-compact ends with bigtest requested on the next prompt', () => {
  const config = cfg({ skills: { bigtest: { always: true, from: 'user' } } })
  const events = toCoreEvents(loadFixture('resume-then-compact-then-clear'))
  const cut = events.findIndex((e) => e.type === 'typed' && e.name === 'clear')
  const r = run(config, events.slice(0, cut))
  assert.equal(r.s.ledger.bigtest!.state, 'restoring')
  assert.match(ctx(r.out.at(-1)!), /invoke these skills.*\n- bigtest: for how you work on this task\./)
  const afterLoad = r.out.findIndex((_, i) => events[i]!.type === 'skill')
  assert.ok(afterLoad > 0)
})

test('observe mode: gate, duty and Agent-brief checks deny nothing and record would-deny reasons', () => {
  const config = cfg({ mode: 'observe' })
  const s0 = run(config, [prompt('screen', ['ui']), loadSkill('ui-checklist'), compact()]).s
  const r = run(config, [
    tool('Write', { path: 'a.html' }), // wakes the dormant need: toolContext, recorded as would-deny
    loadSkill('ui-checklist'),
    tool('Write', { path: 'a.html' }), // opens duty
    tool('Write', { path: 'b.html' }), // duty
    tool('Agent', { brief: 'nothing' }), // brief
  ], s0)
  assert.deepEqual(r.out.flatMap(denies), [])
  assert.equal(r.s.observed.length, 3)
  assert.match(r.s.observed[0]!.reason, /ui-checklist/)
  assert.match(r.s.observed[1]!.reason, /open duty/)
  assert.match(r.s.observed[2]!.reason, /skills:/)
})

/**
 * Runs the same prelude and calls in `enforce` (a denied call is repeated once, as the model retries) and in `observe` (each call once).
 * Returns the reasons enforce denied per call, and the reasons observe recorded per call.
 */
function parity(patch: Partial<Config>, prelude: CoreEvent[], calls: CoreEvent[]): { denied: string[][]; recorded: string[][]; retried: string[][] } {
  const denied: string[][] = []
  const retried: string[][] = []
  const enforce = cfg({ ...patch, mode: 'enforce' })
  let s = run(enforce, prelude).s
  for (const e of calls) {
    const r = decide(enforce, s, e)
    s = r.session
    const d = denies(r.actions) as { reason: string }[]
    denied.push(d.map((x) => x.reason))
    if (d.length) {
      const again = decide(enforce, s, { ...e, now: at() }) // the retry
      s = again.session
      retried.push((denies(again.actions) as { reason: string }[]).map((x) => x.reason))
    } else retried.push([])
  }
  const observe = cfg({ ...patch, mode: 'observe' })
  const recorded: string[][] = []
  s = run(observe, prelude).s
  for (const e of calls) {
    const before = s.observed.length
    const r = decide(observe, s, e)
    s = r.session
    assert.deepEqual(denies(r.actions), [])
    recorded.push(s.observed.slice(before).map((o) => o.reason))
  }
  return { denied, recorded, retried }
}
const assertParity = (patch: Partial<Config>, prelude: CoreEvent[], calls: CoreEvent[], expectDenied: number) => {
  const { denied, recorded } = parity(patch, prelude, calls)
  assert.deepEqual(recorded, denied)
  assert.equal(denied.filter((d) => d.length).length, expectDenied)
}
/** Each line of a reason is one check; counts how often each check spoke over all calls. */
const perCheck = (reasons: string[][]) => {
  const n: Record<string, number> = {}
  for (const line of reasons.flat().flatMap((r) => r.split('\n'))) n[line] = (n[line] ?? 0) + 1
  return n
}

test('observe records what enforce denies: after rule repeats', () => {
  const rules = [{ id: 'r1', source: 'user', after: { tools: ['Write'], paths: ['**/*.md'] }, evidence: { tool: 'Bash', command: '*check*' } }]
  const calls = [
    tool('Write', { path: 'a.md' }), // opens
    tool('Write', { path: 'b.md' }), // denied once
    tool('Write', { path: 'c.md' }), // retry state used up
    tool('Write', { path: 'd.md' }),
    tool('Bash', { command: 'run check' }), // evidence closes
    tool('Write', { path: 'e.md' }), // opens again
    tool('Write', { path: 'f.md' }), // denied again
  ]
  assertParity({ rules }, [prompt()], calls, 2)
})

test('observe records what enforce denies: field rule', () => {
  const rules = [{ id: 'f1', source: 'user', before: { tools: ['Bash'] }, field: 'description' }]
  const calls = [tool('Bash'), tool('Bash'), tool('Bash', { present: ['description'] }), tool('Bash')]
  assertParity({ rules }, [prompt()], calls, 3)
})

test('observe records what enforce denies: duty', () => {
  const pre = [prompt('screen', ['ui']), loadSkill('ui-checklist')]
  const calls = [
    tool('Write', { path: 'a.html' }), // opens the duty
    tool('Write', { path: 'b.html' }), // denied once
    tool('Write', { path: 'c.html' }),
    tool('Bash', { command: 'ui-checklist detect' }), // evidence closes
    tool('Write', { path: 'd.html' }),
    tool('Write', { path: 'e.html' }),
  ]
  assertParity({}, pre, calls, 2)
})

test('observe records what enforce denies: brief check on every unmarked brief', () => {
  const pre = [prompt('screen', ['ui'])]
  const calls = [tool('Agent', { brief: 'one' }), tool('Agent', { brief: 'two' }), tool('Agent', { brief: 'three' }), tool('Agent', { brief: 'ok\nskills: none' }), tool('Agent', { brief: 'four' })]
  assertParity({}, pre, calls, 4)
})

test('observe records what enforce denies: gate until the skill loads', () => {
  const skills = { ...base.skills, 'ui-checklist': { need: 'ui', from: 'user' as const, gate: { tools: ['Write', 'Edit'], paths: ['**/*.html'] } } }
  const calls = [tool('Write', { path: 'a.html' }), tool('Write', { path: 'b.html' }), tool('Skill', { skill: 'ui-checklist' }), loadSkill('ui-checklist'), tool('Write', { path: 'c.html' })]
  assertParity({ skills }, [prompt('screen', ['ui'])], calls, 2)
  // enforce denies the retry of a gated call too, because the skill is still not loaded
  assert.ok(parity({ skills }, [prompt('screen', ['ui'])], calls).retried[0]!.length > 0)
})

test('observe counts the same denials as enforce when one call breaks a gate and an after rule', () => {
  const skills = { ...base.skills, 'ui-checklist': { need: 'ui', from: 'user' as const, gate: { tools: ['Write'], paths: ['**/*.html'] } } }
  const rules = [{ id: 'r1', source: 'user', after: { tools: ['Write'], paths: ['**/*.html'] }, evidence: { tool: 'Bash', command: '*check*' } }]
  const calls = [tool('Write', { path: 'a.html' }), tool('Write', { path: 'b.html' }), tool('Skill', { skill: 'ui-checklist' }), loadSkill('ui-checklist'), tool('Write', { path: 'c.html' }), tool('Write', { path: 'd.html' })]
  const { denied, recorded } = parity({ skills, rules }, [prompt('screen', ['ui'])], calls)
  // the rule may land on another call in observe, but each check is counted as often
  assert.deepEqual(perCheck(recorded), perCheck(denied))
  assert.ok(Object.keys(perCheck(denied)).some((l) => l.includes('rule r1')))
})

test('observe records what enforce denies: evidence starts a need', () => {
  const calls = [tool('Bash', { command: 'gh issue create --title x' }), tool('Bash', { command: 'gh issue create --title y' })]
  assertParity({}, [prompt()], calls, 1)
})

test('observe and the retry together open the rules and count the subagent once', () => {
  const rules = [{ id: 'r1', source: 'user', after: { tools: ['Write'], paths: ['**/*.md'] }, evidence: { tool: 'Bash', command: '*check*' } }]
  const config = cfg({ mode: 'observe', rules })
  const pre = run(config, [prompt('screen', ['ui'])]).s
  const r = run(config, [tool('Agent', { brief: 'no line' }), tool('Write', { path: 'a.md' })], pre)
  assert.deepEqual(r.s.liveAgents ?? [], [])
  assert.deepEqual(r.s.openRules.map((o) => o.id), ['r1'])
  assert.equal(r.s.agentDenied, false)
})

test('observe mode still sends the restore context', () => {
  const a = one(cfg({ mode: 'observe', skills: withAlways.skills }), [prompt()])
  assert.match(ctx(a), /terse:terse-mode/)
})

test('observed and errors keep the last 20', () => {
  const config = cfg({ mode: 'observe' })
  const s0 = run(config, [prompt('screen', ['ui'])]).s
  const events: CoreEvent[] = []
  for (let i = 0; i < 25; i++) events.push(tool('Write', { path: `${i}.html` }), { type: 'error', now: at(), where: 'w', message: `m${i}` })
  const r = run(config, events, s0)
  assert.equal(r.s.observed.length, 20)
  assert.equal(r.s.errors.length, 20)
  assert.equal(r.s.errors.at(-1), 'w: m24')
})

test('resume keeps the ledger, clear starts a fresh session', () => {
  const { s } = run(withAlways, [prompt(), loadSkill('terse:terse-mode')])
  const resumed = decide(withAlways, s, { type: 'start', now: at(), start: 'resume', version: '2.1.332' }).session
  assert.equal(resumed.ledger['terse:terse-mode']!.state, 'loaded')
  assert.equal(resumed.version, '2.1.332')
  const cleared = decide(withAlways, s, { type: 'start', now: at(), start: 'clear' }).session
  assert.equal(cleared.ledger['terse:terse-mode']!.state, 'absent')
  assert.equal(cleared.id, s.id)
})

test('resume resets per-process counters', () => {
  const s0 = run(withAlways, [prompt(), loadSkill('terse:terse-mode')]).s
  const s: Session = {
    ...s0,
    liveAgents: ['a1', 'a2'],
    mainSkillCalls: ['x'],
    agentDenied: true,
    learnCalls: ['y'],
    fieldDenied: ['f'],
    needs: { ui: { since: 1, reason: 'kept' } },
    proposals: [{ id: 'p1' } as never],
    noticed: { cut: ['terse:terse-mode'], problems: ['p'] },
    openRules: [{ id: 'r', by: 'b', denied: false, told: false }],
    duties: [{ skill: 'ui-checklist', openedAt: 1, by: 'b', denied: false }],
    ruleSkills: ['terse:terse-mode'],
  }
  const resumed = decide(withAlways, s, { type: 'start', now: at(), start: 'resume' }).session
  assert.deepEqual(resumed.liveAgents, [])
  assert.deepEqual(resumed.mainSkillCalls, [])
  assert.equal(resumed.agentDenied, false)
  assert.deepEqual(resumed.learnCalls, [])
  assert.deepEqual(resumed.fieldDenied, [])
  assert.deepEqual(resumed.ledger, s.ledger)
  assert.deepEqual(resumed.needs, s.needs)
  assert.deepEqual(resumed.proposals, s.proposals)
  assert.deepEqual(resumed.noticed, s.noticed)
  assert.deepEqual(resumed.openRules, s.openRules)
  assert.deepEqual(resumed.duties, s.duties)
  assert.deepEqual(resumed.ruleSkills, s.ruleSkills)
})

test('reload keeps per-run counters', () => {
  const s0 = run(withAlways, [prompt(), loadSkill('terse:terse-mode')]).s
  const s: Session = { ...s0, liveAgents: ['a1', 'a2'], mainSkillCalls: ['x'], agentDenied: true, learnCalls: ['y'], fieldDenied: ['f'] }
  const reloaded = decide(withAlways, s, { type: 'start', now: at(), start: 'reload' }).session
  assert.deepEqual(reloaded.liveAgents, ['a1', 'a2'])
  assert.deepEqual(reloaded.mainSkillCalls, ['x'])
  assert.equal(reloaded.agentDenied, true)
  assert.deepEqual(reloaded.learnCalls, ['y'])
  assert.deepEqual(reloaded.fieldDenied, ['f'])
  assert.deepEqual(reloaded.ledger, s.ledger)
})

test('startup still gives a fresh session', () => {
  const s0 = run(withAlways, [prompt(), loadSkill('terse:terse-mode')]).s
  const s: Session = { ...s0, liveAgents: ['a1', 'a2'], mainSkillCalls: ['x'], agentDenied: true, learnCalls: ['y'] }
  const fresh = decide(withAlways, s, { type: 'start', now: at(), start: 'startup' }).session
  assert.deepEqual(fresh.liveAgents ?? [], [])
  assert.deepEqual(fresh.mainSkillCalls, [])
  assert.equal(fresh.agentDenied, false)
  assert.equal(fresh.learnCalls, undefined)
  assert.equal(fresh.ledger['terse:terse-mode']!.state, 'absent')
})

test('session survives JSON round trip', () => {
  const events: CoreEvent[] = [
    { type: 'start', now: at(), start: 'startup', version: '2.1.332' },
    prompt('screen', ['ui']),
    loadSkill('ui-checklist'),
    tool('Agent', { brief: 'skills: none' }),
    tool('Write', { path: 'a.html' }),
    compact(),
    command('pause'),
    { type: 'error', now: at(), where: 'w', message: 'm' },
  ]
  const { s } = run(cfg({ mode: 'observe' }), events)
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s)
  const again = decide(base, JSON.parse(JSON.stringify(s)) as Session, prompt('more'))
  assert.deepEqual(JSON.parse(JSON.stringify(again.session)), again.session)
})

test('a restore after compaction says the engine note about earlier skills does not apply', () => {
  const config = cfg({ skills: { bigtest: { always: true, from: 'user' } } })
  const r = run(config, [loadSkill('bigtest'), compact(), prompt('next')])
  assert.match(ctx(r.out.at(-1)!), /- bigtest: for how you work on this task\.\n.*must not be run again does not apply/)
  const first = run(config, [prompt('first')])
  assert.doesNotMatch(ctx(first.out.at(-1)!), /does not apply/)
})

test('a skill not installed here is neither requested nor gated', () => {
  const c = cfg({ skills: { ...base.skills, 'terse:terse-mode': { always: true, from: 'user' } } })
  const { s, out } = run(c, [{ type: 'installed', now: at(), names: ['writing-guide', 'writing-check'] }, prompt('make a page', ['ui']), tool('Write', { path: 'x.html' })])
  assert.equal(s.ledger['ui-checklist']!.state, 'not installed here')
  assert.equal(s.ledger['terse:terse-mode']!.state, 'not installed here')
  assert.equal(s.ledger['ui-checklist']!.requests, 0)
  const text = JSON.stringify(out)
  assert.doesNotMatch(text, /ui-checklist|terse-mode/)
  assert.equal(out[2]!.some((a) => a.kind === 'deny'), false)
})

test('a config event adds new skills as absent, drops removed ones and swaps config errors', () => {
  const c = cfg()
  const start = initSession(c, 'session-1', 0, 'clear')
  const withErr = { ...start, errors: ['config: old', 'hook: kept'] }
  const next = cfg({ skills: { 'writing-guide': base.skills['writing-guide']!, 'pdf-tool': { need: 'prose', from: 'user' } } })
  const { s } = run(next, [{ type: 'config', now: at(), errors: [] }], withErr)
  assert.deepEqual(Object.keys(s.ledger).sort(), ['pdf-tool', 'writing-guide'])
  assert.equal(s.ledger['pdf-tool']!.state, 'absent')
  assert.deepEqual(s.errors, ['hook: kept'])
})

test('a skill not installed here opens no duty and is left out of the Agent brief list', () => {
  const c = cfg({ mode: 'observe' })
  const gone = [{ type: 'installed', now: at(), names: ['writing-guide'] } as CoreEvent]
  const { s, out } = run(c, [...gone, prompt('x', ['ui']), tool('Write', { path: 'x.html' }), tool('Agent', { brief: 'no skills line' })])
  assert.deepEqual(s.duties, [])
  const denied = JSON.stringify(out)
  assert.doesNotMatch(denied, /ui-checklist/)
  const enforced = run(cfg(), [...gone, prompt('x', ['prose']), tool('Agent', { brief: 'no skills line' })])
  const deny = enforced.out[2]!.find((a) => a.kind === 'deny') as { reason: string } | undefined
  assert.ok(deny)
  assert.doesNotMatch(deny.reason, /ui-checklist/)
  assert.match(deny.reason, /writing-guide/)
})

test('a config event drops needs the config no longer has and duties of removed skills', () => {
  const c = cfg()
  const start = {
    ...initSession(c, 'session-1', 0, 'clear'),
    needs: { ui: { since: 1, reason: 'x' }, gone: { since: 1, reason: 'y' } },
    duties: [{ skill: 'ui-checklist', openedAt: 1, by: 'Write', denied: false }, { skill: 'removed', openedAt: 1, by: 'Write', denied: false }],
  }
  const { s } = run(c, [{ type: 'config', now: at(), errors: [] }], start)
  assert.deepEqual(Object.keys(s.needs), ['ui'])
  assert.deepEqual(s.duties.map((d) => d.skill), ['ui-checklist'])
})

// --- Review before 0.1.0 ---

const projectCfg = (extra: Partial<Config> = {}): Config =>
  cfg({
    mode: 'enforce',
    needs: { pn: { for: 'work', what: 'A project need.' } },
    projectNeeds: ['pn'],
    skills: { 'proj-skill': { need: 'pn', from: 'project' }, 'proj-always': { always: true, from: 'project' } },
    ...extra,
  })
const withRoot = (e: CoreEvent, root = '/work/p'): CoreEvent => ({ ...e, root }) as CoreEvent

test('untrusted project file: no restore text for its skills, with or without a root', () => {
  const c = projectCfg()
  assert.doesNotMatch(ctx(one(c, [withRoot(prompt('x', ['pn']))])), /proj-/)
  assert.doesNotMatch(ctx(one(c, [prompt('x', ['pn'])])), /proj-/)
  const trusted = projectCfg({ trustProjects: ['/work/p/'] })
  assert.match(ctx(one(trusted, [withRoot(prompt('x', ['pn']))])), /proj-skill/)
  assert.match(ctx(one(trusted, [withRoot(prompt('x', ['pn']))])), /proj-always/)
})

test('untrusted project file: a restore after compaction on a tool result does not name its skills', () => {
  const c = projectCfg()
  const { out } = run(c, [loadSkill('proj-always'), compact(), withRoot(tool('Read'))])
  assert.deepEqual(out.at(-1)!.filter((a) => a.kind === 'toolContext'), [])
})

test('untrusted project file: a project need does not deny an Agent brief, a trusted one does', () => {
  const c = projectCfg()
  const events = [withRoot(prompt('x', ['pn'])), withRoot(tool('Agent', { brief: 'do it' }))]
  const r = run(c, events)
  assert.deepEqual(denies(r.out.at(-1)!), [])
  const t = run(projectCfg({ trustProjects: ['/work/p'] }), events)
  assert.equal(denies(t.out.at(-1)!).length, 1)
  assert.match((denies(t.out.at(-1)!)[0] as { reason: string }).reason, /pn/)
})

test('a user need still denies an Agent brief when the root is not trusted', () => {
  const r = run(base, [withRoot(prompt('x', ['prose'])), withRoot(tool('Agent', { brief: 'do it' }))])
  assert.equal(denies(r.out.at(-1)!).length, 1)
})

test('the restore block never passes 10,000 characters with notes, and the rest stays absent', () => {
  const skills = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`plugin:${'s'.repeat(50)}-${String(i).padStart(3, '0')}`, { always: true, from: 'user' as const }]))
  const notes = Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, text: 'x'.repeat(490), source: 'user' }))
  const c = cfg({ skills, notes, needs: {} })
  const start = { ...initSession(c, 's', 0, 'clear'), freshNotes: notes.map((n) => n.id) }
  const { s, out } = run(c, [prompt()], start)
  const text = ctx(out.at(-1)!)
  assert.ok(text.length <= 10_000, `${text.length} characters`)
  assert.match(text, /x{490}/, 'the notes are still in the block')
  const asked = Object.values(s.ledger).filter((e) => e.state === 'restoring').length
  assert.ok(asked > 0 && asked < 300)
  assert.equal(Object.values(s.ledger).filter((e) => e.state === 'absent').length, 300 - asked, 'skills left out stay absent and are listed by /souffleur')
  const again = run(c, [prompt()], s)
  assert.ok(ctx(again.out.at(-1)!).length <= 10_000)
})

test('three failed classifier runs in a row record an error, a good run resets the count and the error', () => {
  const failed = (): CoreEvent => ({ ...prompt('x'), classifierFailed: true }) as CoreEvent
  const two = run(base, [failed(), failed()]).s
  assert.deepEqual(two.errors, [])
  const three = run(base, [failed()], two).s
  assert.ok(three.errors.some((m) => /^classifier: /.test(m)), three.errors.join('\n'))
  assert.equal(run(base, [failed()], three).s.errors.filter((m) => /^classifier: /.test(m)).length, 1, 'recorded once')
  const good = run(base, [{ ...prompt('x'), classifierFailed: false } as CoreEvent], three).s
  assert.deepEqual(good.errors, [])
  assert.equal(run(base, [failed(), failed()], good).s.errors.length, 0, 'the count starts again')
})

test('three failed learn calls in a row record an error, a good one resets', () => {
  const learned = (ok: boolean): CoreEvent => ({ type: 'learned', now: at(), ok })
  const three = run(base, [learned(false), learned(false), learned(false)]).s
  assert.ok(three.errors.some((m) => /^learn: /.test(m)), three.errors.join('\n'))
  assert.deepEqual(run(base, [learned(true)], three).s.errors, [])
  assert.deepEqual(run(base, [learned(false), learned(false), learned(true), learned(false), learned(false)]).s.errors, [])
})

test('pause stops restore requests; resume brings them back', () => {
  const r = run(withAlways, [command('pause')])
  assert.equal(r.s.paused, true)
  assert.doesNotMatch(ctx(one(withAlways, [prompt()], r.s)), /terse-mode/)
  assert.deepEqual(one(withAlways, [prompt('x', ['prose'])], r.s), [])
  const after = run(withAlways, [command('resume')], r.s)
  assert.equal(after.s.paused, false)
  assert.match((after.out[0]![0] as { text: string }).text, /on again/i)
  assert.match(ctx(one(withAlways, [prompt()], after.s)), /terse-mode/)
})

test('pause stops the restore after a compaction on a tool result, and need matches are not recorded', () => {
  const s0 = run(withAlways, [loadSkill('terse:terse-mode'), compact(), command('pause')]).s
  assert.deepEqual(one(withAlways, [tool('Read')], s0).filter((a) => a.kind === 'toolContext'), [])
  assert.deepEqual(Object.keys(run(withAlways, [prompt('x', ['prose'])], s0).s.needs), [])
})

test('resume without a pause says so; a resumed session is not paused', () => {
  assert.match((one(base, [command('resume')])[0] as { text: string }).text, /not paused/i)
  const paused = run(base, [command('pause')]).s
  const resumed = decide(base, paused, { type: 'start', now: at(), start: 'resume' }).session
  assert.equal(resumed.paused, false)
  assert.match((one(base, [command('nonsense')])[0] as { text: string }).text, /resume/)
})

test('an open duty is mentioned once per opening', () => {
  const openDuty = [prompt('screen', ['ui']), loadSkill('ui-checklist'), tool('Write', { path: '/p/a.html' })]
  const s1 = run(base, openDuty).s
  assert.equal(s1.duties.length, 1)
  const first = run(base, [prompt()], s1)
  assert.match(ctx(first.out[0]!), /Open duty: ui-checklist/)
  const second = run(base, [prompt()], first.s)
  assert.doesNotMatch(ctx(second.out[0]!), /Open duty/)
  const closed = run(base, [tool('Bash', { command: 'node ui-checklist detect' }), tool('Write', { path: '/p/b.html' })], second.s)
  assert.equal(closed.s.duties.length, 1)
  assert.match(ctx(run(base, [prompt()], closed.s).out[0]!), /Open duty: ui-checklist/, 'a new opening is mentioned again')
})

test('the Skill call that loads a gated skill is not denied', () => {
  const c = cfg({ skills: { g: { always: true, from: 'user', gate: { tools: ['Skill'] } } } })
  assert.deepEqual(denies(one(c, [prompt(), tool('Skill', { skill: 'g' })])), [])
  assert.equal(denies(one(c, [prompt(), tool('Skill', { skill: 'other' })])).length, 1, 'other Skill calls still wait')
})

test('trustProjects with a trailing slash still trusts the root in a tool call', () => {
  const c = cfg({ trustProjects: ['/work/p/'], skills: { 'p-gate': { always: true, from: 'project', gate: { tools: ['Write'] } } } })
  assert.equal(denies(one(c, [withRoot(prompt()), withRoot(tool('Write', { path: '/work/p/a' }))])).length, 1)
})

test('recovered removes errors of that hook only', () => {
  const { s } = run(cfg({ mode: 'observe' }), [
    { type: 'error', now: at(), where: 'prompt.submit', message: 'a' },
    { type: 'error', now: at(), where: 'tool.call', message: 'b' },
    { type: 'error', now: at(), where: 'prompt.submit', message: 'c' },
    { type: 'recovered', now: at(), where: 'prompt.submit' },
  ])
  assert.deepEqual(s.errors, ['tool.call: b'])
})

test('recovered leaves config, learn and classifier errors and their counters', () => {
  const failed = (): CoreEvent => ({ type: 'prompt', now: at(), text: 'x', fromUser: true, matched: [], classifierFailed: true })
  const events: CoreEvent[] = [
    { type: 'config', now: at(), errors: ['bad'] },
    { type: 'learned', now: at(), ok: false },
    { type: 'learned', now: at(), ok: false },
    { type: 'learned', now: at(), ok: false },
    failed(),
    failed(),
    failed(),
  ]
  const before = run(cfg({ mode: 'observe' }), events).s
  assert.equal(before.errors.length, 3)
  for (const where of ['prompt.submit', 'config', 'learn', 'classify', 'classifier']) {
    const after = decide(cfg({ mode: 'observe' }), before, { type: 'recovered', now: at(), where }).session
    assert.deepEqual(after.errors, before.errors, where)
    assert.equal(after.learnFails, 3)
    assert.equal(after.classifyFails, 3)
  }
})

test('recovered with no matching error returns the same errors', () => {
  const before = run(cfg({ mode: 'observe' }), [{ type: 'error', now: at(), where: 'tool.call', message: 'b' }]).s
  const after = decide(cfg({ mode: 'observe' }), before, { type: 'recovered', now: at(), where: 'prompt.submit' })
  assert.equal(after.session.errors, before.errors)
  assert.deepEqual(after.actions, [])
})

const classified = (matched: string[], failed = false, text = 'please look at this some more'): CoreEvent => ({ type: 'prompt', now: at(), text, fromUser: true, matched, classifierFailed: failed })
const repeat = (n: number, make: () => CoreEvent): CoreEvent[] => Array.from({ length: n }, make)

test('need ends after 20 unmatched prompts', () => {
  const start = run(cfg(), [classified(['ui'])]).s
  assert.ok('ui' in start.needs)
  const a = run(cfg(), repeat(19, () => classified([])), start)
  assert.ok('ui' in a.s.needs)
  const b = run(cfg(), [classified([])], a.s)
  assert.equal('ui' in b.s.needs, false)
  assert.ok(b.out[0]!.some((x) => x.kind === 'debug' && /ui/.test(x.text)))
})

test('a match resets the count', () => {
  let s = run(cfg(), [classified(['ui'])]).s
  s = run(cfg(), repeat(19, () => classified([])), s).s
  s = run(cfg(), [classified(['ui'])], s).s
  s = run(cfg(), repeat(19, () => classified([])), s).s
  assert.ok('ui' in s.needs)
})

test('classifier failure is no miss', () => {
  let s = run(cfg(), [classified(['ui'])]).s
  s = run(cfg(), repeat(30, () => classified([], true)), s).s
  assert.ok('ui' in s.needs)
  s = run(cfg(), repeat(30, () => prompt('no classifier ran')), s).s
  assert.ok('ui' in s.needs)
})

test('command need never ends', () => {
  let s = run(cfg(), [command('need ui')]).s
  assert.ok('ui' in s.needs)
  s = run(cfg(), repeat(40, () => classified([])), s).s
  assert.ok('ui' in s.needs)
})

test('starting a need writes a debug line with the reason', () => {
  const r = decide(cfg(), initSession(cfg(), 'session-1', 0, 'clear'), { type: 'prompt', now: at(), text: 'build a screen', fromUser: true, matched: ['ui'], classifierFailed: false })
  assert.ok(r.actions.some((x) => x.kind === 'debug' && /need:ui/.test(x.text)))
})

test('short prompts neither count as a miss nor reset the count', () => {
  let s = run(cfg(), [classified(['ui'])]).s
  s = run(cfg(), repeat(25, () => classified([], false, 'ja')), s).s
  assert.ok('ui' in s.needs)
  s = run(cfg(), repeat(19, () => classified([])), s).s
  s = run(cfg(), [classified([], false, 'ok ja')], s).s
  assert.ok('ui' in s.needs, 'a short prompt does not push it over')
  s = run(cfg(), [classified([])], s).s
  assert.equal('ui' in s.needs, false)
})

test('an ended need frees skills that were only restoring for it', () => {
  const c = cfg({ skills: { ...base.skills, 'shared': { need: 'ui', from: 'user' }, 'other': { need: 'prose', from: 'user' } } })
  const row = { state: 'restoring' as const, since: 1, reason: '', requests: 1 }
  const s0 = initSession(c, 'session-1', 0, 'clear')
  const start: Session = {
    ...s0,
    needs: { ui: { since: 1, reason: 'r', misses: 19 }, prose: { since: 1, reason: 'r', misses: 0 } },
    ledger: { ...s0.ledger, 'ui-checklist': row, shared: row, other: row },
  }
  const s = run(c, [classified(['prose'])], start).s
  assert.equal('ui' in s.needs, false)
  assert.equal(s.ledger['ui-checklist']!.state, 'absent')
  assert.equal(s.ledger['ui-checklist']!.requests, 0)
  assert.equal(s.ledger['shared']!.state, 'absent')
  assert.equal(s.ledger['other']!.state, 'restoring', 'still needed by prose')
})

// Audiences: the restore request says what each skill is for.
const audienceConfig = (): Config => cfg({
  needs: {
    prose: { for: 'readers', what: 'Writing text people read.' },
    ui: { for: 'users', what: 'Building a screen.' },
    old: { for: 'work', what: 'Old need.', noAudience: true },
  },
  skills: {
    'terse:terse-mode': { always: true, for: 'chat', from: 'user' },
    'writing-guide': { need: 'prose', from: 'user' },
    'writing-check': { need: 'prose', from: 'user' },
    'ui-design': { need: 'ui', from: 'user' },
    plain: { always: true, from: 'user' },
  },
})
const needsOn = (...names: string[]): Session => ({ ...initSession(audienceConfig(), 's', 0, 'clear'), needs: Object.fromEntries(names.map((n) => [n, { since: 0, reason: 'test' }])) })

test('restore request: one line per audience, fixed sentences, chat trailer', () => {
  const c = audienceConfig()
  const text = ctx(decide(c, needsOn('prose', 'ui'), prompt('go on please now')).actions)
  assert.equal(text, [
    'Souffleur: before anything else, invoke these skills with the Skill tool, one after another:',
    '- writing-guide, writing-check: for texts other people read (docs, issues, PRs, app copy). Not for your replies in this chat.',
    '- ui-design: for what users of the product see (screens, pages, components). Not for your replies in this chat.',
    '- plain: for how you work on this task.',
    '- terse:terse-mode: for your replies in this chat.',
    'Your replies in this chat follow terse:terse-mode.',
  ].join('\n'))
})

test('restore request: no trailer without a readers or users group, no group line for nothing', () => {
  const c = audienceConfig()
  const text = ctx(decide(c, needsOn(), prompt('go on please now')).actions)
  assert.equal(text, [
    'Souffleur: before anything else, invoke these skills with the Skill tool, one after another:',
    '- plain: for how you work on this task.',
    '- terse:terse-mode: for your replies in this chat.',
  ].join('\n'))
})

test('restore after compaction keeps the compaction sentence after the groups', () => {
  const c = audienceConfig()
  const r = run(c, [loadSkill('plain'), compact(), prompt('next one please now')])
  assert.match(ctx(r.out.at(-1)!), /\n- plain: for how you work on this task\.\n- terse:terse-mode: for your replies in this chat\.\n.*must not be run again does not apply to them: invoke them again\.$/)
})

test('restore request stays under RESTORE_LIMIT with groups and never splits a name', () => {
  const names = Array.from({ length: 400 }, (_, i) => `a-long-skill-name-number-${i}`)
  const skills = Object.fromEntries(names.map((n, i) => [n, { need: i % 2 ? 'prose' : 'ui', from: 'user' as const }]))
  const c = cfg({ needs: audienceConfig().needs, skills })
  const s = { ...initSession(c, 's', 0, 'clear'), needs: { prose: { since: 0, reason: 't' }, ui: { since: 0, reason: 't' } } }
  const r = decide(c, s, prompt('go on please now'))
  const text = ctx(r.actions)
  assert.ok(text.length <= 5000, `length ${text.length}`)
  const asked = text.match(/a-long-skill-name-number-\d+/g)!
  assert.ok(asked.length > 10 && asked.length < 400)
  for (const n of asked) assert.ok(names.includes(n), n)
  const left = Object.entries(r.session.ledger).filter(([, row]) => row.state === 'absent').length
  assert.equal(left, 400 - asked.length)
})

test('notIn: a skill excluded in this root is not requested, gated, or listed in the brief check', () => {
  const c = cfg({
    needs: { ui: { for: 'users', what: 'Building a screen.' } },
    skills: {
      'ui-design': { need: 'ui', from: 'user', notIn: ['/work/p'], gate: { tools: ['Write'], paths: ['**/*.html'] }, duty: { after: { tools: ['Write'], paths: ['**/*.html'] }, evidence: { tool: 'Bash' } } },
      other: { need: 'ui', from: 'user' },
      mine: { always: true, from: 'user', notIn: ['/work/p'] },
    },
  })
  const s0 = { ...initSession(c, 's', 0, 'clear'), needs: { ui: { since: 0, reason: 't' } } }
  const p = decide(c, s0, { ...prompt('go on please now'), root: '/work/p/' } as CoreEvent)
  const text = ctx(p.actions)
  assert.match(text, /other/)
  assert.doesNotMatch(text, /ui-design|mine/)
  assert.equal(p.session.ledger['ui-design']!.state, 'absent')
  assert.equal(p.session.ledger['ui-design']!.requests, 0)
  const w = decide(c, p.session, { ...tool('Write', { path: 'x.html' }), root: '/work/p' } as CoreEvent)
  assert.deepEqual(w.actions.filter((a) => a.kind === 'deny'), [])
  assert.deepEqual(w.session.duties, [])
  const a = decide(c, w.session, { ...tool('Agent', { brief: 'do it' }), root: '/work/p' } as CoreEvent)
  const reason = (a.actions.find((x) => x.kind === 'deny') as { reason: string }).reason
  assert.match(reason, /Configured skills: other\./)
  // Elsewhere the skill counts as before.
  const e = decide(c, s0, { ...prompt('go on please now'), root: '/work/q' } as CoreEvent)
  assert.match(ctx(e.actions), /ui-design/)
})

test('restore: compaction sentence comes before the chat trailer, which is the last line', () => {
  const c = audienceConfig()
  const woken = { ...prompt('write the readme for this project now', ['prose']), classifierFailed: false, deliverable: 'text-for-others' } as CoreEvent
  const r = run(c, [loadSkill('writing-guide'), compact(), woken], needsOn('prose'))
  const lines = ctx(r.out.at(-1)!).split('\n')
  assert.match(lines.at(-2)!, /must not be run again does not apply/)
  assert.equal(lines.at(-1), 'Your replies in this chat follow terse:terse-mode.')
})

test('an always-on chat skill excluded in this root is not named in the trailer', () => {
  const c = audienceConfig()
  c.skills['terse:terse-mode'] = { always: true, for: 'chat', from: 'user', notIn: ['/work/p'] }
  const text = ctx(decide(c, needsOn('prose'), { ...prompt('go on please now'), root: '/work/p' } as CoreEvent).actions)
  assert.doesNotMatch(text, /terse:terse-mode|Your replies in this chat follow/)
})

test('gate denial names the audience of the skill', () => {
  const c = cfg({
    needs: { prose: { for: 'readers', what: 'Writing.' } },
    skills: { 'writing-guide': { need: 'prose', from: 'user', gate: { tools: ['Write'], paths: ['**/*.md'] } } },
  })
  const s = { ...initSession(c, 's', 0, 'clear'), needs: { prose: { since: 0, reason: 't' } } }
  const r = decide(c, s, tool('Write', { path: 'a.md' }))
  const reason = (r.actions.find((x) => x.kind === 'deny') as { reason: string }).reason
  assert.match(reason, /Souffleur: load writing-guide with the Skill tool first, then retry\. writing-guide is for texts other people read \(docs, issues, PRs, app copy\)\. Not for your replies in this chat\./)
})

const workCfg = cfg({
  needs: { ...base.needs, debug: { for: 'work', what: 'Debugging a failure.' } },
  skills: { ...base.skills, 'root-cause': { need: 'debug', from: 'user' } },
})
const failedPrompt = (): CoreEvent => ({ type: 'prompt', now: at(), text: 'x', fromUser: true, matched: [], classifierFailed: true })

test('after three classifier failures each prompt lists only the work needs, a good answer ends it', () => {
  const two = run(workCfg, [failedPrompt(), failedPrompt()])
  assert.doesNotMatch(ctx(two.out.at(-1)!), /cannot classify/)
  const three = run(workCfg, [failedPrompt()], two.s)
  assert.equal(ctx(three.out[0]!), 'Souffleur cannot classify prompts right now. If this prompt starts one of these, invoke its skills first: debug (Debugging a failure.): root-cause')
  const four = run(workCfg, [failedPrompt()], three.s)
  assert.match(ctx(four.out[0]!), /cannot classify prompts right now/)
  assert.doesNotMatch(ctx(four.out[0]!), /prose|writing-guide|ui-checklist/)
  const good = run(workCfg, [{ ...prompt('x'), classifierFailed: false } as CoreEvent], four.s)
  assert.doesNotMatch(ctx(good.out[0]!), /cannot classify/)
})

test('the prompt event carries the deliverable and it changes nothing by itself', () => {
  const r = run(workCfg, [{ ...prompt('x'), classifierFailed: false, deliverable: 'chat-reply' } as CoreEvent])
  assert.deepEqual(r.s.needs, {})
})

test('a failed call B counts no miss for work needs but still for others', () => {
  const c = cfg({ needs: { ...base.needs, debug: { for: 'work', what: 'Debugging a failure.' } }, skills: { ...base.skills, 'root-cause': { need: 'debug', from: 'user' } } })
  const start = run(c, [], { ...initSession(c, 'session-1', 0, 'clear'), needs: { debug: { since: 1, reason: 'need:debug from "x"', misses: 0 }, prose: { since: 1, reason: 'x', misses: 0 } } as never })
  const r = run(c, [{ ...prompt('please fix the failing test now'), classifierFailed: false, workFailed: true } as CoreEvent], start.s)
  assert.equal(r.s.needs.debug!.misses ?? 0, 0)
  assert.equal(r.s.needs.prose!.misses, 1)
})

test('three failed call B runs in a row record one classifier B error, a good B answer clears it', () => {
  const b = (workFailed?: boolean, deliverable: 'code-or-repo-work' | 'chat-reply' = 'code-or-repo-work'): CoreEvent =>
    ({ ...prompt('x'), classifierFailed: false, deliverable, ...(workFailed === undefined ? {} : { workFailed }) }) as CoreEvent
  const two = run(workCfg, [b(true), b(true)]).s
  assert.deepEqual(two.errors, [])
  const three = run(workCfg, [b(true)], two).s
  assert.equal(three.workFails, 3)
  assert.equal(three.errors.filter((m) => /^classifier B: /.test(m)).length, 1)
  assert.match(three.errors[0]!, /^classifier B: the small model failed to pick a work need 3 prompts in a row, so work needs are not detected$/)
  assert.match(statusLine(three, 'enforce')!, /^\d\d:\d\d · degraded, see \/souffleur$/)
  assert.equal(run(workCfg, [b(true)], three).s.errors.length, 1, 'recorded once')
  const good = run(workCfg, [b(false)], three).s
  assert.equal(good.workFails, 0)
  assert.deepEqual(good.errors, [])
})

test('a prompt where B did not run neither counts nor clears call B failures', () => {
  const chat = { ...prompt('x'), classifierFailed: false, deliverable: 'chat-reply' } as CoreEvent
  const fail = { ...prompt('x'), classifierFailed: false, deliverable: 'code-or-repo-work', workFailed: true } as CoreEvent
  const mid = run(workCfg, [fail, chat, fail, chat]).s
  assert.equal(mid.workFails, 2)
  assert.deepEqual(mid.errors, [])
  const three = run(workCfg, [fail], mid).s
  assert.equal(three.errors.length, 1)
  assert.equal(run(workCfg, [chat], three).s.errors.length, 1, 'chat does not clear')
  assert.equal(run(workCfg, [chat], three).s.workFails, 3)
})

test('after three call B failures the work fallback line comes only on a prompt A called code work', () => {
  const s = { ...initSession(workCfg, 'session-1', 0, 'clear'), workFails: 3 }
  const code = ctx(one(workCfg, [{ ...prompt('x'), classifierFailed: false, deliverable: 'code-or-repo-work', workFailed: true } as CoreEvent], s))
  assert.match(code, /^Souffleur cannot pick a work need right now\. If this prompt starts one of these, invoke its skills first: debug/m)
  assert.doesNotMatch(code, /cannot classify/)
  const chat = one(workCfg, [{ ...prompt('x'), classifierFailed: false, deliverable: 'chat-reply' } as CoreEvent], s)
  assert.doesNotMatch(JSON.stringify(chat), /cannot (classify|pick)/)
  const aFail = ctx(one(workCfg, [{ ...prompt('x'), classifierFailed: true } as CoreEvent], { ...s, workFails: 0, classifyFails: 3 }))
  assert.match(aFail, /cannot classify prompts right now/)
})

test('after three call B failures the prompt context carries the fallback line', () => {
  const s = { ...initSession(workCfg, 'session-1', 0, 'clear'), workFails: 3 }
  const text = ctx(one(workCfg, [{ ...prompt('x'), classifierFailed: false, deliverable: 'code-or-repo-work', workFailed: true } as CoreEvent], s))
  assert.match(text, /cannot pick a work need right now.*debug \(Debugging a failure\.\): root-cause/)
})

test('a stored session without workFails counts from zero', () => {
  const s = initSession(workCfg, 'session-1', 0, 'clear')
  assert.equal(s.workFails, undefined)
  assert.equal(run(workCfg, [{ ...prompt('x'), classifierFailed: false, workFailed: true } as CoreEvent], s).s.workFails, 1)
})

test('every error event counts per step, a recovery keeps the count, clear resets it, reload and resume keep it', () => {
  const err = (where: string): CoreEvent => ({ type: 'error', now: at(), where, message: 'boom' })
  const s = run(base, [err('tool.call'), err('tool.call'), { type: 'recovered', now: at(), where: 'tool.call' }, err('tool.call')]).s
  assert.deepEqual(s.failCounts, { 'tool.call': 3 })
  assert.equal(initSession(base, 'session-2', 0, 'clear').failCounts, undefined)
  for (const start of ['reload', 'resume'] as const) {
    assert.deepEqual(run(base, [{ type: 'start', now: at(), start }], s).s.failCounts, { 'tool.call': 3 }, start)
  }
  assert.equal(run(base, [{ type: 'start', now: at(), start: 'clear' }], s).s.failCounts, undefined, 'clear')
})

test('the third failure in a row of a tracked step adds one to its count, the step name without the colon', () => {
  const b = (workFailed: boolean): CoreEvent => ({ ...prompt('x'), classifierFailed: false, deliverable: 'code-or-repo-work', workFailed }) as CoreEvent
  const a = (classifierFailed: boolean): CoreEvent => ({ ...prompt('x'), classifierFailed }) as CoreEvent
  const afterB = run(workCfg, [b(true), b(true), b(true), b(true), b(false)]).s
  assert.deepEqual(afterB.failCounts, { 'classifier B': 1 })
  const both = run(workCfg, [a(true), a(true), a(true), b(true), b(true), b(true)]).s
  assert.deepEqual(both.failCounts, { classifier: 1, 'classifier B': 1 })
  assert.deepEqual(run(workCfg, [b(true), b(true)]).s.failCounts, undefined)
  const learn = run(workCfg, Array.from({ length: 3 }, () => ({ type: 'learned', now: at(), ok: false }) as CoreEvent)).s
  assert.deepEqual(learn.failCounts, { learn: 1 })
  assert.match(renderTable(workCfg, afterB, 1), /^Failures this session: classifier B 1$/m)
  assert.equal(initSession(workCfg, 'session-2', 0, 'clear').failCounts, undefined)
  assert.deepEqual(run(workCfg, [{ type: 'start', now: at(), start: 'resume' }], afterB).s.failCounts, { 'classifier B': 1 })
})

test('the told counts of problems are kept over reload and resume and reset by clear', () => {
  const s: Session = { ...initSession(base, 'session-1', 0, 'clear'), noticed: { cut: [], problems: ['degraded:tool.call'], tells: { 'degraded:tool.call': 2 } } }
  for (const start of ['reload', 'resume'] as const) {
    assert.deepEqual(run(base, [{ type: 'start', now: at(), start }], s).s.noticed?.tells, { 'degraded:tool.call': 2 }, start)
  }
  assert.equal(run(base, [{ type: 'start', now: at(), start: 'clear' }], s).s.noticed, undefined, 'clear')
  assert.equal(initSession(base, 'session-2', 0, 'clear').noticed, undefined, 'new session')
})

const fallbackCfg = (patch: Partial<Config>) => cfg({ needs: { ...base.needs, debug: { for: 'work', what: 'Debugging a failure.' } }, ...patch })
const failedSession = (c: Config, extra: Partial<Session> = {}) => ({ ...initSession(c, 'session-1', 0, 'clear'), classifyFails: 3, ...extra })
const fallbackLine = (c: Config, s: Session) => ctx(one(c, [failedPrompt()], s))

test('fallback line skips loaded skills and active needs', () => {
  const c = fallbackCfg({ skills: { ...base.skills, 'root-cause': { need: 'debug', from: 'user' }, 'second-look': { need: 'debug', from: 'user' } } })
  const s = failedSession(c)
  assert.match(fallbackLine(c, s), /debug \(Debugging a failure\.\): root-cause, second-look/)
  const loaded = { ...s, ledger: { ...s.ledger, 'root-cause': { ...s.ledger['root-cause']!, state: 'loaded' as const } } }
  assert.match(fallbackLine(c, loaded), /: second-look$/)
  const active = { ...s, needs: { debug: { since: 1, reason: 'command' } } }
  assert.doesNotMatch(fallbackLine(c, active), /cannot classify/)
})

test('fallback line leaves out untrusted project, notIn, not-installed skills; none while paused', () => {
  const c = fallbackCfg({ skills: { ...base.skills, 'proj-skill': { need: 'debug', from: 'project' }, 'user-skill': { need: 'debug', from: 'user', notIn: ['/work/p'] } } })
  assert.doesNotMatch(ctx(one(c, [{ ...failedPrompt(), root: '/work/p' } as CoreEvent], failedSession(c))), /cannot classify/)
  const c2 = fallbackCfg({ skills: { ...base.skills, 'proj-skill': { need: 'debug', from: 'project' }, ok: { need: 'debug', from: 'user' } } })
  const t = ctx(one(c2, [failedPrompt()], failedSession(c2)))
  assert.match(t, /: ok$/)
  assert.doesNotMatch(t, /proj-skill/)
  const s = failedSession(c2)
  const gone = { ...s, ledger: { ...s.ledger, ok: { ...s.ledger.ok!, state: 'not installed here' as const } } }
  assert.doesNotMatch(fallbackLine(c2, gone), /cannot classify/)
  assert.doesNotMatch(fallbackLine(c2, { ...s, paused: true }), /cannot classify/)
})

// --- tool evidence and dormant needs (audience PR 2, task 2) ---
const evCfg = (patch: Partial<Config> = {}): Config => cfg({
  skills: {
    'writing-guide': { need: 'prose', from: 'user' },
    'ui-design': { need: 'ui', from: 'user', gate: { tools: ['Write', 'Edit'], paths: ['**/*.html'] } },
  },
  ...patch,
})
const bash = (command: string, extra: Partial<Extract<CoreEvent, { type: 'tool' }>> = {}): CoreEvent => tool('Bash', { command, ...extra })
/** What the call said about skills: the deny reason (enforce) or the toolContext text (observe). */
const said = (a: Action[]): string => a.map((x) => (x.kind === 'deny' ? x.reason : x.kind === 'toolContext' ? x.text : '')).join('\n')
const sessionWith = (c: Config, needs: Session['needs']): Session => ({ ...initSession(c, 's', 0, 'clear'), needs })

test('evidence: a gate-path call starts the users need and asks for its skill', () => {
  const c = evCfg({ mode: 'observe' })
  const r = decide(c, initSession(c, 's', 0, 'clear'), tool('Write', { path: 'src/page.html' }))
  assert.match(r.session.needs.ui!.reason, /^tool: Write src\/page\.html/)
  assert.equal(r.session.ledger['ui-design']!.requests, 1)
  assert.match(said(r.actions), /ui-design/)
})

test('evidence: gate-path call in enforce mode denies until the skill is loaded', () => {
  const c = evCfg()
  const r = decide(c, initSession(c, 's', 0, 'clear'), tool('Write', { path: 'src/page.html' }))
  assert.equal(denies(r.actions).length, 1)
  assert.ok('ui' in r.session.needs)
})

test('evidence: gh issue comment starts readers, not users', () => {
  const c = evCfg()
  const r = decide(c, initSession(c, 's', 0, 'clear'), bash('gh issue comment 12 --body x'))
  assert.match(r.session.needs.prose!.reason, /^tool: Bash gh issue comment/)
  assert.equal('ui' in r.session.needs, false)
  assert.match(said(r.actions), /writing-guide/)
})

test('evidence: each listed command starts readers', () => {
  const c = evCfg()
  for (const cmd of ['gh issue create -t x', 'gh issue comment 1 -b x', 'gh pr create --fill', 'gh pr edit 3 --body y']) {
    assert.ok('prose' in decide(c, initSession(c, 's', 0, 'clear'), bash(cmd)).session.needs, cmd)
  }
  for (const cmd of ['git status', 'git commit -m x', 'git commit', 'gh pr view 3', 'echo hello']) {
    assert.equal('prose' in decide(c, initSession(c, 's', 0, 'clear'), bash(cmd)).session.needs, false, cmd)
  }
})

test('evidence: a text command inside a chained command counts', () => {
  const c = evCfg()
  for (const cmd of ['cd x && gh pr create --fill', 'git push ; gh pr edit 1 -b a', 'npm test || gh issue create -t b']) {
    assert.ok('prose' in decide(c, initSession(c, 's', 0, 'clear'), bash(cmd)).session.needs, cmd)
  }
})

test('evidence: a need already active is only refreshed, not requested again', () => {
  const c = evCfg()
  const s0 = sessionWith(c, { prose: { since: 1, reason: 'need:prose from "x"', misses: 5 } })
  const r = decide(c, s0, bash('gh pr create -t x'))
  assert.equal(r.session.needs.prose!.reason, 'need:prose from "x"')
  assert.equal(r.session.needs.prose!.since, 1)
  assert.equal(r.session.needs.prose!.misses, 0)
  assert.equal(said(r.actions), '')
})

test('evidence: a paused session starts nothing; a subagent call starts nothing', () => {
  const c = evCfg()
  const paused = { ...initSession(c, 's', 0, 'clear'), paused: true }
  assert.equal('prose' in decide(c, paused, bash('gh pr create -t x')).session.needs, false)
  assert.equal('prose' in decide(c, initSession(c, 's', 0, 'clear'), bash('gh pr create -t x', { agentId: 'a1' })).session.needs, false)
})

test('compaction: readers and users needs go dormant, chat and work keep going', () => {
  const c = evCfg({ needs: { ...base.needs, debug: { for: 'work', what: 'Debugging.' } }, skills: { ...evCfg().skills, root: { need: 'debug', from: 'user' } } })
  const s0 = sessionWith(c, { prose: { since: 1, reason: 't' }, ui: { since: 1, reason: 't' }, debug: { since: 1, reason: 't' } })
  const s = decide(c, s0, compact()).session
  assert.equal(s.needs.prose!.dormant, true)
  assert.equal(s.needs.ui!.dormant, true)
  assert.equal(s.needs.debug!.dormant, undefined)
})

test('Review Focus 3: a dormant readers need requests nothing on the first prompt after compaction, but does on gh pr create', () => {
  const c = evCfg()
  const s0 = sessionWith(c, { prose: { since: 1, reason: 't' } })
  const r = run(c, [compact(), prompt('please carry on with this now')], s0)
  assert.doesNotMatch(ctx(r.out.at(-1)!), /writing-guide/)
  assert.equal(r.s.ledger['writing-guide']!.requests, 0)
  const t1 = decide(c, r.s, bash('gh pr create --fill'))
  assert.match(said(t1.actions), /writing-guide/)
  assert.equal(t1.session.needs.prose!.dormant, undefined)
})

test('dormant: a dormant users need is not counted as active for the Agent brief check', () => {
  const c = evCfg()
  const s0 = sessionWith(c, { ui: { since: 1, reason: 't', dormant: true } })
  const w = decide(c, s0, tool('Agent', { brief: 'do it' }))
  // dormant ui does not count as active: no brief denial
  assert.deepEqual(denies(w.actions), [])
})

test('dormant: A answering text-for-others or screen wakes the matching dormant needs only', () => {
  const c = evCfg()
  const dormant = sessionWith(c, { prose: { since: 1, reason: 't', dormant: true }, ui: { since: 1, reason: 't', dormant: true } })
  const a = decide(c, dormant, { ...prompt('write the readme for this project', ['prose']), classifierFailed: false, deliverable: 'text-for-others' } as CoreEvent)
  assert.equal(a.session.needs.prose!.dormant, undefined)
  assert.equal(a.session.needs.ui!.dormant, true)
  assert.match(ctx(a.actions), /writing-guide/)
  assert.doesNotMatch(ctx(a.actions), /ui-design/)
  const b = decide(c, dormant, { ...prompt('build the settings page for me', ['ui']), classifierFailed: false, deliverable: 'screen' } as CoreEvent)
  assert.equal(b.session.needs.ui!.dormant, undefined)
  assert.equal(b.session.needs.prose!.dormant, true)
})

test('dormant: a chat-reply prompt keeps the need dormant', () => {
  const c = evCfg()
  const dormant = sessionWith(c, { prose: { since: 1, reason: 't', dormant: true } })
  const a = decide(c, dormant, { ...prompt('warum steht dort restoring bitte genau'), classifierFailed: false, deliverable: 'chat-reply' } as CoreEvent)
  assert.equal(a.session.needs.prose!.dormant, true)
  assert.doesNotMatch(ctx(a.actions), /writing-guide/)
})

test('expiry: readers need counts a miss only when A answered another deliverable; 20 end it', () => {
  const c = evCfg()
  let s = sessionWith(c, { prose: { since: 1, reason: 't' }, ui: { since: 1, reason: 't' } })
  const p = (deliverable: 'chat-reply' | 'text-for-others' | 'screen' | 'code-or-repo-work', matched: string[]): CoreEvent => ({ ...prompt('this is a longer prompt text', matched), classifierFailed: false, deliverable } as CoreEvent)
  s = decide(c, s, p('chat-reply', [])).session
  assert.equal(s.needs.prose!.misses, 1)
  assert.equal(s.needs.ui!.misses, 1)
  s = decide(c, s, p('text-for-others', ['prose'])).session
  assert.equal(s.needs.prose!.misses, 0)
  assert.equal(s.needs.ui!.misses, 2)
  for (let i = 0; i < 18; i++) s = decide(c, s, p('code-or-repo-work', [])).session
  assert.equal('ui' in s.needs, false)
  assert.equal(s.needs.prose!.misses, 18)
  // short prompts and failed classification do not count
  const short = decide(c, s, { ...prompt('ja', []), classifierFailed: false, deliverable: 'chat-reply' } as CoreEvent).session
  assert.equal(short.needs.prose!.misses, 18)
})

test('Review Focus 5: evidence in a notIn root requests no excluded skill; untrusted project skills and needs are not requested', () => {
  const c = evCfg({ skills: { 'writing-guide': { need: 'prose', from: 'user', notIn: ['/work/p'] }, 'writing-check': { need: 'prose', from: 'user' } } })
  const r = decide(c, initSession(c, 's', 0, 'clear'), bash('gh pr create -t x', { root: '/work/p/' }))
  const text = said(r.actions)
  assert.match(text, /writing-check/)
  assert.doesNotMatch(text, /writing-guide/)
  assert.equal(r.session.ledger['writing-guide']!.requests, 0)
  // all skills excluded: no need starts at all
  const c2 = evCfg({ skills: { 'writing-guide': { need: 'prose', from: 'user', notIn: ['/work/p'] }, 'ui-design': { need: 'ui', from: 'user', notIn: ['/work/p'], gate: { tools: ['Write'], paths: ['**/*.html'] } } } })
  const r2 = decide(c2, initSession(c2, 's', 0, 'clear'), bash('gh pr create -t x', { root: '/work/p' }))
  assert.deepEqual(r2.session.needs, {})
  const r3 = decide(c2, initSession(c2, 's', 0, 'clear'), tool('Write', { path: 'a.html', root: '/work/p' }))
  assert.deepEqual(r3.session.needs, {})
  assert.deepEqual(denies(r3.actions), [])
  // untrusted project skill/need, root not in trustProjects
  const c3 = evCfg({ needs: { prose: { for: 'readers', what: 'w' } }, projectNeeds: ['prose'], skills: { 'proj-guide': { need: 'prose', from: 'project' } } })
  const r4 = decide(c3, initSession(c3, 's', 0, 'clear'), bash('gh pr create -t x', { root: '/work/q' }))
  assert.deepEqual(r4.session.needs, {})
  assert.equal(r4.actions.filter((a) => a.kind === 'toolContext').length, 0)
  const trusted = evCfg({ ...c3, trustProjects: ['/work/q'] })
  assert.ok('prose' in decide(trusted, initSession(trusted, 's', 0, 'clear'), bash('gh pr create -t x', { root: '/work/q' })).session.needs)
})

// --- fix round 1 ---
test('evidence in enforce: the first call is denied once with the scoped restore text, the retry passes', () => {
  const c = evCfg()
  for (const ev of [bash('gh pr create --fill'), tool('Write', { path: 'a.html' })]) {
    const r1 = decide(c, initSession(c, 's', 0, 'clear'), ev)
    assert.equal(denies(r1.actions).length, 1)
    assert.equal(r1.actions.filter((a) => a.kind === 'toolContext').length, 0)
    const own = ev.type === 'tool' && ev.tool === 'Bash' ? 'writing-guide' : 'ui-design'
    assert.match(said(r1.actions), new RegExp(own))
    assert.equal(r1.session.ledger[own]!.requests, 1)
    const r2 = decide(c, r1.session, { ...ev, now: at() } as CoreEvent)
    if (own === 'writing-guide') assert.deepEqual(denies(r2.actions), [])
    assert.equal(r2.session.ledger[own]!.requests, 1)
  }
})

test('evidence in observe: no denial, toolContext after the call', () => {
  const c = evCfg({ mode: 'observe' })
  for (const ev of [bash('gh pr create --fill'), tool('Write', { path: 'a.html' })]) {
    const r = decide(c, initSession(c, 's', 0, 'clear'), ev)
    assert.deepEqual(denies(r.actions), [])
    assert.equal(r.actions.filter((a) => a.kind === 'toolContext').length, 1)
  }
})

test('evidence restore is scoped to the started need; the deny names every skill it counted', () => {
  const c = evCfg({ skills: { ...evCfg().skills, 'other-ui': { need: 'ui', from: 'user' }, 'terse:terse-mode': { always: true, from: 'user' } } })
  const r = decide(c, initSession(c, 's', 0, 'clear'), bash('gh pr create -t x'))
  assert.match(said(r.actions), /writing-guide/)
  assert.doesNotMatch(said(r.actions), /terse|ui-design|other-ui/)
  for (const n of ['terse:terse-mode', 'ui-design', 'other-ui']) assert.equal(r.session.ledger[n]!.requests, 0, n)
  assert.equal(r.session.ledger['writing-guide']!.requests, 1)
})

test('gate-path call on a dormant users need wakes it (observe: toolContext, enforce: deny)', () => {
  for (const mode of ['observe', 'enforce'] as const) {
    const c = evCfg({ mode })
    const s0 = sessionWith(c, { ui: { since: 1, reason: 't', dormant: true } })
    const r = decide(c, s0, tool('Write', { path: 'a.html' }))
    assert.equal(r.session.needs.ui!.dormant, undefined)
    assert.match(said(r.actions), /ui-design/)
    assert.equal(denies(r.actions).length, mode === 'enforce' ? 1 : 0)
  }
})

test('contextNotes: notes of a dormant need wait until it wakes', () => {
  const c = evCfg({ notes: [{ id: 'n1', text: 'Write short.', need: 'prose', source: 'user' }] })
  const s0 = sessionWith(c, { prose: { since: 1, reason: 't', dormant: true } })
  assert.doesNotMatch(ctx(decide(c, s0, prompt('a prompt of some words here')).actions), /Write short/)
  const w = decide(c, s0, { ...prompt('write the readme for the project now', ['prose']), classifierFailed: false, deliverable: 'text-for-others' } as CoreEvent)
  assert.match(ctx(w.actions), /Write short/)
})

test('commands: prefixes and assignments are normalised; git commit and look-alikes are not text commands', () => {
  const c = evCfg()
  for (const cmd of ['GH_TOKEN=x gh pr create -t a', 'env A=1 gh pr create', 'sudo gh pr edit 1', 'time gh issue comment 1', 'command gh pr create', 'FOO=1 BAR=2 gh pr create']) {
    assert.ok('prose' in decide(c, initSession(c, 's', 0, 'clear'), bash(cmd)).session.needs, cmd)
  }
  for (const cmd of ['git commit-graph write', 'git commit -m a', 'gh pr create-x', 'gh pr view 1']) {
    assert.equal('prose' in decide(c, initSession(c, 's', 0, 'clear'), bash(cmd)).session.needs, false, cmd)
  }
})

test('commands: a quoted gh pr create inside echo counts (accepted false positive)', () => {
  const c = evCfg()
  assert.ok('prose' in decide(c, initSession(c, 's', 0, 'clear'), bash('echo "ok && gh pr create -t x"')).session.needs)
})

test('compaction: a need set with the command never goes dormant', () => {
  const c = evCfg()
  const s = decide(c, sessionWith(c, { prose: { since: 1, reason: 'command' }, ui: { since: 1, reason: 't' } }), compact()).session
  assert.equal(s.needs.prose!.dormant, undefined)
  assert.equal(s.needs.ui!.dormant, true)
})

test('trust: a prompt does not wake a project-only dormant need in an untrusted root', () => {
  const c = evCfg({ needs: { prose: { for: 'readers', what: 'w' } }, projectNeeds: ['prose'], skills: { 'proj-guide': { need: 'prose', from: 'project' } } })
  const s0 = sessionWith(c, { prose: { since: 1, reason: 't', dormant: true } })
  const r = decide(c, s0, { ...prompt('write the readme for the project now'), classifierFailed: false, deliverable: 'text-for-others', root: '/work/q' } as CoreEvent)
  assert.equal(r.session.needs.prose!.dormant, true)
})

test('status: a dormant need is listed as waiting since compaction', async () => {
  const { statusText } = await import('../src/core/decide.ts')
  const c = evCfg()
  const text = statusText(c, sessionWith(c, { prose: { since: 0, reason: 't', dormant: true }, ui: { since: 0, reason: 't' } }), 1)
  assert.match(text, /- prose \(since \d\d:\d\d, waiting since compaction\)/)
  assert.match(text, /- ui \(since \d\d:\d\d\)/)
})

// --- final fix wave: evidence needs stay quiet in chat, fresh signals reset requests ---
const aPrompt = (deliverable: string, text = 'write the readme for the project now', matched: string[] = []): CoreEvent => ({ ...prompt(text, matched), classifierFailed: false, deliverable } as CoreEvent)

test('evidence need: the evidence call requests, a chat-reply prompt does not, a text prompt does again', () => {
  const c = evCfg({ mode: 'observe' })
  const a = run(c, [bash('gh pr create -t x')])
  assert.equal(a.s.ledger['writing-guide']!.requests, 1)
  const chat = run(c, [bash('gh pr create -t x'), aPrompt('chat-reply', 'what does this do exactly')])
  assert.doesNotMatch(ctx(chat.out[1]!), /writing-guide/)
  assert.equal(chat.s.ledger['writing-guide']!.requests, 1)
  const failed = run(c, [bash('gh pr create -t x'), { ...prompt('what does this do exactly'), classifierFailed: true } as CoreEvent])
  assert.doesNotMatch(ctx(failed.out[1]!), /writing-guide/)
  const again = run(c, [bash('gh pr create -t x'), aPrompt('chat-reply', 'what does this do exactly'), aPrompt('text-for-others', 'write the readme for the project now', ['prose'])])
  assert.match(ctx(again.out[2]!), /writing-guide/)
  assert.equal(again.s.ledger['writing-guide']!.state, 'restoring')
})

test('a fresh deliverable signal resets requests and brings an unavailable skill back', () => {
  const c = evCfg({ mode: 'observe' })
  const r = run(c, [
    aPrompt('text-for-others', 'write the readme for the project now', ['prose']),
    aPrompt('code-or-repo-work', 'fix the parser for the new input format'),
    aPrompt('code-or-repo-work', 'fix the lexer for the new input format'),
  ])
  assert.equal(r.s.ledger['writing-guide']!.state, 'unavailable')
  const readme = decide(c, r.s, aPrompt('text-for-others', 'update the readme for the project now', ['prose']))
  assert.match(ctx(readme.actions), /writing-guide/)
  assert.equal(readme.session.ledger['writing-guide']!.state, 'restoring')
  assert.equal(readme.session.ledger['writing-guide']!.requests, 1)
})

test('observe records the first evidence call as would have denied', () => {
  const c = evCfg({ mode: 'observe' })
  const r = decide(c, initSession(c, 's', 0, 'clear'), bash('gh pr create -t x'))
  assert.equal(r.session.observed.length, 1)
  assert.match(r.session.observed[0]!.reason, /writing-guide/)
  assert.match(said(r.actions), /writing-guide/)
})

test('the compaction sentence appears only after a compaction', () => {
  const c = evCfg({ mode: 'observe' })
  const plain = run(c, [aPrompt('text-for-others', 'write the readme for the project now', ['prose']), aPrompt('text-for-others', 'write the readme for the project again', ['prose'])])
  assert.match(ctx(plain.out[1]!), /writing-guide/)
  assert.doesNotMatch(ctx(plain.out[1]!), /Compaction cut/)
  const cut = run(c, [aPrompt('text-for-others', 'write the readme for the project now', ['prose']), loadSkill('writing-guide'), compact(), aPrompt('text-for-others', 'write the readme for the project again', ['prose'])])
  assert.match(ctx(cut.out[3]!), /Compaction cut/)
})

// --- reply check ---

const replyCfg = (mode: 'observe' | 'enforce' = 'enforce', reply: { maxChars?: number; headings?: number } = { maxChars: 100, headings: 0 }): Config =>
  cfg({ mode, skills: { 'terse:terse-mode': { always: true, for: 'chat', from: 'user', reply }, ...base.skills } })
const LONG = 'word '.repeat(60)
const reply = (answer: string, extra: Partial<Extract<CoreEvent, { type: 'reply' }>> = {}): CoreEvent => ({ type: 'reply', now: at(), answer, fromCommand: false, aborted: false, ...extra })
const loaded = (c: Config, extra: CoreEvent[] = []) => run(c, [loadSkill('terse:terse-mode'), ...extra]).s

test('reply: a violation is counted and the next prompt carries one reminder line', () => {
  const c = replyCfg()
  const r = run(c, [loadSkill('terse:terse-mode'), reply(`# Head\n${LONG}`), prompt('next')])
  assert.deepEqual(r.s.replyCheck && { total: r.s.replyCheck.total, over: r.s.replyCheck.over }, { total: 1, over: 1 })
  assert.match(ctx(r.out.at(-1)!), /^Souffleur: your last reply had 307 characters and 1 heading \(limit 100 characters, 0 headings\)\. Replies in this chat follow terse:terse-mode\.$/m)
  assert.equal(r.s.replyCheck?.pending, undefined)
})

test('reply: without a headings limit the headings part is omitted, without maxChars the characters part', () => {
  const a = run(replyCfg('enforce', { maxChars: 100 }), [loadSkill('terse:terse-mode'), reply(LONG), prompt('x')])
  assert.match(ctx(a.out.at(-1)!), /Souffleur: your last reply had 300 characters \(limit 100 characters\)\. Replies in this chat follow terse:terse-mode\./)
  const b = run(replyCfg('enforce', { headings: 1 }), [loadSkill('terse:terse-mode'), reply('# a\n## b\nok'), prompt('x')])
  assert.match(ctx(b.out.at(-1)!), /Souffleur: your last reply had 2 headings \(limit 1 heading\)\. Replies in this chat follow terse:terse-mode\./)
})

test('reply: a reply within the limits is counted but gives no reminder and clears a waiting one', () => {
  const c = replyCfg()
  const r = run(c, [loadSkill('terse:terse-mode'), reply(LONG), reply('short'), prompt('x')])
  assert.equal(r.s.replyCheck?.total, 2)
  assert.equal(r.s.replyCheck?.over, 1)
  assert.doesNotMatch(ctx(r.out.at(-1)!), /last reply/)
})

test('reply: a long reply that is mostly a code block is not a violation', () => {
  const answer = `ok\n\`\`\`ts\n${'x'.repeat(3000)}\n\`\`\`\n`
  const r = run(replyCfg(), [loadSkill('terse:terse-mode'), reply(answer), prompt('x')])
  assert.equal(r.s.replyCheck?.over ?? 0, 0)
  assert.doesNotMatch(ctx(r.out.at(-1)!), /last reply/)
})

test('reply: a reply to a typed command, an aborted turn and a paused session are not checked', () => {
  const c = replyCfg()
  for (const e of [reply(LONG, { fromCommand: true }), reply(LONG, { aborted: true })]) {
    const r = run(c, [loadSkill('terse:terse-mode'), e, prompt('x')])
    assert.equal(r.s.replyCheck, undefined)
    assert.doesNotMatch(ctx(r.out.at(-1)!), /last reply/)
  }
  const paused = run(c, [loadSkill('terse:terse-mode'), command('pause'), reply(LONG), prompt('x')])
  assert.equal(paused.s.replyCheck, undefined)
  assert.doesNotMatch(ctx(paused.out.at(-1)!), /last reply/)
})

test('reply: six violating replies in a row remind on prompts 1 and 6 only', () => {
  const c = replyCfg()
  let s = loaded(c)
  const reminded: boolean[] = []
  for (let i = 0; i < 6; i++) {
    s = decide(c, s, reply(LONG)).session
    const r = decide(c, s, prompt(`p${i + 1}`))
    s = r.session
    reminded.push(/last reply/.test(ctx(r.actions)))
  }
  assert.deepEqual(reminded, [true, false, false, false, false, true])
  assert.equal(s.replyCheck?.total, 6)
  assert.equal(s.replyCheck?.over, 6)
})

test('reply: the reminder is context, not a notice, and notices false does not change it', () => {
  const c = { ...replyCfg(), notices: false }
  const r = run(c, [loadSkill('terse:terse-mode'), reply(LONG), prompt('x')])
  assert.match(ctx(r.out.at(-1)!), /last reply/)
  assert.deepEqual(r.out.at(-1)!.map((a) => a.kind).filter((k) => k !== 'context'), [])
})

test('reply: both modes only remind; the skill stays loaded however many violations come', () => {
  for (const mode of ['enforce', 'observe'] as const) {
    const r = run(replyCfg(mode), [loadSkill('terse:terse-mode'), reply(LONG), reply(LONG), reply(LONG)])
    assert.equal(r.s.ledger['terse:terse-mode']?.state, 'loaded')
    assert.equal(r.s.replyCheck?.over, 3)
    assert.equal('streak' in (r.s.replyCheck ?? {}), false)
  }
})

test('reply: singular heading in the reminder', () => {
  const r = run(replyCfg('enforce', { headings: 1, maxChars: 200 }), [loadSkill('terse:terse-mode'), reply(`# a\n## b\n${'x'.repeat(10)}`), prompt('x')])
  assert.match(ctx(r.out.at(-1)!), /had 19 characters and 2 headings \(limit 200 characters, 1 heading\)/)
  const one = run(replyCfg('enforce', { headings: 0, maxChars: 200 }), [loadSkill('terse:terse-mode'), reply('# a\nb'), prompt('x')])
  assert.match(ctx(one.out.at(-1)!), /and 1 heading \(limit 200 characters, 0 headings\)/)
})

test('reply: nothing is ever denied by the reply check', () => {
  const r = run(replyCfg('enforce'), [loadSkill('terse:terse-mode'), reply(LONG), reply(LONG), tool('Bash', { command: 'ls' })])
  assert.deepEqual(denies(r.out.at(-1)!), [])
})

test('reply: counts survive a resume and a reload, and restart on a clear', () => {
  const c = replyCfg()
  const s = run(c, [loadSkill('terse:terse-mode'), reply(LONG)]).s
  for (const start of ['resume', 'reload'] as const) {
    const back = decide(c, s, { type: 'start', now: at(), start }).session
    assert.equal(back.replyCheck?.over, 1)
    assert.equal(back.replyCheck?.total, 1)
    assert.equal(JSON.parse(JSON.stringify(back)).replyCheck.over, 1)
  }
  assert.equal(decide(c, s, { type: 'start', now: at(), start: 'clear' }).session.replyCheck, undefined)
})

test('reply: a config without reply does no counting and no reminder', () => {
  const r = run(withAlways, [loadSkill('terse:terse-mode'), reply(LONG), prompt('x')])
  assert.equal(r.s.replyCheck, undefined)
  assert.doesNotMatch(ctx(r.out.at(-1)!), /last reply/)
})

test('reply: a chat skill excluded in this root or a project skill of an untrusted root is not checked', () => {
  const c = replyCfg()
  c.skills['terse:terse-mode']!.notIn = ['/work/a']
  assert.equal(decide(c, loaded(c), reply(LONG, { root: '/work/a' })).session.replyCheck, undefined)
  assert.equal(decide(c, loaded(c), reply(LONG, { root: '/work/b' })).session.replyCheck?.over, 1)
  const p = replyCfg()
  p.skills['terse:terse-mode']!.from = 'project'
  assert.equal(decide(p, loaded(p), reply(LONG, { root: '/work/b' })).session.replyCheck, undefined)
})

test('a skill cut by compaction whose need ended mid-restore still gets the invoke-again note when it is needed again', () => {
  const c = cfg()
  const s0 = initSession(c, 'session-1', 0, 'clear')
  const row = { state: 'restoring' as const, since: 1, reason: '', requests: 1, lastCompactAt: 5 }
  const start: Session = { ...s0, needs: { ui: { since: 1, reason: 'r', misses: 19 } }, ledger: { ...s0.ledger, 'ui-checklist': row } }
  const s = run(c, [classified([])], start).s
  assert.equal('ui' in s.needs, false)
  assert.equal(s.ledger['ui-checklist']!.state, 'absent')
  assert.equal(s.ledger['ui-checklist']!.lastCompactAt, 5)
  const text = ctx(one(c, [classified(['ui'])], s))
  assert.match(text, /ui-checklist/)
  assert.match(text, /invoke them again\./)
})

test('a skill loaded after the compaction asks for no invoke-again note when its need starts again', () => {
  const c = cfg()
  let s = run(c, [compact(), classified(['ui']), loadSkill('ui-checklist')], uiLoaded(c)).s
  assert.equal(s.ledger['ui-checklist']!.lastCompactAt, undefined)
  s = run(c, repeat(20, () => classified([])), s).s
  assert.equal('ui' in s.needs, false)
  // The row left the loaded state by hand, as when its text was lost without a compaction.
  s = { ...s, ledger: { ...s.ledger, 'ui-checklist': { ...s.ledger['ui-checklist']!, state: 'absent' } } }
  const text = ctx(one(c, [classified(['ui'])], s))
  assert.match(text, /ui-checklist/)
  assert.doesNotMatch(text, /invoke them again/)
})

// #30: a skill that never loads must not deny every call for the rest of the turn.
const stuck = () => run(base, [prompt('screen', ['ui'])]).s
const tryLoad = (skill = 'ui-checklist') => tool('Skill', { skill })
const html = (n = 1) => Array.from({ length: n }, () => tool('Write', { path: 'x.html' }))

test('release: the 4th gated call of a turn passes after 3 denials and is recorded', () => {
  // No duty: a duty denies the next gated call once, and duties are not part of the release.
  const { duty: _d, ...gateOnly } = base.skills['ui-checklist']!
  const config = cfg({ skills: { ...base.skills, 'ui-checklist': gateOnly } })
  const s0 = run(config, [prompt('screen', ['ui'])]).s
  const none = run(config, html(5), s0)
  assert.deepEqual(none.out.map((a) => denies(a).length), [1, 1, 1, 1, 1], 'no load attempt: the gate keeps denying')
  assert.deepEqual(none.s.errors, [])
  const r = run(config, [...html(1), tryLoad(), ...html(4)], s0)
  assert.deepEqual(r.out.slice(1).map((a) => denies(a).length), [0, 1, 1, 0, 0])
  const note = r.s.observed.filter((o) => /released after 3 denials: ui-checklist did not load/.test(o.reason))
  assert.equal(note.length, 2)
  assert.deepEqual(r.s.errors.filter((e) => e.startsWith('gate: ')), ['gate: ui-checklist did not load after 3 denials in a turn; calls released'])
})

test('release: a skill that loads after 2 denials is gated normally, and the counter resets on the next prompt', () => {
  const s0 = run(base, [...html(2), tryLoad(), loadSkill('ui-checklist')], stuck()).s
  assert.deepEqual(denies(one(base, html(1), s0)), [])
  const stale = run(base, [compact()], s0).s
  assert.equal(denies(one(base, html(1), stale)).length, 1, 'gated again after the compaction')
  const released = run(base, [...html(1), tryLoad(), ...html(3)], stuck()).s
  assert.equal(released.turnDenials?.['ui-checklist'], 3)
  const next = run(base, [prompt('again', ['ui'])], released)
  assert.deepEqual(next.s.turnDenials, {})
  assert.deepEqual(next.s.turnTries, [])
  assert.equal(denies(one(base, html(1), next.s)).length, 1)
})

// Without the duty, which denies the next gated call once and is not part of the release.
const gateOnlyCfg = () => {
  const { duty: _d, ...gateOnly } = base.skills['ui-checklist']!
  return cfg({ skills: { ...base.skills, 'ui-checklist': gateOnly } })
}

test('release: a Skill load attempt made before the first denial does not count', () => {
  const config = gateOnlyCfg()
  const s0 = run(config, [prompt('screen', ['ui'])]).s
  const r = run(config, [tryLoad(), ...html(4)], s0)
  assert.deepEqual(r.out.slice(1).map((a) => denies(a).length), [1, 1, 1, 1], 'the 4th call is still denied')
  const after = run(config, [...html(1), tryLoad(), ...html(4)], s0)
  assert.deepEqual(after.out.slice(2).map((a) => denies(a).length), [1, 1, 0, 0], 'a try after a denial releases as before')
})

test('release: the restore denial after a compaction counts, so a try made in answer to it can release', () => {
  const config = gateOnlyCfg()
  // 1 restore denial (it names the skill), the try, then 2 more denials make 3; the next call passes.
  const r = run(config, [prompt('screen', ['ui']), compact(), ...html(1), tryLoad(), ...html(3)])
  assert.deepEqual(r.out.slice(2).map((a) => denies(a).length), [1, 0, 1, 1, 0])
})

test('release: a skill that loads starts its release state again, so a later stall needs a fresh try', () => {
  const config = gateOnlyCfg()
  const s0 = run(config, [prompt('screen', ['ui']), ...html(1), tryLoad(), loadSkill('ui-checklist'), compact()]).s
  assert.equal(s0.turnDenials?.['ui-checklist'], undefined)
  assert.deepEqual(s0.turnTries, [])
  // The first call after the compaction is denied by the restore request and counts for its skill, the next 3 are gate denials:
  // the count is past 3, but there is no load attempt since the load, so all 4 calls are denied.
  const r = run(config, html(4), s0)
  assert.deepEqual(r.out.map((a) => denies(a).length), [1, 1, 1, 1], 'the denial before the load does not add up')
  const again = run(config, [tryLoad(), ...html(1)], r.s)
  assert.equal(denies(again.out[1]!).length, 0, 'a fresh try after the denials releases')
})

test('release: two stuck skills are counted separately', () => {
  const two = cfg({ skills: { ...base.skills, 'css-guide': { need: 'ui', from: 'user', gate: { tools: ['Write'], paths: ['**/*.css'] } } } })
  const s0 = run(two, [prompt('screen', ['ui'])]).s
  const css = tool('Write', { path: 'a.css' })
  const r = run(two, [...html(1), tryLoad(), ...html(2), css, ...html(1), css], s0)
  assert.deepEqual(r.out.filter((_, i) => [0, 2, 3, 4, 5, 6].includes(i)).map((a) => denies(a).length), [1, 1, 1, 1, 0, 1])
})

test('release: observe mode never denies, never releases and records every would-deny as before', () => {
  const config = cfg({ mode: 'observe' })
  const s0 = run(config, [prompt('screen', ['ui'])]).s
  const r = run(config, html(5), s0)
  assert.deepEqual(r.out.flatMap(denies), [])
  assert.equal(r.s.observed.length, 5)
  assert.ok(r.s.observed.every((o) => !/released/.test(o.reason)))
  assert.deepEqual(r.s.errors, [])
})

test('release: an unavailable skill is never denied and is recorded as such', () => {
  const { s } = run(base, [prompt('screen', ['ui']), prompt('2'), prompt('3')])
  assert.equal(s.ledger['ui-checklist']!.state, 'unavailable')
  const r = run(base, html(1), s)
  assert.deepEqual(denies(r.out[0]!), [])
  assert.match(r.s.observed.at(-1)!.reason, /ui-checklist.*\(skill unavailable\)/)
})

test('release: a skill rule releases after 3 denials too', () => {
  const rule = { id: 'agent-needs-guide', before: { tools: ['Agent'] }, skill: 'writing-guide', source: 'user' }
  const config = cfg({ rules: [rule] })
  const s0 = run(config, [prompt()]).s
  assert.equal(s0.ledger['writing-guide']!.state, 'absent')
  const agent = () => tool('Agent', { brief: 'skills: none' })
  const r = run(config, [agent(), tryLoad('writing-guide'), agent(), agent(), agent(), agent()], s0)
  assert.deepEqual(r.out.map((a) => denies(a).length), [1, 0, 1, 1, 0, 0])
  assert.ok(r.s.observed.some((o) => /released after 3 denials: writing-guide did not load/.test(o.reason)))
})

test('release: a skill that loads drops its gate error; another stuck skill keeps its own', () => {
  const two = cfg({ skills: { ...base.skills, 'css-guide': { need: 'ui', from: 'user', gate: { tools: ['Write'], paths: ['**/*.css'] } } } })
  const { duty: _d, ...gateOnly } = two.skills['ui-checklist']!
  const config = cfg({ skills: { ...two.skills, 'ui-checklist': gateOnly } })
  const css = tool('Write', { path: 'a.css' })
  const s0 = run(config, [prompt('screen', ['ui'])]).s
  const s1 = run(config, [...html(1), tryLoad(), ...html(3), css, tryLoad('css-guide'), css, css, css], s0).s
  assert.equal(s1.errors.filter((e) => e.startsWith('gate: ')).length, 2)
  const s2 = run(config, [loadSkill('ui-checklist')], s1).s
  assert.deepEqual(s2.errors.filter((e) => e.startsWith('gate: ')), ['gate: css-guide did not load after 3 denials in a turn; calls released'])
})

test('release: the unavailable record is kept for every call', () => {
  const { s } = run(base, [prompt('screen', ['ui']), prompt('2'), prompt('3')])
  const r = run(base, html(3), s)
  assert.equal(r.s.observed.filter((o) => /skill unavailable/.test(o.reason)).length, 3)
})

test('lastSeen: a main-loop tool call stamps it, a subagent call and an unrelated event do not; start stamps it', () => {
  const s0 = initSession(base, 's', 5, 'clear')
  assert.equal(s0.lastSeen, 5)
  const t1 = tool('Read')
  assert.equal(decide(base, s0, t1).session.lastSeen, (t1 as { now: number }).now)
  assert.equal(decide(base, s0, tool('Read', { agentId: 'a' })).session.lastSeen, 5)
  const resumed = decide(base, { ...s0, lastSeen: 1 }, { type: 'start', now: 99, start: 'resume' }).session
  assert.equal(resumed.lastSeen, 99)
})

test('always-on work skill with no active need: Agent brief without skills line is denied once, retry passes', () => {
  for (const audience of ['work', 'readers'] as const) {
    const c = cfg({ skills: { 'big-test': { always: true, from: 'user', for: audience } } })
    const r = run(c, [tool('Agent', { brief: 'do it' }), tool('Agent', { brief: 'do it' })])
    assert.equal(r.out[0]![0]!.kind, 'deny')
    assert.match((r.out[0]![0] as { reason: string }).reason, /Configured skills: big-test\. Active needs: none\. Always-on: big-test\./)
    assert.deepEqual(r.out[1], [])
  }
})

test('always-on chat skill only: Agent brief is never checked', () => {
  const c = cfg({ skills: { 'terse:terse-mode': { always: true, from: 'user', for: 'chat' } } })
  assert.deepEqual(run(c, [tool('Agent', { brief: 'do it' })]).out.flatMap(denies), [])
})

test('always-on work skill excluded for this root or not installed here: Agent brief is not checked', () => {
  const c = cfg({ skills: { 'big-test': { always: true, from: 'user', notIn: ['/work/p'] } } })
  const w = decide(c, initSession(c, 's', 0, 'clear'), { ...tool('Agent', { brief: 'do it' }), root: '/work/p' } as CoreEvent)
  assert.deepEqual(w.actions, [])
  const s0 = initSession(c, 's', 0, 'clear')
  const gone = { ...s0, ledger: { ...s0.ledger, 'big-test': { ...s0.ledger['big-test']!, state: 'not installed here' as const } } }
  assert.deepEqual(decide(c, gone, tool('Agent', { brief: 'do it' })).actions, [])
})

test('always-on work skill: "skills: none" in the brief passes', () => {
  const c = cfg({ skills: { 'big-test': { always: true, from: 'user' } } })
  assert.deepEqual(one(c, [tool('Agent', { brief: 'Fix typo.\nskills: none' })]), [])
})

test('observe mode: an always-on skill brief check only records', () => {
  const c = cfg({ mode: 'observe', skills: { 'big-test': { always: true, from: 'user' } } })
  const r = run(c, [tool('Agent', { brief: 'do it' })])
  assert.deepEqual(r.out.flatMap(denies), [])
  assert.match(r.s.observed.at(-1)!.reason, /Always-on: big-test/)
})

test('always-on work skill in state unavailable: Agent brief is not checked', () => {
  const c = cfg({ skills: { 'big-test': { always: true, from: 'user' } } })
  const s0 = initSession(c, 's', 0, 'clear')
  const gone = { ...s0, ledger: { ...s0.ledger, 'big-test': { ...s0.ledger['big-test']!, state: 'unavailable' as const } } }
  assert.deepEqual(decide(c, gone, tool('Agent', { brief: 'do it' })).actions, [])
})

test('always-on work skill: the brief check skips blocked, subagent, paused and untrusted-project cases', () => {
  const user = cfg({ skills: { 'big-test': { always: true, from: 'user' } } })
  // A project block removes the skill from the config it names.
  const blocked = cfg({ skills: {}, project: { root: '/work/p', blocked: ['big-test'], blockedSkills: ['big-test'] } as unknown as Config['project'] })
  assert.deepEqual(denies(run(blocked, [withRoot(tool('Agent', { brief: 'do it' }))]).out.at(-1)!), [])
  // A call made inside a subagent is not checked.
  assert.deepEqual(one(user, [tool('Agent', { brief: 'do it', agentId: 'a1' })]), [])
  // A paused session is not checked.
  assert.deepEqual(denies(run(user, [command('pause'), tool('Agent', { brief: 'do it' })]).out.at(-1)!), [])
  // A skill from an untrusted project file does not count; with a trusted root it does.
  const proj = cfg({ skills: { 'proj-always': { always: true, from: 'project' } } })
  assert.deepEqual(denies(run(proj, [withRoot(tool('Agent', { brief: 'do it' }))]).out.at(-1)!), [])
  assert.equal(denies(run({ ...proj, trustProjects: ['/work/p'] }, [withRoot(tool('Agent', { brief: 'do it' }))]).out.at(-1)!).length, 1)
})

test('three failed call A runs open the classifier pause, skipped prompts count it down, a failed probe reopens it, a good probe clears it', () => {
  const failed = (): CoreEvent => ({ type: 'prompt', now: at(), text: 'x', fromUser: true, matched: [], classifierFailed: true })
  const skipped = (): CoreEvent => ({ type: 'prompt', now: at(), text: 'x', fromUser: true, matched: [], classifierSkipped: true })
  let s = run(cfg(), [failed(), failed()]).s
  assert.equal(s.classifyPause ?? 0, 0)
  s = decide(cfg(), s, failed()).session
  assert.equal(s.classifyPause, 10)
  for (let i = 9; i >= 0; i--) {
    s = decide(cfg(), s, skipped()).session
    assert.equal(s.classifyPause, i)
  }
  // skipped prompts neither count as failures nor clear the error
  assert.equal(s.classifyFails, 3)
  assert.ok(s.errors.some((m) => m.startsWith('classifier: ')))
  s = decide(cfg(), s, failed()).session
  assert.equal(s.classifyPause, 10)
  s = decide(cfg(), s, { type: 'prompt', now: at(), text: 'x', fromUser: true, matched: [], classifierFailed: false }).session
  assert.equal(s.classifyPause, 0)
  assert.equal(s.classifyFails, 0)
  assert.deepEqual(s.errors, [])
})

test('the pause never counts below zero, and a prompt without a classifier run leaves it alone', () => {
  const s0 = { ...run(cfg(), []).s, classifyPause: 2 }
  const plain = decide(cfg(), s0, { type: 'prompt', now: at(), text: 'x', fromUser: true, matched: [] }).session
  assert.equal(plain.classifyPause, 2)
  const skip = (s: Session) => decide(cfg(), s, { type: 'prompt', now: at(), text: 'x', fromUser: true, matched: [], classifierSkipped: true }).session
  assert.equal(skip(skip(skip(s0))).classifyPause, 0)
})

test('a resume clears the pause, a reload keeps it', () => {
  const s0 = { ...run(cfg(), []).s, classifyPause: 7 }
  assert.equal(decide(cfg(), s0, { type: 'start', now: at(), start: 'resume' }).session.classifyPause, 0)
  assert.equal(decide(cfg(), s0, { type: 'start', now: at(), start: 'reload' }).session.classifyPause, 7)
})

test('while the pause is open the table and the degraded notice say so', () => {
  const failed = (): CoreEvent => ({ type: 'prompt', now: at(), text: 'x', fromUser: true, matched: [], classifierFailed: true })
  const s = run(cfg(), [failed(), failed(), failed()]).s
  assert.match(renderTable(cfg(), s, at()), /Need detection is paused .* retries in 10 prompts/)
  assert.match(problemKeys(cfg(), s).get('degraded:classifier') ?? '', /Need detection is paused and will retry in 10 prompts\. Details: \/souffleur\.$/)
  assert.doesNotMatch(renderTable(cfg(), { ...s, classifyPause: 0 }, at()), /paused/)
})
