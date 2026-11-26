# Design

Status: approved 2026-11-25, extended the same day with rules and notes. Verified against Claude Code 2.1.322 and 2.1.332.

## Intent

A Claude Code user with a handful of skills they rely on (a writing style guide, a UI design checklist, a token-saving rule set) should never have to ask "is that skill still active?". Today they have to: compaction cuts or drops skill text, and nothing reports it. Souffleur keeps track of which skills a session needs and has loaded, restores what compaction or a resume took away, and can show its state at any time. See [background.md](background.md) for the evidence.

Success: the user stops asking whether a skill still runs, and Claude can answer "which skills are active and why" from Souffleur's ledger.

## Goals

1. Know, per session, which skills were loaded, when, and whether their full text is still in the context.
2. Decide from the meaning of the current work, not from keywords, which configured skills it needs.
3. Restore a needed skill that is missing or truncated, without the user asking.
4. Hold back a configured step (for example writing a prototype file) until the skills it needs are loaded.
5. Check configured duties that leave a trace, such as "run the UI detector after writing a prototype".
6. Show the ledger on request and in the status line.
7. When the main session hands work to a subagent, make it state which skills the subagent needs.
8. Work the same after startup, compaction, resume, clear, a lost connection and a reload of the mod.
9. Learn the rules that matter from the skills a user actually has, from slips and from the user's own words, and keep them in one place: Souffleur's config, not memory files or scattered notes. Nothing becomes a rule without the user's yes.

## Non-goals

- Judging whether the model applied a skill's style rules well. Souffleur guarantees "loaded" and "duty with a trace done"; it cannot grade prose.
- Writing or editing skills.
- Replacing Claude Code's own skill listing or its auto-invocation.
- Supporting Claude Code versions without the mod API.

## Anti-goals

These would make Souffleur a failure even if it technically works:

- Pasting full skill texts into every prompt.
- A rule or note the user never confirmed.
- More than one question per turn, or a question in the middle of a turn.
- Reminder noise: text in every turn when nothing is missing.
- A silent failure. If Souffleur cannot read an event or the API changed, it says so; it never reports "all loaded" by default.
- Blocking the user's work on a false positive without a way out.

## Constraints

Measured on Claude Code 2.1.322 (details in [background.md](background.md)):

- Compaction in a running process re-attaches a skill cut at 20,000 characters, with a truncation note. Resume followed by compaction re-attaches nothing.
- Invoking a skill again after compaction delivers its full text.
- Mod events `skill.prompt` (every skill expansion: Skill tool, typed `/name`, preload) and `session.compact` (before and after) fire as expected.
- A system prompt section added through `prompt.compose` survives `/compact`. Sections are cached per thread: a changed answer only goes out after a compaction or a new thread, unless it breaks the prompt cache.
- `$.model.classify(text, labels)` with the default small model takes about 800 ms and returns one label.
- The mod API is early access and changes between releases.
- Hook and mod output above 10,000 characters is moved to a file; the model sees a preview only.

## Approaches considered

| Approach | How | Trade-off |
|---|---|---|
| A. Command hooks reading the transcript | Shell or Node hooks on `SessionStart`, `UserPromptSubmit`, `PostToolUse`; find the last `compact_boundary` in the transcript JSONL | Works on any version with hooks. Reads an undocumented file format after the fact; the boundary is not yet written when the compact hook runs; plugin hook updates need `/reload-plugins`, which does nothing over Remote Control. |
| B. CLI that installs command hooks into settings | Same logic as A, installed by `souffleur install` into `~/.claude/settings.json` | Settings hooks reload live. Same transcript problems as A, and semantic detection needs a separate model call or a per-prompt card. |
| C. Mod (chosen) | In-process plugin on `skill.prompt`, `session.compact`, `prompt.submit`, `prompt.compose`, `tool.call` | Sees loads and compactions as they happen, has a built-in classifier, a system prompt section that survives compaction, a status line and commands. Cost: an early-access API that will change. |

The user picked C on 2026-11-25. To contain the API risk, everything except the event wiring lives in a core with no import of `claude-code`.

## Design

### Parts

```
src/core/        plain TypeScript, no claude-code import, fully unit-tested
  config.ts      load and validate the rule file
  ledger.ts      per-skill state machine
  needs.ts       which skills the session needs, and why
  decide.ts      given ledger + needs + event: what to do
  status.ts      render the ledger as a table and a one-line status
src/mod/         thin adapter, the only code that imports 'claude-code'
  register.ts    wires events to core, performs the actions core returns
```

`decide.ts` returns actions as data (`restore(skill)`, `deny(tool, reason)`, `append(text)`, `status(text)`), and the adapter carries them out. Tests drive the core with event sequences recorded from real sessions.

### Configuration

JSON, so the mod needs no parser dependency. A user file `~/.claude/souffleur.json`, optionally extended by a project file `.claude/souffleur.json`.

