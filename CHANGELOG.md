# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Every write of `~/.claude/souffleur.json` now goes through one path: a uniquely named temporary copy that is parsed back and moved over the file (a symlinked file is written through), a re-read right before the move with up to 3 retries when another session saved meanwhile (far fewer lost entries; a save in the instant between the re-read and the move can still win), one backup per session start with the newest 3 kept (only `.bak-<13-digit ms>` copies are pruned), and a reload of the config at the next prompt when either config file changed on disk (#91).

## [0.2.9] - 2026-11-28

### Changed

- Docs: shorter README with a quick start; reference moved to docs/.

### Fixed

- A skill that a background agent loads no longer counts as loaded in the main session, so a gated main call is no longer let through for it; live agent runs are tracked from their own start and end, not from the Agent tool call returning; skills an agent preloads at spawn are covered, a main Skill call by the bare name still counts, and a lost run end is pruned at the next prompt (#88).
- A failing store write can no longer drop a decision: the session copy is written at turn end, after a compaction, on a proposal change and at session end instead of on every tool call, a failed copy or status update only shows as degraded, and stored copies are capped at 50 and expire after 14 days (#87).

## [0.2.8] - 2026-11-27

### Fixed

- A skill that is not installed in this project no longer counts as needing attention; the band in the apps stays hidden for it.

## [0.2.7] - 2026-11-27

### Added

- The desktop and mobile apps show Souffleur's status in a one-row band above the prompt while something needs attention: a skill restoring or missing, degraded, not set up, or a newer release (#21).

## [0.2.6] - 2026-11-27

### Changed

- `/souffleur init` asks once per plugin when two or more of its skills have no setting yet (#43): all when the task needs it, don't watch any, ask one by one, or decide later. Every per-skill question now offers `Decide later`, which skips the skill and writes nothing, in place of `Stop`; closing a dialog still stops `init`. `Loaded by its own plugin at start (rare)` is offered only when it is the current or the recommended answer.
- In `observe` mode, "Would have denied" lists the same denials `enforce` would give, assuming the model retries after each denial, counted per rule and per skill (#31). When one call breaks several checks, a check can be listed on another call than `enforce` denies it on. An `after` rule is now listed once per open rule instead of at every repeat, and the subagent brief check is listed for every brief without a `skills:` line instead of every second one. `enforce` is unchanged.

### Security

- Learning reads a skill's text only when its source is one Souffleur knows to be safe (user, policy, plugin, built-in, synced); any other source needs a trusted project (#33).

## [0.2.5] - 2026-11-27

### Changed

- The brief check on `Agent` calls also applies to always-on skills that are not `for: chat` (#36). With such a skill, every `Agent` brief needs a `skills:` line in `enforce` mode, even when no need is active. A brief without one is denied once and then passes on the retry. The reason adds `Always-on: <names>.`. Skills that are excluded here, not installed here, unavailable or from an untrusted project file do not count.

### Fixed

- The denial that asks for skills after a compaction now counts toward the release of a stuck skill, so a load attempt made in answer to it can release the gate (#70).
- A gate that released after three denials no longer carries that state into the rest of the turn once its skill loads (#70). The denials and the load attempt of a skill that loads are forgotten, so a later stall of the same skill in the same turn counts from zero and needs its own load attempt before it is released.

### Security

- Only the person can run `/souffleur` verbs that change state (#34). `init`, `migrate`, `pause`, `resume`, `need` and `drop` now refuse a plugin or the model like the other verbs already did; `/souffleur` and `status` still answer anyone.

## [0.2.4] - 2026-11-27

### Added

- Souffleur tells you when a newer release exists and can install it (#68). The user file takes `"update": "notify" | "auto" | "off"` (default `notify`). Once a day it looks up the release tags on GitHub in the background and shows one line at the next session start. `/souffleur` has a new line with the version, the newest release, the time of the last check and the setting.
- `"update": "auto"` installs a newer release at session start, in the background, and only when the release tag is signed by the SSH key in the new user-file key `updateSigner`. A tag that is unsigned or signed by another key is not installed; a line says so. Without `updateSigner`, auto only shows the notify line. Auto and `/souffleur update` touch only the folder install, never one with uncommitted changes or one that is not exactly on a release tag.
- `/souffleur update` installs the newest release now. With `updateSigner` set it checks the signature first; without it, the tag installs unsigned and the answer says so. Only you can run it, not a plugin or the model.
- The marketplace install is not changed: its line points to `/plugin update`.

## [0.2.3] - 2026-11-27

### Changed

- A gate or skill rule on a skill that does not load now stops denying after three denials of that skill in one turn, once the model has tried to load it with a `Skill` call (#30). The calls pass and are listed under `Would have denied` as `released after 3 denials: <skill> did not load`, and one error shows through the degraded notice. A skill in state `unavailable` is no longer denied; it is only listed. The counters start again with each prompt of yours.
- The status line now starts with the local time Souffleur last saw the session (`14:02 · observe · 9 loaded`), the last activity it saw: your prompts, the main session's tool calls and turn ends, and the session start (#41). A time that stops moving shows that the session is gone.

## [0.2.2] - 2026-11-27

### Added

- `/souffleur` and the status line now show what the small model costs. `/souffleur` lists the calls, tokens and an estimated dollar cost for this session and in total, at list price; the status line adds `· ~$0.03` for the session. The classifier calls now go through `$.model.complete` (same speed as `$.model.classify`), which reports the tokens. A classifier answer in quotes or backticks, after `Label:`, in another case, or with spaces or a final period still counts; a label inside a sentence does not. Counting runs after the answer, so it never delays a prompt. The total is kept in the plugin store and is best effort: two sessions at the same moment can lose a count.

## [0.2.1] - 2026-11-27

### Changed

- Before the question opens, one chat line names every skill (40 at most), because the app cuts the question text. `Ignore all here` now says how many skills it ignored.

### Fixed

- An answer to the project-skills question that comes after the two-minute limit now counts. A late `Ignore all here` writes at once; a late `Set up now` starts the set-up at the next turn end. Both do nothing when the project got a block meanwhile, when the answer belongs to an earlier question, or while Souffleur is paused. Before, the late answer was dropped without a word.

## [0.2.0] - 2026-11-26

### Added

- Once per session, in a repository with no project block yet, Souffleur asks one question about the project's own skills that your config does not name: set them up now (init's round, for this project or everywhere), ignore them all here, or later. Where no dialog opens it shows one notice. Nothing is written for `Later`, a dismissal or a timeout.
- `/souffleur block <name>`, `unblock <name>` and `project` change and show the per-project block of the open repository.
- The user file can hold per-project blocks (`projects`) that block named skills, notes and rules in one repository and add entries for it only, while everything else stays the shared standard. `/souffleur` names the project, shows blocked skills as `blocked here` and reads `absent` as `not needed yet`.

## [0.1.9] - 2026-11-26

### Fixed

- `/souffleur review` and `/souffleur rule` no longer hang on a dialog that nobody answers: after two minutes they return `no answer within two minutes; the proposal stays queued`, the dialog stays open and a late tap still counts once (#54).
- A skill that compaction cut, whose need ended while it was being restored, and that is needed again, gets the "invoke them again" sentence in its request; a skill loaded after the compaction does not (#53).

## [0.1.8] - 2026-11-26

### Fixed

- When the small model fails to pick a work need three prompts in a row, the status now shows `degraded, see /souffleur` and the fallback line lists the work needs (on prompts the first classifier call called code work), as it already did when the first classifier call fails. A good answer clears it (#57).
- A failing step is told at most twice per session, the second time after a "back to normal" and marked "(again)"; each failing step gets its own line with its own newest error, and "back to normal" is not lost when one step flaps while another holds. `/souffleur` shows `Failures this session: tool.call 3, classifier B 1, ...` so a failure that cleared stays countable, including the first classifier call, the second one and learning (#48).

## [0.1.7] - 2026-11-26

### Changed

- Proposals by the model are limited to standing instructions of the user (notes) and to rules a check can decide (a skill loaded before a call, a field a call carries, evidence after a call); the system prompt sentence and the tool description say so, and a note with source `slip` is refused (#59).
- After you decline a proposal (dialog, reply word or `/souffleur decline`) or dismiss its dialog, the model's further proposals are refused and not queued for the rest of the session. A dialog that cannot open, a dialog that times out, a reply notice that a later prompt ends without an answer, a typed command and an accept do not stop proposals. The stop and a dismissed dialog are kept in the session, so a hot reload or a resume neither re-asks nor allows new proposals; a new session or `/clear` starts clean. `/souffleur rule` and `/souffleur review` still work (#59).

## [0.1.6] - 2026-11-26

### Added

- Reply check for the `chat` skill: an always-on skill with `for: "chat"` can carry `reply: { maxChars, headings }` (200 to 20000 characters, 0 to 20 headings, both optional). After each main-session answer Souffleur measures the reply without code blocks and counts heading lines, counts violations per session (kept over a resume), shows `<skill>: <v> of <t> replies over the limit` in `/souffleur`, and adds one reminder line to the next prompt's context, at most once per five prompts. Both modes only remind. Replies to typed commands, aborted turns and mostly-code replies are not checked; nothing is denied.

## [0.1.5] - 2026-11-26

### Changed

- A `readers` or `users` need starts from tool evidence, without a model call: a call that matches a gate of one of its skills, or for `readers` a Bash command `gh issue create|comment` or `gh pr create|edit` (also inside `cd x && gh pr create …`); a plain `git commit` does not count, because it started the writing skills in nearly every coding session. After a compaction these needs go dormant: their skills are requested again only on the next such evidence or when a prompt is classified as a text for others or a screen. In observe the request follows the first such call; in enforce the first such call is denied once with the request, so these gates are effectively always on (once per session and after each compaction). Only the skills of the started need are asked for. Excluded (`notIn`) and untrusted-project skills are never requested because of evidence. `/souffleur` shows dormant needs as `waiting since compaction`. A need that evidence started is not asked for again on a chat-reply prompt; a fresh signal for a need resets its skills' request count and brings an `unavailable` skill back. In observe the first evidence call is listed under "Would have denied". A need named `none` is rejected, a `for: "chat"` need gets a config warning, and the compaction sentence of the request appears only after a compaction.
- A prompt is classified by what the agent will produce, in two parallel calls (A within 2.5 s, B within 4 s): call A (`chat-reply`, `text-for-others`, `screen`, `code-or-repo-work`) starts the `readers` or `users` needs, call B picks a `work` need and counts only for code or repo work. One slow call B no longer fails the whole prompt (#52). After three failures in a row each prompt lists the `work` needs and their skills so the model can pick (needs already active and skills already loaded are left out); each failure's kind (`timeout`, `rejected`, `unknown-label`) goes to the debug log.

## [0.1.4] - 2026-11-26

### Added

- Config: a need can be `{ "for": "chat|readers|users|work", "what": "..." }` and an always-on skill can carry `for`; the old string need still works and counts as `work`. A user-file skill can list `notIn` project roots.
- Souffleur says each skill's audience when it asks for it: the load request has one line per audience (`for texts other people read ...`, `for your replies in this chat.`, `for how you work on this task.`), the system prompt section says each skill applies only to the output named with it and names the `chat` skill, and a skill listed in `notIn` for the project root is not requested, gated, named in the Agent brief check or counted as cut (`/souffleur` shows `excluded in this project`). A gate denial names the audience of the skill it asks for. The system prompt section keeps `Always-on skills: <names>.` for always-on skills that are not `for: chat`. `/souffleur` lists under "Audience not set:" needs without an audience (`<need>: no audience set; add "for" to it in ~/.claude/souffleur.json`) and always-on skills without `for` (`<skill>: always on without "for"; add "for": "chat" if it shapes your replies in this chat`).

### Fixed

- A duty arms only on a file-changing call (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`); a tool such as an Artifact publish never arms one, so a checked file can be published without a new duty (#51). A duty whose `after.tools` names no file tool is kept with a config error.

## [0.1.3] - 2026-11-26

### Changed

- Proposals are asked about at the end of every main-session answer, also in sessions that report no interactive surface (Remote Control starts such sessions). Where no dialog opens, Souffleur shows the proposal as a notice, and a reply of `accept`, `annehmen`, `decline` or `ablehnen` as the person's very next prompt answers it. A peer, a hand-back or the model cannot answer this way (#44).
- `/souffleur` is shorter: active needs show as name and start time (the prompt excerpt that started a need goes to the debug log), "Would have denied" groups equal reasons as `6× reason (05:50–06:42)` with the newest full message once, "Notes waiting for a later prompt" lists only notes that are held back, and the header says times are UTC. A need ends by itself after 20 prompts in a row that the classifier ran on without matching it; a need set with `/souffleur need` stays until `/souffleur drop`. Prompts of three words or fewer do not count toward the 20, and skills that were only being restored for an ended need go back to absent (#37).

### Fixed

- A turn-end dialog that nobody answers is given up after two minutes and shown as a notice; the notice names `/souffleur accept <id>` where a reply cannot reach the session (`claude -p`). A prompt handled as a reply is not classified, and a failing debug log no longer drops the restore context.

## [0.1.2] - 2026-11-26

### Fixed

- Fixed: field rules no longer see the event metadata of a tool call (`tool`, `tool_use_id`, `agentId`, `requestMeta`) as arguments, so a field rule named like one of them no longer passes without that argument (#40).
- Fixed: a resume in a new process resets the per-run counters (subagents running, main skill calls, denied agent and field rules, pending learn calls), so a stale count no longer blocks or misreads the resumed session; a reload in the same process keeps them (#32).
- Fixed: a hook error clears once that hook works again, so one transient failure no longer keeps the status `degraded` until restart. Config errors and the classifier and learn failure counts keep their own lifecycle (#35).

## [0.1.1] - 2026-11-26

### Added

- Notices: short `Souffleur:` lines in the transcript for session start, compaction and problems, once per event and for the main session only. `"notices": false` in the user file turns them off.

### Fixed

- The propose tool is registered again on a user prompt when it dropped out of the tool list. The line `Souffleur: tool reconnected.` appears only when the tool was seen and then went missing; a tool the list never showed is registered again silently, once per process.

## [0.1.0] - 2026-11-25

### Added

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

### Fixed

- Fix: a skill is marked `not installed here` only from the session's own skill listing, never from the command list, and not when the listing is incomplete. Names match with or without the plugin prefix. Such a skill opens no duty and does not appear in the always-on text, the brief check or the open duties.
- Fix: the injected answer gets a line in the summary every time it is the result, including when it stays unchanged and in the text without a dialog. A plugin with a `SessionStart` hook gets a note, one without gets a warning, and unreadable files say so.
- Fix: a session start, a reload and any event on a session that missed a config change bring the ledger in line with the config. The skill listing no longer holds up the prompt.
- Fix: `/souffleur migrate` reads the config fresh, counts only user file skills as watched, lists every skill a hook names, treats a bare word as a guess, and notes watched skills that are not installed in the session.
- Fix: `/souffleur init` now applies its answers to the running session: new skills show as absent, removed ones leave the table and the status line updates, with no new session needed.
- Fix: the answer `Injected by its plugin` is now `Loaded by its own plugin at start (rare)`, explained with an example and listed last. `init` warns when the plugin declares no `SessionStart` hook, because the status would report the skill as loaded when it is not.
- Fix: a configured skill that this session does not list shows as `not installed here` and is neither requested nor gated, so a user file can name a skill of one project without noise elsewhere.
- Fix: `/souffleur migrate` warns when a hook serves a skill Souffleur does not watch, or names no skill, and then lists `Keep` first.
- Fix: `init` proposes an existing need only when the skill's description clearly matches it, and recommends `Don't watch` for skills that run only on an explicit request.

### Security

- A project file is report only unless its root is in `trustProjects`: Souffleur no longer asks the model to load its skills, names them in the system prompt or lets its needs deny an `Agent` brief. A project file may define 20 skills and 10 needs; more get an error that names the cap. Duty evidence gets the same length and control character checks as rule evidence, and `trustProjects` ignores trailing slashes.

[Unreleased]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.9...HEAD
[0.2.9]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/r4KK4n/skill-souffleur/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/r4KK4n/skill-souffleur/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/r4KK4n/skill-souffleur/releases/tag/v0.1.0
