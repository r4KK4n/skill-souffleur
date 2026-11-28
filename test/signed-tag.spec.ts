import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowedSigners, goodSignature, signedTagObject, verifyTagArgs } from '../src/core/update.ts'

// The adapter runs exactly these helpers (`tagVerified` in src/mod/register.ts). Here real git and ssh-keygen check real tags, so
// a git wording change or a wrong -c flag fails CI instead of passing against scripted output.

const onPath = (tool: string) => spawnSync(tool, ['-?'], { stdio: 'ignore' }).error === undefined
const have = onPath('git') && onPath('ssh-keygen')
const skip = have ? false : 'git and ssh-keygen are not both on PATH, so no real signature can be made or checked'
const TAG = 'v9.9.9'

let dir = ''
let repo = ''
const key = { a: '', b: '' }
const oid = { good: '', other: '', unsigned: '', pgp: '' }

/** A clean environment: no user git config, no signing key or ssh agent from the machine running the test. */
const env = () => ({ PATH: process.env['PATH'] ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' })
const run = (cmd: string, args: string[], cwd: string, input?: string): string => {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env: env() })
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const git = (...args: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], repo)
const verifyTag = (signer: string, id: string) => {
  const file = join(dir, 'allowed_signers')
  writeFileSync(file, allowedSigners(signer))
  return spawnSync('git', ['-C', repo, ...verifyTagArgs(file, id)], { encoding: 'utf8', env: env() })
}

/** What `tagVerified` does with a tag object: the structural check, then `git verify-tag` with the allowed_signers file of `signer`. */
function verified(signer: string, id: string): boolean {
  const obj = spawnSync('git', ['-C', repo, 'cat-file', 'tag', id], { encoding: 'utf8' })
  if (obj.status !== 0 || !signedTagObject(obj.stdout, TAG)) return false
  const r = verifyTag(signer, id)
  return r.status === 0 && goodSignature(r.stderr)
}

before(() => {
  if (!have) return
  dir = mkdtempSync(join(tmpdir(), 'souffleur-sig-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  for (const k of ['a', 'b'] as const) {
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `key-${k}`, '-f', join(dir, `key-${k}`)], dir)
    key[k] = readFileSync(join(dir, `key-${k}.pub`), 'utf8').trim().split(' ').slice(0, 2).join(' ')
  }
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  // The signature covers the object's own `tag v9.9.9` line, so each case signs under that name and the ref is dropped afterwards; the object stays.
  for (const [name, pub] of [['good', 'key-a.pub'], ['other', 'key-b.pub'], ['unsigned', undefined]] as const) {
    if (pub === undefined) git('tag', '-a', TAG, '-m', 'release')
    else git('-c', 'gpg.format=ssh', '-c', `user.signingkey=${join(dir, pub)}`, 'tag', '-s', TAG, '-m', 'release')
    oid[name] = git('rev-parse', `refs/tags/${TAG}`)
    git('tag', '-d', TAG)
  }
  const head = git('rev-parse', 'HEAD')
  const body = `object ${head}\ntype commit\ntag ${TAG}\ntagger t <t@t> 1 +0000\n\nrelease\n-----BEGIN PGP SIGNATURE-----\n\niQEzBAABCAAdFiEE\n-----END PGP SIGNATURE-----\n`
  oid.pgp = run('git', ['hash-object', '-t', 'tag', '-w', '--stdin'], repo, body)
})

after(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

test('a tag signed by the updateSigner key verifies', { skip }, () => {
  assert.equal(verified(key.a, oid.good), true)
})

test('a tag signed by a second key does not verify against the first', { skip }, () => {
  assert.equal(verified(key.a, oid.other), false)
  assert.equal(verified(key.b, oid.other), true, 'the same tag does verify against its own key, so the failure above is the key')
})

test('an unsigned annotated tag does not verify', { skip }, () => {
  assert.equal(verified(key.a, oid.unsigned), false)
})

test('a tag whose signature block is PGP armor does not verify', { skip }, () => {
  assert.equal(verified(key.a, oid.pgp), false)
})

test('git itself accepts the good tag with exactly these arguments', { skip }, () => {
  const r = verifyTag(key.a, oid.good)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /^Good "git" signature for souffleur with ED25519 key SHA256:/m)
})