The project file comes from whatever repository the user opens, so it is untrusted. It may add skills and needs under names the user file does not use; it can never change, remove or shadow a user entry, never set `mode`, and never hold rules or notes. Its gates and duties only report, even in `enforce`, unless the user file lists that project root under `trustProjects` (roots are compared without trailing slashes, as `where` is). For a root that is not trusted, Souffleur also does not ask the model to load the file's skills, does not name them in the system prompt and does not let the file's needs raise the subagent brief check; `/souffleur` lists them and says why. The file may define at most 20 skills and 10 needs; the rest are dropped with an error that names the cap. Each file is validated on its own before the merge: an invalid entry drops that entry with an error, not the whole file, and never touches an entry of the same name in the other file. Names are limited to letters, digits, `:`, `_`, `-` and 64 characters; need texts to one line of 200 characters.

```json
{
  "skills": {
    "terse:terse-mode": { "always": true, "startup": "injected" },
    "writing-guide": { "need": "prose" },
    "writing-check": { "need": "prose" },
    "ui-design": {
      "need": "ui",
      "gate": { "tools": ["Write", "Edit", "Artifact"], "paths": ["**/*.html", "**/*.tsx"] },
      "duty": { "after": { "tools": ["Write"], "paths": ["**/*.html"] }, "evidence": { "tool": "Bash", "command": "*ui-design*detect*" } }
    }
  },
  "needs": {
    "prose": "Writing text people read: docs, specs, plans, issues, UI copy.",
    "ui": "Designing or building something a user sees: screens, prototypes, mockups, components."
  }
}
```

Paths in `gate`, `duty` and rules are globs with `*`, `**` and `?` only; other glob syntax is rejected. A glob without a leading `/` or `**/` matches relative to the project root. The duty's `evidence.command` uses the same glob syntax on the command line (`*ui-check*detect*`), not a regular expression, so no configured pattern can make matching slow.

A skill with `always` is needed from the first turn. A skill with `need` is needed once the classifier has matched that need in the session. `gate` and `duty` are optional.

The top-level `mode` key decides whether Souffleur may block anything. In `observe`, the default, Souffleur keeps the ledger, asks for restores and reports through `/souffleur`, but denies no tool call; `/souffleur` lists each call it would have denied. In `enforce`, gates and duties deny as described below. Only the user file sets `mode`. A project file that sets it gets an error and the mode stays as the user file has it, so a cloned repository can neither switch gates on nor off.

### Ledger

One entry per configured skill, kept in `$.state` for the session and mirrored to `$.store` keyed by session id so a resume finds it.

| State | Meaning | Entered by |
|---|---|---|
| `absent` | never loaded in this session | start |
| `loaded` | full text in the context | `skill.prompt` with the full text |
| `stale` | was loaded, a compaction happened since | `session.compact` (after) |
| `restoring` | Souffleur asked for it, not yet seen | a `restore` action |
| `unavailable` | asked for twice without a load; not asked for or gated again this session | a second unanswered request |
| `not installed here` | configured, but this session's skill list does not name it; never asked for or gated | the list checked at session start and on each user prompt |

A user file may name a project skill of one repository. Elsewhere that skill shows as `not installed here`. Souffleur never asks for it and never gates on it, opens no duty for it and lists none, leaves it out of the always-on text in the system prompt and out of the configured-skills list in the brief check, and the status line counts these skills separately. An absent skill, or one counted loaded only because its plugin injects it at startup, is marked when the list lacks it. Any other loaded skill keeps its state.

The list is the skill listing of `$.session.usage`. No fallback is used for marking: when the listing is missing, empty or says it holds fewer skills than there are, no skill is marked. A configured name matches a listed name when both are equal, or when one side has no plugin prefix and the part after the colon of the other equals it.

The ledger follows the config. `/souffleur init` re-reads the user file after it writes, a session start (also a resume or reload) reads it again, and a session whose ledger lists other skills than the config follows the config on its next event: new skills start `absent`, removed ones leave the ledger, and needs the config no longer has and duties of removed skills are dropped. The skill list is checked at session start and on each user prompt, beside the need classification, and the prompt goes on without it after 300 ms.

Each entry keeps `since`, `reason` (`always`, `need:ui from "build a login mockup"`, `loaded by user`), and the time of the last compaction it went through.

After any compaction every `loaded` skill becomes `stale`. Measuring which skills the engine re-attached in full is possible from the transcript but brittle, and re-invoking a needed skill is cheap compared with working without it. A `stale` skill that is not needed stays `stale` and costs nothing.

### Needs

- On every user prompt (`prompt.submit`, not prompts submitted by a plugin), the adapter asks the classifier once per configured need whether the prompt matches it. The calls run in parallel; the whole step has a budget of 1.5 s, after which it continues without a verdict.
- A matched need stays active across prompts that do not mention it. Work on a prototype spans many prompts that do not mention it again; dropping the need after one unrelated prompt would bring back the original problem. It ends by itself only after a long run of misses (see Status).
- `/souffleur need ui` and `/souffleur drop ui` let the user set or clear a need by hand.

### Restoring

When a needed skill is `absent`, `stale` or `restoring`, Souffleur acts on the user's prompt itself: the `prompt.submit` hook adds a short context block to that prompt naming the skills and asking the model to invoke each with the Skill tool before anything else. The model loads them as its first step in the same turn, and `skill.prompt` confirms each one. Souffleur never attaches a skill's text itself; the text always comes from the engine's own expansion. `$.prompt.submit({ text: "/<skill>" })` was ruled out: it queues a separate turn that runs after the user's prompt.

