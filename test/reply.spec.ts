import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkReply } from '../src/core/reply.ts'

const FENCE = '```'

test('counts the characters of the answer and its headings', () => {
  const r = checkReply('# Title\nsome words\n## More\nend', { maxChars: 200, headings: 0 })
  assert.equal(r.headings, 2)
  assert.equal(r.chars, '# Title\nsome words\n## More\nend'.length)
  assert.equal(r.over, true)
  assert.equal(r.skip, false)
})

test('a heading is one to six hashes and a space at the start of a line', () => {
  const r = checkReply('####### seven\n#nospace\n  # indented\n###### six\n# one', {})
  assert.equal(r.headings, 2)
})

test('fenced code and inline code do not count towards the length', () => {
  const answer = `short ${FENCE}ts\n${'x'.repeat(500)}\n${FENCE} and \`${'y'.repeat(300)}\` end`
  const r = checkReply(answer, { maxChars: 200 })
  assert.equal(r.chars, 'short  and  end'.length)
  assert.equal(r.over, false)
})

test('a hash line inside a fenced block is not a heading', () => {
  const r = checkReply(`text\n${FENCE}sh\n# comment\n${FENCE}\nmore text more text more text`, { headings: 0 })
  assert.equal(r.headings, 0)
  assert.equal(r.over, false)
})

test('a limit that is not set is no limit', () => {
  const long = checkReply('a'.repeat(5000), { headings: 0 })
  assert.equal(long.over, false)
  const heads = checkReply('# h\n' + 'a'.repeat(5000), { maxChars: 20000 })
  assert.equal(heads.over, false)
  assert.equal(checkReply('# h\n' + 'a'.repeat(5000), {}).over, false)
})

test('over is true at one more than the limit, false at the limit', () => {
  assert.equal(checkReply('a'.repeat(200), { maxChars: 200 }).over, false)
  assert.equal(checkReply('a'.repeat(201), { maxChars: 200 }).over, true)
  assert.equal(checkReply('# a\nb', { headings: 1 }).over, false)
  assert.equal(checkReply('# a\n## b', { headings: 1 }).over, true)
})

test('an answer that is mostly a code block is skipped, not a violation', () => {
  const answer = `Here:\n${FENCE}ts\n${'x'.repeat(3000)}\n${FENCE}\n`
  const r = checkReply(answer, { maxChars: 200 })
  assert.equal(r.skip, true)
  assert.equal(r.over, false)
})

test('half code or less is checked; an empty answer is skipped', () => {
  const answer = `${'t'.repeat(600)}\n${FENCE}\n${'x'.repeat(100)}\n${FENCE}\n`
  assert.equal(checkReply(answer, { maxChars: 200 }).skip, false)
  assert.equal(checkReply('', { maxChars: 200 }).skip, true)
})

test('an unclosed fence runs to the end of the answer', () => {
  const r = checkReply(`hi\n${FENCE}\n${'x'.repeat(1000)}`, { maxChars: 200 })
  assert.equal(r.skip, true)
})

test('tilde fences count like backtick fences', () => {
  const r = checkReply(`hi\n~~~sh\n# not a heading\n${'x'.repeat(500)}\n~~~\nend`, { maxChars: 200, headings: 0 })
  assert.equal(r.headings, 0)
  assert.equal(r.chars, 'hi\n\nend'.length)
  assert.equal(r.over, false)
  assert.equal(checkReply(`~~~\n${'x'.repeat(1000)}`, { maxChars: 200 }).skip, true)
})
