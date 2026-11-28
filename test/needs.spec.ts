import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDeliverable, clip, neededSkills } from '../src/core/needs.ts'
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
    trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify',
    skills: {
      a: { need: 'ui', from: 'user' },
      b: { always: true, from: 'user' },
      c: { need: 'prose', from: 'user' },
      d: { from: 'user' },
    },
  }
  assert.deepEqual(neededSkills(config, { prose: {} }), ['b', 'c'])
  assert.deepEqual(neededSkills(config, { prose: {}, ui: {} }), ['a', 'b', 'c'])
  assert.deepEqual(neededSkills(config, {}), ['b'])
})

test('neededSkills leaves out skills excluded in the root, extras included', () => {
  const config: Config = {
    mode: 'observe', needs, trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify',
    skills: { a: { always: true, from: 'user', notIn: ['/work/p'] }, b: { need: 'ui', from: 'user' }, c: { from: 'user', notIn: ['/work/p'] } },
  }
  assert.deepEqual(neededSkills(config, { ui: {} }, ['c'], '/work/p/'), ['b'])
  assert.deepEqual(neededSkills(config, { ui: {} }, ['c'], '/work/q'), ['a', 'b', 'c'])
  assert.deepEqual(neededSkills(config, { ui: {} }, ['c']), ['a', 'b', 'c'])
})

test('call A asks about the deliverable with the exact labels and text', async () => {
  const seen: { text: string; labels: readonly string[] }[] = []
  await classifyDeliverable('write the docs', needs, async (text, labels) => { seen.push({ text, labels }); return 'chat-reply' }, never)
  const a = seen.find((c) => c.labels.includes('chat-reply'))!
  assert.deepEqual(a.labels, ['chat-reply', 'text-for-others', 'screen', 'code-or-repo-work'])
  assert.equal(
    a.text,
    'What will the agent produce in answer to this prompt? Answer with one label.\nchat-reply: an answer, explanation, discussion or status in this chat.\ntext-for-others: a text other people will read, such as a README, docs, an issue, a pull request text or app copy.\nscreen: something users of a product see, such as a page, a component or a prototype.\ncode-or-repo-work: code, tests, a fix, configuration or other changes in the repository.\n\nPrompt:\nwrite the docs',
  )
})

test('each deliverable label maps to its needs', async () => {
  assert.deepEqual(await classifyDeliverable('x', needs, kind('chat-reply', 'debug'), never), { matched: [], failed: false, kind: 'chat-reply' })
  assert.deepEqual(await classifyDeliverable('x', needs, kind('text-for-others'), never), { matched: ['prose'], failed: false, kind: 'text-for-others' })
  assert.deepEqual(await classifyDeliverable('x', needs, kind('screen'), never), { matched: ['ui'], failed: false, kind: 'screen' })
  assert.deepEqual(await classifyDeliverable('x', needs, kind('code-or-repo-work', 'plan'), never), { matched: ['plan'], failed: false, kind: 'code-or-repo-work' })
})

test('call B labels are the work need names plus none, the descriptions sit in the text, and none starts nothing', async () => {
  const seen: (readonly string[])[] = []
  const texts: string[] = []
  const got = await classifyDeliverable('x', needs, async (text, labels) => { seen.push(labels); texts.push(text); return text.startsWith('What will') ? 'code-or-repo-work' : 'none' }, never)
  assert.deepEqual(got, { matched: [], failed: false, kind: 'code-or-repo-work' })
  assert.deepEqual(seen.find((l) => l.includes('none')), ['debug', 'plan', 'none'])
  assert.match(texts.find((t) => t.includes('Which kind'))!, /debug: Debugging a failure\.\nplan: Planning a change\./)
})

test('a German chat question classified chat-reply starts nothing', async () => {
  const got = await classifyDeliverable('warum steht dort restoring?', needs, kind('chat-reply', 'debug'), never)
  assert.deepEqual(got.matched, [])
  assert.equal(got.failed, false)
})

test('A late is a timeout failure', async () => {
  const got = await classifyDeliverable('x', needs, (text) => (text.startsWith('What will') ? new Promise<string>(() => {}) : Promise.resolve('none')), () => Promise.resolve(), 1)
  assert.deepEqual(got, { matched: [], failed: true, failure: 'timeout' })
})

test('A with an unknown label is unknown-label, a throw is rejected', async () => {
  assert.deepEqual(await classifyDeliverable('x', needs, kind('banana'), never), { matched: [], failed: true, failure: 'unknown-label' })
  const thrown = await classifyDeliverable('x', needs, async () => { throw new Error('boom') }, never)
  assert.deepEqual(thrown, { matched: [], failed: true, failure: 'rejected' })
})

test('one slow call B does not fail the prompt when A answered in time', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const run = classifyDeliverable('x', needs, (text) => (text.startsWith('What will') ? Promise.resolve('code-or-repo-work') : new Promise<string>(() => {})), () => gate)
  release()
  assert.deepEqual(await run, { matched: [], failed: false, kind: 'code-or-repo-work', bFailure: 'timeout' })
})

