import type { Config, SkillRule } from './types.ts'

/** What `/souffleur init` works with. Pure functions only: the adapter reads, asks and writes. */

export const NOT_SET_UP = 'not set up, run /souffleur init'

export type LoadChoice = 'start' | 'injected' | 'need' | 'none'
export type Source = 'user' | 'project' | 'hook' | 'model'
export type Candidate = { skill: string; source: Source }
export type NeedText = { key: string; text: string }
export type Suggestion = { skill: string; need: NeedText }
/** One skill as `init` sees it: where it came from, how it is kept now, and what is recommended. */
export type Plan = { skill: string; source: Source; current?: LoadChoice; recommended: LoadChoice; need?: NeedText }

const MAX_PICKS = 10
const NEED_KEY = /^[A-Za-z0-9:_-]{1,64}$/

export const CHOICE_LABEL: Record<LoadChoice, string> = {
  start: 'From the start',
  injected: 'Injected by its plugin',
  need: 'When the task needs it',
  none: "Don't watch",
}
export const STOP = 'Stop'

export const SETUP_INTRO = [
  'Souffleur init decides how each skill is kept in your sessions. It asks one question per skill: From the start, Injected by its plugin (plugin skills only), When the task needs it, or Don\'t watch. Stop ends the run.',
  'Every answer is written to ~/.claude/souffleur.json right away, so closing a dialog keeps the answers you already gave. A skill with a gate or duty is never removed.',
  'init does not touch your hooks, CLAUDE.md or memory files. /souffleur migrate retires old hooks.',
].join('\n\n')

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bare = (skill: string) => skill.split(':').pop() ?? skill

/** The way an existing entry keeps its skill. */
export function currentChoice(rule: Partial<SkillRule> | undefined): LoadChoice | undefined {
  if (!rule) return undefined
  if (rule.always) return rule.startup === 'injected' ? 'injected' : 'start'
  return rule.need !== undefined ? 'need' : undefined
}

/** The label for a choice, or `choice` mapped back from an answer; undefined for free text. */
export function choiceOf(label: string): LoadChoice | 'stop' | undefined {
  if (label === STOP) return 'stop'
  return (Object.keys(CHOICE_LABEL) as LoadChoice[]).find((c) => CHOICE_LABEL[c] === label)
}

/**
 * Skills `init` goes through: those in the user file, then those a user hook reloads, then the small
 * model's picks. A skill that only a project file configures comes last and is listed, not asked:
 * `init` writes the user file.
 */
export function candidates(config: Config, installed: string[], reloadHooked: string[], picked: string[]): Candidate[] {
  const out: Candidate[] = []
  const has = (skill: string) => out.some((c) => c.skill === skill)
  for (const [skill, rule] of Object.entries(config.skills)) if (rule.from === 'user') out.push({ skill, source: 'user' })
  const known = (skill: string) => !(skill in config.skills) && !has(skill) && installed.includes(skill)
  for (const skill of reloadHooked) if (known(skill)) out.push({ skill, source: 'hook' })
  for (const skill of picked) if (known(skill)) out.push({ skill, source: 'model' })
  for (const [skill, rule] of Object.entries(config.skills)) if (rule.from === 'project') out.push({ skill, source: 'project' })
  return out
}

/**
 * Answer labels for one skill, at most four. The current choice comes first, else the recommended one.
 * `Injected by its plugin` is offered for plugin skills (`a:b`); the others get `Stop` as the fourth answer.
 */
export function options(skill: string, current: LoadChoice | undefined, recommended: LoadChoice): string[] {
  const plugin = skill.includes(':')
  // A skill that is injected although it has no plugin name: keep the choice, and give up Stop (closing the dialog stops anyway).
  const all: LoadChoice[] = plugin || current === 'injected' ? ['start', 'injected', 'need', 'none'] : ['start', 'need', 'none']
  const first = current ?? recommended
  const order = all.includes(first) ? [first, ...all.filter((c) => c !== first)] : all
  const labels = order.map((c) => CHOICE_LABEL[c])
  return all.length === 4 ? labels : [...labels, STOP]
}

/** A description as config.ts accepts it: whitespace collapsed to single spaces, 1 to 200 characters; undefined otherwise. */
export function cleanNeedText(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, ' ').trim()
  return text.length >= 1 && text.length <= 200 ? text : undefined
}

