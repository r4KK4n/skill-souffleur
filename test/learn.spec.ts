import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, initSession } from '../src/core/decide.ts'
import type { Config } from '../src/core/types.ts'
import { MAX_READS, parseProposals, shouldRead, skillHash } from '../src/core/learn.ts'

const config: Config = { mode: 'observe', skills: {}, needs: {}, trustProjects: [], rules: [], notes: [], learn: { skills: true } }
const off: Config = { ...config, learn: { skills: false } }
const fresh = () => initSession(config, 's1', 0, 'clear')
const rule = (command: string) => ({ kind: 'rule', after: { tools: ['Edit'], paths: ['src/**'] }, evidence: { tool: 'Bash', command } })

test('the hash follows name and text', () => {
  assert.equal(skillHash('a', 'text'), skillHash('a', 'text'))
  assert.notEqual(skillHash('a', 'text'), skillHash('b', 'text'))
  assert.notEqual(skillHash('a', 'text'), skillHash('a', 'text '))
  assert.match(skillHash('a', 'text'), /^[0-9a-f]{16}$/)
})

test('same skill text is read once', () => {
  const h = skillHash('writing-guide', 'v1')
  assert.equal(shouldRead(fresh(), config, h, []), true)
  assert.equal(shouldRead(fresh(), config, h, [h]), false, 'a hash from an earlier session')
  assert.equal(shouldRead(fresh(), config, skillHash('writing-guide', 'v2'), [h]), true, 'a changed text is new')
})

test('five reads per session cap', () => {
  const s = { ...fresh(), skillReads: MAX_READS - 1 }
  assert.equal(shouldRead(s, config, 'x', []), true)
  assert.equal(shouldRead({ ...s, skillReads: MAX_READS }, config, 'x', []), false)
})

test('learn.skills false reads nothing', () => {
  assert.equal(shouldRead(fresh(), off, 'x', []), false)
  const r = decide(off, fresh(), { type: 'skill', now: 1, skill: 'writing-guide', text: 'Always run `npm test`.' })
  assert.deepEqual(r.actions, [])
})

test('a main-session load asks for a read; a subagent load does not', () => {
  const text = 'Always run `npm test` after editing files under src/.'
  const typed = decide(config, fresh(), { type: 'skill', now: 1, skill: 'writing-guide', text })
  assert.deepEqual(typed.actions, [{ kind: 'learn', skill: 'writing-guide', text }], 'a typed /name load has no Skill tool call before it')
  let s = decide(config, fresh(), { type: 'tool', now: 1, tool: 'Skill', skill: 'writing-guide' }).session
  assert.equal(decide(config, s, { type: 'skill', now: 2, skill: 'writing-guide', text }).actions.length, 1, 'paired with a main Skill call')
  s = decide(config, fresh(), { type: 'tool', now: 1, tool: 'Agent' }).session
  assert.deepEqual(decide(config, s, { type: 'skill', now: 2, skill: 'writing-guide', text }).actions, [], 'a subagent runs: its load is not read')
})

test('garbage model output yields no proposals', () => {
  for (const raw of ['', 'sorry', '{', '[1, 2', 'null', '{"a":1}', '[1,"x",null]', '[{"kind":"thing"}]', `[${'{"kind":"note","text":"x"},'.repeat(5000)}]`]) {
    assert.deepEqual(parseProposals(raw, 'writing-guide', config), [], raw.slice(0, 30))
  }
})

test('more than three proposals are cut to three', () => {
  const raw = JSON.stringify([1, 2, 3, 4, 5].map((i) => rule(`npm test ${i}`)))
  assert.equal(parseProposals(raw, 'writing-guide', config).length, 3)
  assert.equal(parseProposals(`Here you go:\n\`\`\`json\n${raw}\n\`\`\``, 'writing-guide', config).length, 3, 'JSON inside prose and a fence')
  assert.equal(parseProposals(JSON.stringify({ proposals: [rule('npm test')] }), 'writing-guide', config).length, 1, 'wrapped in an object')
})

test('items that fail validation are dropped, the rest stay', () => {
  const raw = JSON.stringify([{ kind: 'note', text: 'two\nlines' }, rule('npm test'), { kind: 'rule', before: { tools: ['Agent'] } }, { kind: 'note', text: 'Reply in German.' }])
  const got = parseProposals(raw, 'writing-guide', config)
  assert.equal(got.length, 2)
  assert.deepEqual(got.map((p) => p.from), ['skill:writing-guide', 'skill:writing-guide'])
  assert.equal(got[0]!.origin, 'skill writing-guide')
  assert.equal(got[0]!.entry.source, 'skill:writing-guide')
})
