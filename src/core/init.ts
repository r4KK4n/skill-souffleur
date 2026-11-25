import type { SkillRule } from './types.ts'

/** What `/souffleur init` works with. Pure functions only: the adapter reads, asks and writes. */

export const NOT_SET_UP = 'souffleur: not set up, run /souffleur init'

export type HookOverlap = { event: string; matcher?: string; command: string; index: [number, number]; why: string }
export type SkillProposal = { name: string; rule: SkillRule; needText?: string }
export type Passage = { file: string; line: number; text: string }

const MAX_PROPOSALS = 10
const MAX_PASSAGES = 20
const MAX_LINE = 120
const NEED_NAME = /^[A-Za-z0-9:_-]{1,64}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isWordChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c)

/**
 * True when `text` names `skill` (a script name like `skill-x-reload.sh` counts; letters or digits around it do not). A plugin skill `plugin:name` also counts by its
 * part after the colon. Names shorter than 5 characters without `-` or `:` (`init`, `run`, `pdf`)
 * are too common in ordinary commands (`git init`) and never count.
 */
function names(text: string, skill: string): boolean {
  const forms = [skill]
  const bare = skill.split(':').pop()
  if (bare !== undefined && bare !== skill) forms.push(bare)
  return forms.some((form) => {
    if (form.length < 5 && !/[-:]/.test(form)) return false
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      if (!isWordChar(text[at - 1]) && !isWordChar(text[at + form.length])) return true
    }
    return false
  })
}

/** The first of `skills` that `text` names, if any. */
const namedSkill = (text: string, skills: string[]): string | undefined => skills.find((s) => names(text, s))

/**
 * Finds settings hooks that do what Souffleur does. A hook entry overlaps when
 *  1. its command or its matcher names a known skill (installed or configured), or
 *  2. its command looks like a skill reload script: it contains `preload`, `reload` or `inject`
 *     together with `skill` (for example `skill-preload.sh`, `inject-skills.sh`).
 * The heuristic errs toward listing; the user decides per hook and nothing changes without a yes.
 * `index` is `[group, hook]` inside `hooks[event]`.
 */
export function findHookOverlaps(settings: unknown, skillNames: string[]): HookOverlap[] {
  if (!isObject(settings) || !isObject(settings.hooks)) return []
  const found: HookOverlap[] = []
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue
    groups.forEach((group, g) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined
      group.hooks.forEach((hook, h) => {
        if (!isObject(hook) || typeof hook.command !== 'string') return
        const command = hook.command
        const bySkill = namedSkill(command, skillNames) ?? (matcher === undefined ? undefined : namedSkill(matcher, skillNames))
        const pattern = /(preload|reload|inject)/i.exec(command)?.[1]?.toLowerCase()
        let why: string | undefined
        if (bySkill !== undefined) why = `names the skill ${bySkill}`
        else if (pattern !== undefined && /skill/i.test(command)) why = `looks like a skill ${pattern} script`
        if (why === undefined) return
        found.push({ event, ...(matcher === undefined ? {} : { matcher }), command, index: [g, h], why })
      })
    })
  }
  return found
}

/** A copy of `settings` without exactly the hook `o` names; emptied groups and events go too. Unchanged when the entry no longer matches. */
export function removeHook(settings: unknown, o: HookOverlap): unknown {
  if (!isObject(settings) || !isObject(settings.hooks)) return settings
  const groups = settings.hooks[o.event]
  const [g, h] = o.index
  const group = Array.isArray(groups) ? groups[g] : undefined
  const hook = isObject(group) && Array.isArray(group.hooks) ? group.hooks[h] : undefined
  if (!isObject(group) || !Array.isArray(group.hooks) || !isObject(hook) || hook.command !== o.command) return settings
  const left = group.hooks.filter((_: unknown, i: number) => i !== h)
  const nextGroups = (groups as unknown[]).flatMap((x, i) => (i !== g ? [x] : left.length ? [{ ...group, hooks: left }] : []))
  const hooks: Record<string, unknown> = {}
  for (const [event, value] of Object.entries(settings.hooks)) {
    if (event !== o.event) hooks[event] = value
    else if (nextGroups.length) hooks[event] = nextGroups
  }
  const { hooks: _old, ...rest } = settings
  return { ...rest, hooks }
}

/** Lines of CLAUDE.md or memory text that name a known skill, with file and line, at most 20. Never edited. */
export function findPassages(files: { file: string; text: string }[], skillNames: string[]): Passage[] {
  const out: Passage[] = []
  for (const { file, text } of files) {
    const lines = text.split(/\r\n|\r|\n/)
    for (let i = 0; i < lines.length && out.length < MAX_PASSAGES; i++) {
      const line = lines[i]!.trim()
      if (line && namedSkill(line, skillNames) !== undefined) out.push({ file, line: i + 1, text: line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line })
    }
  }
  return out
}

