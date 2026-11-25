# Contributing

Thanks for taking the time to help. Souffleur is maintained by one person, so small, focused changes are the easiest to review.

## Before you start

For anything larger than a typo or a one-line fix, open an issue first and describe the problem. A short discussion up front saves you from writing a pull request that does not fit.

## Pull requests

- Branch from `main` and keep one change per pull request.
- Add or update tests for any change in behaviour.
- Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) format, for example `fix: keep the ledger after a resumed session`.
- Update `CHANGELOG.md` under "Unreleased" if users will notice the change.

Pull requests are merged with squash, so the pull request title becomes the commit message. Write it in the same format.

## Reporting bugs

Use the bug report form. Include your Claude Code version (`claude --version`): hook and plugin behaviour changes between releases, and most bugs depend on it.