If the model skips the request, the gate is the backstop: the next gated step is denied until the skill is loaded. A skill still not seen after one more prompt shows as `restoring` in the status. After two unanswered requests Souffleur stops asking for that skill, shows it as `unavailable` and stops gating on it, so a skill that cannot load never blocks work.

Compaction can also happen in the middle of a long turn, when no user prompt follows for a while. Then the restore request rides on the next main-session tool call instead: Souffleur lets the call run and adds the request to its result as `context`, which the API offers for exactly this.

Restores run in config order with no size cap. Restoring two writing skills and a UI design skill after a compaction adds roughly 80 KB. The code marks this as a shortcut: add a priority cap if measurements show restores pushing sessions into the next compaction early.

No cap applies to the skills' own text. The request that names the skills is cut at 5,000 characters, and the whole context block of a prompt (request, notes, reminders) at 10,000, because longer hook output is moved to a file. Skills left out stay `absent` or `stale` in `/souffleur` and are asked for on a later prompt.

### Skills loaded without `skill.prompt`

Some skill text reaches the context through other paths: a plugin's own startup hook (a token-saving plugin injects its rules at startup), or the engine's re-attachment after compaction. Souffleur does not see these. A skill can set `"startup": "injected"` in the config; Souffleur then treats it as `loaded` at session start and `stale` after the first compaction, so it neither duplicates the startup text nor misses the loss.

Souffleur replaces the user's earlier preload and reload hooks. Removing those is part of adopting Souffleur; it does not run beside them.

### System prompt section

A short, stable section added through `prompt.compose`:

> Souffleur keeps track of skills in this session. If a message from Souffleur asks you to load skills, invoke each one with the Skill tool before you continue. Each skill applies only to the output named with it. Replies in this chat follow terse:terse-mode; a skill for other readers or for product users never changes how you reply here.

It holds the rule and the `chat` skill that is always on (if any), never the changing ledger, because sections are cached per thread and must not break the prompt cache. It also carries the notes without `need`, and one sentence asking the model to call `souffleur_propose` when a slip happened that a rule would have caught or the user asks it to remember a rule. Notes in the section are capped at 2,000 characters; above that the status line says so and `/souffleur` lists the notes that were left out.

### Gates and duties

