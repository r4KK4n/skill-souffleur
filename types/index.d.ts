// The contract for `$.state`. It must be self-contained, so the session shape is spelled out here
// and mirrors `Session` in src/core/decide.ts; the type check fails when the two drift apart.
declare module 'claude-code' {
  interface PluginState {
    'skill-souffleur': {
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
        needs: Record<string, { since: number; reason: string }>
        duties: { skill: string; openedAt: number; by: string; denied: boolean }[]
        paused: boolean
        id: string
        mainSkillCalls: string[]
        subagentsRunning: number
        compactedSincePrompt: boolean
        agentDenied: boolean
        observed: { at: number; reason: string }[]
        errors: string[]
        version?: string
      }
    }
  }
}
