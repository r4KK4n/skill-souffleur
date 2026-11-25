# Background

How Souffleur started, what the research found, and why it is built the way it is. Dates are when each step happened.

## 2026-11-24: the problem

During a two-day Claude Code session that designed a UI prototype, several skills stopped working after the context was compacted, although they had been loaded earlier:

- A token-saving skill came back as a one-line reminder instead of its full rules, and answers got long again.
- The writing skills (humanizer, stop-slop) were no longer applied to the prototype's text.
- The UI design skill's detector stopped running from the seventh prototype version on.

Four small shell hooks were supposed to prevent this. Each reacted to keywords or file names, and each checked "already loaded?" by searching the whole transcript. The transcript still contains the load from before the compaction, so the hooks stayed silent while the skill text was already gone from the context. The user had to ask again and again whether a skill was still active.

## 2026-11-25: research

### Other users report the same

About 30 issues in [anthropics/claude-code](https://github.com/anthropics/claude-code/issues) from July 2025 to November 2026 describe rules or skills lost after compaction or resume. They fall into three groups:

1. CLAUDE.md rules followed less after compaction. Claude Code now re-reads the project CLAUDE.md from disk after compaction, so the text is back, but reports of ignored rules continue.
2. The list of available skills dropped after compaction ([#74990](https://github.com/anthropics/claude-code/issues/74990)). Fixed in Claude Code 2.1.304.
3. The text of skills already used in the session. Still open: bodies come back cut to 5,000 tokens per skill and 25,000 in total ([#82144](https://github.com/anthropics/claude-code/issues/82144)), and a skill used before a resume is not re-attached at all ([#94564](https://github.com/anthropics/claude-code/issues/94564)).

Workarounds people report: a `SessionStart` hook with matcher `compact`, the `reloadSkills` hook output, and telling Claude to call the Skill tool again. Plain reminder text injected by hooks works for some and not for others. `PostCompact` hook output did not reach the model after automatic compaction.

### Existing tools

No tool found tracks which skills a session needs, which are loaded, and which a compaction dropped. The closest:

- [diet103/claude-code-infrastructure-showcase](https://github.com/diet103/claude-code-infrastructure-showcase): keyword and path rules in `skill-rules.json`, a hook that blocks edits until a required skill is loaded.
- [obra/superpowers](https://github.com/obra/superpowers): re-injects one bootstrap skill on startup, clear and compact.
- Forced-evaluation hooks that make the model answer yes or no for each skill before it starts. One author measured 80 to 100 percent activation with them against about 20 percent with plain suggestions, on older Haiku and Sonnet models.
- Several young routers that match skills by local embeddings.

### Tests on Claude Code 2.1.322

A test skill of 43 KB with marker lines at its start and end:

| Scenario | Result |
|---|---|
| Skill loaded, then `/compact` in the same process | Re-attached, cut at exactly 20,000 characters with a truncation note. The model could no longer see the end marker. |
| Skill loaded, session resumed, then `/compact` | Not re-attached at all. |
| Skill invoked again after compaction | Full 43 KB text, end marker visible. |
| `SessionStart` hook with source `compact` | Runs before the compaction boundary is written to the transcript, so it cannot read what was lost. |
| Typed `/name` command | Fires `UserPromptExpansion`, not `UserPromptSubmit`. |

A second test used Claude Code's mod API (in-process plugins, early access):

| Question | Result |
|---|---|
| Does `skill.prompt` see every skill load? | Yes, including skills the model invoked on its own. |
| Does `session.compact` fire around a compaction? | Yes, before and after. |
| Does a system prompt section added by a mod survive `/compact`? | Yes. The model quoted it after compaction. |
| How fast is `$.model.classify` with the default small model? | About 800 ms per prompt. It labelled "build me a login screen mockup" as `user-interface`. |

## Decision

Souffleur is built as a Claude Code mod. Hooks only see the transcript after the fact; a mod sees skill loads and compactions as they happen, can keep a short ledger in the system prompt where compaction does not touch it, can classify a prompt with the built-in small model, and can show its state in the client. The mod API is early access and changes between releases, so the rules and the ledger live in plain code with no dependency on it, and only a thin layer talks to the API.