- Gate: on `tool.call` for a configured tool and path, if a skill whose gate matches is needed and not `loaded`, deny with a reason that names the skill and says how to proceed. The model then loads it and retries. `/souffleur pause` turns every denial off for the session: gates, duties, rules and the subagent brief check. It also stops restore requests, need detection (no classifier calls), the turn-end questions and the reading of skill texts. `/souffleur resume` undoes it, and a pause is not carried over when a session is resumed. A gate cannot name the `Skill` tool (the entry is dropped with an error), and the `Skill` call that loads a gated skill is never denied.
- Duty: when a call matches `after`, Souffleur records an open duty. A later tool call matching `evidence` closes it. While a duty is open, the next call that matches the skill's gate (writing or publishing the next prototype file, for example) is denied once with the duty named; the retry passes, so a wrong evidence pattern cannot trap the session. This enforces it in the same turn without a paid turn of its own. An open duty is also mentioned once, with the next user prompt's context, and not again until it closes and opens anew.
- A duty arms only on a file-changing call (`Write`, `Edit`, `NotebookEdit`, `MultiEdit`) that matches `after`; any other tool in `after.tools` (a publish, for example) never arms it, so publishing a file after its check opens no new duty (#51). A file changed outside the file tools (a Bash redirect or `sed -i`) opens no duty either, and a later publish does not. A duty whose `after.tools` names none of the file tools is kept, with a config error, because it never opens.

### Rules and notes

Skills carry rules that are easy to miss at the moment they matter. Example: a workflow skill says "name a model for every subagent, or it inherits the session's most expensive one". If that skill is not loaded when the session dispatches a subagent, the rule is lost and nothing notices. Users also give standing instructions ("answer in German", "never translate quoted English") that today live in memory files, project notes or nowhere.

Souffleur keeps both in its config, next to the skills:

```json
{
  "rules": [
    { "id": "agent-needs-workflow", "before": { "tools": ["Agent"] }, "skill": "dev-workflow", "source": "skill:dev-workflow" },
    { "id": "agent-names-model", "before": { "tools": ["Agent"] }, "field": "model", "source": "slip" },
    { "id": "test-after-edit", "after": { "tools": ["Edit"], "paths": ["src/**"] }, "evidence": { "tool": "Bash", "command": "npm test" }, "source": "user" }
  ],
  "notes": [
    { "id": "reply-language", "text": "Reply to the user in German, briefly.", "source": "user" },
    { "id": "ui-copy", "text": "Show UI copy to the user before writing it.", "need": "ui", "source": "user" }
  ]
}
```

A rule has a trace Souffleur can see, in one of three kinds (`source` is `user`, `slip` or `skill:<name>`): a skill that must be loaded before a matching call (`skill`), a field the call must carry (`field`), or evidence that must follow a matching call (`after` with `evidence`, the same as a duty). Rules follow `mode`: in `observe` a broken rule is listed, in `enforce` the call is denied with the rule named. How each kind enforces:

- `skill`: a matching call is denied until the skill is `loaded`, like a gate. Once a rule has fired or its skill was loaded in a session, the skill counts as needed for the rest of that session, so it is restored after compaction like any needed skill. A skill named only in a rule gets a ledger entry too.
- `field`: a matching call without that field is denied once; the retry passes, so a wrong rule cannot trap the session.
- `after` with `evidence`: a matching call opens the rule; while it is open, the next call that matches `after` again is denied once, and an open rule is listed at turn end. Evidence closes it.

When one call breaks several rules, or a rule and the subagent brief check below, the denial lists all of them in one reason. A rule or note may carry `where` to apply in one project only. `where` is the main repository root, resolved through git's common directory, so a rule made in one worktree also holds in the others.

Rules and notes are read from the user file only. A project file that contains them gets an error for those keys, because a cloned repository must not be able to deny calls or write into the system prompt.

A note has no trace and is never checked. A note without `need` goes into the system prompt section, so it survives compaction without a message per turn. A note with `need` goes into the `prompt.submit` context block when that need first matches and again after each compaction while the need stays active. A note confirmed during a session is also sent once in the next context block, because the cached system prompt section only changes after a compaction or a new thread.

#### Where proposals come from

- Skills. Learning needs a user file (a session that is not set up reads nothing), a person at the prompt (`isInteractive`) and no pause. When the main session loads a skill Souffleur has not read before, a small model reads the text once and proposes at most three rules or notes that have a trace or are standing instructions. A version is the skill file at the load's `path` (read with `$.fs`, capped at 60,000 characters) together with the skill name and an extractor version, so arguments or command output in the computed text do not create new versions; without a path the computed text stands in. A version is marked in the plugin store under its own key, `souffleur:skill-hash:<hash>`: `{ "offers": n }` once its proposals were queued, and `{ "done": true }` when every one of them was answered (yes, no or a request to revise) or when nothing was left to ask because each proposal was known or declined. A queue that is dropped first (the session ends, `/clear`) leaves the version at `offers`, so the next load reads it again, up to three offers. A version whose proposals still wait in the session is not read again. A read that fails, gets no answer or an answer that does not parse stores a failure count, gives the session its read back, and is tried again on a later load until three failures. A read that finds the queue full leaves the version unmarked. Three failed reads or failed classifier runs in a row put an error in the session, so the status shows `degraded`; a good call clears it. At most five reads start per session (a `/clear` starts a new session with five more), at most twenty proposals wait in the queue and at most six of them come from skill texts. A proposal equal to an existing rule or a declined one is dropped. A slip or a user proposal is asked about before any skill proposal. `"learn": { "skills": false }` turns this source off.

  What the core does and what the adapter does. The core marks a main-session load: a load with a main `Skill` call or typed name announced before it, or any load while no subagent runs. `skill.prompt` has no `agentId`, so a load by a background subagent that runs while the main session loads nothing itself can be read as a main load; that is a known gap. The adapter reads the file, claims the version in the process, counts the read in the session under the serialised session update, then calls the small model after the hook has answered, with `timeoutMs: 30000`, so a slow or failing call cannot hold up or break `skill.prompt`.

  What reaches the user. The skill text is untrusted. The prompt wraps it in a tag with a random suffix and asks only for obligations the skill states about itself, as JSON. Each item goes through the same parser as an entry in the user file; on top of that a note from a skill is at most 300 characters, an item that mentions Souffleur or its tool is dropped, and the command of an `after` evidence must occur word for word in the skill text. Skills from the project or an MCP server are read only when the main root is in `trustProjects`. The proposals carry source `skill:<name>`; the dialog names the skill ("project skill ...", "plugin ..."), starts with "Read from a skill's text, not verified:", and offers this project first for a project skill. A request to revise such a proposal refers to it by id and does not quote it.
- Slips. Souffleur registers a tool, `souffleur_propose`, and the system prompt section asks the model to call it when something went wrong that a rule would have caught (a denial, a "would have denied" entry, a correction from the user). The main model knows what happened in the conversation; a small model reading events does not.
- The user. "Remember as a rule: ..." in chat goes through the same tool. `/souffleur rule <text>` does too: the small model shapes the text into a rule or note through `$.model.complete`, and if that fails the text is kept as a note. The command asks at once, because the user has just said what they want; handing the words to the main model would only reach it with the next prompt.

#### Asking

Proposals wait in a queue. On `turn.complete`, if the queue is not empty, Souffleur asks about the first one with `$.ui.ask`, Claude Code's own choice dialog: "Add rule: before Agent calls, dev-workflow is loaded?" with `Yes, everywhere`, `Yes, this project only`, `No`. The dialog shows the rule in its exact short form (`before Agent: skill dev-workflow loaded`), not a paraphrase. Text typed under "Other" goes to the main model in the next context block as a request to revise the proposal, whatever its source; the revision is asked about at a later turn end. One question per turn at most. A dismissed dialog leaves the proposal queued; `/souffleur` lists open proposals, and `/souffleur review` asks about them one by one. A declined proposal is remembered by its hash and not proposed again. Where `$.ui.ask` rejects (nobody can answer, as under `claude -p`), no dialog is tried again at turn end in that session: proposals stay queued, each is shown once as a notice at a turn end, and `/souffleur review`, `/souffleur accept <id>` or a reply word handle them in text. If the registered tool does not reach the model, the system prompt sentence about it is left out and `/souffleur rule` remains for the user's own rules.

Sessions that Remote Control starts for the desktop and mobile apps run as SDK sessions and report `isInteractive: false`. Souffleur therefore does not gate the question on `isInteractive`: it calls `$.ui.ask` at the end of every main-session answer while a proposal waits, and treats a rejection (nobody can answer, as under `claude -p`) as "no dialog here". At a turn end, a dialog without an answer after two minutes makes Souffleur show a notice for that proposal only; the session keeps asking about later proposals. The dialog stays open: if it is answered later while the proposal still waits, that answer is written like any dialog answer and disarms the reply. If the proposal already left the queue (the person replied first), the late answer is ignored. A person's prompts over Remote Control carry origin `bridge` (see `docs/compatibility.md`). Verified: a `$.ui.ask` dialog appeared in the desktop app over Remote Control (2026-11-25). Not verified: the dialog in the mobile app, and whether `$.ui.log` lines show on the remote client. A typed `/souffleur review` that cannot open its dialog inside the command lists the proposals in text, and at the end of the next turn Souffleur asks again, or shows the notice when no dialog can open.

Where no dialog opens, Souffleur shows the waiting proposal as a notice, and shows no further notice while one offer is still open (a turn end after a peer message or hand-back does not replace it): `Souffleur: proposal note-1a2b: <short form>. Reply "accept" (everywhere) or "decline".` A proposal read from a skill's text carries the caution `(read from a skill's text, not verified)`. The offer is armed only when the notice was written, so with notices off nothing can be answered by a reply. The person's very next prompt is checked before the model sees it, and any prompt of the person ends the offer, whatever it says; a message from a peer or a subagent hand-back does not. When the prompt's whole text, trimmed and lower-cased, is one of `accept`, `annehmen` or `decline`, `ablehnen`, and it comes from the person (origin `composer` or `bridge`, no typed command, never a peer, a subagent hand-back or the model), Souffleur applies it to the proposal it showed, shows the result as a toast and adds one line to the prompt's context saying so. If the write failed, the context line says the proposal stays queued. A paused session ignores replies. A reload (a second `session.start`) ends the offer, so a word typed after it does not act; the proposal stays queued, and the next turn end shows the notice again. A surface that drops `$.ui.log` without an error would still arm the reply; this residual risk is accepted because only the four words, as the very next prompt of the person, act. Three more limits are known and accepted. The record of shown notices and of a stopped dialog survives `/clear` (it is cleared by `session.start`, which `/clear` does not send), so a cleared session may show fewer notices than a new one. A prompt the person queued during a turn can answer a notice shown at that turn's end, because it is the very next prompt of the person. A reload asks again, because it clears the record of what was shown. When the notice is shown and the last prompt of the person had origin `sdk` in a session that reports `isInteractive: false` (`claude -p`), it names `/souffleur accept <id>` instead of the reply words. No new dialog and no new notice open while a notice waits for its reply; the offer stays until a prompt of the person ends it. Words such as `ja` or `yes` are not reply words, so an answer to the model's own question right after the notice never accepts. After a reply the next waiting proposal is asked about or shown at the next turn end. `accept` means everywhere; `/souffleur accept <id> here` stays for one project.

Confirmed rules and notes are written to the user file, `~/.claude/souffleur.json`, never to a project file, so what Souffleur learns about a user's way of working stays on their machine.

#### Approaches considered

| Approach | Trade-off |
|---|---|
| A small model in the mod does all of it | No cost in the main conversation, but it lacks the conversation, so it cannot tell why a slip happened. |
| The main model does all of it through the tool | Has the context, but reading every skill would cost tokens and context in the main conversation. |
| Mixed (chosen 2026-11-25) | The small model reads skills, which needs no conversation and happens once per version. Slips and the user's words go through the main model. Souffleur asks in both cases. |

### Subagents

The ledger, gates and duties cover the main session only (the user's choice on 2026-11-25). `skill.prompt` carries no agent id, but a Skill tool call does: a load the model asks for is preceded by a `tool.call` for the Skill tool, with `agentId` when a subagent made it. Souffleur counts a `skill.prompt` for the main session only when it follows a main-session Skill call for that skill, a typed `/name` (`command.run`), or arrives while no subagent is running. Anything else, such as a skill preloaded into a subagent, leaves the main ledger alone. A gate on a subagent's own writes could still not be lifted reliably, so subagents are not gated.

Instead Souffleur makes the main session decide, at the moment it hands work off, which skills the subagent needs. On `tool.call` for `Agent`, if the session has an active need, the brief must name the skills the subagent should load, or say `skills: none` for mechanical work that only carries out what was already written and checked. A brief without that line is denied once with a reason listing the configured skills and the active needs. Souffleur does not pick the skills itself; the main session knows whether the subagent writes new text or applies text that already exists.

### Setup and moving over

Install is one line at the prompt, `/plugin install skill-souffleur --marketplace r4KK4n/skill-souffleur`, which needs `.claude-plugin/marketplace.json` in the repository. The README describes install, a minimal config, the commands, `observe` and `enforce`, and how to switch Souffleur off again.

Setting up has two separate jobs, so there are two commands. `/souffleur init` decides how each skill should be kept. `/souffleur migrate` retires the user's own hooks that did that job before. Each command starts with a short paragraph saying what it is about, what it will ask, and what each answer does, so the user knows before the first question that `migrate` can remove hook entries.

On a session start without a user config, the status line says `not set up, run /souffleur init` and `/souffleur` explains it. Nothing is added to the conversation.

#### `/souffleur init`: how each skill is kept

`init` can run any time, not only after install: when a skill was added, removed or behaves differently. It asks about the skills in the user file, then the skills a user hook reloads, then up to ten more that one small-model call over all installed skill descriptions picks as worth watching. The other installed skills are named in the closing summary as not watched; a re-run asks about them only when picked. A skill configured only in a project file is listed with a note that `init` writes the user file and leaves it alone. One dialog per skill; for each it offers how Souffleur should keep it:

- `From the start`: needed from the first turn (`always`). Souffleur asks the model to load it at session start and after every compaction.
- `Loaded by its own plugin at start (rare)`: a plugin puts the text in at session start itself (`always` with `startup: "injected"`), for example with a hook that runs at session start. Souffleur counts it as loaded at startup and asks for it only after a compaction or a clear. Skills that a plugin merely lists, or that you invoke with the Skill tool, are not injected; picking this answer for them makes the ledger report a skill as loaded when it is not.
- `When the task needs it`: needed once a prompt matches a description (`need`). The dialog shows the proposed description; text typed under "Other" replaces it.
- `Don't watch`: no entry; an existing entry is removed. An entry that carries a hand-written `gate` or `duty` is not removed: `init` says so and leaves it for the user to edit.

