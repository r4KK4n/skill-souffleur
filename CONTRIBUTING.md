# Contributing

One person maintains Souffleur, so small, focused changes are the easiest to review.

## Before you start

For anything larger than a typo or a one-line fix, open an issue first and describe the problem. A short discussion up front saves you from writing a pull request that does not fit.

## Run it locally

You need Node 22.6 or later (the tests run with `--experimental-strip-types`).

```
npm ci
npm test
npm run typecheck
claude plugin validate .
claude plugin test .
```

`npm test` and `npm run typecheck` need no login. The two `claude plugin` commands need Claude Code (the version named in `VERIFIED_UP_TO` in `src/core/version.ts`) and no login either. Run them before you push a change to `src/mod/`.

## Pull requests

- Branch from `main` and keep one change per pull request.
- Add or update tests for any change in behaviour.
- Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) format, for example `fix: keep the ledger after a resumed session`.
- Update `CHANGELOG.md` under "Unreleased" if users will notice the change.
- If users will notice the change, also raise `version` in `.claude-plugin/plugin.json` and in the plugin entry of `.claude-plugin/marketplace.json` (see Versions and releases for which part to raise). Claude Code compares this number, so without a new one `claude plugin update` reports "already at the latest version" and the change never reaches an installed copy. A test fails when the two files differ.

Pull requests are merged with squash, so the pull request title becomes the commit message. Write it in the same format.

## Versions and releases

The version in `plugin.json` and `marketplace.json` follows [Semantic Versioning](https://semver.org/). While the major version is 0, the rules are:

- A new feature or a change in behaviour raises the minor version (0.3.0).
- A fix raises the patch version.
- A change to a config key that breaks existing files raises the minor version, and the `CHANGELOG.md` entry names the key.

Releases are cut from `main` with a signed tag. Pushing the tag `v<version>` starts `.github/workflows/release.yml`, which creates the GitHub release from the matching `CHANGELOG.md` section and fails when that section is missing. Do not touch the `CHANGELOG.md` headings in a pull request: the maintainer moves the "Unreleased" entries under the new version when tagging. The maintainer also creates the tag `v<version>`, for example `v0.1.0`.

### Cutting a release

The maintainer does these steps after the version and changelog are on `main`:

1. Check that CI is green and that `version` in `plugin.json` and `marketplace.json` matches the new number.
2. Move the "Unreleased" entries in `CHANGELOG.md` under the new version heading with its date.
3. Create a signed tag on the release commit and verify it. Set the signing config in the repository, not globally:

   ```
   git config gpg.format ssh
   git config user.signingkey ~/.ssh/<key>.pub
   git tag -s v0.2.9 -m "release 0.2.9"
   git verify-tag v0.2.9
   ```

   `git verify-tag` needs an `allowed_signers` file that lists the public key from [docs/updates.md](docs/updates.md#signed-releases).
4. Push the tag with `git push origin v0.2.9`. The release workflow then publishes the release.

Tags from `v0.2.4` on are signed with the key in [docs/updates.md](docs/updates.md#signed-releases); earlier tags are not. Automatic updates install only tags that verify against the key a user lists as `updateSigner`.

When you check Souffleur on a newer Claude Code version, add the behaviour and the version to [docs/compatibility.md](docs/compatibility.md) and set `VERIFIED_UP_TO` in `src/core/version.ts` to the same version. A test compares the two. `/souffleur` tells users when their Claude Code is newer than that version.

## Checks in CI

The `mod` job installs the Claude Code version named in `VERIFIED_UP_TO` and runs `claude plugin validate .` and `claude plugin test .`. A weekly workflow runs both against the latest Claude Code and opens an issue titled "Mod checks fail on Claude Code <version>" when one fails. Neither command needs a login. Run them locally before you push a change to `src/mod/`. GitHub turns off scheduled workflows after 60 days without repository activity, so after a quiet period check the Actions tab and start the weekly workflow again by hand (its `workflow_dispatch` trigger).

## Reporting bugs

Use the bug report form. Include your Claude Code version (`claude --version`): hook and plugin behaviour changes between releases, and most bugs depend on it.
