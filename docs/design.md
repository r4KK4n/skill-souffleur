# Design

Status: draft for review, 2026-11-25. Verified against Claude Code 2.1.322.

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

## Non-goals

- Judging whether the model applied a skill's style rules well. Souffleur guarantees "loaded" and "duty with a trace done"; it cannot grade prose.
- Writing or editing skills.
- Replacing Claude Code's own skill listing or its auto-invocation.
- Supporting Claude Code versions without the mod API.

## Anti-goals

These would make Souffleur a failure even if it technically works:

- Pasting full skill texts into every prompt.
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

JSON, so the mod needs no parser dependency. A user file `~/.claude/souffleur.json`, optionally merged with a project file `.claude/souffleur.json` (project entries win per skill).

```json
{
  "skills": {
    "chisle:chisle": { "always": true, "startup": "injected" },
    "humanizer": { "need": "prose" },
    "stop-slop": { "need": "prose" },
    "impeccable": {
      "need": "ui",
      "gate": { "tools": ["Write", "Edit", "Artifact"], "paths": ["**/*.html", "**/*.tsx"] },
      "duty": { "after": { "tools": ["Write"], "paths": ["**/*.html"] }, "evidence": { "tool": "Bash", "command": "impeccable.*detect" } }
    }
  },
  "needs": {
    "prose": "Writing text people read: docs, specs, plans, issues, UI copy.",
    "ui": "Designing or building something a user sees: screens, prototypes, mockups, components."
  }
}
```

A skill with `always` is needed from the first turn. A skill with `need` is needed once the classifier has matched that need in the session. `gate` and `duty` are optional.

The top-level `mode` key decides whether Souffleur may block anything. In `observe`, the default, Souffleur keeps the ledger, asks for restores and reports through `/souffleur`, but denies no tool call; `/souffleur` lists each call it would have denied. In `enforce`, gates and duties deny as described below. Only the user file can set `enforce`. A project file that sets it gets an error and the mode stays as the user file has it, so a cloned repository cannot switch gates on for whoever opens it.

### Ledger

One entry per configured skill, kept in `$.state` for the session and mirrored to `$.store` keyed by session id so a resume finds it.

| State | Meaning | Entered by |
|---|---|---|
| `absent` | never loaded in this session | start |
| `loaded` | full text in the context | `skill.prompt` with the full text |
| `stale` | was loaded, a compaction happened since | `session.compact` (after) |
| `restoring` | Souffleur asked for it, not yet seen | a `restore` action |

Each entry keeps `since`, `reason` (`always`, `need:ui from "build a login mockup"`, `loaded by user`), and the time of the last compaction it went through.

After any compaction every `loaded` skill becomes `stale`. Measuring which skills the engine re-attached in full is possible from the transcript but brittle, and re-invoking a needed skill is cheap compared with working without it. A `stale` skill that is not needed stays `stale` and costs nothing.

### Needs

- On every user prompt (`prompt.submit`, not prompts submitted by a plugin), the adapter asks the classifier once per configured need whether the prompt matches it. The calls run in parallel; the whole step has a budget of 1.5 s, after which it continues without a verdict.
- A matched need stays active for the rest of the session. Work on a prototype spans many prompts that do not mention it again; dropping the need after one unrelated prompt would bring back the original problem.
- `/souffleur need ui` and `/souffleur drop ui` let the user set or clear a need by hand.

### Restoring

When a needed skill is `absent`, `stale` or `restoring`, Souffleur acts on the user's prompt itself: the `prompt.submit` hook adds a short context block to that prompt naming the skills and asking the model to invoke each with the Skill tool before anything else. The model loads them as its first step in the same turn, and `skill.prompt` confirms each one. Souffleur never attaches a skill's text itself; the text always comes from the engine's own expansion. `$.prompt.submit({ text: "/<skill>" })` was ruled out: it queues a separate turn that runs after the user's prompt.

If the model skips the request, the gate is the backstop: the next gated step is denied until the skill is loaded. A skill still not seen after one more prompt shows as `restoring` in the status.

