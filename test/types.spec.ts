import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { PluginState } from 'claude-code'
import type { Session } from '../src/core/decide.ts'

const literals = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort()

test('the state union in types/index.d.ts equals SkillState in src/core/ledger.ts', () => {
  const ledger = readFileSync(new URL('../src/core/ledger.ts', import.meta.url), 'utf8')
  const contract = readFileSync(new URL('../types/index.d.ts', import.meta.url), 'utf8')
  const fromCode = /export type SkillState =([^\n]*)/.exec(ledger)?.[1]
  const fromTypes = /state:([^\n]*)/.exec(contract)?.[1]
  assert.ok(fromCode && fromTypes)
  assert.deepEqual(literals(fromTypes), literals(fromCode))
  assert.ok(literals(fromCode).includes('not installed here'))
})

// Type-level guard, checked by `npm run typecheck`: the published contract and the stored session have the same keys and fit each other.
type Contract = PluginState['skill-souffleur']['session']
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const sameKeys: Same<keyof Contract, keyof Session> = true
const contractFitsSession: Same<Contract, Session> = true
void sameKeys
void contractFitsSession
