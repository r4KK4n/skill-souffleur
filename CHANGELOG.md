# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Install with `/plugin install skill-souffleur --marketplace r4KK4n/skill-souffleur`; the repository now holds a marketplace file.
- `/souffleur init`: asks per skill how it is kept (from the start, injected by its plugin, when the task needs it, or not watched) and writes each answer to `~/.claude/souffleur.json`. Without a dialog it prints the recommendations and changes nothing.
- `/souffleur migrate`: lists hooks in `settings.json` that do what Souffleur does, including guesses from script names such as `preload` and `reload`, and turns off the ones you pick after a backup. It never edits scripts, `CLAUDE.md` or memory files.
- Status line `souffleur: not set up, run /souffleur init` while no user config exists.
- Config file: user file `~/.claude/souffleur.json`, optional project file with restricted rights.
- Need detection: a prompt is matched against the configured needs, and the skills those needs name are asked for when missing.
- Gates and duties: a step can wait until its skills are loaded, and a duty can require evidence after a step. Nothing is denied in `observe` mode, the default.
- Restore after compaction and resume: the mod keeps a ledger per session, marks skills stale when `/compact` runs and asks the model to load them again on the next prompt.
- `/souffleur` command: shows the ledger, the active needs, open duties and calls that `observe` mode would have denied. Also `need`, `drop` and `pause`.
- Status line: `souffleur: 2 loaded, 1 stale`, or `souffleur: degraded, see /souffleur` when a config file or an event could not be read.
- System prompt section that tells the model to follow Souffleur's load requests and names the always-on skills.
