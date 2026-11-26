import type { Session } from './decide.ts'
import { contextNotes, sectionNotes } from './rules.ts'
import { excludedIn, isTrustedRoot } from './config.ts'
import type { Config, Mode } from './types.ts'
import { versionNotice } from './version.ts'

const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ')

/** `HH:MM` in UTC. */
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16)

/** The first sentence of each line of a reason, without final periods. */
const heads = (reason: string): string[] => reason.split('\n').map((l) => (l.split(/\.(?:\s|$)/)[0] ?? l).trim())

/** The `/souffleur` reply: mode, the version notice when Claude Code is newer than the verified one, one row per ledger entry, then non-empty sections, then the Claude Code version. */
export function renderTable(config: Config, s: Session, now: number, root?: string): string {
  void now
  const lines = [`Mode: ${config.mode}${s.paused ? ' (paused)' : ''}. Times in UTC.`]
  const notice = versionNotice(s.version)
  if (notice) lines.push(notice)
  lines.push('')
  lines.push('| Skill | State | Since | Reason |', '| --- | --- | --- | --- |')
  for (const [name, e] of Object.entries(s.ledger)) {
    const state = config.skills[name] !== undefined && excludedIn(config.skills[name]!, root) ? 'excluded in this project' : e.state
    lines.push(`| ${cell(name)} | ${state} | ${clock(e.since)} | ${cell(e.reason)} |`)
  }
  if (!isTrustedRoot(config, root) && Object.values(config.skills).some((r) => r.from === 'project')) {
    lines.push('', 'The project file defines skills, but this project is not trusted (trustProjects in the user file): they are listed here and neither requested nor allowed to deny a call.')
  }
  const duties = s.duties.filter((d) => s.ledger[d.skill]?.state !== 'not installed here').map((d) => `- ${d.skill} (${d.by})`)
  if (duties.length) lines.push('', 'Open duties:', ...duties)
  const trusted = isTrustedRoot(config, root)
  const bare = Object.entries(config.needs).filter(([name, n]) => n.noAudience && (trusted || !(config.projectNeeds ?? []).includes(name))).map(([name]) => `${name}: no audience set, run /souffleur init`)
  if (bare.length) lines.push('', 'Needs without an audience:', ...bare)
  const needs = Object.entries(s.needs).map(([name, n]) => `- ${name} (since ${clock(n.since)})`)
  if (needs.length) lines.push('', 'Active needs:', ...needs)
  // Equal first sentences (per line, sorted) form one group, so a call that broke two checks stays apart from one that broke one.
  const groups = new Map<string, { n: number; first: number; last: number; newest: string; newestAt: number }>()
  for (const o of s.observed) {
    const key = heads(o.reason).sort().join('\n')
    const g = groups.get(key)
    if (!g) groups.set(key, { n: 1, first: o.at, last: o.at, newest: o.reason, newestAt: o.at })
    else Object.assign(g, { n: g.n + 1, first: Math.min(g.first, o.at), last: Math.max(g.last, o.at), ...(o.at >= g.newestAt ? { newest: o.reason, newestAt: o.at } : {}) })
  }
  const indent = (text: string) => text.split('\n').map((l) => `  ${l}`)
  const denied = [...groups.values()].flatMap((g) => {
    if (g.n === 1) {
      const [first = '', ...rest] = g.newest.split('\n')
      return [`- ${clock(g.first)} ${first}`, ...rest.map((l) => `  ${l}`)]
    }
    return [`- ${g.n}× ${heads(g.newest).join('; ')} (${clock(g.first)}–${clock(g.last)})`, ...indent(g.newest)]
  })
  if (denied.length) lines.push('', 'Would have denied:', ...denied)
  if (s.proposals.length) lines.push('', `Open proposals (${s.proposals.length}), /souffleur review asks about them:`, ...s.proposals.map((p) => `- ${p.entry.id}`))
  const leftOut = sectionNotes(config, root).leftOut
  if (leftOut.length) lines.push('', `Notes left out of the system prompt (2,000 character limit): ${leftOut.map((n) => n.id).join(', ')}`)
  const due = contextNotes(config, s, root)
  const waiting = due.leftOut
  if (waiting.length) lines.push('', `Notes waiting for a later prompt (a context block holds 2,000 characters): ${waiting.map((n) => n.id).join(', ')}`)
  if (config.rules.length || config.notes.length) lines.push('', `Rules: ${config.rules.length}, notes: ${config.notes.length}`)
  if (s.errors.length) lines.push('', 'Errors:', ...s.errors.map((err) => `- ${err}`))
  if (s.version !== undefined) lines.push('', `Claude Code ${s.version}`)
  return lines.join('\n')
}

/** Short summary for the status line; undefined when no skill is configured. */
export function statusLine(s: Session, mode: Mode, notesLeftOut = 0, config?: Config, root?: string): string | undefined {
  if (s.errors.length) return 'degraded, see /souffleur'
  const counts = { loaded: 0, restoring: 0, stale: 0, unavailable: 0, 'not installed here': 0 }
  for (const [name, e] of Object.entries(s.ledger)) {
    if (config?.skills[name] !== undefined && excludedIn(config.skills[name]!, root)) continue
    if (e.state in counts) counts[e.state as keyof typeof counts] += 1
  }
  if (Object.keys(s.ledger).length === 0 && s.proposals.length === 0 && notesLeftOut === 0) return undefined
  const prefix = mode === 'observe' ? 'observe ·' : ''
  const parts = [`${counts.loaded} loaded`]
  if (counts.restoring) parts.push(`${counts.restoring} restoring`)
  if (counts.stale) parts.push(`${counts.stale} stale`)
  if (counts.unavailable) parts.push(`${counts.unavailable} unavailable`)
  if (counts['not installed here']) parts.push(`${counts['not installed here']} not installed here`)
  if (s.proposals.length) parts.push(`${s.proposals.length} to review`)
  if (notesLeftOut) parts.push(`${notesLeftOut} ${notesLeftOut === 1 ? 'note' : 'notes'} over the limit`)
  return prefix ? `${prefix} ${parts.join(', ')}` : parts.join(', ')
}
