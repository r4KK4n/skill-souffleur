export type SkillName = string
export type NeedName = string
export type Match = { tools: string[]; paths?: string[] }
export type Origin = 'user' | 'project'
/** Who receives the output a skill shapes: the chat reply, other readers of a text, product users, or nobody (how the agent works). */
export type Audience = 'chat' | 'readers' | 'users' | 'work'
export const AUDIENCES: readonly Audience[] = ['chat', 'readers', 'users', 'work']
/** `what` is the classifier text. `noAudience` marks the old string form, which counts as `work`. */
export type Need = { for: Audience; what: string; noAudience?: true }
/** Limits for the chat replies of an always-on chat skill. A missing field is no limit. */
export type ReplyLimits = { maxChars?: number; headings?: number }
export type SkillRule = {
  /** Set by the parser from the file the entry came from; never read from JSON. */
  from: Origin
  always?: boolean
  /** Only with `always`. */
  for?: Audience
  /** Main repository roots where the skill is off. Only the user file sets it. */
  notIn?: string[]
  /** Only with `always` and `for: "chat"`. */
  reply?: ReplyLimits
  startup?: 'injected'
  need?: NeedName
  gate?: Match
  duty?: { after: Match; evidence: { tool: string; command?: string } }
}
export type Mode = 'observe' | 'enforce'
export type Config = {
  mode: Mode
  skills: Record<SkillName, SkillRule>
  needs: Record<NeedName, Need>
  /** Absolute project roots whose gates and duties may deny. Only the user file sets it. */
  trustProjects: string[]
  /** Only the user file holds these. */
  rules: Rule[]
  notes: Note[]
  learn: { skills: boolean }
  /** Session notices in the transcript. Only the user file sets it. */
  notices: boolean
  /** The need names the user file defines: proposals may name only these. */
  userNeeds?: string[]
  /** The need names only the project file defines: they count only for a trusted root. */
  projectNeeds?: string[]
  /** The per-project block of the open root, set when the user file has one for it. Standard entries it names are already removed. */
  project?: {
    root: string
    /** Every name the block lists, skill, note or rule id, also names the standard lacks. */
    blocked: string[]
    /** The subset of `blocked` that names a skill of the standard. */
    blockedSkills: string[]
    /** Own skills, then note ids, then rule ids the block adds and that survived validation. */
    own: string[]
    ignored: string[]
  }
}

/**
 * A check with a trace Souffleur can see, in one of three kinds: `before` + `skill` (the skill is loaded before a matching call),
 * `before` + `field` (a matching call carries the field), `after` + `evidence` (evidence follows a matching call).
 * `source` is `user`, `slip` or `skill:<name>`. `where` is a main repository root.
 */
export type Rule = {
  id: string
  where?: string
  source: string
  before?: Match
  skill?: SkillName
  field?: string
  after?: Match
  evidence?: { tool: string; command?: string }
}
/** A standing instruction. Never checked. Without `need` it goes into the system prompt section, with `need` into the prompt context. */
export type Note = { id: string; text: string; need?: NeedName; where?: string; source: string }
