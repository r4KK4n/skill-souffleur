import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, initSession } from '../src/core/decide.ts'
import type { Action, CoreEvent, Session } from '../src/core/decide.ts'
import type { Config } from '../src/core/types.ts'
import { loadFixture, toCoreEvents } from './fixtures.ts'

const base: Config = {
  mode: 'enforce',
  needs: { prose: { for: 'readers', what: 'Writing text people read.' }, ui: { for: 'users', what: 'Building a screen.' } },
  trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true,
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
  const { s, out } = run(config, events)
  assert.equal(s.ledger.bigtest!.state, 'restoring')
  assert.match(ctx(out[1]!), /bigtest/)
  assert.equal(s.subagentsRunning, 1)
  const done = run(config, [{ type: 'agentDone', now: at() }], s)
  assert.equal(done.s.subagentsRunning, 0)
})

test('skill load while a subagent runs and without a main Skill call is ignored', () => {
  const { s } = run(base, [prompt('x', ['prose']), tool('Agent', { brief: 'skills: none' }), loadSkill('writing-guide')])
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
  assert.match((r1.out[1]![0] as { text: string }).text, /- writing-guide, writing-check: for texts other people read.*\n- terse:terse-mode: for how you work on this task\./)
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
  assert.match((denied[0] as { reason: string }).reason, /load ui-checklist with the Skill tool first, then retry\. .*\/souffleur pause/)
  const ok = run(base, [loadSkill('ui-checklist'), tool('Write', { path: 'x.html' })], s0)
  assert.deepEqual(ok.out[1], [])
  assert.deepEqual(denies(one(base, [tool('Write', { path: 'x.ts' })], s0)), [])
})

test('gate does nothing while the need is not active', () => {
  assert.deepEqual(one(base, [tool('Write', { path: 'x.html' })]), [])
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
    tool('Write', { path: 'a.html' }), // gate: stale
    loadSkill('ui-checklist'),
    tool('Write', { path: 'a.html' }), // opens duty
    tool('Write', { path: 'b.html' }), // duty
    tool('Agent', { brief: 'nothing' }), // brief
  ], s0)
  assert.deepEqual(r.out.flatMap(denies), [])
  assert.equal(r.s.observed.length, 3)
  assert.match(r.s.observed[0]!.reason, /load ui-checklist/)
  assert.match(r.s.observed[1]!.reason, /open duty/)
  assert.match(r.s.observed[2]!.reason, /skills:/)
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
    subagentsRunning: 2,
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
  assert.equal(resumed.subagentsRunning, 0)
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
  const s: Session = { ...s0, subagentsRunning: 2, mainSkillCalls: ['x'], agentDenied: true, learnCalls: ['y'], fieldDenied: ['f'] }
  const reloaded = decide(withAlways, s, { type: 'start', now: at(), start: 'reload' }).session
  assert.equal(reloaded.subagentsRunning, 2)
  assert.deepEqual(reloaded.mainSkillCalls, ['x'])
  assert.equal(reloaded.agentDenied, true)
  assert.deepEqual(reloaded.learnCalls, ['y'])
  assert.deepEqual(reloaded.fieldDenied, ['f'])
  assert.deepEqual(reloaded.ledger, s.ledger)
})

test('startup still gives a fresh session', () => {
  const s0 = run(withAlways, [prompt(), loadSkill('terse:terse-mode')]).s
  const s: Session = { ...s0, subagentsRunning: 2, mainSkillCalls: ['x'], agentDenied: true, learnCalls: ['y'] }
  const fresh = decide(withAlways, s, { type: 'start', now: at(), start: 'startup' }).session
  assert.equal(fresh.subagentsRunning, 0)
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
    '- terse:terse-mode: for your replies in this chat.',
    '- writing-guide, writing-check: for texts other people read (docs, issues, PRs, app copy). Not for your replies in this chat.',
    '- ui-design: for what users of the product see (screens, pages, components). Not for your replies in this chat.',
    '- plain: for how you work on this task.',
    'Your replies in this chat follow terse:terse-mode.',
  ].join('\n'))
})

test('restore request: no trailer without a readers or users group, no group line for nothing', () => {
  const c = audienceConfig()
  const text = ctx(decide(c, needsOn(), prompt('go on please now')).actions)
  assert.equal(text, [
    'Souffleur: before anything else, invoke these skills with the Skill tool, one after another:',
    '- terse:terse-mode: for your replies in this chat.',
    '- plain: for how you work on this task.',
  ].join('\n'))
})

test('restore after compaction keeps the compaction sentence after the groups', () => {
  const c = audienceConfig()
  const r = run(c, [loadSkill('plain'), compact(), prompt('next one please now')])
  assert.match(ctx(r.out.at(-1)!), /\n- plain: for how you work on this task\.\n.*must not be run again does not apply/)
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
