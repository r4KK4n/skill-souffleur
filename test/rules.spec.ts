import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../src/core/config.ts'
import { decide, initSession } from '../src/core/decide.ts'
import type { Action, CoreEvent, Session } from '../src/core/decide.ts'
import { NOTE_CAP, sectionNotes } from '../src/core/rules.ts'
import type { Config, Note, Rule } from '../src/core/types.ts'

const empty: Config = { mode: 'enforce', skills: {}, needs: { ui: 'Building a screen.' }, trustProjects: [], rules: [], notes: [], learn: { skills: true } }
const cfg = (patch: Partial<Config>): Config => ({ ...empty, ...patch })

let t = 0
const at = () => ++t
const tool = (name: string, extra: Partial<Extract<CoreEvent, { type: 'tool' }>> = {}): CoreEvent => ({ type: 'tool', now: at(), tool: name, ...extra })
const prompt = (matched: string[] = [], root = '/work/a'): CoreEvent => ({ type: 'prompt', now: at(), text: 'do it', fromUser: true, matched, root })
const loadSkill = (skill: string): CoreEvent => ({ type: 'skill', now: at(), skill })
const compact = (): CoreEvent => ({ type: 'compact', now: at(), phase: 'after', trigger: 'manual' })

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
const last = (config: Config, events: CoreEvent[]) => run(config, events).out.at(-1)!
const denial = (a: Action[]) => a.filter((x) => x.kind === 'deny').map((x) => (x as { reason: string }).reason).join('\n')
const ctx = (a: Action[]) => a.filter((x) => x.kind === 'context').map((x) => (x as { text: string }).text).join('\n')

const fieldRule: Rule = { id: 'agent-names-model', before: { tools: ['Agent'] }, field: 'model', source: 'slip' }
const skillRule: Rule = { id: 'agent-needs-workflow', before: { tools: ['Agent'] }, skill: 'dev-workflow', source: 'skill:dev-workflow' }
const afterRule: Rule = { id: 'test-after-edit', after: { tools: ['Edit'], paths: ['src/**'] }, evidence: { tool: 'Bash', command: 'npm test' }, source: 'user' }

test('field rule denies Agent without model once', () => {
  const c = cfg({ rules: [fieldRule] })
  const { out } = run(c, [tool('Agent', { present: ['prompt'] }), tool('Agent', { present: ['prompt'] }), tool('Agent', { present: ['prompt', 'model'] })])
  assert.match(denial(out[0]!), /agent-names-model/)
  assert.match(denial(out[0]!), /before Agent: field model/)
  assert.equal(denial(out[1]!), '', 'the retry passes')
  assert.equal(denial(out[2]!), '')
})

test('field rule is satisfied by a call that carries the field', () => {
  assert.equal(denial(last(cfg({ rules: [fieldRule] }), [tool('Agent', { present: ['model'] })])), '')
})

test('skill rule denies until loaded, then skill is needed after compaction', () => {
  const c = cfg({ rules: [skillRule] })
  const { out, s } = run(c, [tool('Agent'), loadSkill('dev-workflow'), tool('Agent'), compact(), prompt()])
  assert.match(denial(out[0]!), /dev-workflow/)
  assert.equal(denial(out[2]!), '')
  assert.equal(s.ledger['dev-workflow']?.state, 'restoring')
  assert.match(ctx(out[4]!), /invoke these skills[^\n]*dev-workflow/)
})

test('a rule that fired makes its skill needed even without a load', () => {
  const c = cfg({ rules: [skillRule] })
  const { out } = run(c, [tool('Agent'), prompt()])
  assert.match(ctx(out[1]!), /dev-workflow/)
})

test('a skill only named in a rule gets a ledger entry', () => {
  assert.equal(initSession(cfg({ rules: [skillRule] }), 's', 0, 'clear').ledger['dev-workflow']?.state, 'absent')
})

test('after rule denies next matching call once', () => {
  const c = cfg({ rules: [afterRule] })
  const edit = () => tool('Edit', { path: '/work/a/src/x.ts', root: '/work/a' })
  const { out, s } = run(c, [edit(), edit(), edit(), tool('Bash', { command: 'npm test' }), edit()])
  assert.equal(denial(out[0]!), '', 'the first edit opens the rule')
  assert.match(denial(out[1]!), /test-after-edit/)
  assert.equal(denial(out[2]!), '', 'the retry passes')
  assert.equal(s.openRules.length, 1, 'evidence closed it, the last edit opened it again')
  assert.equal(denial(out[4]!), '')
  assert.match(ctx(run(c, [edit(), prompt()]).out[1]!), /Open rule: test-after-edit/)
})

test('evidence closes an after rule', () => {
  const c = cfg({ rules: [afterRule] })
  const { s } = run(c, [tool('Edit', { path: '/work/a/src/x.ts', root: '/work/a' }), tool('Bash', { command: 'npm test' })])
  assert.deepEqual(s.openRules, [])
})

test('one denial lists every broken rule and the brief check', () => {
  const c = cfg({ rules: [fieldRule, skillRule], skills: { 'ui-guide': { need: 'ui', from: 'user' } } })
  const { out } = run(c, [prompt(['ui']), tool('Agent', { present: ['prompt'], brief: 'do the thing' })])
  const reason = denial(out[1]!)
  assert.match(reason, /agent-names-model/)
  assert.match(reason, /agent-needs-workflow/)
  assert.match(reason, /skills: <names>/)
  assert.equal(out[1]!.filter((a) => a.kind === 'deny').length, 1)
})

