import { compareVersions } from './version.ts'

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const DAY_MS = 86_400_000

/** The newest release tag in `git ls-remote --tags --refs` output that is newer than `current`; only `vX.Y.Z` tags count. */
export function newestRelease(lsRemote: string, current: string): string | undefined {
  let best: string | undefined
  for (const line of lsRemote.split(/\r?\n/)) {
    const m = /^[0-9a-f]+\trefs\/tags\/(\S+)$/.exec(line.trim())
    const tag = m?.[1]
    if (tag === undefined || !TAG.test(tag)) continue
    if (compareVersions(tag.slice(1), current) !== 1) continue
    if (best === undefined || compareVersions(tag.slice(1), best.slice(1)) === 1) best = tag
  }
  return best
}

/** True when no check is stored, the stored one is at least 24 hours old, or it lies in the future (wrong clock). */
export function isCheckDue(check: { at: number } | undefined, now: number): boolean {
  return check === undefined || check.at > now || now - check.at >= DAY_MS
}

export function isUpdateCheck(v: unknown): v is { at: number; latest?: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return typeof o.at === 'number' && Number.isFinite(o.at) && (o.latest === undefined || (typeof o.latest === 'string' && TAG.test(o.latest)))
}

export type UpdateKind = 'notify' | 'notify-market' | 'auto-done' | 'auto-unverified' | 'auto-no-signer'

/** A release tag as people read it: without the leading `v`. */
export const shown = (tag: string): string => tag.replace(/^v/, '')

/** The one line shown for a newer release. */
export function updateLine(kind: UpdateKind, tag: string, cur: string, root = 'the plugin folder'): string {
  const next = shown(tag)
  const out = `Souffleur ${next} is out (you run ${cur}).`
  switch (kind) {
    case 'notify': return `${out} /souffleur update installs it.`
    case 'notify-market': return `${out} /plugin update installs it.`
    case 'auto-done': return `Souffleur updated to ${next} (tag signed by your key).`
    case 'auto-unverified': return `Souffleur ${next} is out but its tag is not signed by your updateSigner key; not installed. Update by hand with git in ${root}.`
    case 'auto-no-signer': return `${out} /souffleur update installs it. Set updateSigner to let auto install it.`
  }
}

/** Why a folder install was left alone. */
export function refusalLine(reason: string, root: string): string {
  return `Souffleur: not updated, ${reason}. Update by hand with git in ${root}.`
}

/** Git verifies the last signature block of a tag, so the last `-----BEGIN ` line must open an SSH signature that ends the object; armor quoted in the message does not count. */
export function endsInSshSignature(obj: string): boolean {
  const lines = obj.replace(/\n$/, '').split('\n')
  const begin = lines.map((l, i) => (l.startsWith('-----BEGIN ') ? i : -1)).filter((i) => i >= 0).pop()
  return begin !== undefined && lines[begin] === '-----BEGIN SSH SIGNATURE-----' && lines[lines.length - 1] === '-----END SSH SIGNATURE-----' && !lines.slice(begin + 1, -1).some((l) => l.startsWith('-----'))
}

/** The raw tag object (`git cat-file tag`) names `tag` in its own header and ends in an SSH signature. The signature does not cover the ref name, so the header is checked. */
export function signedTagObject(obj: string, tag: string): boolean {
  const header = obj.split('\n\n')[0] ?? ''
  return header.split('\n').includes(`tag ${tag}`) && endsInSshSignature(obj)
}

/** The allowed_signers file: one line, the update signer's key for the `git` namespace. */
export const allowedSigners = (signer: string): string => `souffleur namespaces="git" ${signer}\n`

/** The arguments after `git -C <root>` that verify the tag object `oid` against the allowed_signers `file`. */
export const verifyTagArgs = (file: string, oid: string): string[] => ['-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${file}`, 'verify-tag', oid]

/** The line git prints on stderr for a signature from the allowed_signers entry. */
export const goodSignature = (stderr: string): boolean => stderr.split('\n').some((line) => line.startsWith('Good "git" signature for souffleur with '))
