import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PLUGIN_VERSION } from '../src/mod/version.ts'

// Lives beside the core tests but touches only the one-constant module of the adapter, not the mod API.
test('PLUGIN_VERSION equals plugin.json and marketplace.json', () => {
  const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'))
  const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'))
  assert.equal(plugin.version, PLUGIN_VERSION)
  assert.equal(market.plugins[0].version, PLUGIN_VERSION)
})
