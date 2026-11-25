import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const coreDir = join(import.meta.dirname, '..', 'src', 'core')

test('core imports neither claude-code nor node builtins', () => {
  const files = readdirSync(coreDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length > 0, 'src/core has no .ts files')
  for (const file of files) {
    const lines = readFileSync(join(coreDir, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      assert.doesNotMatch(line, /from ['"](claude-code|node:)/, `src/core/${file}:${i + 1}`)
    })
  }
})
