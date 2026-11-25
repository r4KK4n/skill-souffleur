import type { Session } from './decide.ts'
import type { Config, Mode } from './types.ts'

const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ')

/** `HH:MM` in UTC. */
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16)

/** The `/souffleur` reply: mode, one row per ledger entry, then non-empty sections, then the Claude Code version. */
export function renderTable(config: Config, s: Session, now: number): string {
  void now
  const lines = [`Mode: ${config.mode}${s.paused ? ' (paused)' : ''}`, '']
  lines.push('| Skill | State | Since | Reason |', '| --- | --- | --- | --- |')
  for (const [name, e] of Object.entries(s.ledger)) {
    lines.push(`| ${cell(name)} | ${e.state} | ${clock(e.since)} | ${cell(e.reason)} |`)
  }
  const duties = s.duties.map((d) => `- ${d.skill} (${d.by})`)
  if (duties.length) lines.push('', 'Open duties:', ...duties)
  const needs = Object.entries(s.needs).map(([name, n]) => `- ${name}: ${n.reason}`)
  if (needs.length) lines.push('', 'Active needs:', ...needs)
  const denied = s.observed.map((o) => `- ${clock(o.at)} ${o.reason}`)
  if (denied.length) lines.push('', 'Would have denied:', ...denied)
  if (s.errors.length) lines.push('', 'Errors:', ...s.errors.map((err) => `- ${err}`))
  if (s.version !== undefined) lines.push('', `Claude Code ${s.version}`)
  return lines.join('\n')
}

/** Short summary for the status line; undefined when no skill is configured. */
export function statusLine(s: Session, mode: Mode): string | undefined {
  if (s.errors.length) return 'souffleur: degraded, see /souffleur'
  const counts = { loaded: 0, restoring: 0, stale: 0, unavailable: 0 }
  for (const e of Object.values(s.ledger)) {
    if (e.state in counts) counts[e.state as keyof typeof counts] += 1
  }
  if (Object.keys(s.ledger).length === 0) return undefined
  const prefix = mode === 'observe' ? 'souffleur (observe):' : 'souffleur:'
  const parts = [`${counts.loaded} loaded`]
  if (counts.restoring) parts.push(`${counts.restoring} restoring`)
  if (counts.stale) parts.push(`${counts.stale} stale`)
  if (counts.unavailable) parts.push(`${counts.unavailable} unavailable`)
  return `${prefix} ${parts.join(', ')}`
}