`$.ui.ask` shows at most four answers plus "Other". The injected answer is offered only for plugin skills (`<plugin>:<skill>`) and comes last, never first unless it is the current setting; for the others the fourth answer is `Stop`. Closing a dialog also stops `init`, keeping the answers given so far; when the very first dialog cannot open, `init` falls back to the text output described below.

The recommended answer comes first. A user hook that reloads the skill on every start points to `From the start`; otherwise the small model's pick proposes `When the task needs it` with a need, or `Don't watch`. The mod API cannot show which plugin hook prints which skill text, so the injected answer is never recommended automatically: the user picks it, and the dialog explains it with an example. Whenever the result for a plugin skill is the injected answer (a new pick, a setting that stays as it was, or the recommendation in the no-dialog text), `init` reads every installed copy of the plugin: its `hooks/hooks.json` and the hooks declared in its `plugin.json`, found through `~/.claude/plugins/installed_plugins.json`. It then adds one line to the summary. With no `SessionStart` hook anywhere it is a warning that the status would report the skill as loaded when it is not. With a hook it is a note that Souffleur cannot tell whether the hook prints the skill, unless a hook command names the skill, which gives no line. When a file cannot be read, the line says Souffleur could not check. The current setting of a configured skill is shown first and kept when the user picks it again; changing the kind keeps any `gate` or `duty`.

For `When the task needs it`, the small model reuses an existing need only when the skill's description clearly says it serves that kind of task (`writing-guide` and `writing-check` share `prose`). Otherwise it proposes a new need, or none, which makes `Don't watch` the recommendation. A skill whose own description says it runs only on an explicit request (it starts with "Use only when", or says "only when the user asks" or "invoke only when explicitly") is never sent to the model and gets `Don't watch` as the recommendation. A description that only mentions explicit requests somewhere does not count. Text typed under "Other" for a skill on a shared need creates a new need for that skill, so the other skills keep their trigger. A need that no skill in the user file references after `init` is removed. Answers are written to `~/.claude/souffleur.json` as they come, keeping every other key.

At the end `init` says whether it found hooks or notes that overlap with the new entries and points to `/souffleur migrate`.

#### `/souffleur migrate`: retiring old reload hooks

`migrate` reads `~/.claude/settings.json` (hooks), the user and project `CLAUDE.md` and the current project's memory index. It flags a hook when its command or matcher names a configured skill. For an installed skill that is not configured, only the full `plugin:skill` name or the name inside a script file name counts, and the dialog marks it as a guess. A hook that runs a script (`.sh`, `.js`, `.mjs`, `.ts`, `.py`, or a file under `hooks/`) with `preload`, `reload` or `inject` in its name is flagged as a guess too. For each flagged hook it asks `Turn off`, `Keep` or `Show me what to do`. A hook counts as naming a skill firmly when a script file name or the full `plugin:skill` name contains it; a bare word in the command is only a guess. The hook lists every skill it names. When any of them is not in the user file, when the match is a guess, or when the hook names no skill at all, so that it may serve a skill of another project or a rules file, the question says that turning it off leaves that without reminders, and `Keep` comes first. Only skills of the user file count as watched. When a watched skill is `not installed here` in the current session, the report adds a note. `migrate` reads the config files again when it starts. `Turn off` copies `settings.json` to `settings.json.bak-souffleur-<date>-<time>` first (a name that is already taken gets a counter, so an older copy is never overwritten; one copy per run) and removes only that hook entry, and only when the file still holds what the edit was based on; settings hooks reload live. `Show me what to do` changes nothing and adds the manual steps to the closing report. Hook scripts and `CLAUDE.md` or memory text are never edited. It lists only passages that name a configured skill and read like a loading or reminding instruction (load, invoke, preload, reload, remind, hook), with file and line.

Without a dialog (`claude -p`), both commands print what they would ask, the config entries as JSON and the steps, and change nothing. Once rules and notes exist, `migrate` also queues the standing instructions it found as note proposals, with or without a dialog; they are asked at turn end or by `/souffleur review`. The queue lives in the session and does not survive it, except that a declined hash is kept in the plugin store.

### Audience

Every skill shapes output for someone. Souffleur records who, and says it whenever it asks for a skill, so a skill for one audience does not shape output for another (for example a writing-style skill for documentation does not change the replies in the chat).

| `for` | Who receives the output | Examples |
|---|---|---|
| `chat` | the person in this session | the agent's replies in the conversation |
| `readers` | people outside the chat who read a text | docs, specs, issue and PR texts, commit bodies, app copy |
| `users` | people who use the product | screens, pages, components, prototypes |
| `work` | nobody reads it; it shapes how the agent works | debugging, test-first, planning, review steps |

`for` sits on a need (`"prose": { "for": "readers", "what": "A text people outside this chat will read …" }`), because the skills of one need share its deliverable. An `always` skill has no need and carries `for` itself. The old string form of a need still works and counts as `work`, with a status hint to run `/souffleur init`. `/souffleur` lists needs and always-on skills without `for` under "Audience not set:" and names the config file to edit. Planned: `init` proposes `for` from the skill's description and warns when an always-on skill is `readers` or `users`; until then `for` is set by hand.

The load request groups skills by audience with a fixed sentence per value, for example: `writing-guide, writing-check: for texts other people read (docs, issues, PRs, app copy). Not for your replies in this chat.` Groups come in the order readers, users, work, chat, then the compaction sentence when it applies. When a `chat` skill is always on and the request holds a `readers` or `users` group, the last line is `Your replies in this chat follow <chat skill>.` The system prompt section says that each skill applies only to the output named with it, names the `chat` skill, and lists the other always-on skills as `Always-on skills: <names>.`

Needs start from the deliverable, not the topic. Planned (not built yet): the rest of this list and the reply check below. Today a need starts from the prompt classifier, one call per need.


- Planned: a `readers` or `users` need starts from tool evidence: a call its skills' gates match, or `gh issue create|comment`, `gh pr create|edit`, `git commit` for `readers`. No model call.
- Planned: per prompt, two classifier calls run in parallel instead of one per need. Call A asks what the agent will produce: `chat-reply`, `text-for-others`, `screen`, `code-or-repo-work`. Call B picks one `work` need or `none`, and counts only when A says `code-or-repo-work`. `chat-reply` starts nothing.
- Planned: a failed call counts as `chat-reply`. After three failures in a row the status shows `needs: degraded`, and each prompt carries one line listing the `work` needs so the main model can pick; the line stops with the first good answer. Each failure goes to the debug log with its kind.
- After a compaction, `chat` and `work` skills are requested on the next prompt; `readers` and `users` skills wait for the next deliverable signal.

Planned: adherence is checked for the `chat` skill only, without a model: on `turn.complete` with reason `answer`, the answer's length without code blocks and its count of heading lines are compared with `"reply": { "maxChars": …, "headings": … }` on that skill. A violation is counted in `/souffleur` and adds one line to the next prompt's context (at most once per five prompts). In `enforce`, two violations in a row mark the skill `stale`, so it is requested again. Nothing is denied; the answer is already shown.

A user-file skill can carry `"notIn": [<main repository root>, …]`: in those roots it is not needed, requested or gated, and `/souffleur` shows `excluded in this project`. A project file cannot switch off a user's skill.

A duty arms only on a call that changes a file (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`). A publish never opens a duty.

