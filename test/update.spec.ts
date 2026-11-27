import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCheckDue, isUpdateCheck, newestRelease, refusalLine, updateLine } from '../src/core/update.ts'

const ls = (...tags: string[]) => tags.map((t, i) => `${String(i).repeat(40)}\trefs/tags/${t}`).join('\n')

test('newestRelease picks the newest tag, v0.2.10 beats v0.2.9', () => {
  assert.equal(newestRelease(ls('v0.2.9', 'v0.2.10', 'v0.2.4'), '0.2.3'), 'v0.2.10')
})

test('newestRelease ignores pre-releases, short tags, branches and junk', () => {
  assert.equal(newestRelease(ls('v0.3.0-rc.1', 'v1.0', 'main', 'release', 'v0.3.0+b1', 'v01.2.3x'), '0.2.3'), undefined)
  assert.equal(newestRelease(`abc\trefs/heads/v9.9.9\n${ls('v0.2.4')}`, '0.2.3'), 'v0.2.4')
})

test('newestRelease returns nothing when no tag is newer (no downgrade)', () => {
  assert.equal(newestRelease(ls('v0.2.3', 'v0.2.2'), '0.2.3'), undefined)
  assert.equal(newestRelease('', '0.2.3'), undefined)
})

test('newestRelease tolerates CRLF, blank lines and peeled refs', () => {
  assert.equal(newestRelease(`${ls('v0.2.4')}\r\n\r\nabc\trefs/tags/v0.2.5^{}\r\n`, '0.2.3'), 'v0.2.4')
})

test('newestRelease with an unparsable current version returns nothing', () => {
  assert.equal(newestRelease(ls('v0.2.4'), 'dev'), undefined)
})

test('isCheckDue: missing is due, 24 h exactly is due, one ms less is not', () => {
  const now = 1_000_000_000_000
  assert.equal(isCheckDue(undefined, now), true)
  assert.equal(isCheckDue({ at: now - 86_400_000 }, now), true)
  assert.equal(isCheckDue({ at: now - 86_399_999 }, now), false)
  assert.equal(isCheckDue({ at: now + 5 }, now), true)
  assert.equal(isCheckDue({ at: 9e15 }, now), true)
})

test('isUpdateCheck accepts { at, latest? } only', () => {
  assert.equal(isUpdateCheck({ at: 1 }), true)
  assert.equal(isUpdateCheck({ at: 1, latest: 'v0.2.4' }), true)
  for (const bad of [undefined, null, 5, 'x', [], {}, { at: '1' }, { at: NaN }, { at: 1, latest: 4 }, { at: 1, latest: '--orphan' }, { at: 1, latest: 'v0.2.4\nx' }, { at: 1, latest: 'v1.0' }, { at: 1, latest: 'v0.3.0-rc.1' }]) assert.equal(isUpdateCheck(bad), false)
})

test('updateLine texts are exact', () => {
  assert.equal(updateLine('notify', 'v0.2.4', '0.2.3'), 'Souffleur v0.2.4 is out (you run 0.2.3). /souffleur update installs it.')
  assert.equal(updateLine('notify-market', 'v0.2.4', '0.2.3'), 'Souffleur v0.2.4 is out (you run 0.2.3). /plugin update installs it.')
  assert.equal(updateLine('auto-done', 'v0.2.4', '0.2.3'), 'Souffleur updated to v0.2.4 (tag signed by your key).')
  assert.equal(updateLine('auto-unverified', 'v0.2.4', '0.2.3'), 'Souffleur v0.2.4 is out but its tag is not signed by your updateSigner key; not installed. /souffleur update installs it anyway.')
  assert.equal(updateLine('auto-no-signer', 'v0.2.4', '0.2.3'), 'Souffleur v0.2.4 is out (you run 0.2.3). /souffleur update installs it. Set updateSigner to let auto install it.')
})

test('refusalLine text is exact', () => {
  assert.equal(refusalLine('the working tree has changes', '/p/x'), 'Souffleur: not updated, the working tree has changes. Update by hand with git in /p/x.')
})