Restores run in config order with no size cap. Restoring humanizer, stop-slop and impeccable after a compaction adds roughly 80 KB. The code marks this as a shortcut: add a priority cap if measurements show restores pushing sessions into the next compaction early.

### Skills loaded without `skill.prompt`

Some skill text reaches the context through other paths: a plugin's own startup hook (Chisle injects its rules at startup), or the engine's re-attachment after compaction. Souffleur does not see these. A skill can set `"startup": "injected"` in the config; Souffleur then treats it as `loaded` at session start and `stale` after the first compaction, so it neither duplicates the startup text nor misses the loss.

Souffleur replaces the user's earlier preload and reload hooks. Removing those is part of adopting Souffleur; it does not run beside them.

### System prompt section

A short, stable section added through `prompt.compose`:

> Souffleur keeps track of skills in this session. If a message from Souffleur asks you to load skills, invoke each one with the Skill tool before you continue. Always-on skills: chisle:chisle.

It holds the rule and the `always` skills from the config, never the changing ledger, because sections are cached per thread and must not break the prompt cache.

### Gates and duties

- Gate: on `tool.call` for a configured tool and path, if a skill whose gate matches is needed and not `loaded`, deny with a reason that names the skill and says how to proceed. The model then loads it and retries. `/souffleur pause` turns gates off for the session.
- Duty: when a call matches `after`, Souffleur records an open duty. A later tool call matching `evidence` closes it. While a duty is open, the next call that matches the skill's gate (writing or publishing the next prototype file, for example) is denied with the duty named, which enforces it in the same turn without a paid turn of its own. An open duty at turn end is also listed in the context of the next user prompt.

### Subagents

The ledger, gates and duties cover the main session only (the user's choice on 2026-11-25). `skill.prompt` carries no agent id, so a skill a subagent loads cannot be told apart from one the main session loads, and a gate on a subagent's writes could not be lifted reliably.

Instead Souffleur makes the main session decide, at the moment it hands work off, which skills the subagent needs. On `tool.call` for `Agent`, if the session has an active need, the brief must name the skills the subagent should load, or say `skills: none` for mechanical work that only carries out what was already written and checked. A brief without that line is denied once with a reason listing the configured skills and the active needs. Souffleur does not pick the skills itself; the main session knows whether the subagent writes new text or applies text that already exists.

### Status

- `/souffleur` (or `/souffleur status`) prints the ledger: skill, state, since, reason, open duties.
- The status line shows a short summary, for example `souffleur: 4 loaded, 1 restoring`.
- When the mod cannot read an event it expects (a renamed field, a missing event), the status line says `souffleur: degraded, see /souffleur` and the command lists what failed.

### Failure handling

- A hook that throws passes the event through unchanged (the engine's default) and records the error for `/souffleur`.
- The classifier failing or timing out means no new need for that prompt; existing needs stay.
- The adapter checks the Claude Code version at start and lists it in the status. Behaviour verified on other versions is named in `docs/compatibility.md`.

## Testing

- Core: unit tests over event sequences, including compaction in process, resume then compaction, a reload of the mod mid-session, a typed `/name`, a gate denial and retry, and a duty with and without evidence.
- Fixtures: event payloads recorded from real Claude Code sessions, with personal data removed.
- Adapter: `claude plugin validate` and `claude plugin test`, plus one scripted headless run (`claude -p --plugin-dir`) per release that loads a large skill, compacts, and checks that Souffleur restored it.

## To verify before or during the plan

1. Does the model reliably invoke the skills a context block names before other work? Measure on the models in use.
2. Does `skill.prompt` fire for the engine's own re-attachment after compaction? (In the first test it did not.)
3. Does `$.state` survive a reload of the mod and a resume, and does `$.store` keyed by session id cover the rest?
4. How does the status line render in the desktop and mobile clients?
5. Plugin skill names: is the `skill.prompt` key `chisle:chisle` or `chisle`?

## Left to the builder

- File layout inside `src/`, test runner choice (Node's built-in `node:test` unless something forces otherwise), TypeScript settings.
- Exact wording of the appended rows and denial reasons.
- The JSON schema check for the config, as long as it needs no runtime dependency.