test('a throwing call B never fails the prompt', async () => {
  const got = await classifyDeliverable('x', needs, async (text) => { if (text.startsWith('What will')) return 'code-or-repo-work'; throw new Error('boom') }, never)
  assert.deepEqual(got, { matched: [], failed: false, kind: 'code-or-repo-work', bFailure: 'rejected' })
})

test('without work needs call B is not made', async () => {
  let calls = 0
  await classifyDeliverable('x', { prose: needs.prose }, async () => { calls += 1; return 'code-or-repo-work' }, never)
  assert.equal(calls, 1)
})

test('chat-reply returns at once, whatever B and the clock do', async () => {
  const got = await classifyDeliverable('x', needs, (text) => (text.startsWith('What will') ? Promise.resolve('chat-reply') : new Promise<string>(() => {})), never)
  assert.deepEqual(got, { matched: [], failed: false, kind: 'chat-reply' })
})

test('B failures are reported as bFailure only for code work', async () => {
  const code = (b: () => Promise<string>) => async (text: string) => (text.startsWith('What will') ? 'code-or-repo-work' : b())
  assert.equal((await classifyDeliverable('x', needs, code(async () => { throw new Error('boom') }), never)).bFailure, 'rejected')
  assert.equal((await classifyDeliverable('x', needs, code(async () => 'banana'), never)).bFailure, 'unknown-label')
  assert.equal((await classifyDeliverable('x', needs, code(async () => ''), never)).bFailure, 'rejected')
  const late = await classifyDeliverable('x', needs, (text) => (text.startsWith('What will') ? Promise.resolve('code-or-repo-work') : new Promise<string>(() => {})), () => Promise.resolve(), 1)
  assert.deepEqual(late, { matched: [], failed: false, kind: 'code-or-repo-work', bFailure: 'timeout' })
  assert.equal((await classifyDeliverable('x', needs, code(async () => 'none'), never)).bFailure, undefined)
  const chat = await classifyDeliverable('x', needs, async (text) => { if (text.startsWith('What will')) return 'chat-reply'; throw new Error('boom') }, never)
  assert.equal(chat.bFailure, undefined)
})

test('an empty or null answer of A is rejected, not unknown-label', async () => {
  assert.equal((await classifyDeliverable('x', needs, async () => '', never)).failure, 'rejected')
  assert.equal((await classifyDeliverable('x', needs, async () => null as unknown as string, never)).failure, 'rejected')
})

test('B maps by label index even when a need name is a prefix of another', async () => {
  const two = { debug: { for: 'work', what: 'a: b' }, 'debug-more': { for: 'work', what: 'c' } } as const
  const got = await classifyDeliverable('x', two, async (text, labels) => (text.startsWith('What will') ? 'code-or-repo-work' : labels[1]!), never)
  assert.deepEqual(got.matched, ['debug-more'])
})

test('A and B have their own budgets: B outlives the A budget', async () => {
  const waits: number[] = []
  const sleep = (ms: number) => { waits.push(ms); return new Promise<void>(() => {}) }
  const got = await classifyDeliverable('x', needs, async (text) => (text.startsWith('What will') ? 'code-or-repo-work' : 'debug'), sleep)
  assert.deepEqual(waits.sort(), [2500, 4000])
  assert.deepEqual(got.matched, ['debug'])
})

test('call B is not timed when no work need exists', async () => {
  const waits: number[] = []
  const sleep = (ms: number) => { waits.push(ms); return new Promise<void>(() => {}) }
  await classifyDeliverable('x', { prose: { for: 'readers', what: 'w' } }, async () => 'chat-reply', sleep)
  assert.deepEqual(waits, [2500])
})

test('an answer with whitespace or a trailing period still matches its label', async () => {
  for (const answer of ['code-or-repo-work.', '  code-or-repo-work\n', ' code-or-repo-work. ']) {
    const r = await classifyDeliverable('x', needs, kind(answer, 'plan'), never)
    assert.deepEqual(r, { matched: ['plan'], failed: false, kind: 'code-or-repo-work' }, JSON.stringify(answer))
  }
  assert.deepEqual(await classifyDeliverable('x', needs, kind('chat-reply', ' debug. '), never), { matched: [], failed: false, kind: 'chat-reply' })
  assert.equal((await classifyDeliverable('x', needs, kind('code-or-repo-work', ' debug. '), never)).matched[0], 'debug')
})

test('quotes, backticks, a Label: prefix and case differences still match', async () => {
  for (const answer of ['"code-or-repo-work"', '`code-or-repo-work`', "'Code-Or-Repo-Work'.", 'Label: code-or-repo-work', 'label:  `CODE-or-repo-work`.', 'LABEL: "code-or-repo-work"\n']) {
    const r = await classifyDeliverable('x', needs, kind(answer, 'Plan'), never)
    assert.deepEqual(r, { matched: ['plan'], failed: false, kind: 'code-or-repo-work' }, JSON.stringify(answer))
  }
  assert.equal((await classifyDeliverable('x', needs, kind('Chat-Reply'), never)).kind, 'chat-reply')
})