test('observe mode records rule breaks only', () => {
  const c = cfg({ mode: 'observe', rules: [fieldRule] })
  const { out, s } = run(c, [tool('Agent', { present: [] })])
  assert.equal(denial(out[0]!), '')
  assert.match(s.observed[0]!.reason, /agent-names-model/)
})

test('pause stops every rule', () => {
  const c = cfg({ rules: [fieldRule, skillRule] })
  const { out } = run(c, [{ type: 'command', now: at(), args: 'pause' }, tool('Agent', { present: [] })])
  assert.equal(denial(out[1]!), '')
})

test('a rule with where applies in that project only', () => {
  const c = cfg({ rules: [{ ...fieldRule, where: '/work/a' }] })
  assert.match(denial(last(c, [tool('Agent', { present: [], root: '/work/a' })])), /agent-names-model/)
  assert.equal(denial(last(c, [tool('Agent', { present: [], root: '/work/b' })])), '')
})

test('a subagent call is never checked by a rule', () => {
  const c = cfg({ rules: [fieldRule] })
  assert.equal(denial(last(c, [tool('Agent', { present: [], agentId: 'a1' })])), '')
})

test('user file rules and notes parse; project file rules are an error', () => {
  const user = JSON.stringify({
    needs: { ui: 'Building a screen.' },
    rules: [fieldRule, skillRule, afterRule],
    notes: [{ id: 'reply-language', text: 'Reply in German.', source: 'user' }, { id: 'ui-copy', text: 'Show copy first.', need: 'ui', source: 'user' }],
    learn: { skills: false },
  })
  const ok = parseConfig(user, undefined)
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.config.rules.length, 3)
  assert.equal(ok.config.notes.length, 2)
  assert.equal(ok.config.learn.skills, false)
  const project = parseConfig(undefined, JSON.stringify({ rules: [fieldRule], notes: [{ id: 'n', text: 'x', source: 'user' }], learn: { skills: false } }))
  assert.equal(project.config.rules.length, 0)
  assert.equal(project.config.notes.length, 0)
  assert.equal(project.config.learn.skills, true)
  assert.equal(project.errors.filter((e) => /only allowed in the user config/.test(e)).length, 3)
})

test('invalid rule and note entries are dropped one by one', () => {
  const r = parseConfig(JSON.stringify({
    rules: [fieldRule, { id: 'two-kinds', before: { tools: ['A'] }, skill: 's', field: 'f', source: 'user' }, { id: 'no-evidence', after: { tools: ['A'] }, source: 'user' }, fieldRule],
    notes: [{ id: 'n1', text: 'a\nb', source: 'user' }, { id: 'n2', text: 'ok', need: 'missing', source: 'user' }, { id: 'n3', text: 'fine', source: 'user' }],
  }), undefined)
  assert.deepEqual(r.config.rules.map((x) => x.id), ['agent-names-model'])
  assert.deepEqual(r.config.notes.map((x) => x.id), ['n3'])
  assert.equal(r.errors.length, 5)
})

test('note without need goes to section, capped at 2000 chars', () => {
  const note = (id: string, text: string, extra: Partial<Note> = {}): Note => ({ id, text, source: 'user', ...extra })
  const long = 'x'.repeat(500)
  const c = cfg({ notes: [note('a', 'Reply in German.'), note('b', 'Only here.', { where: '/work/b' }), note('c', 'Needs ui.', { need: 'ui' }), note('d', long), note('e', long), note('f', long), note('g', long), note('h', long)] })
  const r = sectionNotes(c, '/work/a')
  assert.match(r.text, /Reply in German\./)
  assert.doesNotMatch(r.text, /Only here/)
  assert.doesNotMatch(r.text, /Needs ui/)
  assert.ok(r.text.length <= NOTE_CAP + 200)
  assert.deepEqual(r.leftOut.map((n) => n.id), ['g', 'h'])
  assert.equal(sectionNotes(cfg({}), '/work/a').text, '')
})

test('need note sent on first match and after compaction', () => {
  const c = cfg({ notes: [{ id: 'ui-copy', text: 'Show copy first.', need: 'ui', source: 'user' }] })
  const { out } = run(c, [prompt(), prompt(['ui']), prompt(), compact(), prompt()])
  assert.equal(ctx(out[0]!), '')
  assert.match(ctx(out[1]!), /Show copy first\./)
  assert.equal(ctx(out[2]!), '', 'once while the need stays')
  assert.match(ctx(out[4]!), /Show copy first\./, 'again after a compaction')
})

test('confirmed note sent once in next context', () => {
  const c = cfg({ notes: [{ id: 'reply-language', text: 'Reply in German.', source: 'user' }] })
  const start = { ...initSession(c, 's', 0, 'clear'), freshNotes: ['reply-language'] }
  const { out } = run(c, [prompt(), prompt()], start)
  assert.match(ctx(out[0]!), /Reply in German\./)
  assert.equal(ctx(out[1]!), '')
})