### Status

- `/souffleur` (or `/souffleur status`) prints the ledger: skill, state, since, reason, open duties.
- Active needs show as `prose (since 05:27)`. The prompt excerpt that started a need goes to the debug log only.
- "Would have denied" groups the entries by the first sentence of each line of the reason: a group of two or more prints `6× Agent brief without a "skills:" line (05:50–06:42)`, followed once by the full message of the newest entry, indented; a single entry prints `05:50 <full message>`.
- A need ends by itself after 20 user prompts in a row that the classifier ran on and did not match to it. A prompt of three words or fewer ("ja", "mach weiter") does not count as a miss, but a match on it still resets the count and can start a need. Skills that were only being restored for the ended need go back to `absent`. A need set with `/souffleur need` ends only with `/souffleur drop`. Ending a need writes a debug line, no notice.
- The status line shows a short summary, for example `observe · 4 loaded, 1 restoring`. Claude Code puts the plugin name in front of it.
- When the mod cannot read an event it expects (a renamed field, a missing event), the status line says `degraded, see /souffleur` and the command lists what failed.

### Notices

The status line shows only in the terminal. Users of the desktop and mobile apps, and anyone not watching it, learn what Souffleur did from short lines in the transcript. The core compares the session before and after each change (`src/core/notices.ts`); the adapter writes the lines with `$.ui.log`, which the user sees as a dim line and the model does not.

