# Soul builder

`agent-bot soul build [PATH] [--check]` derives harness files from a soul
package (ADR-0332 decisions 4 and 8). With no PATH, the current Agent ID
(environment or worktree pin) resolves through `soulDirInfo` / `soulDirectory`,
including a registered, moved soul. It does not guess from the current harness
or use the current checkout as the soul directory. An explicit PATH needs no
identity or credentials.

## Rendering contract

`soul-builder.mjs` exports the pure `buildHarnessFiles(packageEntries)`:
entries have the shape returned by `readSoulPackageEntries`, with generated
paths excluded. Output is a UTF-8-byte-sorted `Map<path, Buffer>`. Rendering
uses only input content, normalizes text to LF, and never reads the registry,
environment, clock, credentials, filesystem or absolute host paths. Generated
input is ignored, and paths with traversal/control characters are refused.
The builder does not modify its inputs.

The fixed format-2 `GENERATED_HARNESS_PATHS`, marker and ignore list now live
in `soul-harness-contract.mjs`, re-exported by `soul-package.mjs` for existing
consumers. Their values are unchanged. `expectedGeneratedFiles` delegates to
the pure builder, without importing the disk/CLI layer.

## Harness output

Outputs are built for all supported consumers, independently of
`preferredHarnesses` (which is launch preference, not a build allowlist).
A native consumer receives no duplicate configuration folder.

| Harness | Instructions | Skills / generated folder |
| --- | --- | --- |
| Claude Code | Marked `CLAUDE.md` with `@AGENTS.md` | `.claude/skills/<name>/` |
| Gemini CLI | Marked `GEMINI.md` with `@AGENTS.md` | `.gemini/skills/<name>/` |
| Codex | Native `AGENTS.md` | No `.codex/` output; native skills need no harness translation |
| OpenCode | Native `AGENTS.md` | Uses shared `.claude/skills/`; no `.opencode/` output |
| Cursor | Native `AGENTS.md` | Uses shared `.claude/skills/`; no `.cursor/` output |
| Copilot CLI | Native instruction support | Uses shared `.claude/skills/`; no `.github/` output |
| Devin CLI | Claude-compatible consumer | Shared Claude output; no `.devin/` output |
| Muse | No verified definition adapter in this repo | No dedicated output; follow-up |

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
package validation. `--check` prints JSON `{drift, writes, removals}`, exits 1
for drift/conflicts, and never writes. Clean checks exit 0. New package homes
build after copying, before dependency installation and git initialization;
a failed build removes the half-created home.

Format 2 ignores only exact expected bytes. Editing a marked generated file
changes the revision until rebuilt; the marker cannot hide arbitrary authored
content. Build/rebuild leave the v2 revision unchanged. Format 1 still covers
all files, including generated output; there is no implicit format upgrade.

## Follow-ups

`mcp.json`, `tools.json` and `policy.json` are opaque package extensions in
`docs/soul-package.md`; no common machine-readable translation schema is
defined here. README placement snippets and hook JSON dialects do not define
such a schema. This builder generates no MCP/tool/policy JSON or TOML, and
adds no unknown JSON marker key. A follow-up must define the source schema,
verify each target's marker tolerance, and stay within the fixed v2 paths.
Muse's definition adapter and lossless ownership of opaque sibling assets
also need explicit contracts.
