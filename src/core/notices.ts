import { isTrustedRoot } from './config.ts'
import type { Session } from './decide.ts'
import { neededSkills } from './needs.ts'
import type { Config, SkillName } from './types.ts'
import { versionNotice } from './version.ts'

const PREFIX = 'Souffleur: '

/** The line shown at session start, fresh or resumed. */
export function startNotice(config: Config, s: Session, setUp: boolean, pluginVersion: string): string {
  if (!setUp) return `${PREFIX}${pluginVersion} · not set up, run /souffleur init.`
  const skills = Object.values(config.skills)
  const always = skills.filter((r) => r.always === true).length
  const onDemand = skills.length - always
  const p = s.proposals.length
  return `${PREFIX}${pluginVersion} · ${config.mode} · ${always} always-on, ${onDemand} on demand${p ? ` · ${p} proposal(s) waiting` : ''}.`
}

/** First line of an error, ASCII only, at most 120 characters. */
function plainError(text: string): string {
  const line = (text.split(/\r?\n/)[0] ?? '').replace(/[^\x20-\x7e]/g, '?').trim()
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

/** The step an error belongs to: its first line up to the first `: `, else the whole line. */
function stepOf(error: string): string {
  const line = plainError(error)
  const gate = /^gate: (\S+) did not load/.exec(line)
  if (gate) return `gate:${gate[1]}`
  const i = line.indexOf(': ')
  return i > 0 ? line.slice(0, i) : line
}

/** The problems that hold now, key to line text. A key stays the same while the problem lasts. */
export function problemKeys(config: Config, s: Session, root?: string): Map<string, string> {
  const out = new Map<string, string>()
  // `not installed here` is normal for a project skill outside its project, so only `unavailable` counts.
  for (const [name, e] of Object.entries(s.ledger)) {
    if (e.state === 'unavailable') out.set(`missing:${name}`, `${PREFIX}${name} did not load after two requests.`)
  }
  // One key per step (the text before the first ": "); the line names that step's newest error.
  const newest = new Map<string, string>()
  for (const err of s.errors) newest.set(stepOf(err), err)
  const paused = (s.classifyPause ?? 0) > 0 ? ` Need detection is paused and will retry in ${s.classifyPause} prompts.` : ''
  const pausedB = (s.workPause ?? 0) > 0 ? ` Work detection is paused and will retry in ${s.workPause} prompts.` : ''
  for (const [step, err] of newest) out.set(`degraded:${step}`, `${PREFIX}degraded: ${plainError(err).replace(/\.$/, '')}.${step === 'classifier' ? paused : step === 'classifier B' ? pausedB : ''} Details: /souffleur.`)
  const version = versionNotice(s.version)
  if (version) out.set('version', `${PREFIX}${version}`)
  if (!isTrustedRoot(config, root) && Object.values(config.skills).some((r) => r.from === 'project')) {
    out.set('untrusted', `${PREFIX}this project's skill file is not trusted; its skills are listed only.`)
  }
  return out
}

/**
 * Lines for what changed between two sessions, once per event. The returned session carries what was told
 * in `noticed`; store it, or the same lines come again. `config.notices === false` keeps the bookkeeping and drops the lines.
 */
export function notices(config: Config, before: Session, after: Session, root?: string): { lines: string[]; session: Session } {
  const lines: string[] = []
  const was = before.noticed ?? { cut: [], problems: [] }
  const state = (s: Session, name: SkillName) => s.ledger[name]?.state

  // Only names the restore step will ask for count as cut: needed, trusted, session not paused. Others would never come back.
  const trusted = isTrustedRoot(config, root)
  const asked = new Set(after.paused ? [] : neededSkills(config, after.needs, after.ruleSkills, root).filter((name) => trusted || config.skills[name]?.from !== 'project'))
  // Names still cut stay; one that became unavailable, left the config, is not installed here or is no longer asked for cannot come back.
  const cut: SkillName[] = was.cut.filter((name) => asked.has(name) && ['stale', 'restoring', 'loaded'].includes(state(after, name) ?? ''))
  let newlyCut = false
  for (const name of Object.keys(before.ledger)) {
    if (asked.has(name) && state(before, name) === 'loaded' && state(after, name) === 'stale') {
      newlyCut = true
      if (!cut.includes(name)) cut.push(name)
    }
  }
  let nextCut = cut
  if (newlyCut) {
    lines.push(`${PREFIX}cut by compaction: ${cut.join(', ')}; will ask the model to reload them.`)
  } else if (cut.length > 0 && cut.every((name) => state(after, name) === 'loaded')) {
    lines.push(`${PREFIX}reloaded: ${cut.join(', ')}.`)
    nextCut = []
  }

  // A key is told at most twice a session: the second time only after a `back to normal`, with ` (again)`. A third
  // return is silent and never counts as a told problem. `problems` holds the told keys of this round; it is
  // emptied when nothing holds, so a step that clears while another still holds does not lose that `back to normal`.
  const now = problemKeys(config, after, root)
  const tells: Record<string, number> = { ...(was.tells ?? Object.fromEntries(was.problems.map((key) => [key, 1]))) }
  const told: string[] = []
  for (const [key, line] of now) {
    const n = tells[key] ?? 0
    if (n === 0 || (n === 1 && !was.problems.includes(key))) {
      lines.push(n === 0 ? line : line.replace(/\.( Details: \/souffleur\.)?$/, (_, details: string | undefined) => ` (again).${details ?? ''}`))
      tells[key] = n + 1
      told.push(key)
    }
  }
  const problems = now.size === 0 ? [] : [...new Set([...was.problems, ...told])]
  if (was.problems.length > 0 && now.size === 0) lines.push(`${PREFIX}back to normal.`)

  const session: Session = { ...after, noticed: { cut: nextCut, problems, tells } }
  return { lines: config.notices === false ? [] : lines, session }
}
