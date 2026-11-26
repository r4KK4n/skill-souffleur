import { excludedIn } from './config.ts'
import type { Audience, Config, Need, NeedName, SkillName } from './types.ts'

export type Classify = (text: string, labels: readonly string[]) => Promise<string>

export const DELIVERABLES = ['chat-reply', 'text-for-others', 'screen', 'code-or-repo-work'] as const
export type Deliverable = (typeof DELIVERABLES)[number]
export type ClassifyFailure = 'timeout' | 'rejected' | 'unknown-label'

const A_TEXT = [
  'What will the agent produce in answer to this prompt? Answer with one label.',
  'chat-reply: an answer, explanation, discussion or status in this chat.',
  'text-for-others: a text other people will read, such as a README, docs, an issue, a pull request text or app copy.',
  'screen: something users of a product see, such as a page, a component or a prototype.',
  'code-or-repo-work: code, tests, a fix, configuration or other changes in the repository.',
].join('\n')
const LATE = '\0late'

/**
 * Two classifier calls in parallel under one budget. Call A asks what the agent will produce; `text-for-others` starts every
 * `readers` need, `screen` every `users` need, `chat-reply` nothing. Call B picks one `work` need (or `none`) and counts only
 * when A says `code-or-repo-work`; A is awaited first and B only then. A late, rejected, empty or unknown answer of A fails the prompt; a failed B is reported as `bFailure` and fails nothing.
 */
export async function classifyDeliverable(
  prompt: string,
  needs: Record<NeedName, Need>,
  classify: Classify,
  sleep: (ms: number) => Promise<void>,
  budgetMs = 2500,
  budgetBMs = 4000,
): Promise<{ matched: NeedName[]; failed: boolean; kind?: Deliverable; failure?: ClassifyFailure; bFailure?: ClassifyFailure }> {
  // Both budgets run from the start: A gets budgetMs, B gets budgetBMs and is awaited only after code work.
  const timerA = sleep(budgetMs).then(() => LATE)
  const timerB = sleep(budgetBMs).then(() => LATE)
  const entries = Object.entries(needs)
  const work = entries.filter(([, n]) => n.for === 'work')
  // The label is the bare need name: the classifier returns no label at all for a long label with a colon (verified on 2.1.332).
  const labels = [...work.map(([name]) => name), 'none']
  const options = work.map(([name, n]) => `${name}: ${n.what}`).join('\n')
  /** One call under the shared budget; never rejects. */
  const call = async (text: string, asked: readonly string[], timer: Promise<string>): Promise<{ answer: string } | { failure: ClassifyFailure }> => {
    try {
      const answer = await Promise.race([classify(text, asked), timer])
      if (answer === LATE) return { failure: 'timeout' }
      if (answer === undefined || answer === null || answer === '') return { failure: 'rejected' }
      return asked.includes(answer) ? { answer } : { failure: 'unknown-label' }
    } catch {
      return { failure: 'rejected' }
    }
  }
  const callA = call(`${A_TEXT}\n\nPrompt:\n${prompt}`, DELIVERABLES, timerA)
  // B starts at once so the two calls overlap; it is awaited only when A says code work.
  const callB = work.length === 0 ? Promise.resolve({ answer: 'none' }) : call(`Which kind of work does this prompt start? Answer none if it starts no work.\n${options}\n\n${prompt}`, labels, timerB)
  const a = await callA
  if ('failure' in a) return { matched: [], failed: true, failure: a.failure }
  const kind = a.answer as Deliverable
  const of = (audience: Audience) => entries.filter(([, n]) => n.for === audience).map(([name]) => name)
  if (kind === 'text-for-others') return { matched: of('readers'), failed: false, kind }
  if (kind === 'screen') return { matched: of('users'), failed: false, kind }
  if (kind === 'chat-reply') return { matched: [], failed: false, kind }
  const b = await callB
  if ('failure' in b) return { matched: [], failed: false, kind, bFailure: b.failure }
  const pick = work[labels.indexOf(b.answer)]
  return { matched: pick ? [pick[0]] : [], failed: false, kind }
}

/** Skills with `always`, plus skills whose `need` is active, in config order, then `extra` (skills a rule fired or saw loaded). */
export function neededSkills(config: Config, active: Record<NeedName, { dormant?: boolean }>, extra: readonly SkillName[] = [], root?: string): SkillName[] {
  const here = (name: string) => config.skills[name] === undefined || !excludedIn(config.skills[name]!, root)
  const named = Object.entries(config.skills)
    .filter(([, rule]) => rule.always === true || (rule.need !== undefined && rule.need in active && !active[rule.need]!.dormant))
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
