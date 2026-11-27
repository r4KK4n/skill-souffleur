# Installing and updating

How to install Souffleur in the two supported ways, how updates reach you, and how signed releases work. Souffleur needs Claude Code 2.1.332 or later; it is verified on 2.1.332 and older versions are untested.

## Marketplace install

Type this at the prompt of a terminal session:

```
/plugin install skill-souffleur --marketplace r4KK4n/skill-souffleur
```

Claude Code asks whether to add the marketplace; answer `y`. It then asks for a scope: choose user to cover every project, or project for one repository. Souffleur starts with no configuration. Until you add one, the status line reads `not set up, run /souffleur init`. Souffleur then watches no skill, asks the model to load nothing and denies nothing. It still adds one sentence to the system prompt, registers the `/souffleur` command and the `souffleur_propose` tool, and keeps its session copy in the plugin store.

`/plugin` exists only in the terminal interface. In a Remote Control session from the desktop or mobile app it is not available ("Plugins aren't available in this environment"). Install from a shell on the machine that runs Claude Code instead:

```
claude plugin marketplace add r4KK4n/skill-souffleur
claude plugin install skill-souffleur@skill-souffleur --scope user
```

New sessions load it. A running session picks it up after `/reload-plugins` or a restart.

To update:

```
claude plugin marketplace update skill-souffleur
claude plugin update skill-souffleur@skill-souffleur
```

Restart Claude Code afterwards. Every change that users notice raises the plugin version, so the update finds it. If Claude Code is newer than the version Souffleur was checked on, `/souffleur` says so in one line.

## Folder install

An installed plugin reaches a running session only after `/reload-plugins` or a restart, and `/reload-plugins` is not available in Remote Control sessions. Claude Code also loads a plugin from a folder under `~/.claude/skills/` and watches that folder, so a running session reloads Souffleur when its files change (checked on 2.1.332, see [compatibility.md](compatibility.md)). Install it there from a release tag:

```
claude plugin uninstall skill-souffleur@skill-souffleur
git clone --branch v0.2.9 https://github.com/r4KK4n/skill-souffleur ~/.claude/skills/skill-souffleur
```

To move to a newer release:

```
cd ~/.claude/skills/skill-souffleur && git fetch --tags && git checkout <tag>
```

Every running session picks up the new version, usually within half a minute. Use release tags only, never `main`: a release with a fault would reach every running session at once. To go back, check out the previous tag. A session that was already running when the folder was created does not see it; start that one once more.

Use one install method, not both. While the marketplace plugin is installed, Claude Code does not load the folder at all: the installed plugin keeps the name `skill-souffleur`. The folder install keeps its own stored data. Copy the old store file if you want to keep it: in `~/.claude/plugins/store/`, the marketplace install writes `skill-souffleur_skill-souffleur-<hash>.json` and the folder install `skill-souffleur_skills-dir-<hash>.json`. Without the copy, skill texts are read again once, earlier proposals can come back (decline them again with `/souffleur decline <id>`), and a session resumed after the switch starts with an empty ledger.

## Uninstall

- Marketplace install: `claude plugin uninstall skill-souffleur@skill-souffleur`, or `/plugin uninstall skill-souffleur` in a terminal session.
- Folder install: `rm -rf ~/.claude/skills/skill-souffleur`.

Your `~/.claude/souffleur.json` stays where it is, and so does the backup of `settings.json` that `/souffleur migrate` makes.

## Update notice and automatic update

This is the only request Souffleur makes unasked. Once a day, in the background, it runs `git ls-remote --tags --refs https://github.com/r4KK4n/skill-souffleur` to read the tag list from github.com, and shows one line at the next session start: `Souffleur 0.2.4 is out (you run 0.2.3). /souffleur update installs it.` (`/plugin update installs it.` for the marketplace install). Only tags shaped `vX.Y.Z` count, and only a newer one than the version you run. The look-up never delays a session start, and a failed one stays silent and is tried again after a day. `/souffleur` shows the version, the newest release, when it was checked and the setting. `plugin.json` declares `github.com` as the one network host.

The setting `update` in `~/.claude/souffleur.json` (user file only):

- `"notify"` (default): the line above.
- `"auto"`: at session start, after the first line, Souffleur installs a newer release when its tag is signed by the key you list in `updateSigner`. It says `Souffleur updated to 0.2.4 (tag signed by your key).` A tag that is unsigned or signed by another key is not installed.
- `"off"`: no look-up and no line. Nothing then goes to github.com.

`auto` and `/souffleur update` also fetch from that repository URL, but only when you set `auto` or type the command. Everything else Souffleur sends goes through Claude Code's own model calls (see [data.md](data.md)).

```json
{
  "update": "auto",
  "updateSigner": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICzde8cPJHhfSqO03qNB2/1FCI8EsaNcuQwnZHdSMcR7"
}
```

`updateSigner` is a public SSH key line (one line, starting with `ssh-`, `ecdsa-` or `sk-`). It is user file only. Without it, `auto` shows the notify line plus `Set updateSigner to let auto install it.` and installs nothing.

`/souffleur update` installs the newest release now. With `updateSigner` set it verifies the tag first and refuses one that does not verify. Without `updateSigner` it installs the tag unsigned, because you asked, and the answer says `(unsigned; you asked for it)`. Running sessions pick the new version up at their next turn. An install happens only at a session start or through this command, and one session installs at a time: another session that finds a fresh lock skips (auto) or asks you to try again in a minute (command). The lock stops two installs at once but not a reload: a running session that hot-reloads during the few seconds of `git checkout` can load a mix of two versions, and a restart fixes it.

Both ways change only a folder install. They leave the folder alone, and say why, when it has uncommitted changes or when its checkout is not exactly a `vX.Y.Z` tag (for example your own commits or a branch). In a marketplace install, `/souffleur update` answers `run /plugin update`.

## Signed releases

The maintainer signs release tags with an SSH key. Tags from `v0.2.4` on carry that signature; `v0.1.0` to `v0.2.3` are unsigned. The public key:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICzde8cPJHhfSqO03qNB2/1FCI8EsaNcuQwnZHdSMcR7
```

Its fingerprint is `SHA256:SS2teSG68oM5wAd3RRTMgtRM8wOpQFBRfnI37qfa/1I`. To let `auto` install this repository's releases, paste the key line above as the value of `updateSigner`, as in the example.

To check a tag by hand, put this line into a file (`allowed_signers`) and point git at it:

```
souffleur namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICzde8cPJHhfSqO03qNB2/1FCI8EsaNcuQwnZHdSMcR7
```

```
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=allowed_signers verify-tag v0.2.9
```

The output names the same fingerprint. When Souffleur verifies a tag it writes that file into its own data folder each time, with your `updateSigner` as the key, and installs only the commit it verified. The key is also in [SECURITY.md](../SECURITY.md). The tag ruleset on GitHub blocks deletion and force pushes but does not require signatures, so the signature is what `auto` relies on.

A fork signs with its own key. Whoever runs a fork lists that key as `updateSigner`, and the update check still looks at this repository's tags unless the fork changes the URL in `src/mod/register.ts`.
