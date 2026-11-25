import type { Config, SkillName } from './types.ts'

export type SkillState = 'absent' | 'loaded' | 'stale' | 'restoring' | 'unavailable'
export type Entry = { state: SkillState; since: number; reason: string; lastCompactAt?: number; requests: number }
export type Ledger = Record<SkillName, Entry>

const MAX_REQUESTS = 2

/** One entry per configured skill plus `extra`. Injected skills start loaded only at a real startup. */
export function initLedger(config: Config, now: number, start: 'startup' | 'resume' | 'clear', extra: SkillName[] = []): Ledger {
  const ledger: Ledger = {}
  for (const [name, rule] of Object.entries(config.skills)) {
    ledger[name] = rule.startup === 'injected' && start === 'startup'
      ? { state: 'loaded', since: now, reason: 'injected at startup', requests: 0 }
      : { state: 'absent', since: now, reason: '', requests: 0 }
  }
  for (const name of extra) {
    if (!(name in ledger)) ledger[name] = { state: 'absent', since: now, reason: '', requests: 0 }
  }
  return ledger
}

/** A skill's text entered the context. Names the ledger does not know are ignored. */
export function skillLoaded(l: Ledger, skill: SkillName, now: number, reason: string): Ledger {
  if (!(skill in l)) return l
  return { ...l, [skill]: { ...l[skill]!, state: 'loaded', since: now, reason, requests: 0 } }
}

/** A compaction drops loaded text. Absent and unavailable skills are not affected. */
export function compacted(l: Ledger, now: number): Ledger {
  const next: Ledger = {}
  for (const [name, e] of Object.entries(l)) {
    if (e.state === 'loaded') next[name] = { ...e, state: 'stale', since: now, lastCompactAt: now }
    else if (e.state === 'stale') next[name] = { ...e, lastCompactAt: now }
    else if (e.state === 'restoring') next[name] = { ...e, lastCompactAt: now }
    else next[name] = e
  }
  return next
}

/** A load was requested for these skills. After two unanswered requests a skill becomes unavailable. */
export function requested(l: Ledger, skills: SkillName[], now: number): Ledger {
  const next: Ledger = { ...l }
  for (const name of skills) {
    const e = next[name]
    if (!e) continue
    if (e.requests >= MAX_REQUESTS) {
      next[name] = { ...e, state: 'unavailable', since: now, reason: `not seen after ${MAX_REQUESTS} requests` }
    } else {
      next[name] = { ...e, state: 'restoring', since: now, requests: e.requests + 1 }
    }
  }
  return next
}
