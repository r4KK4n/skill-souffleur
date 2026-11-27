import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRICES, addUsage, costSuffix, formatTokens, formatUse } from '../src/core/cost.ts'
import type { ModelUse } from '../src/core/cost.ts'

const use = (over: Partial<ModelUse> = {}): ModelUse => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, ...over })

test('the price table pins the list prices per million tokens', () => {
  assert.deepEqual(PRICES['claude-haiku-5-5'], { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 })
  assert.deepEqual(PRICES['haiku'], PRICES['claude-haiku-5-5'])
})

test('addUsage counts one call with its tokens and prices it', () => {
  const r = addUsage(undefined, 'haiku', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })
  assert.deepEqual(r, { calls: 1, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, usd: 0.1 + 0.5 + 0.01 + 0.125 })
})

test('addUsage adds to the accumulator and treats missing fields as 0', () => {
  const a = addUsage(undefined, 'claude-haiku-5-5', { input_tokens: 100, output_tokens: 10 })
  const b = addUsage(a, 'haiku', { output_tokens: 5 })
  assert.equal(b.calls, 2)
  assert.equal(b.input, 100)
  assert.equal(b.output, 15)
  assert.equal(b.cacheRead, 0)
  assert.ok(Math.abs(b.usd - (100 * 0.1 + 15 * 0.5) / 1e6) < 1e-12)
  assert.equal(b.unpriced, undefined)
})

test('a call without usage counts as one call with no tokens', () => {
  assert.deepEqual(addUsage(undefined, 'haiku', undefined), use({ calls: 1 }))
})

test('addUsage does not change its input', () => {
  const a = use({ calls: 1 })
  addUsage(a, 'haiku', { input_tokens: 5 })
  assert.deepEqual(a, use({ calls: 1 }))
})

test('an unknown model keeps its tokens, adds no dollars and is named once', () => {
  const a = addUsage(undefined, 'mystery-1', { input_tokens: 10, output_tokens: 2 })
  const b = addUsage(a, 'mystery-1', { input_tokens: 10 })
  assert.deepEqual(b, use({ calls: 2, input: 20, output: 2, unpriced: ['mystery-1'] }))
})

test('formatTokens uses k and M at one decimal', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1.0k')
  assert.equal(formatTokens(18_300), '18.3k')
  assert.equal(formatTokens(999_999), '1.0M')
  assert.equal(formatTokens(2_450_000), '2.5M')
})

test('formatUse gives the session and total line', () => {
  const s = use({ calls: 42, input: 18_000, output: 1_200, cacheRead: 300, usd: 0.03 })
  const t = use({ calls: 310, input: 1, output: 1, usd: 0.21 })
  assert.equal(formatUse(s, t), 'Small model: 42 calls, 18.3k in / 1.2k out, about $0.03 this session (total 310 calls, about $0.21). Estimate at list price.')
})

test('formatUse shows less than a cent and singular call', () => {
  assert.equal(formatUse(use({ calls: 1, input: 50, output: 2, usd: 0.000006 }), use({ calls: 1, usd: 0.000006 })), 'Small model: 1 call, 50 in / 2 out, < $0.01 this session (total 1 call, < $0.01). Estimate at list price.')
})

test('formatUse without a total or without calls', () => {
  assert.equal(formatUse(use({ calls: 2, input: 10, output: 1, usd: 0.02 }), undefined), 'Small model: 2 calls, 10 in / 1 out, about $0.02 this session. Estimate at list price.')
  assert.equal(formatUse(use(), use({ calls: 5, usd: 0.5 })), 'Small model: no calls this session (total 5 calls, about $0.50). Estimate at list price.')
  assert.equal(formatUse(undefined, undefined), undefined)
  assert.equal(formatUse(use(), use()), undefined)
})

test('an unknown model never shows as free', () => {
  const s = use({ calls: 3, input: 10, output: 1, usd: 0, unpriced: ['mystery-1'] })
  const line = formatUse(s, s)!
  assert.match(line, /\$ unknown for mystery-1 this session/)
  assert.match(line, /total 3 calls, \$ unknown for mystery-1/)
  assert.doesNotMatch(line, /\$0\.00|< \$0\.01/)
})

test('costSuffix shows session dollars, nothing at 0 calls, never a free unknown', () => {
  assert.equal(costSuffix(undefined), '')
  assert.equal(costSuffix(use()), '')
  assert.equal(costSuffix(use({ calls: 4, usd: 0.034 })), ' · ~$0.03')
  assert.equal(costSuffix(use({ calls: 4, usd: 0.0001 })), ' · < $0.01')
  assert.equal(costSuffix(use({ calls: 1, unpriced: ['x'] })), ' · $ unknown')
})

test('costSuffix stays empty when calls cost nothing', () => {
  assert.equal(costSuffix(use({ calls: 3, usd: 0 })), '')
})
