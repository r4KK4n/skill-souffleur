export type SkillName = string
export type NeedName = string
export type Match = { tools: string[]; paths?: string[] }
export type Origin = 'user' | 'project'
export type SkillRule = {
  /** Set by the parser from the file the entry came from; never read from JSON. */
  from: Origin
  always?: boolean
  startup?: 'injected'
  need?: NeedName
  gate?: Match
  duty?: { after: Match; evidence: { tool: string; command?: string } }
}
export type Mode = 'observe' | 'enforce'
export type Config = {
  mode: Mode
  skills: Record<SkillName, SkillRule>
  needs: Record<NeedName, string>
  /** Absolute project roots whose gates and duties may deny. Only the user file sets it. */
  trustProjects: string[]
}
