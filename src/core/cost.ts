/** Token counts and the estimated cost of the small-model calls Souffleur makes, for one session or in total. */
export type ModelUse = {
  calls: number
  /** Uncached input tokens. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Dollars at list price, for the calls whose model is in `PRICES`. */
  usd: number
  /** Models used that have no price: their tokens count, their dollars stay unknown. */
  unpriced?: string[]
}

/** The fields of `ModelUsage` the count reads; a missing field counts as 0. */
export type UsageFields = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** List prices in USD per million tokens (the Anthropic pricing table, cached 2026-11-03). */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

/** The count after one more call; `usage` is absent for a call that was not answered. */
export function addUsage(acc: ModelUse | undefined, model: string, usage: UsageFields | undefined): ModelUse {
  const a: ModelUse = acc ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 }
  const input = num(usage?.input_tokens)
  const output = num(usage?.output_tokens)
  const cacheRead = num(usage?.cache_read_input_tokens)
  const cacheWrite = num(usage?.cache_creation_input_tokens)
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined
  const next: ModelUse = {
    calls: a.calls + 1,
    input: a.input + input,
    output: a.output + output,
    cacheRead: a.cacheRead + cacheRead,
    cacheWrite: a.cacheWrite + cacheWrite,
    usd: a.usd + (price === undefined ? 0 : (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1e6),
  }
  const unpriced = price === undefined && !(a.unpriced ?? []).includes(model) ? [...(a.unpriced ?? []), model] : a.unpriced
  if (unpriced !== undefined) next.unpriced = unpriced
  return next
}

/** `999`, `1.0k`, `18.3k`, `2.5M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = (n / 1000).toFixed(1)
  return k === '1000.0' || n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${k}k`
}

const dollars = (usd: number): string => (usd < 0.005 ? '< $0.01' : `$${usd.toFixed(2)}`)
const calls = (n: number): string => `${n} ${n === 1 ? 'call' : 'calls'}`
const priced = (u: ModelUse): string => (u.unpriced?.length ? `$ unknown for ${u.unpriced.join(', ')}` : dollars(u.usd))
const about = (u: ModelUse): string => (u.unpriced?.length || u.usd < 0.005 ? priced(u) : `about ${priced(u)}`)

/** The `/souffleur` line for this session and the total; undefined when no call was made. */
export function formatUse(session: ModelUse | undefined, total: ModelUse | undefined): string | undefined {
  const s = session !== undefined && session.calls > 0 ? session : undefined
  const t = total !== undefined && total.calls > 0 ? total : undefined
  if (s === undefined && t === undefined) return undefined
  const tail = t === undefined ? '' : ` (total ${calls(t.calls)}, ${about(t)})`
  const head = s === undefined ? 'no calls this session' : `${calls(s.calls)}, ${formatTokens(s.input + s.cacheRead + s.cacheWrite)} in / ${formatTokens(s.output)} out, ${about(s)} this session`
  return `Small model: ${head}${tail}. Estimate at list price.`
}

/** The status line addition: session dollars; empty while nothing was spent (no call, or calls without tokens). */
export function costSuffix(s: ModelUse | undefined): string {
  if (s === undefined || s.calls === 0) return ''
  if (s.unpriced?.length) return ' · $ unknown'
  if (s.usd === 0) return ''
  return s.usd < 0.005 ? ' · < $0.01' : ` · ~${dollars(s.usd)}`
}
