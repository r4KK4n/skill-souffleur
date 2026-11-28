import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isFromUser, isUserOrigin, presentArgs, toolFields } from '../src/mod/map.ts'

const input = (extra: Record<string, unknown> = {}) => ({ text: 'hello', origin: { kind: 'composer' }, ...extra })

test('isFromUser accepts composer, bridge and sdk prompts', () => {
  for (const kind of ['composer', 'bridge', 'sdk']) assert.equal(isFromUser(input({ origin: { kind } })), true)
})

test('isFromUser rejects typed commands, meta prompts and other origins', () => {
  assert.equal(isFromUser(input({ command: { name: 'compact', args: '' } })), false)
  assert.equal(isFromUser(input({ isMeta: true })), false)
  for (const kind of ['peer', 'task-notification', 'scheduled-trigger']) {
    assert.equal(isFromUser(input({ origin: { kind } })), false)
  }
})

test('toolFields reads the flat string arguments and ignores other types', () => {
  const e = { tool: 'Agent', tool_use_id: 't1', file_path: '/a/x.html', command: 'ls', prompt: 'skills: none', skill: 'writing-guide', model: 'haiku' }
  assert.deepEqual(toolFields(e), { path: '/a/x.html', command: 'ls', brief: 'skills: none', skill: 'writing-guide', model: 'haiku' })
  assert.deepEqual(toolFields({ tool: 'Write', tool_use_id: 't2', file_path: 5, command: null }), {})
})

test('isFromUser treats a prompt without origin as typed (the test kit sets none)', () => {
  assert.equal(isFromUser({ text: 'hello' } as never), true)
})

test('isUserOrigin counts composer, bridge and sdk, and nothing else, not even a missing origin', () => {
  for (const kind of ['composer', 'bridge', 'sdk']) assert.equal(isUserOrigin({ origin: { kind } }), true)
  for (const kind of ['plugin', 'peer', 'scheduled-trigger']) assert.equal(isUserOrigin({ origin: { kind } }), false)
  assert.equal(isUserOrigin({}), false)
})

test('presentArgs drops reserved metadata', () => {
  const e = { tool: 'Agent', tool_use_id: 't1', agentId: 'a1', requestMeta: {}, model: 'haiku', description: '' }
  assert.deepEqual(presentArgs(e), ['model'])
})

test('presentArgs keeps real arguments', () => {
  assert.deepEqual(presentArgs({ tool: 'Agent', file_path: '/a', content: undefined, command: null, prompt: 'x', agent: 'reviewer' }), ['file_path', 'prompt', 'agent'])
})

test('startsTurn: non-user prompts that start a main-session model turn', async () => {
  const { startsTurn } = await import('../src/mod/map.ts')
  for (const kind of ['peer', 'peer-send-message', 'task-notification', 'scheduled-trigger', 'projects-relay', 'channel', 'coordinator', 'slack-ping', 'auto-continuation']) assert.equal(startsTurn({ origin: { kind } }), true, kind)
  for (const kind of ['composer', 'observer', 'observer-activity', 'unclassified', 'plugin']) assert.equal(startsTurn({ origin: { kind } }), false, kind)
  // The recorded subagent hand-back (test/fixtures/subagent.json) is meta and starts the turn.
  assert.equal(startsTurn({ isMeta: true, origin: { kind: 'peer' } }), true)
  assert.equal(startsTurn({ origin: { kind: 'peer' }, turnId: 't1' }), false)
  assert.equal(startsTurn({ isMeta: true, origin: { kind: 'peer' }, turnId: 't1' }), false)
  assert.equal(startsTurn({ origin: { kind: 'peer' }, command: {} }), false)
  assert.equal(startsTurn({}), false)
})