test('an answer that holds a label inside a sentence does not match', async () => {
  for (const answer of ['I think chat-reply fits.', 'chat-reply or screen', 'The label is code-or-repo-work.', 'Label: chat-reply is right', '`chat-reply` or `screen`']) {
    const r = await classifyDeliverable('x', needs, kind(answer), never)
    assert.deepEqual(r, { matched: [], failed: true, failure: 'unknown-label' }, answer)
  }
})

const wf = (x: string): boolean => (x as unknown as { isWellFormed(): boolean }).isWellFormed()

test('clip keeps surrogate pairs whole at both cuts', () => {
  const head = `${'a'.repeat(1499)}😀${'b'.repeat(3000)}`
  assert.equal(head.charCodeAt(1499) >= 0xd800 && head.charCodeAt(1499) <= 0xdbff, true)
  const out = clip(head)
  assert.equal(wf(out), true)
  const tailCut = `${'c'.repeat(3000)}😀${'d'.repeat(499)}`
  assert.equal(wf(clip(tailCut)), true)
  assert.equal(wf(clip(`${'e'.repeat(2400)}😀`.repeat(3))), true)
})

// --- workCheck: "after" starts call B only after A said code work (#126) ---

test('with workCheck after, A=chat-reply makes no call B at all', async () => {
  const seen: string[] = []
  const got = await classifyDeliverable('x', needs, async (text) => { seen.push(text); return 'chat-reply' }, never, 2500, 4000, { workCheck: 'after' })
  assert.deepEqual(got, { matched: [], failed: false, kind: 'chat-reply' })
  assert.equal(seen.length, 1)
})

test('with workCheck after, text-for-others and screen make no call B either', async () => {
  for (const a of ['text-for-others', 'screen']) {
    const seen: string[] = []
    await classifyDeliverable('x', needs, async (text) => { seen.push(text); return a }, never, 2500, 4000, { workCheck: 'after' })
    assert.equal(seen.length, 1, a)
  }
})

test('with workCheck after, A=code makes exactly one call B and it starts after A resolved', async () => {
  const log: string[] = []
  const got = await classifyDeliverable(
    'x',
    needs,
    async (text) => {
      if (text.startsWith('What will')) {
        log.push('A start')
        await Promise.resolve()
        log.push('A end')
        return 'code-or-repo-work'
      }
      log.push('B start')
      return 'plan'
    },
    never,
    2500,
    4000,
    { workCheck: 'after' },
  )
  assert.deepEqual(log, ['A start', 'A end', 'B start'])
  assert.deepEqual(got, { matched: ['plan'], failed: false, kind: 'code-or-repo-work' })
})

test('in parallel mode both calls start before A resolves', async () => {
  const log: string[] = []
  await classifyDeliverable('x', needs, async (text) => { log.push(text.startsWith('What will') ? 'A start' : 'B start'); await Promise.resolve(); return text.startsWith('What will') ? 'chat-reply' : 'none' }, never)
  assert.deepEqual(log, ['A start', 'B start'])
})

test('with workCheck after, B gets its own budget counted from its own start', async () => {
  const sleeps: { ms: number; at: string[] }[] = []
  const events: string[] = []
  const sleep = (ms: number) => { events.push(`sleep ${ms}`); return new Promise<void>(() => {}) }
  await classifyDeliverable(
    'x',
    needs,
    async (text, _l, t) => { events.push(`${text.startsWith('What will') ? 'A' : 'B'} ${t}`); return text.startsWith('What will') ? 'code-or-repo-work' : 'none' },
    sleep,
    2500,
    4000,
    { workCheck: 'after' },
  )
  void sleeps
  // B's timer is created after A's call started and answered, not together with A's timer.
  assert.deepEqual(events, ['sleep 2500', 'A 2500', 'sleep 4000', 'B 4000'])
})

test('with workCheck after, a slow B times out on its own budget and fails nothing else', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  let n = 0
  const sleep = () => (++n === 1 ? new Promise<void>(() => {}) : gate)
  const run = classifyDeliverable('x', needs, (text) => (text.startsWith('What will') ? Promise.resolve('code-or-repo-work') : new Promise<string>(() => {})), sleep, 2500, 4000, { workCheck: 'after' })
  await Promise.resolve()
  release()
  assert.deepEqual(await run, { matched: [], failed: false, kind: 'code-or-repo-work', bFailure: 'timeout' })
})

test('with workCheck after, a failed A makes no call B', async () => {
  const seen: string[] = []
  const got = await classifyDeliverable('x', needs, async (text) => { seen.push(text); return 'banana' }, never, 2500, 4000, { workCheck: 'after' })
  assert.deepEqual(got, { matched: [], failed: true, failure: 'unknown-label' })
  assert.equal(seen.length, 1)
})

test('skipWork makes no call B in either mode and picks no work need', async () => {
  for (const workCheck of ['parallel', 'after'] as const) {
    const seen: string[] = []
    const got = await classifyDeliverable('x', needs, async (text) => { seen.push(text); return 'code-or-repo-work' }, never, 2500, 4000, { workCheck, skipWork: true })
    assert.deepEqual(got, { matched: [], failed: false, kind: 'code-or-repo-work' }, workCheck)
    assert.equal(seen.length, 1, workCheck)
  }
})
