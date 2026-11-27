import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, initSession } from '../src/core/decide.ts'
import type { CoreEvent, Session } from '../src/core/decide.ts'
import { requested, skillLoaded } from '../src/core/ledger.ts'
import { renderTable, statusLine } from '../src/core/status.ts'
import type { Config } from '../src/core/types.ts'
import { parseConfig } from '../src/core/config.ts'

const T0 = Date.UTC(2026, 10, 25, 8, 0)
const T1 = Date.UTC(2026, 10, 25, 9, 5)

const config: Config = {
  mode: 'enforce',
  needs: { prose: { for: 'readers', what: 'Writing text people read.' }, ui: { for: 'users', what: 'Building a screen.' } },
  trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify',
  skills: {
    'writing-guide': { need: 'prose', from: 'user' },
    'writing-check': { need: 'prose', from: 'user' },
    'terse:terse-mode': { always: true, from: 'user' },
    'ui-checklist': { need: 'ui', from: 'user' },
  },
}

const fresh = (c: Config = config, version?: string): Session => {
  const { lastSeen: _l, ...s } = initSession(c, 'session-1', T0, 'clear', version)
  return s
}

test('status line counts loaded and restoring', () => {
  const s0 = fresh()
  const s: Session = {
    ...s0,
    ledger: requested(skillLoaded(s0.ledger, 'writing-guide', T1, 'matched prompt'), ['writing-check'], T1),
  }
  assert.equal(statusLine(s, 'enforce'), '1 loaded, 1 restoring')
})

test('status line says degraded when errors exist', () => {
  const s: Session = { ...fresh(), errors: ['tool_name missing from payload'] }
  assert.equal(statusLine(s, 'enforce'), 'degraded, see /souffleur')
})

test('status line is undefined without skills', () => {
  const empty: Config = { ...config, skills: {} }
  assert.equal(statusLine(fresh(empty), 'enforce'), undefined)
})

test('observe mode prefix in status line', () => {
  const s0 = fresh()
  const s: Session = { ...s0, ledger: skillLoaded(s0.ledger, 'writing-guide', T1, 'matched prompt') }
  assert.equal(statusLine(s, 'observe'), 'observe · 1 loaded')
})

test('table lists every configured skill with state and reason', () => {
  const s0 = fresh(config, '2.1.332')
  const s: Session = { ...s0, ledger: skillLoaded(s0.ledger, 'writing-guide', T1, 'matched prompt') }
  const out = renderTable(config, s, T1)
  const lines = out.split('\n')
  assert.equal(lines[0], 'Mode: enforce. Times in UTC.')
  assert.match(out, /^\| Skill \| State \| Since \| Reason \|$/m)
  assert.match(out, /^\| writing-guide \| loaded \| 09:05 \| matched prompt \|$/m)
  assert.match(out, /^\| terse:terse-mode \| not needed yet \| 08:00 \|  \|$/m)
  for (const name of Object.keys(config.skills)) assert.match(out, new RegExp(`^\\| ${name.replace(':', '\\:')} \\|`, 'm'))
  assert.equal(lines.at(-1), 'Claude Code 2.1.332')
})

test('table shows not seen after 2 requests', () => {
  let ledger = fresh().ledger
  for (let i = 0; i < 3; i++) ledger = requested(ledger, ['writing-check'], T1)
  const s: Session = { ...fresh(), ledger }
  assert.match(renderTable(config, s, T1), /^\| writing-check \| unavailable \| 09:05 \| not seen after 2 requests \|$/m)
})

test('table lists open duties and active needs', () => {
  const s: Session = {
    ...fresh(),
    duties: [{ skill: 'ui-checklist', openedAt: T1, by: 'Write index.html', denied: false }],
    needs: { ui: { since: T1, reason: 'command' } },
    errors: ['tool_name missing from payload'],
  }
  const out = renderTable(config, s, T1)
  assert.match(out, /^Open duties:\n- ui-checklist \(Write index\.html\)$/m)
  assert.match(out, /^Active needs:\n- ui \(since 09:05\)$/m)
  assert.match(out, /^Errors:\n- tool_name missing from payload$/m)
})