/** A valid need key made from a skill name. */
export const needKeyFor = (skill: string): string => bare(skill).replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 64) || 'need'

/** Why `userConfig` cannot be edited, or undefined when it can (or does not exist yet). */
export function configProblem(userConfig: unknown): string | undefined {
  if (userConfig === undefined) return undefined
  if (!isObject(userConfig)) return 'it is not a JSON object'
  for (const key of ['skills', 'needs']) if (userConfig[key] !== undefined && !isObject(userConfig[key])) return `"${key}" is not an object`
  return undefined
}

/** A need key for `skill` that no other need uses. */
function forkKey(needs: Record<string, unknown>, key: string, skill: string): string {
  const base = `${key}-${bare(skill).replace(/[^A-Za-z0-9:_-]/g, '-')}`.slice(0, 60)
  let candidate = base
  for (let n = 2; candidate in needs; n++) candidate = `${base}-${n}`
  return candidate
}

/**
 * Applies one answer to the user config and returns the new config; the input is not changed.
 * Keeps every other key, and a gate or duty when the kind changes. `none` on an entry with a gate or
 * duty leaves it and says so. A need text that differs from a need other skills use (user or project file,
 * `projectSkills`) gets a new key. Needs that no skill references any more are dropped and listed in `pruned`.
 * A config that cannot be edited, or a need text config.ts would reject, comes back unchanged with a note.
 */
export function applyChoice(
  userConfig: unknown,
  skill: string,
  choice: LoadChoice,
  need?: NeedText,
  projectSkills: Record<string, unknown> = {},
): { config: unknown; note?: string; pruned?: string[] } {
  const problem = configProblem(userConfig)
  if (problem) return { config: userConfig, note: `${skill}: the config file was not changed because ${problem}.` }
  if (need && (!NEED_KEY.test(need.key) || cleanNeedText(need.text) !== need.text)) {
    return { config: userConfig, note: `${skill}: the description was skipped because it is not one line of 1 to 200 characters.` }
  }
  const doc: Record<string, unknown> = isObject(userConfig) ? { ...userConfig } : { mode: 'observe' }
  const skills: Record<string, unknown> = isObject(doc.skills) ? { ...doc.skills } : {}
  const needs: Record<string, unknown> = isObject(doc.needs) ? { ...doc.needs } : {}
  const old = isObject(skills[skill]) ? skills[skill] : {}
  const { always: _a, startup: _s, need: oldNeed, ...rest } = old

  if (choice === 'none') {
    if ('gate' in old || 'duty' in old) {
      return { config: userConfig, note: `${skill} has a gate or duty, so its entry stays. Remove it by hand in the user file if you no longer want it.` }
    }
    delete skills[skill]
  } else if (choice === 'start') skills[skill] = { always: true, ...rest }
  else if (choice === 'injected') skills[skill] = { always: true, startup: 'injected', ...rest }
  else {
    const want: NeedText = need ?? {
      key: typeof oldNeed === 'string' ? oldNeed : needKeyFor(skill),
      text: typeof oldNeed === 'string' && typeof needs[oldNeed] === 'string' ? (needs[oldNeed] as string) : `The task calls for ${skill}.`,
    }
    let key = want.key
    if (key in needs && needs[key] !== want.text) {
      const uses = (all: Record<string, unknown>) => Object.entries(all).some(([name, r]) => name !== skill && isObject(r) && r.need === key)
      if (uses(skills) || uses(projectSkills)) key = forkKey(needs, key, skill)
    }
    needs[key] = want.text
    skills[skill] = { need: key, ...rest }
  }

  const used = new Set([...Object.values(skills), ...Object.values(projectSkills)].flatMap((r) => (isObject(r) && typeof r.need === 'string' ? [r.need] : [])))
  const pruned: string[] = []
  for (const key of Object.keys(needs)) {
    if (used.has(key)) continue
    delete needs[key]
    pruned.push(key)
  }
  // Keep the file's shape: an empty section is added only when something is in it or it was there.
  if ('skills' in doc || Object.keys(skills).length) doc.skills = skills
  if ('needs' in doc || Object.keys(needs).length) doc.needs = needs
  return { config: doc, ...(pruned.length ? { pruned } : {}) }
}