- Each notice starts with `Souffleur:`, is English, has at most two sentences, and fires once per event.
- Session start (fresh or resumed): version, mode, how many skills are always on and on demand, waiting proposals. Without a user file: `not set up, run /souffleur init`.
- After a compaction that cut or dropped tracked skills: `cut by compaction: <names>; will ask the model to reload them`. The line names only the skills Souffleur will ask for: needed, from a trusted file, and not paused. When every one of them is loaded again: `reloaded: <names>`.
- Problems, each once until it clears: a skill that did not load after two requests (not one that is only "not installed here": a project skill outside its project is normal), `degraded` with the reason (first line of the error, ASCII only, at most 120 characters), Claude Code newer than the verified version, an untrusted project file. When the last problem clears: `back to normal`.
- No notice for a denial: the denial already shows in the transcript.
- Only the main session gets notices, not subagents.
- `"notices": false` in the user file turns them off. A project file cannot change it.

The propose tool's server can disconnect between turns while the hooks keep running. On each user prompt the adapter checks `$.tool.list()`; when `souffleur_propose` is missing it registers the tool again. The line `Souffleur: tool reconnected` appears only when the tool was seen in the list and then went missing; a tool the list never showed is registered again silently, once per process. A failed registration leaves the system prompt sentence out, as at start.

