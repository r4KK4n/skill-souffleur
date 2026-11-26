import { excludedIn } from './config.ts'
import type { Audience, Config, Need, NeedName, SkillName } from './types.ts'

export type Classify = (text: string, labels: readonly string[]) => Promise<string>

/**
 * Asks the classifier once per need, in parallel. Returns the needs answered `match` before the budget ends,
 * in the order of `needs`. A rejected call, an answer that is neither label, or a call still running at the end
 * counts as no match and sets `failed`.
 */
export async function classifyPromptChecked(
  prompt: string,
  needs: Record<NeedName, Need>,
  classify: Classify,
  timeout: (ms: number) => Promise<void>,
  budgetMs = 1500,
): Promise<{ matched: NeedName[]; failed: boolean }> {
  const matched = new Set<NeedName>()
  let answered = 0
  let failed = false
  const calls = Object.entries(needs).map(async ([name, need]) => {
    try {
      const answer = await classify(`Need: ${need.what}\n\nPrompt: ${prompt}`, ['match', 'no-match'])
      if (answer === 'match') matched.add(name)
      if (answer === 'match' || answer === 'no-match') answered += 1
      else failed = true
    } catch {
      // A failing classifier call means no new need for this prompt.
      failed = true
    }
  })
  await Promise.race([Promise.all(calls), timeout(budgetMs)])
  return { matched: Object.keys(needs).filter((name) => matched.has(name)), failed: failed || answered < calls.length }
}

export async function classifyPrompt(prompt: string, needs: Record<NeedName, Need>, classify: Classify, timeout: (ms: number) => Promise<void>, budgetMs = 1500): Promise<NeedName[]> {
  return (await classifyPromptChecked(prompt, needs, classify, timeout, budgetMs)).matched
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
