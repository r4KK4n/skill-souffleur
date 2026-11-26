import { excludedIn } from './config.ts'
import type { Audience, Config, Need, NeedName, SkillName } from './types.ts'

export type Classify = (text: string, labels: readonly string[]) => Promise<string>

export const DELIVERABLES = ['chat-reply', 'text-for-others', 'screen', 'code-or-repo-work'] as const
export type Deliverable = (typeof DELIVERABLES)[number]
export type ClassifyFailure = 'timeout' | 'rejected' | 'unknown-label'

const LATE = '\0late'
const REJECTED = '\0rejected'

/**
 * Two classifier calls in parallel under one budget. Call A asks what the agent will produce; `text-for-others` starts every
 * `readers` need, `screen` every `users` need, `chat-reply` nothing. Call B picks one `work` need (or `none`) and counts only
 * when A says `code-or-repo-work`. A late, rejected or unknown answer of A fails the prompt; B never does.
 */
export async function classifyDeliverable(
  prompt: string,
  needs: Record<NeedName, Need>,
  classify: Classify,
  sleep: (ms: number) => Promise<void>,
  budgetMs = 2500,
): Promise<{ matched: NeedName[]; failed: boolean; kind?: Deliverable; failure?: ClassifyFailure }> {
  const timer = sleep(budgetMs).then(() => LATE)
  const entries = Object.entries(needs)
  const work = entries.filter(([, n]) => n.for === 'work')
  const labels = work.map(([name, n]) => `${name}: ${n.what}`)
  const callA = Promise.race([classify(`What will the agent produce in answer to this prompt?\n\n${prompt}`, DELIVERABLES), timer]).then(
    (answer): { answer: string } => ({ answer }),
    (): { answer: string } => ({ answer: REJECTED }),
  )
  // B starts at once so the two calls overlap; whether it counts is decided after A.
  const callB: Promise<string> =
    work.length === 0
      ? Promise.resolve('none')
      : Promise.race([classify(`Which kind of work does this prompt start?\n\n${prompt}`, [...labels, 'none']), timer]).catch(() => 'none')
  const [{ answer: a }, b] = await Promise.all([callA, callB])
  if (a === LATE) return { matched: [], failed: true, failure: 'timeout' }
  if (!(DELIVERABLES as readonly string[]).includes(a)) return { matched: [], failed: true, failure: a === REJECTED ? 'rejected' : 'unknown-label' }
  const kind = a as Deliverable
  const of = (audience: Audience) => entries.filter(([, n]) => n.for === audience).map(([name]) => name)
  if (kind === 'text-for-others') return { matched: of('readers'), failed: false, kind }
  if (kind === 'screen') return { matched: of('users'), failed: false, kind }
  if (kind === 'chat-reply' || b === LATE) return { matched: [], failed: false, kind }
  const pick = work.find(([name]) => b.slice(0, Math.max(b.indexOf(': '), 0)) === name || b === name)
  return { matched: pick ? [pick[0]] : [], failed: false, kind }
}

/** Skills with `always`, plus skills whose `need` is active, in config order, then `extra` (skills a rule fired or saw loaded). */
export function neededSkills(config: Config, active: Record<NeedName, unknown>, extra: readonly SkillName[] = [], root?: string): SkillName[] {
  const here = (name: string) => config.skills[name] === undefined || !excludedIn(config.skills[name]!, root)
  const named = Object.entries(config.skills)
    .filter(([, rule]) => rule.always === true || (rule.need !== undefined && rule.need in active))
    .map(([name]) => name)
    .filter(here)
  return [...named, ...extra.filter((name) => !named.includes(name) && here(name))]
}

/** Who a skill's output is for: the audience of its need, or its own `for` when always-on; otherwise `work`. */
export const audienceOf = (config: Config, name: SkillName): Audience => {
  const rule = config.skills[name]
  return rule?.for ?? (rule?.need === undefined ? undefined : config.needs[rule.need]?.for) ?? 'work'
}

/** The classifier text of each need, for code that still works with plain strings. */
export const needTexts = (needs: Record<NeedName, Need>): Record<NeedName, string> => Object.fromEntries(Object.entries(needs).map(([name, n]) => [name, n.what]))