/** The prompt for the small model: which of the installed skills belong in the config. */
export function proposalPrompt(skills: string[], passages: Passage[], configured: string[]): string {
  const notes = passages.map((p) => `- ${p.file}:${p.line} ${p.text}`).join('\n') || '(none)'
  return [
    'You help set up a tool that keeps skills loaded in a coding session.',
    'Pick at most 10 of the installed skills that the user clearly wants in every session ("always": true) or for a kind of task ("need": a short label, with "needText": one sentence that says when the task is of that kind).',
    'Use only names from the installed list. Skip anything already configured. When unsure, leave a skill out.',
    `Installed skills: ${skills.join(', ')}`,
    `Already configured: ${configured.join(', ') || '(none)'}`,
    `Lines from the user's standing instructions that name a skill:\n${notes}`,
    'Answer with JSON only: {"skills":[{"name":"...","always":true},{"name":"...","need":"label","needText":"..."}]}',
  ].join('\n')
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

/** Skill entries from a tolerant read of the model's reply: installed names only, valid shapes only, at most 10. */
export function parseSkillProposals(raw: string, known: string[]): SkillProposal[] {
  const data = extractJson(raw)
  const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.skills) ? data.skills : []
  const out: SkillProposal[] = []
  for (const item of list) {
    if (out.length >= MAX_PROPOSALS) break
    if (!isObject(item) || typeof item.name !== 'string' || !known.includes(item.name) || out.some((p) => p.name === item.name)) continue
    if (item.always === true) out.push({ name: item.name, rule: { from: 'user', always: true } })
    else if (typeof item.need === 'string' && NEED_NAME.test(item.need)) {
      const needText = typeof item.needText === 'string' && item.needText.trim() ? item.needText.trim().slice(0, 200) : undefined
      out.push({ name: item.name, rule: { from: 'user', need: item.need }, ...(needText === undefined ? {} : { needText }) })
    }
  }
  return out
}

const ruleJson = (r: SkillRule): Record<string, unknown> => (r.always ? { always: true } : { need: r.need })

/**
 * Adds proposals to the user config text. Every existing key stays; an existing skill entry or need
 * is never replaced. A new file starts in `observe`. Invalid existing JSON is an error, not a rewrite.
 */
export function mergeUserConfig(existing: string | undefined, proposals: SkillProposal[]): { text: string; added: string[] } | { error: string } {
  let doc: Record<string, unknown>
  if (existing === undefined) doc = { mode: 'observe' }
  else {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (!isObject(parsed)) return { error: 'the config file is not a JSON object' }
      doc = { ...parsed }
    } catch (e) {
      return { error: `the config file is not valid JSON (${(e as Error).message})` }
    }
  }
  const skills = isObject(doc.skills) ? { ...doc.skills } : {}
  const needs = isObject(doc.needs) ? { ...doc.needs } : {}
  const added: string[] = []
  for (const p of proposals) {
    if (p.name in skills) continue
    skills[p.name] = ruleJson(p.rule)
    added.push(p.name)
    if (p.rule.need !== undefined && !(p.rule.need in needs)) needs[p.rule.need] = p.needText ?? p.rule.need
  }
  doc.skills = skills
  doc.needs = needs
  return { text: `${JSON.stringify(doc, null, 2)}\n`, added }
}

const describeRule = (r: SkillRule) => (r.always ? 'always' : `need "${r.need}"`)

/** One-line question text for a skill entry. */
export const describeProposal = (p: SkillProposal): string => `${p.name}: ${describeRule(p.rule)}${p.needText === undefined ? '' : ` (${p.needText})`}`

export const describeHook = (o: HookOverlap): string => `${o.event}${o.matcher === undefined ? '' : ` [${o.matcher}]`}: ${o.command} (${o.why})`

/** Manual steps for one hook, for the `Show me what to do` answer and the no-dialog text. */
export const hookSteps = (o: HookOverlap, settingsPath: string): string =>
  `Remove the ${o.event} hook "${o.command}" from ${settingsPath} (copy the file first). If the script is only used for this, delete it too.`

/** The text `/souffleur init` returns when it cannot ask: proposals, JSON, steps; nothing is written. */
export function initSteps(a: { proposals: SkillProposal[]; hooks: HookOverlap[]; passages: Passage[]; configPath: string; settingsPath: string }): string {
  const out = ['Souffleur init: no dialog is available here, so nothing was changed.', '']
  if (a.proposals.length) {
    const merged = mergeUserConfig(undefined, a.proposals)
    out.push('Proposed skill entries:', ...a.proposals.map((p) => `- ${describeProposal(p)}`), '', `Config entries for ${a.configPath}:`, '', '```json', 'text' in merged ? merged.text.trimEnd() : '', '```', '')
  } else out.push('No skill entries proposed.', '')
  if (a.hooks.length) out.push('Hooks that do what Souffleur now does:', ...a.hooks.map((o) => `- ${describeHook(o)}`), '')
  if (a.passages.length) out.push('Standing instructions that name a skill (Souffleur never edits these):', ...a.passages.map((p) => `- ${p.file}:${p.line} ${p.text}`), '')
  out.push('Steps:')
  let n = 1
  if (a.proposals.length) out.push(`${n++}. Put the entries above into ${a.configPath}, keeping what the file already holds. It starts in observe mode.`)
  for (const o of a.hooks) out.push(`${n++}. ${hookSteps(o, a.settingsPath)}`)
  if (a.passages.length) out.push(`${n++}. Decide whether the passages above still belong in your instructions once Souffleur keeps the skills loaded.`)
  out.push(`${n}. Run /souffleur in a new session to check the ledger. Run /souffleur init in a session with a dialog to let it make these changes with your yes on each.`)
  return out.join('\n')
}
