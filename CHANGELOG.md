# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Fix: a skill is marked `not installed here` only from the session's own skill listing, never from the command list, and not when the listing is incomplete. Names match with or without the plugin prefix. Such a skill opens no duty and does not appear in the always-on text, the brief check or the open duties.
- Fix: the injected answer gets a line in the summary every time it is the result, including when it stays unchanged and in the text without a dialog. A plugin with a `SessionStart` hook gets a note, one without gets a warning, and unreadable files say so.
- Fix: a session start, a reload and any event on a session that missed a config change bring the ledger in line with the config. The skill listing no longer holds up the prompt.
- Fix: `/souffleur migrate` reads the config fresh, counts only user file skills as watched, lists every skill a hook names, treats a bare word as a guess, and notes watched skills that are not installed in the session.
- Fix: `/souffleur init` now applies its answers to the running session: new skills show as absent, removed ones leave the table and the status line updates, with no new session needed.
- Fix: the answer `Injected by its plugin` is now `Loaded by its own plugin at start (rare)`, explained with an example and listed last. `init` warns when the plugin declares no `SessionStart` hook, because the status would report the skill as loaded when it is not.
- Fix: a configured skill that this session does not list shows as `not installed here` and is neither requested nor gated, so a user file can name a skill of one project without noise elsewhere.
- Fix: `/souffleur migrate` warns when a hook serves a skill Souffleur does not watch, or names no skill, and then lists `Keep` first.
- Fix: `init` proposes an existing need only when the skill's description clearly matches it, and recommends `Don't watch` for skills that run only on an explicit request.
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