/** Pulls JSON out of a model reply that may carry prose or code fences; undefined when none parses. */
function extractJson(raw: string): unknown {
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const from = raw.indexOf(open)
    const to = raw.lastIndexOf(close)
    if (from === -1 || to <= from) continue
    try {
      return JSON.parse(raw.slice(from, to + 1))
    } catch {
      // try the other shape
    }
  }
  return undefined
}

/** The prompt for the small model: which installed skills are worth watching, and for which kind of task. */
export function picksPrompt(skills: { name: string; description?: string }[], existingNeeds: Record<string, string>): string {
  const list = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description.slice(0, 160)}` : ''}`).join('\n')
  const needs = Object.entries(existingNeeds).map(([k, t]) => `- ${k}: ${t}`).join('\n') || '(none)'
  return [
    'You help set up a tool that keeps skills loaded in a coding session.',
    `Pick at most ${MAX_PICKS} of the installed skills that a developer would want loaded for a certain kind of task, such as writing text or building a screen.`,
    'For each, give "need": a short label, and "needText": one sentence that says when a task is of that kind. When an existing need fits, reuse its label. When unsure, leave a skill out.',
    `Existing needs:\n${needs}`,
    `Installed skills:\n${list}`,
    'Answer with JSON only: {"skills":[{"name":"...","need":"label","needText":"..."}]}',
  ].join('\n')
}

/** Picks from a tolerant read of the model's reply: installed names only, valid shapes only, at most 10. An existing need key keeps its text. */
export function parsePicks(raw: string, installed: string[], existingNeeds: Record<string, string>): Suggestion[] {
  const data = extractJson(raw)
  const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.skills) ? data.skills : []
  const out: Suggestion[] = []
  for (const item of list) {
    if (out.length >= MAX_PICKS) break
    if (!isObject(item) || typeof item.name !== 'string' || !installed.includes(item.name) || out.some((p) => p.skill === item.name)) continue
    if (typeof item.need !== 'string' || !NEED_KEY.test(item.need)) continue
    const known = existingNeeds[item.need]
    const given = typeof item.needText === 'string' ? cleanNeedText(item.needText.slice(0, 200)) : undefined
    const text = known ?? given
    if (text === undefined) continue
    out.push({ skill: item.name, need: { key: item.need, text } })
  }
  return out
}

/** One line per skill for the dialog and the no-dialog text. */
export function describePlan(p: Plan): string {
  const now = p.current === undefined ? 'not watched' : CHOICE_LABEL[p.current]
  const why = p.source === 'hook' ? 'a hook of yours reloads it' : p.source === 'model' ? 'looks worth watching' : p.source === 'project' ? 'set in the project file' : 'in your config'
  return `${p.skill}: ${now} (${why}), recommended: ${CHOICE_LABEL[p.recommended]}`
}

/** The text `/souffleur init` returns when it cannot ask: the explanation, the recommendations and the config they give. */
export function setupSteps(a: { plans: Plan[]; userConfig: unknown; configPath: string; unwatched: string[] }): string {
  const out = [SETUP_INTRO, '', 'No dialog is available here, so nothing was changed.', '']
  const asked = a.plans.filter((p) => p.source !== 'project')
  const project = a.plans.filter((p) => p.source === 'project')
  let config = a.userConfig
  if (asked.length) {
    out.push('Recommended per skill:', ...asked.map((p) => `- ${describePlan(p)}`), '')
    for (const p of asked) if (p.recommended !== p.current) config = applyChoice(config, p.skill, p.recommended, p.need).config
    out.push(`With these answers ${a.configPath} would read:`, '', '```json', JSON.stringify(config ?? { mode: 'observe', skills: {}, needs: {} }, null, 2), '```', '')
  } else out.push('No skills to ask about.', '')
  if (project.length) out.push(`Set only in a project file, so init leaves ${project.length === 1 ? 'it' : 'them'} alone:`, ...project.map((p) => `- ${p.skill}`), '')
  if (a.unwatched.length) out.push(`Installed and not watched: ${a.unwatched.join(', ')}.`, '')
  out.push('Steps:', `1. Put the entries you want into ${a.configPath}, keeping what the file already holds. A new file starts in observe mode.`, '2. Run /souffleur init in a session with a dialog to let it ask per skill and write the answers.')
  return out.join('\n')
}
