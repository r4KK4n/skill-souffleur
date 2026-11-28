import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, initSession } from '../src/core/decide.ts'
import { addEntry, answer, describeProposal, enqueue, makeProposal, nextQuestion, parseReply, parseShaped, proposalNotice, shapePrompt } from '../src/core/proposals.ts'
import type { Proposal } from '../src/core/proposals.ts'
import type { Config, Note, Rule } from '../src/core/types.ts'

const config: Config = { mode: 'observe', skills: {}, needs: { ui: { for: 'users', what: 'Building a screen.' } }, trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify' }
const fresh = () => initSession(config, 's1', 0, 'clear')
const ruleRaw = (skill: string) => ({ kind: 'rule', before: { tools: ['Agent'] }, skill })
const prop = (raw: unknown, from = 'slip'): Proposal => {
  const r = makeProposal(raw, from, config)
  assert.ok(r.proposal, r.error)
  return r.proposal
}

test('a proposal is validated like a config entry', () => {
  assert.match(makeProposal({ kind: 'rule', before: { tools: ['Agent'] } }, 'slip', config).error ?? '', /exactly one/)
  assert.match(makeProposal({ kind: 'note', text: 'a\nb' }, 'user', config).error ?? '', /one line/)
  assert.match(makeProposal({ kind: 'note', text: 'x', need: 'nope' }, 'user', config).error ?? '', /need/)
  assert.match(makeProposal({ kind: 'thing' }, 'user', config).error ?? '', /kind/)
  const p = prop({ kind: 'note', text: 'Reply in German.', why: 'user said so' }, 'user')
  assert.equal(p.kind, 'note')
  assert.equal((p.entry as Note).source, 'user')
  assert.match(p.entry.id, /^note-[0-9a-f]{8}$/)
})

test('queue cap 20 and duplicate drop', () => {
  let s = fresh()
  const first = enqueue(config, s, prop(ruleRaw('s0')))
  s = first.session
  assert.equal(first.status, 'queued')
  assert.equal(enqueue(config, s, prop(ruleRaw('s0'))).status, 'duplicate', 'same content, same hash')
  for (let i = 1; i < 20; i++) s = enqueue(config, s, prop(ruleRaw(`s${i}`))).session
  assert.equal(s.proposals.length, 20)
  const over = enqueue(config, s, prop(ruleRaw('s99')))
  assert.equal(over.status, 'full')
  assert.equal(over.session.proposals.length, 20)
  const existing: Rule = { id: 'old', before: { tools: ['Agent'] }, skill: 'known', source: 'user' }
  assert.equal(enqueue({ ...config, rules: [existing] }, fresh(), prop(ruleRaw('known'))).status, 'duplicate', 'equal to an existing rule')
})

test('enqueue rejects a proposal whose id already waits', () => {
  const a = prop({ kind: 'note', text: 'Reply in German.' }, 'user')
  const s = enqueue(config, fresh(), a).session
  // a different entry whose short id collides with the waiting one (the id is 8 hex digits of the hash)
  const b: Proposal = { ...prop({ kind: 'note', text: 'Reply in French.' }, 'user'), entry: { ...a.entry, text: 'Reply in French.' } as Note }
  assert.notEqual(b.hash, a.hash)
  const r = enqueue(config, s, b)
  assert.equal(r.status, 'duplicate')
  assert.deepEqual(r.session.proposals.map((p) => p.hash), [a.hash])
})

test('declined proposal is not asked again', () => {
  let s = enqueue(config, fresh(), prop(ruleRaw('a'))).session
  const hash = s.proposals[0]!.hash
  s = answer(config, s, hash, 'No').session
  assert.deepEqual(s.proposals, [])
  assert.deepEqual(s.declined, [hash])
  assert.equal(enqueue(config, s, prop(ruleRaw('a'))).status, 'declined')
  assert.equal(nextQuestion(s), undefined)
})

test('one question per turn: the first proposal, in its exact short form', () => {
  let s = fresh()
  s = enqueue(config, s, prop(ruleRaw('dev-workflow'))).session
  s = enqueue(config, s, prop({ kind: 'note', text: 'Reply in German.' }, 'user')).session
  const q = nextQuestion(s)!
  assert.equal(q.question, 'Add rule: before Agent: skill dev-workflow loaded?')
  assert.deepEqual(q.options, ['Yes, everywhere', 'Yes, this project only', 'No'])
  assert.equal(nextQuestion(s)!.question, q.question, 'asking again changes nothing')
})

test('yes everywhere writes rule without where', () => {
  const s = enqueue(config, fresh(), prop(ruleRaw('dev-workflow'))).session
  const r = answer(config, s, s.proposals[0]!.hash, 'Yes, everywhere', '/work/a')
  assert.equal(r.write?.kind, 'rule')
  assert.equal('where' in r.write!.entry, false)
  assert.deepEqual(r.session.proposals, [])
})

test('yes project returns the root to write into and no where', () => {
  const s = enqueue(config, fresh(), prop(ruleRaw('dev-workflow'))).session
  const r = answer(config, s, s.proposals[0]!.hash, 'Yes, this project only', '/work/a')
  assert.equal(r.write!.project, '/work/a')
  assert.equal('where' in r.write!.entry, false)
})

test('a confirmed note without need is sent once in the next context', () => {
  const s = enqueue(config, fresh(), prop({ kind: 'note', text: 'Reply in German.' }, 'user')).session
  const r = answer(config, s, s.proposals[0]!.hash, 'Yes, everywhere', '/work/a')
  assert.deepEqual(r.session.freshNotes, [r.write!.entry.id])
})

test('other text yields revise request in next context', () => {
  let s = enqueue(config, fresh(), prop(ruleRaw('dev-workflow'))).session
  const r = answer(config, s, s.proposals[0]!.hash, 'Only when the brief is long')
  assert.deepEqual(r.session.proposals, [])
  assert.equal(r.write, undefined)
  assert.match(r.revise ?? '', /Only when the brief is long/)
  s = r.session
  const out = decide(config, s, { type: 'prompt', now: 1, text: 'go', fromUser: true, matched: [] })
  assert.match(out.actions.map((a) => (a.kind === 'context' ? a.text : '')).join('\n'), /Only when the brief is long/)
  assert.deepEqual(out.session.revise, [])
})

test('addEntry keeps every other key and refuses a taken id', () => {
  const doc = { mode: 'enforce', skills: { a: { always: true } }, trustProjects: ['/w'] }
  const entry: Rule = { id: 'r1', before: { tools: ['Agent'] }, skill: 's', source: 'slip' }
  const r = addEntry(doc, 'rule', entry)
  assert.deepEqual((r.config as typeof doc & { rules: Rule[] }).rules, [entry])
  assert.equal((r.config as typeof doc).mode, 'enforce')
  assert.deepEqual((r.config as typeof doc).trustProjects, ['/w'])
  assert.deepEqual(doc, { mode: 'enforce', skills: { a: { always: true } }, trustProjects: ['/w'] }, 'input untouched')
  assert.match(addEntry(r.config, 'rule', entry).note ?? '', /already/)
  assert.deepEqual(addEntry(undefined, 'note', { id: 'n', text: 'x', source: 'user' }).config, { notes: [{ id: 'n', text: 'x', source: 'user' }] })
})

test('addEntry with a root writes into projects[root], keeps the block and refuses a standard id', () => {
  const entry: Rule = { id: 'r1', before: { tools: ['Agent'] }, skill: 's', source: 'slip' }
  const doc = { notes: [{ id: 'n-std', text: 'x' }], projects: { '/work/a/': { block: ['n-std'], skills: { own: { always: true } } } } }
  const r = addEntry(doc, 'rule', entry, '/work/a')
  const cfg = r.config as { rules?: unknown; projects: Record<string, Record<string, unknown>> }
  assert.equal(cfg.rules, undefined)
  assert.deepEqual(cfg.projects['/work/a/']!.rules, [entry])
  assert.deepEqual(cfg.projects['/work/a/']!.skills, { own: { always: true } })
  assert.equal(addEntry(doc, 'note', { id: 'n-std', text: 'y', source: 'user' }, '/work/a').note, undefined, 'blocked first: allowed')
  const std = addEntry({ rules: [entry] }, 'rule', entry, '/work/a')
  assert.match(std.note ?? '', /already in the standard; block it first or rename/)
  assert.deepEqual(std.config, { rules: [entry] })
  assert.match(addEntry(r.config, 'rule', entry, '/work/a').note ?? '', /already in the block/)
})

test('parseShaped reads the small model answer, tolerates noise, falls back to a note', () => {
  const ok = parseShaped('Sure: {"kind":"rule","before":{"tools":["Agent"]},"field":"model"} done', 'Name a model on every Agent call', config)
  assert.equal(ok.kind, 'rule')
  const bad = parseShaped('no json here', 'Always answer in German', config)
  assert.equal(bad.kind, 'note')
  assert.equal((bad.entry as Note).text, 'Always answer in German')
  assert.equal(parseShaped('{"kind":"rule"}', 'x'.repeat(600), config).kind, 'note')
})

// --- Fix round ---

test('a passage proposal shows its file and line, and a project passage offers this project first', () => {
  const p = { ...prop({ kind: 'note', text: 'Load the guide first.' }, 'user'), origin: 'CLAUDE.md:12', project: true }
  const s = enqueue(config, fresh(), p).session
  const q = nextQuestion(s)!
  assert.match(q.question, /CLAUDE\.md:12/)
  assert.deepEqual(q.options, ['Yes, this project only', 'Yes, everywhere', 'No'])
  const user = { ...prop({ kind: 'note', text: 'Another one here.' }, 'user'), origin: '~/.claude/CLAUDE.md:3' }
  assert.deepEqual(nextQuestion(enqueue(config, fresh(), user).session)!.options, ['Yes, everywhere', 'Yes, this project only', 'No'])
})

test('a note needing a project-file need is refused when the user file lacks it', () => {
  const mixed: Config = { ...config, needs: { ui: { for: 'work', what: 'x' }, extra: { for: 'work', what: 'y' } }, userNeeds: ['ui'] }
  assert.match(makeProposal({ kind: 'note', text: 'hi there', need: 'extra' }, 'user', mixed).error ?? '', /need/)
  assert.ok(makeProposal({ kind: 'note', text: 'hi there', need: 'ui' }, 'user', mixed).proposal)
})

test('init pruning keeps a need that a note uses', async () => {
  const { applyChoice } = await import('../src/core/setup.ts')
  const doc = { needs: { ui: 'Screens.', old: 'Gone.' }, skills: {}, notes: [{ id: 'n', text: 'Show copy first.', need: 'ui', source: 'user' }] }
  const r = applyChoice(doc, 'writing-guide', 'start')
  const out = r.config as { needs: Record<string, string> }
  assert.deepEqual(Object.keys(out.needs), ['ui'])
  assert.deepEqual(r.pruned, ['old'])
})

test('parseReply accepts the listed words', () => {
  for (const w of ['accept', 'annehmen', ' Accept ', 'ANNEHMEN\n']) assert.equal(parseReply(w), 'accept', w)
  for (const w of ['decline', 'ablehnen', ' Decline ']) assert.equal(parseReply(w), 'decline', w)
})

test('parseReply ignores other text', () => {
  for (const w of ['ja', 'yes', 'nein', 'no', 'ja bitte', '', '  ', 'accept it', 'accept!', 'maybe']) assert.equal(parseReply(w), undefined, w)
})

test('the notice carries the reply hint and the caution for a skill text', () => {
  const p = prop({ kind: 'note', text: 'Reply in German.' }, 'user')
  assert.equal(proposalNotice(p), `Souffleur: proposal ${p.entry.id}: ${describeProposal(p).replace(/\.$/, '')}. Reply "accept" (everywhere) or "decline".`)
  assert.doesNotMatch(proposalNotice(p), /\.\./)
  assert.equal(proposalNotice(p, 'command'), `Souffleur: proposal ${p.entry.id}: ${describeProposal(p).replace(/\.$/, '')}. Run /souffleur accept ${p.entry.id} or /souffleur decline ${p.entry.id}.`)
  const q = { ...p, from: 'skill:writing-guide' }
  assert.match(proposalNotice(q), /read from a skill's text, not verified/)
})

test('shapePrompt lists needs by their text', () => {
  const prompt = shapePrompt('x', { ui: { for: 'users', what: 'Building a screen.' } })
  assert.match(prompt, /ui: Building a screen\./)
  assert.doesNotMatch(prompt, /\[object Object\]/)
})

test('a proposal whose id is blocked in the open root is a duplicate', () => {
  const p = prop({ kind: 'note', text: 'Keep it short.' }, 'user')
  const c: Config = { ...config, project: { root: '/work/a', blocked: [p.entry.id], blockedSkills: [], own: [], ignored: [] } }
  assert.equal(enqueue(c, fresh(), p).status, 'duplicate')
  assert.equal(enqueue(config, fresh(), p).status, 'queued')
})

test('addEntry everywhere refuses an id that a project block uses for its own entry', () => {
  const doc = { notes: [], projects: { '/work/a': { notes: [{ id: 'taken', text: 'x' }], rules: [{ id: 'taken-r', before: { tools: ['Edit'] }, skill: 's' }] } } }
  const note = { id: 'taken', text: 'y', source: 'user' } as Note
  const r = addEntry(doc, 'note', note)
  assert.deepEqual(r.config, doc)
  assert.match(r.note ?? '', /taken/)
  const rule = { id: 'taken-r', source: 'user', before: { tools: ['Edit'] }, skill: 's' } as unknown as Rule
  assert.match(addEntry(doc, 'rule', rule).note ?? '', /taken-r/)
  assert.equal(addEntry(doc, 'note', { ...note, id: 'free' }).note, undefined)
})
