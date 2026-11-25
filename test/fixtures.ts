import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type FixtureEvent = {
  event:
    | 'session.start'
    | 'prompt.submit'
    | 'tool.call'
    | 'skill.prompt'
    | 'command.run'
    | 'session.compact.before'
    | 'session.compact.after'
  at: number
  session: string
  input: Record<string, unknown>
}

type FixtureFile = { claudeCode: string; events: FixtureEvent[] }

export function loadFixture(name: string): FixtureEvent[] {
  const path = join(import.meta.dirname, 'fixtures', `${name}.json`)
  const file = JSON.parse(readFileSync(path, 'utf8')) as FixtureFile
  return file.events
}
