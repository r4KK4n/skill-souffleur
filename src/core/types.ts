export type SkillName = string
export type NeedName = string
export type Match = { tools: string[]; paths?: string[] }
export type SkillRule = {
  always?: boolean
  startup?: 'injected'
  need?: NeedName
  gate?: Match
  duty?: { after: Match; evidence: { tool: string; command?: string } }
}
export type Mode = 'observe' | 'enforce'
export type Config = { mode: Mode; skills: Record<SkillName, SkillRule>; needs: Record<NeedName, string> }