### Failure handling

- A hook that throws passes the event through unchanged (the engine's default) and records the error for `/souffleur`. The error clears once the same step works again; each step has its own name, so another step's success does not clear it. Config errors and the small-model failure counts keep their own rules.
- The classifier failing or timing out means no new need for that prompt; existing needs stay.
- The adapter checks the Claude Code version at start and lists it in the status. Behaviour verified on other versions is named in `docs/compatibility.md`.

## Testing

- Core: unit tests over event sequences, including compaction in process, resume then compaction, a reload of the mod mid-session, a typed `/name`, a gate denial and retry, and a duty with and without evidence.
- Fixtures: event payloads recorded from real Claude Code sessions, with personal data removed.
- Adapter: `claude plugin validate` and `claude plugin test`, plus one scripted headless run (`claude -p --plugin-dir`) per release that loads a large skill, compacts, and checks that Souffleur restored it.

## To verify before or during the plan

1. Does the model reliably invoke the skills a context block names before other work? Measure on the models in use.
2. Does `skill.prompt` fire for the engine's own re-attachment after compaction? (In the first test it did not.)
3. Does `$.state` survive a reload of the mod and a resume, and does `$.store` keyed by session id cover the rest? The reload/resume split depends on this; the reload half is the `$.state` row in [compatibility.md](compatibility.md), not verified yet.
4. How does the status line render in the desktop and mobile clients?
5. Plugin skill names: is the `skill.prompt` key `terse:terse-mode` or `terse-mode`?

Items 1 to 5 were answered on 2.1.332, except the reload half of item 3; see [background.md](background.md). Item 4 was dropped: the status line is built for the terminal, and `/souffleur` shows the same everywhere. Items 7 to 10 were answered on 2.1.332 as well, with the evidence in [background.md](background.md#tests-for-rules-and-notes-claude-code-21332):

7. A tool registered with `$.tool.register` reaches the model in the main session, and the model calls it when the system prompt section asks.
8. One small-model call over a 43 KB skill text takes about 2 seconds and returns the requested JSON.
9. An automatic compaction fires `session.compact` with trigger `auto`. A `context` entry on a tool result reaches the model, which may still treat it as untrusted, so a restore request sent that way is a hint, and the gate in `enforce` stays the safety net.
10. `$.session.repo().root` gives the main working tree in a worktree session, and `$.vcs.detect` gives the worktree itself as `root`.

Still open:

6. Does `$.ui.ask` show its dialog in a Remote Control session in the desktop and mobile apps, and does it reject cleanly where nobody can answer? The dialogs of `init`, `migrate` and the turn-end question were tested with the test kit and in the desktop app's dialog. On 2026-11-25 the owner saw a `$.ui.ask` dialog in the desktop app over Remote Control; the mobile app is still open. The `init`, `migrate` and proposal dialogs have not yet run end to end in a live session.

## Left to the builder

- File layout inside `src/`, test runner choice (Node's built-in `node:test` unless something forces otherwise), TypeScript settings.
- Exact wording of the appended rows and denial reasons.
- The JSON schema check for the config, as long as it needs no runtime dependency.
