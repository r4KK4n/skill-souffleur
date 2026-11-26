import { isTrustedRoot } from './config.ts'
import type { Session } from './decide.ts'
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

/** The problems that hold now, key to line text. A key stays the same while the problem lasts. */
export function problemKeys(config: Config, s: Session, root?: string): Map<string, string> {
  const out = new Map<string, string>()
  // `not installed here` is normal for a project skill outside its project, so only `unavailable` counts.
  for (const [name, e] of Object.entries(s.ledger)) {
    if (e.state === 'unavailable') out.set(`missing:${name}`, `${PREFIX}${name} did not load after two requests.`)
  }
  if (s.errors.length > 0) out.set('degraded', `${PREFIX}degraded: ${s.errors.at(-1)}. Details: /souffleur.`)
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

  const cut: SkillName[] = [...was.cut]
  for (const name of Object.keys(before.ledger)) {
    const now = state(after, name)
    if (state(before, name) === 'loaded' && (now === 'stale' || now === 'absent') && !cut.includes(name)) cut.push(name)
  }
  let nextCut = cut
  if (cut.length > was.cut.length) {
    lines.push(`${PREFIX}cut by compaction: ${cut.join(', ')}; asked the model to reload them.`)
  } else if (cut.length > 0 && cut.every((name) => state(after, name) === 'loaded')) {
    lines.push(`${PREFIX}reloaded: ${cut.join(', ')}.`)
    nextCut = []
  }

  const now = problemKeys(config, after, root)
  for (const [key, text] of now) if (!was.problems.includes(key)) lines.push(text)
  if (was.problems.length > 0 && now.size === 0) lines.push(`${PREFIX}back to normal.`)

  const session: Session = { ...after, noticed: { cut: nextCut, problems: [...now.keys()] } }
  return { lines: config.notices === false ? [] : lines, session }
}
