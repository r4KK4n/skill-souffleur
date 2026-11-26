# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

- A duty arms only when a file changed: a tool such as an Artifact publish arms it only for a path written since the last evidence, so a checked file can be published without a new duty (#51).
- Config: a need can be `{ "for": "chat|readers|users|work", "what": "..." }` and an always-on skill can carry `for`; the old string need still works and counts as `work`. A user-file skill can list `notIn` project roots.
- Souffleur says each skill's audience when it asks for it: the load request has one line per audience (`for texts other people read ...`, `for your replies in this chat.`, `for how you work on this task.`), the system prompt section says each skill applies only to the output named with it and names the `chat` skill, and a skill listed in `notIn` for the project root is not requested, gated, named in the Agent brief check or counted as cut (`/souffleur` shows `excluded in this project`). `/souffleur` also hints at needs that have no audience yet: `<need>: no audience set, run /souffleur init`.

## [0.1.3] - 2026-11-26

- A turn-end dialog that nobody answers is given up after two minutes and shown as a notice; the notice names `/souffleur accept <id>` where a reply cannot reach the session (`claude -p`). A prompt handled as a reply is not classified, and a failing debug log no longer drops the restore context.
- Proposals are asked about at the end of every main-session answer, also in sessions that report no interactive surface (Remote Control starts such sessions). Where no dialog opens, Souffleur shows the proposal as a notice, and a reply of `accept`, `annehmen`, `decline` or `ablehnen` as the person's very next prompt answers it. A peer, a hand-back or the model cannot answer this way (#44).
- `/souffleur` is shorter: active needs show as name and start time (the prompt excerpt that started a need goes to the debug log), "Would have denied" groups equal reasons as `6× reason (05:50–06:42)` with the newest full message once, "Notes waiting for a later prompt" lists only notes that are held back, and the header says times are UTC. A need ends by itself after 20 prompts in a row that the classifier ran on without matching it; a need set with `/souffleur need` stays until `/souffleur drop`. Prompts of three words or fewer do not count toward the 20, and skills that were only being restored for an ended need go back to absent (#37).

## [0.1.2] - 2026-11-26

- Fixed: field rules no longer see the event metadata of a tool call (`tool`, `tool_use_id`, `agentId`, `requestMeta`) as arguments, so a field rule named like one of them no longer passes without that argument (#40).
- Fixed: a resume in a new process resets the per-run counters (subagents running, main skill calls, denied agent and field rules, pending learn calls), so a stale count no longer blocks or misreads the resumed session; a reload in the same process keeps them (#32).
- Fixed: a hook error clears once that hook works again, so one transient failure no longer keeps the status `degraded` until restart. Config errors and the classifier and learn failure counts keep their own lifecycle (#35).

## [0.1.1] - 2026-11-26

- Notices: short `Souffleur:` lines in the transcript for session start, compaction and problems, once per event and for the main session only. `"notices": false` in the user file turns them off.
- The propose tool is registered again on a user prompt when it dropped out of the tool list. The line `Souffleur: tool reconnected.` appears only when the tool was seen and then went missing; a tool the list never showed is registered again silently, once per process.

## [0.1.0] - 2026-11-25

- A project file is report only unless its root is in `trustProjects`: Souffleur no longer asks the model to load its skills, names them in the system prompt or lets its needs deny an `Agent` brief. A project file may define 20 skills and 10 needs; more get an error that names the cap. Duty evidence gets the same length and control character checks as rule evidence, and `trustProjects` ignores trailing slashes.
- The restore request and the notes of one prompt stay under 10,000 characters. Skills that do not fit are asked for on a later prompt and stay listed in `/souffleur`.
- The status turns `degraded` after three failed classifier runs or three failed skill reads in a row, and clears after a good one.
- A skill version counts as read only once its proposals were answered. If the queue is dropped first, the version is read again the next time it loads, three times at most.
- `/souffleur pause` also stops restore requests, need detection and the turn-end questions. `/souffleur resume` undoes it. A pause is not carried over when a session is resumed.
- `/souffleur` and every session start read the config files again, so a hand edit applies without a restart.
- An open duty is mentioned once in the prompt context when it opens.
- Session copies in the plugin store are stamped, and copies older than 30 days are removed at session start. The README now lists what Souffleur reads and stores.
- A gate that names the `Skill` tool is rejected when the file is read, and the `Skill` call that loads a gated skill is never denied.
- Version notice: when Claude Code is newer than the newest version Souffleur was checked on, `/souffleur` shows one line with both versions. The status line stays unchanged.
- The plugin has a version, `0.1.0`, in `plugin.json` and `marketplace.json`, so `claude plugin update` can find later changes. CONTRIBUTING explains when to raise it.
- CI runs `claude plugin validate .` and `claude plugin test .` on the verified Claude Code version, and a weekly workflow runs them on the latest one and opens an issue when they fail.
- Learn rules from skills: when the main session loads a skill file Souffleur has not read, a small model reads it in the background (30 second limit) and queues at most three rules or notes the skill states as obligations, with source `skill:<name>`. It needs the user file, a person at the prompt and no pause. A version is read once and marked only after its proposals were queued; five reads per session at most, six skill proposals waiting at most, your own proposals first. The question says it was read from a skill's text and names the skill, plugin or project skill; project and MCP skills need the root in `trustProjects`. A subagent's loads are skipped, except that a background subagent's load can be read as the main session's. `"learn": { "skills": false }` in the user file turns it off.
- Rules and notes in the user file: a rule waits for a skill before a call, requires a field on a call, or requires evidence after a call; a note is a standing instruction for the system prompt section or, with a `need`, for the prompt context. Rules follow `mode`, `/souffleur pause` stops them, and a project file that holds them gets an error.
- The tool `souffleur_propose` lets the model propose a rule or note when something went wrong or you ask it to remember something. Proposals queue (20 at most), and one question per turn is asked at the end of a turn with `Yes, everywhere`, `Yes, this project only` and `No`.
- `/souffleur rule <text>`, `/souffleur review`, `/souffleur accept <id> [here|project]` and `/souffleur decline <id>`; they act only when the user types them. Without a dialog proposals stay queued and nothing is written. `/souffleur migrate` queues standing instructions from `CLAUDE.md` and the memory index as note proposals.
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