test('observe mode shows would-have-denied reasons in table', () => {
  const observe: Config = { ...config, mode: 'observe' }
  const s: Session = {
    ...fresh(observe),
    observed: [{ at: Date.UTC(2026, 10, 25, 9, 30), reason: 'gate: ui-checklist needs ui' }],
  }
  const out = renderTable(observe, s, T1)
  assert.equal(out.split('\n')[0], 'Mode: observe. Times in UTC.')
  assert.match(out, /^Would have denied:\n- 09:30 gate: ui-checklist needs ui$/m)
})

test('paused shows in first line', () => {
  const s: Session = { ...fresh(), paused: true }
  assert.equal(renderTable(config, s, T1).split('\n')[0], 'Mode: enforce (paused). Times in UTC.')
})

test('decide status command replies with the table', () => {
  const s = fresh()
  const e: CoreEvent = { type: 'command', now: T1, args: 'status' }
  const r = decide(config, s, e)
  assert.deepEqual(r.actions, [{ kind: 'reply', text: renderTable(config, s, T1) }])
})

test('table cells escape backslashes, pipes and line breaks', () => {
  const config = parseConfig(JSON.stringify({ skills: { 'writing-guide': { always: true } } }), undefined).config
  const s = initSession(config, 'session-1', T0, 'startup')
  s.ledger['writing-guide'] = { ...s.ledger['writing-guide'], state: 'loaded', reason: 'a\\|b\r\nc' }
  assert.match(renderTable(config, s, T0), /^\| writing-guide \| loaded \| \d\d:\d\d \| a\\\\\\\|b c \|$/m)
})

test('status line counts skills not installed here separately', () => {
  const s0 = fresh()
  const s = decide(config, s0, { type: 'installed', now: T1, names: ['writing-guide'] }).session
  assert.equal(statusLine(s, 'enforce'), '0 loaded, 3 not installed here')
  assert.match(renderTable(config, s, T1), /\| ui-checklist \| not installed here \|/)
})

test('open duties of a skill not installed here are not listed', () => {
  const s0 = decide(config, fresh(), { type: 'installed', now: T1, names: ['writing-guide'] }).session
  const s = { ...s0, duties: [{ skill: 'ui-checklist', openedAt: T1, by: 'Write', denied: false }] }
  assert.doesNotMatch(renderTable(config, s, T1), /Open duties/)
})

test('the table carries the version notice when Claude Code is newer than the verified version, and the status line stays quiet', () => {
  const newer = fresh(config, '99.0.0')
  const table = renderTable(config, newer, T0)
  assert.match(table, /^Running Claude Code 99\.0\.0; Souffleur was checked up to \d+\.\d+\.\d+\. Report problems with `claude --version`\.$/m)
  assert.equal(table.split('\n').filter((l) => l.startsWith('Running Claude Code')).length, 1)
  assert.doesNotMatch(statusLine(newer, 'observe') ?? '', /Claude Code|checked up to/)
})

test('the table has no version notice for a verified or unknown version', () => {
  assert.doesNotMatch(renderTable(config, fresh(config, '2.1.322'), T0), /checked up to/)
  assert.doesNotMatch(renderTable(config, fresh(config), T0), /checked up to/)
})

test('the table says when a project file is read but not trusted', () => {
  const c: Config = { ...config, skills: { ...config.skills, 'proj-skill': { always: true, from: 'project' } } }
  assert.match(renderTable(c, fresh(c), T1, '/work/p'), /not trusted.*trustProjects/s)
  assert.doesNotMatch(renderTable({ ...c, trustProjects: ['/work/p/'] }, fresh(c), T1, '/work/p'), /not trusted/)
  assert.doesNotMatch(renderTable(config, fresh(), T1, '/work/p'), /not trusted/)
})

test('status shows needs as name and time', () => {
  const s: Session = { ...fresh(), needs: { ui: { since: T1, reason: 'need:ui from "&lt;!-- reply 9"' } } }
  const out = renderTable(config, s, T1)
  assert.match(out, /^Active needs:\n- ui \(since 09:05\)$/m)
  assert.doesNotMatch(out, /reply 9|&lt;/)
})

