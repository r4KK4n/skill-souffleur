import type { Config, SkillName } from './types.ts'

/** `not installed here`: the config names the skill but this session's skill list does not, so it is neither requested nor gated. */
export type SkillState = 'absent' | 'loaded' | 'stale' | 'restoring' | 'unavailable' | 'not installed here'
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

/** The ledger after a config change: new skills start absent, removed ones disappear, the rest keep their entry. */
export function syncLedger(l: Ledger, config: Config, now: number): Ledger {
  const next: Ledger = {}
  for (const name of Object.keys(config.skills)) next[name] = l[name] ?? { state: 'absent', since: now, reason: '', requests: 0 }
  return next
}

/**
 * Compares the configured skills with the session's skill list. An absent skill missing from the list becomes
 * `not installed here`; one that is on the list again becomes absent. Loaded, stale and requested skills stay as they are.
 * An empty list means the list could not be read, so nothing changes.
 */
export function markInstalled(l: Ledger, names: string[], now: number): Ledger {
  if (names.length === 0) return l
  const here = new Set(names)
  let changed = false
  const next: Ledger = {}
  for (const [name, e] of Object.entries(l)) {
    if (e.state === 'absent' && !here.has(name)) {
      next[name] = { ...e, state: 'not installed here', since: now, reason: 'not in this session\'s skill list' }
      changed = true
    } else if (e.state === 'not installed here' && here.has(name)) {
      next[name] = { ...e, state: 'absent', since: now, reason: '' }
      changed = true
    } else next[name] = e
  }
  return changed ? next : l
}
