import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDeliverable, neededSkills } from '../src/core/needs.ts'
import type { Config } from '../src/core/types.ts'

const needs = {
  prose: { for: 'readers', what: 'Writing text people read.' },
  ui: { for: 'users', what: 'Building a screen.' },
  debug: { for: 'work', what: 'Debugging a failure.' },
  plan: { for: 'work', what: 'Planning a change.' },
} as const
const never = () => new Promise<void>(() => {})
const kind = (a: string, b = 'none') => async (text: string) => (text.startsWith('What will the agent produce') ? a : b)

test('neededSkills keeps config order and includes always skills', () => {
  const config: Config = {
    mode: 'observe',
    needs,
    trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true,
    skills: {
      a: { need: 'ui', from: 'user' },
      b: { always: true, from: 'user' },
      c: { need: 'prose', from: 'user' },
      d: { from: 'user' },
    },
  }
  assert.deepEqual(neededSkills(config, { prose: 1 }), ['b', 'c'])
  assert.deepEqual(neededSkills(config, { prose: 1, ui: 1 }), ['a', 'b', 'c'])
  assert.deepEqual(neededSkills(config, {}), ['b'])
})

test('neededSkills leaves out skills excluded in the root, extras included', () => {
  const config: Config = {
    mode: 'observe', needs, trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true,
    skills: { a: { always: true, from: 'user', notIn: ['/work/p'] }, b: { need: 'ui', from: 'user' }, c: { from: 'user', notIn: ['/work/p'] } },
  }
  assert.deepEqual(neededSkills(config, { ui: 1 }, ['c'], '/work/p/'), ['b'])
  assert.deepEqual(neededSkills(config, { ui: 1 }, ['c'], '/work/q'), ['a', 'b', 'c'])
  assert.deepEqual(neededSkills(config, { ui: 1 }, ['c']), ['a', 'b', 'c'])
})

test('call A asks about the deliverable with the exact labels and text', async () => {
  const seen: { text: string; labels: readonly string[] }[] = []
  await classifyDeliverable('write the docs', needs, async (text, labels) => { seen.push({ text, labels }); return 'chat-reply' }, never)
  const a = seen.find((c) => c.labels.includes('chat-reply'))!
  assert.deepEqual(a.labels, ['chat-reply', 'text-for-others', 'screen', 'code-or-repo-work'])
  assert.equal(a.text, 'What will the agent produce in answer to this prompt?\n\nwrite the docs')
})

test('each deliverable label maps to its needs', async () => {
  assert.deepEqual(await classifyDeliverable('x', needs, kind('chat-reply', 'debug: Debugging a failure.'), never), { matched: [], failed: false, kind: 'chat-reply' })
  assert.deepEqual(await classifyDeliverable('x', needs, kind('text-for-others'), never), { matched: ['prose'], failed: false, kind: 'text-for-others' })
  assert.deepEqual(await classifyDeliverable('x', needs, kind('screen'), never), { matched: ['ui'], failed: false, kind: 'screen' })
  assert.deepEqual(await classifyDeliverable('x', needs, kind('code-or-repo-work', 'plan: Planning a change.'), never), { matched: ['plan'], failed: false, kind: 'code-or-repo-work' })
})

test('call B offers only work needs plus none, and none starts nothing', async () => {
  const seen: (readonly string[])[] = []
  const got = await classifyDeliverable('x', needs, async (text, labels) => { seen.push(labels); return text.startsWith('What will') ? 'code-or-repo-work' : 'none' }, never)
  assert.deepEqual(got, { matched: [], failed: false, kind: 'code-or-repo-work' })
  assert.deepEqual(seen.find((l) => l.includes('none')), ['debug: Debugging a failure.', 'plan: Planning a change.', 'none'])
})

test('a German chat question classified chat-reply starts nothing', async () => {
  const got = await classifyDeliverable('warum steht dort restoring?', needs, kind('chat-reply', 'debug: Debugging a failure.'), never)
  assert.deepEqual(got.matched, [])
  assert.equal(got.failed, false)
})

test('A late is a timeout failure', async () => {
  const got = await classifyDeliverable('x', needs, (text) => (text.startsWith('What will') ? new Promise<string>(() => {}) : Promise.resolve('none')), () => Promise.resolve(), 1)
  assert.deepEqual(got, { matched: [], failed: true, failure: 'timeout' })
})

test('A with an unknown or empty label is unknown-label, a throw is rejected', async () => {
  assert.deepEqual(await classifyDeliverable('x', needs, kind('banana'), never), { matched: [], failed: true, failure: 'unknown-label' })
  assert.equal((await classifyDeliverable('x', needs, kind(''), never)).failure, 'unknown-label')
  const thrown = await classifyDeliverable('x', needs, async () => { throw new Error('boom') }, never)
  assert.deepEqual(thrown, { matched: [], failed: true, failure: 'rejected' })
})

test('one slow call B does not fail the prompt when A answered in time', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const run = classifyDeliverable('x', needs, (text) => (text.startsWith('What will') ? Promise.resolve('code-or-repo-work') : new Promise<string>(() => {})), () => gate)
  release()
  assert.deepEqual(await run, { matched: [], failed: false, kind: 'code-or-repo-work' })
})

test('a throwing call B never fails the prompt', async () => {
  const got = await classifyDeliverable('x', needs, async (text) => { if (text.startsWith('What will')) return 'code-or-repo-work'; throw new Error('boom') }, never)
  assert.deepEqual(got, { matched: [], failed: false, kind: 'code-or-repo-work' })
})

test('without work needs call B is not made', async () => {
  let calls = 0
  await classifyDeliverable('x', { prose: needs.prose }, async () => { calls += 1; return 'code-or-repo-work' }, never)
  assert.equal(calls, 1)
})
