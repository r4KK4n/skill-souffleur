# Security policy

Souffleur hooks into Claude Code and reads session data on your machine. Review the code before you install it, the same as any other plugin you add to your setup. `src/mod/register.ts` is the place to start: it is the code that touches your machine. The software is provided as is, without warranty (see [LICENSE](LICENSE)).

## Supported versions

The newest release gets fixes. Older versions do not.

## Reporting a vulnerability

If you find a security problem, report it privately: open the [Security tab](https://github.com/r4KK4n/skill-souffleur/security) and choose "Report a vulnerability". Please do not open a public issue for it.

Include the skill-souffleur version, your Claude Code version (`claude --version`), your operating system, and the steps that reproduce the problem.

I use Souffleur myself and try to fix problems I can reproduce. It is a spare-time project, so there is no promised response time or guaranteed fix.

## What Souffleur can do on your machine

- Deny a tool call in `enforce` mode, and add text to your prompts and to the system prompt.
- Write `~/.claude/souffleur.json` after your answer in a dialog, and write `~/.claude/settings.json` (with a backup first) when you answer `Turn off` in `/souffleur migrate`.
- Send the text of a skill you load, up to 60,000 characters, to Claude Code's small model to propose rules. You can switch this off with `"learn": { "skills": false }`.
- Run `git` against `https://github.com/r4KK4n/skill-souffleur` once a day to look for a new release. With `"update": "auto"` and an `updateSigner` key it also checks out a newer release into a folder install.

[docs/data.md](docs/data.md) lists every read, write and store.

## Threat model in short

Souffleur treats these as untrusted: a file in a repository you open, the model, other sessions on your machine, and the update source.

- A repository file. A project's `.claude/souffleur.json` can only add skills and needs under names you do not use. It cannot set `mode`, `rules`, `notes`, `update` or `trustProjects`, and its gates and duties only report until you list that project in `trustProjects`. A cloned repository therefore cannot switch gates on, deny your calls or write into your system prompt.
- The model. It can propose a rule or note through `souffleur_propose`, but nothing is kept without your yes in a dialog or a reply you type. `/souffleur rule`, `review`, `accept`, `decline`, `block`, `unblock` and `update` act only when a person types them.
- Skill texts. The small model that reads a skill gets the text as data, and what it proposes goes through the same parser as your own config and is shown as "not verified". Skills from a project or an MCP server are read only for projects in `trustProjects`.
- Peer sessions and subagents. A message from another session or a subagent's hand-back cannot answer a proposal.
- Updates. See below.

`enforce` is advisory and is not a security boundary: a `Bash` redirect, an MCP file tool and a subagent's writes pass a `Write` gate.

## Signed updates

`"update": "auto"` installs a newer release only when its tag is signed by the SSH key you list as `updateSigner`. Souffleur resolves the tag once, verifies that object and checks out the commit it verified. An unsigned tag, a PGP-signed tag and a tag signed by another key are not installed. It never changes a marketplace install, and it leaves a folder install alone when it has uncommitted changes or is not on a release tag.

Tags from `v0.2.4` on are signed by the maintainer. Earlier tags are not. The public key and its fingerprint:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICzde8cPJHhfSqO03qNB2/1FCI8EsaNcuQwnZHdSMcR7
SHA256:SS2teSG68oM5wAd3RRTMgtRM8wOpQFBRfnI37qfa/1I
```

[docs/updates.md](docs/updates.md#signed-releases) shows how to use it and how to check a tag by hand. The GitHub tag ruleset blocks deleting and force pushing release tags but does not require signatures, so the signature is the check that counts.