test('status groups equal denials with count and range', () => {
  const r = 'Agent brief without a "skills:" line. Add one and retry.'
  const s: Session = { ...fresh(), observed: [
    { at: Date.UTC(2026, 10, 25, 9, 50), reason: r },
    { at: Date.UTC(2026, 10, 25, 10, 10), reason: r },
    { at: Date.UTC(2026, 10, 25, 10, 42), reason: r },
  ] }
  const out = renderTable(config, s, T1)
  assert.match(out, /^Would have denied:\n- 3× Agent brief without a "skills:" line \(09:50–10:42\)\n  Agent brief without a "skills:" line\. Add one and retry\.$/m)
  assert.equal(out.split('Add one and retry').length - 1, 1)
})

test('different reasons stay apart', () => {
  const s: Session = { ...fresh(), observed: [
    { at: Date.UTC(2026, 10, 25, 9, 50), reason: 'gate: a needs ui' },
    { at: Date.UTC(2026, 10, 25, 9, 51), reason: 'gate: b needs ui' },
    { at: Date.UTC(2026, 10, 25, 9, 52), reason: 'gate: a needs ui' },
  ] }
  const out = renderTable(config, s, T1)
  assert.match(out, /^- 2× gate: a needs ui \(09:50–09:52\)$/m)
  assert.match(out, /^- 09:51 gate: b needs ui$/m)
})

test('status says times are UTC', () => {
  const out = renderTable(config, fresh(), T1)
  assert.match(out.split('\n')[0]!, /Times in UTC\./)
  assert.equal(out.split('Times in UTC.').length - 1, 1)
})

test('notes going out next are not listed as waiting', () => {
  const c: Config = { ...config, notes: [
    { id: 'n1', text: 'a'.repeat(100), need: 'ui', source: 'user' },
    { id: 'n2', text: 'b'.repeat(5000), need: 'ui', source: 'user' },
  ] }
  const s: Session = { ...fresh(c), needs: { ui: { since: T1, reason: 'command' } } }
  const out = renderTable(c, s, T1)
  assert.match(out, /Notes waiting for a later prompt[^:]*: n2$/m)
  assert.doesNotMatch(out, /n1/)
})

const PAUSE = 'To turn checks off for this session: /souffleur pause.'
const brief = (needs: string) => `Souffleur: add a line "skills: <names>" (or "skills: none" for mechanical work) to the brief, then retry. Configured skills: writing-guide, ui-checklist. Active needs: ${needs}. ${PAUSE}`

test('production-shaped denials: a group of two prints count, range and the newest full message', () => {
  const s: Session = { ...fresh(), observed: [
    { at: Date.UTC(2026, 10, 25, 9, 50), reason: brief('ui') },
    { at: Date.UTC(2026, 10, 25, 10, 42), reason: brief('ui, prose') },
  ] }
  const out = renderTable(config, s, T1)
  assert.match(out, /^- 2× Souffleur: add a line "skills: <names>" \(or "skills: none" for mechanical work\) to the brief, then retry \(09:50–10:42\)$/m)
  assert.ok(out.includes(`\n  ${brief('ui, prose')}`))
  assert.equal(out.split('Active needs: ui,').length - 1, 1)
})

test('production-shaped denials: a single one prints time and the full message on one line', () => {
  const s: Session = { ...fresh(), observed: [{ at: Date.UTC(2026, 10, 25, 9, 50), reason: brief('ui') }] }
  const out = renderTable(config, s, T1)
  assert.ok(out.includes(`\n- 09:50 ${brief('ui')}`))
  assert.doesNotMatch(out, /1×/)
})

test('a multi-violation reason stays apart from a single one and prints all its lines indented', () => {
  const a = `Souffleur: load ui-checklist with the Skill tool first, then retry. ${PAUSE}`
  const b = `${a}\nSouffleur: open duty for ui-checklist (Write x.html). Do this first: Bash. Then retry. ${PAUSE}`
  const s: Session = { ...fresh(), observed: [
    { at: Date.UTC(2026, 10, 25, 9, 50), reason: a },
    { at: Date.UTC(2026, 10, 25, 9, 51), reason: b },
    { at: Date.UTC(2026, 10, 25, 9, 52), reason: b },
  ] }
  const out = renderTable(config, s, T1)
  assert.match(out, /^- 09:50 Souffleur: load ui-checklist/m)
  assert.match(out, /^- 2× Souffleur: load ui-checklist with the Skill tool first, then retry; Souffleur: open duty for ui-checklist \(Write x\.html\) \(09:51–09:52\)$/m)
  assert.ok(out.includes(`\n  ${a}\n  Souffleur: open duty`))
})

