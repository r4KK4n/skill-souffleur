// The contract for `$.state`. It must be self-contained, so the session shape is spelled out here
// and mirrors `Session` in src/core/decide.ts. test/types.spec.ts asserts at type level (`npm run typecheck`, in CI)
// that the two have the same keys and are mutually assignable, so a field added or dropped on one side fails there.
declare module 'claude-code' {
  interface PluginState {
    'skill-souffleur': {
      /** What the band above the prompt draws; null while nothing needs attention. */
      band: { text: string } | null
      session: {
        ledger: Record<
          string,
          {
            state: 'absent' | 'loaded' | 'stale' | 'restoring' | 'unavailable' | 'not installed here'
            since: number
            reason: string
            lastCompactAt?: number
            requests: number
          }
        >
        needs: Record<string, { since: number; reason: string; misses?: number; dormant?: boolean; evidence?: boolean }>
        duties: { skill: string; openedAt: number; by: string; denied: boolean; told?: boolean }[]
        paused: boolean
        id: string
        mainSkillCalls: string[]
        liveAgents?: string[]
        compactedSincePrompt: boolean
        agentDenied: boolean
        observed: { at: number; reason: string }[]
        errors: string[]
        version?: string
        ruleSkills: string[]
        openRules: { id: string; by: string; denied: boolean; told: boolean }[]
        fieldDenied: string[]
        proposals: {
          hash: string
          kind: 'rule' | 'note'
          entry: {
            id: string
            source: string
            where?: string
            before?: { tools: string[]; paths?: string[] }
            skill?: string
            field?: string
            after?: { tools: string[]; paths?: string[] }
            evidence?: { tool: string; command?: string }
            text?: string
            need?: string
          }
          scope?: 'everywhere' | 'project'
          from: string
          origin?: string
          project?: boolean
          skillHash?: string
        }[]
        declined: string[]
        notesSent: string[]
        freshNotes: string[]
        revise: string[]
        proposed: string[]
        skillReads?: number
        learnCalls?: string[]
        proposalsStopped?: boolean
        askStopped?: boolean
        rev?: number
        classifyFails?: number
        workFails?: number
        classifyPause?: number
        workPause?: number
        learnFails?: number
        touched?: number
        noticed?: { cut: string[]; problems: string[]; tells?: Record<string, number> }
        failCounts?: Record<string, number>
        modelUse?: { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; usd: number; unpriced?: string[] }
        turnDenials?: Record<string, number>
        turnTries?: string[]
        lastSeen?: number
        updateShown?: string
      }
    }
  }
}
