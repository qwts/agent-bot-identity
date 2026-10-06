# Soul builder

`agent-bot soul build [PATH] [--check] [--json]` derives harness files from a
soul package (ADR-0332 decisions 4 and 8; #378 adds the MCP entry). With no
PATH, the current Agent ID (environment or worktree pin) resolves through
`soulDirInfo` / `soulDirectory`, including a registered, moved soul. It does not
guess from the current harness or use the current checkout as the soul
directory. An explicit PATH needs no identity or credentials.

## Rendering contract

`soul-builder.mjs` exports the pure `buildHarnessFiles(packageEntries, {
authored })`: entries have the shape returned by `readSoulPackageEntries`,
with generated paths excluded. Output is a UTF-8-byte-sorted `Map<path,
Buffer>`. Rendering uses only input content, normalizes text to LF, and never
reads the registry, environment, clock, credentials, filesystem or absolute host
paths. Generated input is ignored, and paths with traversal/control characters
are refused. The builder does not modify its inputs.

`authored` is the optional merge base for the MCP files: the bytes already at
each rendered MCP path, supplied by the disk layer, so a soul that ships its own
MCP config keeps its servers and a rebuild over the builder's own output
reproduces it byte for byte. Every other output is a function of the package
entries alone.

The fixed format-2 `GENERATED_HARNESS_PATHS`, marker and ignore list now live
in `soul-harness-contract.mjs`, re-exported by `soul-package.mjs` for existing
consumers. `expectedGeneratedFiles` delegates to the pure builder, without
importing the disk/CLI layer. `.mcp.json` and `opencode.json` joined the list in
#378; `.codex/config.toml` and `.gemini/settings.json` were already covered by
the `.codex/` and `.gemini/` prefixes.

## Harness output

Outputs are built for all supported consumers, independently of
`preferredHarnesses` (which is launch preference, not a build allowlist).
A native consumer receives no duplicate configuration folder.

| Harness | Instructions | Skills / generated folder | MCP (#378) |
| --- | --- | --- | --- |
| Claude Code | Marked `CLAUDE.md` with `@AGENTS.md` | `.claude/skills/<name>/` | `.mcp.json` |
| Gemini CLI | Marked `GEMINI.md` with `@AGENTS.md` | `.gemini/skills/<name>/` | `.gemini/settings.json` |
| Codex | Native `AGENTS.md` | No `.codex/skills/` output; native skills need no harness translation | `.codex/config.toml` |
| OpenCode | Native `AGENTS.md` | Uses shared `.claude/skills/`; no `.opencode/` output | `opencode.json` |
| Cursor | Native `AGENTS.md` | Uses shared `.claude/skills/`; no `.cursor/` output | None yet |
| Copilot CLI | Native instruction support | Uses shared `.claude/skills/`; no `.github/` output | None yet |
| Devin CLI | Claude-compatible consumer | Shared Claude output; no `.devin/` output | None yet |
| Muse | No verified definition adapter in this repo | No dedicated output; follow-up | None yet |

"None yet" means no adapter in this slice, not that the harness lacks the
capability: `soul build --json` names every harness and lists the primitives it
received, so a missing adapter is visible in the report. A later slice adds the
adapter (and fills in `unsupported` for what a harness cannot honor at all).

The ACP registry contains Claude, OpenCode, Muse and disabled Codex launch
rows; it deliberately omits Cursor/Copilot. Launch enablement does not control
rendering. `hook-dialects.mjs` already documents Devin's shared Claude settings;
`sync-hooks.mjs` owns lifecycle hook configuration and remains separate from
soul definition rendering.

Format evidence: [Claude imports](https://code.claude.com/docs/en/memory),
[Gemini imports](https://geminicli.com/docs/cli/gemini-md/) and
[skills](https://geminicli.com/docs/cli/skills/),
[OpenCode skill discovery](https://opencode.ai/docs/skills/),
[Cursor skill compatibility](https://cursor.com/docs/skills), and
[Copilot skill compatibility](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills).

SKILL.md retains YAML front matter at the start; its marker is the first line
following the closing delimiter. Markdown/text siblings are copied with a
leading marker. Shell/Python/Ruby scripts, JavaScript/TypeScript, CSS, TOML and
YAML siblings receive a syntax-appropriate comment; interpreter lines remain
first. Source executable bits are retained on disk. Subdirectories are copied
recursively through the entry inventory.

JSON, binary and unknown sibling formats remain intact in `skills/`: generated
SKILL.md lists relative pointers to those source files. They are not prefixed
or silently converted into invalid native files. Skills using these assets
should resolve the listed source location rather than assume every asset was
copied into the native folder. Broader lossless sibling replication needs an
ownership contract for files that cannot carry a marker.

## The soul's MCP entry (#378)

One server, in the registered placement the daemon already documents: the reach
and agent-comms channel, `agent-bot reach-mcp`, the same subcommand the drive
engine injects for a daemon-run turn. The command is `agent-bot` from PATH —
every install adds it — never an absolute machine path, so one package renders
the same bytes on every host.

| File | Entry |
| --- | --- |
| `.mcp.json` | `"mcpServers": { "agent-bot": { "command": "agent-bot", "args": ["reach-mcp"] } }` |
| `.gemini/settings.json` | `"mcpServers": { "agent-bot": { "command": "agent-bot", "args": ["reach-mcp"] } }` |
| `.codex/config.toml` | `[mcp_servers.agent-bot]` with `command` and `args` |
| `opencode.json` | `"mcp": { "agent-bot": { "type": "local", "command": ["agent-bot", "reach-mcp"] } }` |

**Identity is the working directory's, not the file's.** The registered
placement takes the soul from `git config agentBot.agentId` (or `qwts.agentId`)
in the directory the harness runs in — the same rule `resolveReachIdentity`
applies to a hand-configured desktop harness. So a soul opened by hand in its
own bound worktree (`.soul-state/home`, or any checkout `setup-worktree` pinned)
is the soul; in a directory with no pin the server refuses every tool and says
so, rather than reaching as anyone. No env is stamped into these files: the
injected placement's `AGENT_BOT_REACH_*` stamps are per-invocation daemon state
and must not be baked into a package.

The entry is rendered unless the package's `soul.json` says `comms: false`
(absent means on, as everywhere else) — `agent-bot soul comms <soul> off` is
what turns it off, and the next build removes the files.

Every rendered MCP file carries the marker: TOML with a leading `#` comment
like any other marked text file, JSON as the object's first `_comment` string,
the header position `hasMarker` already requires. Both need the harness to
tolerate the extra key; the paths are registered in the generated-path contract
so the build still owns the file either way.

### Merging a soul's own MCP config

A soul that ships one of these files keeps everything it declared. The builder
adds or overwrites only its own `agent-bot` entry and leaves every other server,
key, table and comment verbatim: JSON is merged object-wise, and TOML is merged
by section — only the `[mcp_servers.agent-bot]` table and its sub-tables are
replaced, because this repository parses no TOML. The result is the builder's
file (marked, rewritten on every build), so a rebuild over its own output is a
no-op. Content that cannot be merged into — invalid JSON, a JSON array, binary
bytes — is refused with a named error and never overwritten; an unmarked file at
any other generated path is still a conflict.

`--check` reports every merge as `{path, harness, kept}` in `merged`, naming
the servers the soul's own file declared.


## Writing and checking

`soul-build.mjs` inventories eligible paths without following symlinks and
preflights the complete build before any mutation. An unmarked file that would
be overwritten is a conflict (exit 1), even if it quotes the marker elsewhere
in its body. A marker must occupy the generated header position, optionally
following front matter or an interpreter line. Unmarked unrelated files at
eligible paths are preserved. Marked stale files are removed only at eligible
paths, and their now-empty generated parents are pruned.

Every build rewrites its outputs by exclusive temporary-file creation and
atomic rename. Conflict detection precedes writes and deletions. The whole
build is not one filesystem transaction: interrupted writes are repaired by a
rebuild. Use a quiescent directory; concurrent writers are unsupported, as for
package validation. `--check` never writes and exits 1 for drift/conflicts;
clean checks exit 0. Without `--json` the command prints a short human summary
(counts, each merge, and the primitives every harness received); `--json`
prints `{drift, writes, removals, merged, harnesses}`, where `harnesses` maps
each known harness to `{rendered, files, unsupported}` — `unsupported` is empty
in this slice and is where a later slice reports a primitive a harness cannot
honor. New package homes build after copying, before dependency installation
and git initialization; a failed build removes the half-created home.

Format 2 ignores only exact expected bytes. Editing a marked generated file
changes the revision until rebuilt; the marker cannot hide arbitrary authored
content. Build/rebuild leave the v2 revision unchanged. Format 1 still covers
all files, including generated output; there is no implicit format upgrade.

One exception is worth knowing: for a soul that ships its **own** MCP config,
the merged file holds more than the pure builder can derive from package entries
alone, so it is not exact expected bytes and therefore participates in the
revision (stably — a rebuild reproduces it byte for byte). Letting
`readSoulPackageEntries` pass generated-path entries into the pure builder would
close that gap.

## Follow-ups

Subagents, commands and hooks (#378's later slices) declare one way in the soul
and are rendered the same way; `unsupported` is where they report a harness
that cannot take them. MCP adapters for Cursor, Copilot, Devin and Muse are not
in this slice.

The rendered entry is named `agent-bot`; the daemon's injected entry and
`reachPolicyRules()` name the same server `agent-reach`, so a
policy-checked daemon turn sees the rendered copy under a name its rules do not
cover, and a harness that loads both files mounts one server twice under two
names. Reconciling the name (or teaching the launcher that a rendered entry
exists) belongs with the daemon and executor changes this slice does not touch.

`mcp.json`, `tools.json` and `policy.json` are opaque package extensions in
`docs/soul-package.md`; no common machine-readable translation schema is
defined here, and README placement snippets and hook JSON dialects do not define
one. A follow-up must define that schema, verify each target's marker tolerance,
and stay within the fixed v2 paths. Muse's definition adapter and lossless
ownership of opaque sibling assets also need explicit contracts.