test('table: excluded skill shows its state text, needs without an audience get the init hint', () => {
  const c: Config = {
    mode: 'enforce', trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify',
    needs: { prose: { for: 'work', what: 'Text.', noAudience: true }, ui: { for: 'users', what: 'Screens.' } },
    skills: { 'ui-design': { need: 'ui', from: 'user', notIn: ['/work/p'] }, 'writing-guide': { need: 'prose', from: 'user' } },
  }
  const s = initSession(c, 's', T0, 'clear')
  const here = renderTable(c, s, T0, '/work/p/')
  assert.match(here, /\| ui-design \| excluded in this project \|/)
  assert.match(here, /\| writing-guide \| not needed yet \|/)
  assert.match(here, /^prose: no audience set; add "for" to it in ~\/\.claude\/souffleur\.json$/m)
  assert.doesNotMatch(here, /^ui: no audience/m)
  assert.match(renderTable(c, s, T0, '/work/q'), /\| ui-design \| not needed yet \|/)
})

test('status line leaves excluded skills out of the counts', () => {
  const c: Config = { mode: 'enforce', trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify', needs: {}, skills: { a: { always: true, from: 'user', notIn: ['/work/p'] }, b: { always: true, from: 'user' } } }
  let s = fresh(c)
  s = { ...s, ledger: skillLoaded(skillLoaded(s.ledger, 'a', T0, 'x'), 'b', T0, 'x') }
  assert.equal(statusLine(s, 'enforce', 0, c, '/work/p/'), '1 loaded')
  assert.equal(statusLine(s, 'enforce', 0, c, '/work/q'), '2 loaded')
})

test('needs without an audience: heading, and none for an untrusted project need', () => {
  const c: Config = {
    mode: 'enforce', trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify',
    needs: { prose: { for: 'work', what: 'Text.', noAudience: true }, pn: { for: 'work', what: 'P.', noAudience: true } },
    projectNeeds: ['pn'], skills: {},
  }
  const s = initSession(c, 's', T0, 'clear')
  const t = renderTable(c, s, T0, '/work/p')
  assert.match(t, /Audience not set:\nprose: no audience set; add "for" to it in ~\/\.claude\/souffleur\.json/)
  assert.doesNotMatch(t, /pn: no audience/)
  assert.match(renderTable({ ...c, trustProjects: ['/work/p'] }, s, T0, '/work/p'), /pn: no audience/)
})

test('audience hints: an always-on skill without "for" gets a hint, one with "for" or an excluded one does not', () => {
  const c: Config = {
    mode: 'enforce', trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify', needs: {},
    skills: { 'chisle:chisle': { always: true, from: 'user' }, terse: { always: true, for: 'chat', from: 'user' }, gone: { always: true, from: 'user', notIn: ['/work/p'] } },
  }
  const s = initSession(c, 's', T0, 'clear')
  const t = renderTable(c, s, T0, '/work/p')
  assert.match(t, /Audience not set:\nchisle:chisle: always on without "for"; add "for": "chat" if it shapes your replies in this chat$/m)
  assert.doesNotMatch(t, /^terse: always on/m)
  assert.doesNotMatch(t, /^gone: always on/m)
})

test('reply check: the chat skill row note counts violations; nothing without reply or without checked replies', () => {
  const c: Config = { ...config, skills: { ...config.skills, 'terse:terse-mode': { always: true, for: 'chat', from: 'user', reply: { maxChars: 100 } } } }
  const long = 'word '.repeat(60)
  let s = fresh(c)
  assert.doesNotMatch(renderTable(c, s, T1), /replies over the limit/)
  for (const answer of [long, 'ok', long]) s = decide(c, s, { type: 'reply', now: T1, answer, fromCommand: false, aborted: false }).session
  assert.match(renderTable(c, s, T1), /^- terse:terse-mode: 2 of 3 replies over the limit$/m)
  const bare: Config = { ...c, skills: { ...c.skills, 'terse:terse-mode': { always: true, for: 'chat', from: 'user' } } }
  assert.doesNotMatch(renderTable(bare, s, T1), /replies over the limit/)
  assert.doesNotMatch(renderTable(config, fresh(), T1), /replies over the limit/)
})

test('the table shows failure counts after the error cleared', () => {
  const s: Session = { ...fresh(), failCounts: { 'tool.call': 3, classifier: 1 } }
  assert.match(renderTable(config, s, T1), /^Failures this session: tool\.call 3, classifier 1$/m)
  assert.doesNotMatch(renderTable(config, { ...fresh(), failCounts: { 'tool.call': 0 } }, T1), /Failures this session/)
  assert.doesNotMatch(renderTable(config, fresh(), T1), /Failures this session/)
})

const standardJson = JSON.stringify({ skills: { 'chat-style': { always: true, for: 'chat' }, 'writing-guide': { need: 'prose' } }, needs: { prose: { for: 'readers', what: 'Writing.' } }, projects: { '/work/a': { block: ['chat-style'], skills: { local: { need: 'prose' } } } } })

test('status names the project and shows blocked skills as blocked here', () => {
  const { config: c } = parseConfig(standardJson, undefined, '/work/a')
  const out = renderTable(c, initSession(c, 's', T0, 'clear'), T1, '/work/a')
  assert.match(out, /^Project: \/work\/a \(block: 1 blocked, 1 own\)$/m)
  assert.match(out, /^\| chat-style \| blocked here \|/m)
  assert.doesNotMatch(out, /chat-style \| absent/)
})

test('status has no project line without a block', () => {
  const { config: c } = parseConfig(standardJson, undefined, '/work/b')
  assert.doesNotMatch(renderTable(c, initSession(c, 's', T0, 'clear'), T1, '/work/b'), /Project:|blocked here/)
})

test('absent rows read not needed yet in the table', () => {
  const { config: c } = parseConfig(standardJson, undefined, '/work/b')
  const s = initSession(c, 's', T0, 'clear')
  assert.equal(s.ledger['writing-guide']!.state, 'absent')
  const out = renderTable(c, s, T1, '/work/b')
  assert.match(out, /^\| writing-guide \| not needed yet \|/m)
  assert.doesNotMatch(out, /\| absent \|/)
})

const used = (over: Partial<NonNullable<Session['modelUse']>> = {}): NonNullable<Session['modelUse']> => ({ calls: 42, input: 18_000, output: 1_200, cacheRead: 300, cacheWrite: 0, usd: 0.03, ...over })

test('status line appends the session dollars and omits them at 0 calls', () => {
  const s0 = fresh()
  const s: Session = { ...s0, ledger: skillLoaded(s0.ledger, 'writing-guide', T1, 'matched prompt') }
  assert.equal(statusLine({ ...s, modelUse: used() }, 'enforce'), '1 loaded · ~$0.03')
  assert.equal(statusLine({ ...s, modelUse: used({ calls: 0, usd: 0 }) }, 'enforce'), '1 loaded')
  assert.equal(statusLine({ ...s, modelUse: used({ usd: 0.001 }) }, 'enforce'), '1 loaded · < $0.01')
  assert.equal(statusLine({ ...s, modelUse: used({ usd: 0, unpriced: ['mystery-1'] }) }, 'enforce'), '1 loaded · $ unknown')
  assert.equal(statusLine({ ...s, modelUse: used() }, 'observe'), 'observe · 1 loaded · ~$0.03')
})

test('status line with notices off still shows the cost', () => {
  const quiet: Config = { ...config, notices: false }
  const s0 = fresh(quiet)
  const s: Session = { ...s0, ledger: skillLoaded(s0.ledger, 'writing-guide', T1, 'matched prompt'), modelUse: used() }
  assert.equal(statusLine(s, 'enforce', 0, quiet), '1 loaded · ~$0.03')
})

test('table shows the small-model line after the reply check, with the total', () => {
  const s: Session = { ...fresh(), modelUse: used(), replyCheck: { total: 3, over: 1, sinceReminder: 0 } }
  const total = used({ calls: 310, usd: 0.21 })
  const out = renderTable(config, s, T1, undefined, total)
  assert.match(out, /^Small model: 42 calls, 18\.3k in \/ 1\.2k out, about \$0\.03 this session \(total 310 calls, about \$0\.21\)\. Estimate at list price\.$/m)
  assert.ok(out.indexOf('Small model:') > out.indexOf('Reply check:') || !out.includes('Reply check:'))
  assert.doesNotMatch(renderTable(config, fresh(), T1), /Small model/)
})

test('the status command reads the total from the event', () => {
  const s: Session = { ...fresh(), modelUse: used() }
  const r = decide(config, s, { type: 'command', now: T1, args: '', total: used({ calls: 310, usd: 0.21 }) })
  const text = r.actions.flatMap((a) => (a.kind === 'reply' ? [a.text] : []))[0]!
  assert.match(text, /\(total 310 calls, about \$0\.21\)/)
})

// #41: the status line starts with the local time Souffleur last saw the session.
const at1402 = new Date(2026, 10, 27, 14, 2).getTime()
const loaded = (s: Session): Session => ({ ...s, ledger: skillLoaded(s.ledger, 'writing-guide', T1, 'matched prompt') })

test('status line starts with the local time of lastSeen', () => {
  const s: Session = { ...loaded(fresh()), lastSeen: at1402 }
  assert.equal(statusLine(s, 'observe'), '14:02 · observe · 1 loaded')
  assert.equal(statusLine({ ...s, lastSeen: new Date(2026, 10, 27, 7, 5).getTime() }, 'enforce'), '07:05 · 1 loaded')
})

test('the time comes first and the cost suffix stays last', () => {
  const s: Session = { ...loaded(fresh()), lastSeen: at1402, modelUse: { calls: 2, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0.03 } }
  assert.match(statusLine(s, 'observe')!, /^14:02 · observe · 1 loaded · ~\$0\.03$/)
})

test('degraded keeps the time prefix', () => {
  assert.equal(statusLine({ ...fresh(), errors: ['x'], lastSeen: at1402 }, 'enforce'), '14:02 · degraded, see /souffleur')
})

test('no lastSeen: the line is as before', () => {
  assert.equal(statusLine(loaded(fresh()), 'enforce'), '1 loaded')
})

test('a person prompt and a seen event set lastSeen; a prompt not from the person does not', () => {
  const a = decide(config, fresh(), { type: 'prompt', now: T1, text: 'hi', fromUser: true, matched: [] }).session
  assert.equal(a.lastSeen, T1)
  assert.equal(decide(config, fresh(), { type: 'prompt', now: T1, text: 'hi', fromUser: false, matched: [] }).session.lastSeen, undefined)
  assert.equal(initSession(config, 's', T0, 'clear').lastSeen, T0, 'a session start stamps it')
  assert.equal(decide(config, a, { type: 'seen', now: T1 + 5 }).session.lastSeen, T1 + 5)
})

test('status shows the version line after the Small model line', () => {
  const s = { ...fresh(), modelUse: { calls: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, usd: 0 } }
  const text = renderTable(config, s, T1, undefined, undefined, { current: '0.2.3', latest: 'v0.2.4', at: Date.UTC(2026, 10, 25, 7, 5) })
  const lines = text.split('\n')
  const small = lines.findIndex((l) => l.startsWith('Small model:'))
  assert.ok(small >= 0)
  assert.equal(lines[small + 1], 'Version 0.2.3 · latest v0.2.4 · checked 07:05 · update: notify')
})

test('status version line with latest unknown and checked never', () => {
  const text = renderTable({ ...config, update: 'off' }, fresh(), T1, undefined, undefined, { current: '0.2.3' })
  assert.ok(text.split('\n').includes('Version 0.2.3 · latest unknown · checked never · update: off'))
})

test('status without update input has no version line', () => {
  assert.ok(!renderTable(config, fresh(), T1).includes('Version '))
})
