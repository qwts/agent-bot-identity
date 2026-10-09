# Soul builder

`agent-bot soul build [PATH] [--check] [--json]` derives harness files from a
soul package (ADR-0332 decisions 4 and 8; #378 adds MCP, subagents, commands and hooks).
With no PATH, the current Agent ID (environment or worktree pin) resolves through
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

`authored` is the optional merge base for MCP, settings and hook files: the bytes already at
each rendered MCP, settings or hook path, supplied by the disk layer, so a soul that ships its own
MCP config keeps its servers and a rebuild over the builder's own output
reproduces it byte for byte. Other output is a function of the package
entries alone.

The fixed format-2 `GENERATED_HARNESS_PATHS`, marker and ignore list now live
in `soul-harness-contract.mjs`, re-exported by `soul-package.mjs` for existing
consumers. `expectedGeneratedFiles` delegates to the pure builder, without
importing the disk/CLI layer. `.mcp.json` and `opencode.json` joined the list in
#378; `.codex/config.toml` and `.gemini/settings.json` were already covered by
the `.codex/` and `.gemini/` prefixes. The harness adapters slice appended
`.github/agents/`, `.kiro/agents/` and `.kiro/settings/mcp.json` (Cursor's and
Devin's files sit under the existing `.cursor/` and `.devin/` prefixes), and
#247 appended `.qwen/settings.json`.

## Harness output

Outputs are built for all supported consumers, independently of
`preferredHarnesses` (which is launch preference, not a build allowlist).
A native consumer receives no duplicate configuration folder.

| Harness | Instructions | Skills / generated folder | MCP (#378) | Subagents | Commands | Hooks |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | Marked `CLAUDE.md` with `@AGENTS.md` | `.claude/skills/<name>/` | `.mcp.json` | `.claude/agents/<name>.md` | `.claude/commands/<name>.md` | `.claude/settings.json` `hooks` |
| Gemini CLI | Marked `GEMINI.md` with `@AGENTS.md` | `.gemini/skills/<name>/` | `.gemini/settings.json` | Unsupported | `.gemini/commands/<name>.toml` | Unsupported |
| Codex | Native `AGENTS.md` | Native skills; no duplicate output | `.codex/config.toml` | Unsupported | Unsupported | `.codex/hooks.json` |
| OpenCode | Native `AGENTS.md` | Uses shared `.claude/skills/` | `opencode.json` | `.opencode/agent/<name>.md` | `.opencode/command/<name>.md` | Unsupported |
| Cursor | Native `AGENTS.md` | Uses shared `.claude/skills/`; no duplicate skills | `.cursor/mcp.json` | `.cursor/agents/<name>.md` | Unsupported (replaced by skills) | `.cursor/hooks.json` |
| Copilot CLI | Native instruction support | Uses shared `.claude/skills/`; `.github/` only for hooks and agents | Shared `.mcp.json` | `.github/agents/<name>.agent.md` | Shared `.claude/commands/<name>.md` | `.github/hooks/agent-bot-soul.json` |
| Devin CLI | Claude-compatible consumer | Shared Claude skills; `.devin/` only for agents | Shared `.mcp.json` | `.devin/agents/<name>.md` | Shared `.claude/commands/<name>.md` (imported as skills) | Shared `.claude/settings.json` |
| Muse | No verified definition adapter in this repo | No dedicated output; follow-up | None yet | Unsupported | Unsupported | Unsupported |
| Kiro | Native `AGENTS.md` | Uses shared `.claude/skills/` | `.kiro/settings/mcp.json` | `.kiro/agents/<name>.md` | Unsupported (format undocumented) | Unsupported |
| Qwen Code | Native `AGENTS.md` | None yet (`.qwen/skills/`) | `.qwen/settings.json` | None yet (`.qwen/agents/`) | None yet (`.qwen/commands/`) | Unsupported |

"None yet" and "Unsupported" describe adapters in this slice, not a claim
that a harness lacks the capability. Subagents and commands without adapters
are explicitly listed under `unsupported` in the build report. A "Shared" cell
is a file another harness's adapter writes that this harness's docs say it reads
natively; it is filled only on that evidence (below), never inferred from shared
skills.

The ACP registry contains Claude, OpenCode, Muse and disabled Codex launch
rows; it deliberately omits Cursor/Copilot. Launch enablement does not control
rendering. `hook-dialects.mjs` already documents Devin's shared Claude settings;
`sync-hooks.mjs` owns lifecycle hook configuration in each harness's user
directory, and the builder owns soul-declared hooks in the soul's own project
files (see [Hooks](#hooks-378-slice-3)).

Format evidence: [Claude imports](https://code.claude.com/docs/en/memory),
[Gemini imports](https://geminicli.com/docs/cli/gemini-md/) and
[skills](https://geminicli.com/docs/cli/skills/),
[OpenCode skill discovery](https://opencode.ai/docs/skills/),
[Cursor skill compatibility](https://cursor.com/docs/skills), and
[Copilot skill compatibility](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills).

Adapter evidence (official docs read 2026-10-07):

- Cursor: [MCP](https://cursor.com/docs/mcp) — project `.cursor/mcp.json`,
  `mcpServers` with `command`/`args`; [subagents](https://cursor.com/docs/subagents) —
  project `.cursor/agents/<name>.md` with `name`, `description`, `model`,
  `readonly`, taking precedence over the Claude-compatible `.claude/agents/`
  it also reads. Commands: the old commands page now redirects to
  [migrating commands to skills](https://cursor.com/help/customization/skills#how-do-i-migrate-commands-to-skills),
  so no current command format is documented.
- Copilot CLI: [MCP](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) —
  project `.mcp.json` (or `.github/mcp.json`), loaded once the folder is trusted;
  [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) —
  commands as `.md` files in `.claude/commands/`, and custom agents from
  `.github/agents/` before `.claude/agents/`;
  [create custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli)
  (`.agent.md`); [tool aliases](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
  accept Claude's tool names case-insensitively and ignore unknown names.
  Checked with Copilot CLI 1.0.90 in a trusted scratch folder: `copilot mcp list --json`
  showed the rendered, marked `.mcp.json` as one `agent-bot` workspace server, and
  `copilot skill list --json` listed a rendered `.claude/commands/` file.
- Kiro: [MCP configuration](https://kiro.dev/docs/mcp/configuration/) — workspace
  `.kiro/settings/mcp.json` with `mcpServers` (IDE and CLI);
  [custom agents](https://kiro.dev/docs/custom-agents/) and the
  [configuration reference](https://kiro.dev/docs/custom-agents/configuration-reference/) —
  workspace `.kiro/agents/<name>.md` (Markdown and the `read`/`write`/`shell`/`web`
  tool tags are new in Kiro CLI 3.0 / IDE 1.0; workspace agents load only in a
  trusted workspace). [Prompts](https://kiro.dev/docs/cli/chat/manage-prompts/)
  live in `.kiro/prompts/`, but their file name and metadata format is not
  documented, so commands stay unsupported.
- Devin CLI: [configuration import](https://docs.devin.ai/cli/reference/configuration/read-config-from) —
  imports Claude's `.mcp.json` MCP servers and `.claude/commands/**/*.md` as skills
  (it also imports `.cursor/mcp.json` and `opencode.json`, which carry the same
  `agent-bot` entry); [subagents](https://docs.devin.ai/cli/subagents) — project
  `.devin/agents/<name>.md` with `name`, `description`, `model`, `allowed-tools`
  (a restriction on a subagent profile); tool names `read`, `edit`, `grep`,
  `glob`, `exec` and MCP tools as `mcp__<server>__<tool>`, from
  [permissions](https://docs.devin.ai/cli/reference/permissions) and the
  [skill `allowed-tools` reference](https://docs.devin.ai/cli/extensibility/skills/creating-skills)
  (checked 2026-10-09).
- Gemini CLI: [subagents](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md)
  are documented in `.gemini/agents/*.md`, but their only switch is
  `experimental.enableAgents`, so they are not documented as stable and stay
  unsupported here.

- Qwen Code (docs read 2026-10-08 at QwenLM/qwen-code `29aef7d`):
  [MCP](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/mcp.md) —
  project scope `.qwen/settings.json` with `mcpServers`, the same stdio
  `command`/`args` entry; [memory](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/memory.md) —
  reads `QWEN.md` and an existing `AGENTS.md`. Its project skills
  (`.qwen/skills/`), agents (`.qwen/agents/`) and commands (`.qwen/commands/`)
  are documented but not rendered yet (#247 is MCP only). The settings file
  also carries the soul's own Qwen settings, so only `mcpServers.agent-bot` is
  the builder's and every other key is merged through. Checked with Qwen Code
  0.25.0: `qwen mcp list` in a directory holding the rendered file, `_comment`
  marker included, lists `agent-bot: agent-bot reach-mcp (stdio)` as *pending
  approval*. Qwen asks before it starts a project-scoped server, so the first
  session in a soul home approves it once (`qwen mcp approve agent-bot`).

**Unverified:** Cursor and Kiro were not run (both CLIs need a sign-in), so
whether they tolerate the leading `_comment` marker key in `.cursor/mcp.json` and
`.kiro/settings/mcp.json` is unverified, as for Cursor's hook file. Copilot CLI's
tolerance was checked (above).

SKILL.md retains YAML front matter at the start; its marker is the first line
following the closing delimiter. Markdown/text siblings are copied with a
leading marker. Shell/Python/Ruby scripts, JavaScript/TypeScript, CSS, TOML and
YAML siblings receive a syntax-appropriate comment; interpreter lines remain
first. Source executable bits are retained on disk. Subdirectories are copied
recursively through the entry inventory.

A skill named in soul.json `skills.disabled` renders nothing at all (no
`SKILL.md`, no siblings, no Gemini copy) while its `skills/<name>/` directory
stays in the package; `rendered` lists `skills` only when some skill rendered.
See [soul-package.md](soul-package.md#manifest-schema).

JSON, binary and unknown sibling formats remain intact in `skills/`: generated
SKILL.md lists relative pointers to those source files. They are not prefixed
or silently converted into invalid native files. Skills using these assets
should resolve the listed source location rather than assume every asset was
copied into the native folder. Broader lossless sibling replication needs an
ownership contract for files that cannot carry a marker.

## Declaring subagents and commands (#378, slice 2)

Declare a subagent in `agents/<name>.md`, using Claude Code agent front matter:

```markdown
---
name: review
description: Review code for correctness
tools: Read, Grep, Bash
model: provider/model
---
Review the proposed change and explain any concrete defects.
```

`name` and `description` are required. `name` must match the filename stem;
like skill names, stems use lowercase letters, digits and single hyphens,
with a maximum of 64 characters. Nested declarations, traversal and control
characters are refused. Agents and commands may share a name because their
rendered paths differ. `tools` and `model` are optional. Omitting them leaves
the target harness defaults in effect; a declared model is copied verbatim,
so authors must choose a model identifier usable by their target harnesses.

Claude receives the original front matter and prompt, with LF normalization
and the generated marker immediately after the closing delimiter. OpenCode
receives `description`, `mode: subagent`, and `model` when declared. Its `tools`
map disables unlisted tools (`"*": false`) and enables the declared names in
lowercase (`Read` → `read`, `Bash` → `bash`, `MultiEdit` → `edit`). Tool names
may be a comma-separated string, an inline YAML list, or an indented YAML list;
an empty inline list disables all tools. Permission expressions such as
`Bash(git:*)` are refused rather than widened into unrestricted tools.

Declare a command in `commands/<name>.md`:

```markdown
---
description: Review a change
argument-hint: "[path]"
---
Review $ARGUMENTS and summarize the findings.
```

The front matter and both fields are optional. Claude retains the declaration,
including its opaque `argument-hint`; an empty front-matter block is omitted.
OpenCode receives only `description` when present and the prompt with `$ARGUMENTS` unchanged. Gemini receives TOML `description`
when present and `prompt`, replacing every `$ARGUMENTS` with `{{args}}`.
Strings are escaped as TOML basic strings, preserving multiline prompts,
quotes and backslashes. `argument-hint` has no translation in these adapters.

Translated scalar fields support plain strings, single/double quotes, and
literal (`|`) or folded (`>`) blocks with optional `-`/`+` chomping. Quote YAML
punctuation in scalar values. Duplicate fields, invalid strings, unsupported
translated YAML constructs, and malformed front matter fail the build. Other
Claude-specific fields remain in Claude's copy; they are not translated.
These adapters remain dependency-free and do not implement general YAML.

### Native subagent files for Cursor, Copilot CLI, Kiro and Devin CLI

Each receives `name`, `description` and, when declared, `model` (verbatim) as
JSON-quoted YAML strings, then the marker and the prompt. Only `tools` differs:

| Harness | Declared `tools` | No `tools` |
| --- | --- | --- |
| Cursor | No per-tool allowlist: `readonly: true` when every tool is read-only (`Read`, `Grep`, `Glob`, `LS`, `NotebookRead`, `WebFetch`, `WebSearch`, `TodoWrite`) or the list is empty; otherwise Cursor's defaults apply | Omitted |
| Copilot CLI | `tools:` the Claude names verbatim (documented aliases; unknown names are ignored, which narrows) | Omitted (all tools) |
| Kiro | `tools:` category tags: `Read`/`Grep`/`Glob`/`LS`/`NotebookRead` → `read`, `Edit`/`MultiEdit`/`Write`/`NotebookEdit` → `write`, `Bash` → `shell`, `WebFetch`/`WebSearch` → `web`, `Task` → `subagent`, `TodoWrite` → `todo_list` | `tools: ["*"]` (the default is undocumented) |
| Devin CLI | `allowed-tools:` `Read` → `read`, `Edit`/`MultiEdit`/`Write` → `edit` (Devin has no `write` tool; `edit` covers file writes), `Grep` → `grep`, `Glob` → `glob`, `Bash` → `exec`; an MCP tool `mcp__<server>__<tool>` keeps its exact name | Omitted (all tools) |

A declared tool Kiro or Devin has no name for (for example an MCP tool for
Kiro, or `WebFetch` for Devin) means that subagent is not rendered for that
harness and is listed under its `unsupported.subagents`, never widened or cut
down. Devin spells MCP tools as Claude does and reads the shared `.mcp.json`, so
a declared `mcp__<server>__<tool>` keeps its exact name; the declaration grammar
admits no `*`, so no server-wide grant is produced. A server name containing
`__`, or an empty server or tool, is ambiguous and stays unsupported. Kiro's
tags are categories, so `Read` grants Kiro's whole read category (reading,
listing, searching). Devin's subagents default to its subagent model rather
than the parent's when `model` is omitted. Cursor and Copilot CLI also read the
Claude copy in `.claude/agents/`; the native file has the same name and wins.

Each harness report adds `subagents` and `commands`, each containing
`{received: [names], rendered: [names]}`. The existing `rendered` primitive
list gains these kinds only when files were generated for that harness;
`files` includes their paths. `unsupported` is
`{subagents: [names], commands: [names]}`: every received name the harness did
not render, so an empty list for a fully supported or undeclared kind. All name
lists are byte-sorted; Copilot's `.agent.md` suffix is not part of the name. For example, Gemini reports
`subagents: {received: ["review"], rendered: []}` and
`unsupported: {subagents: ["review"], commands: []}` for the examples above.
The `.claude/`, `.gemini/` and `.opencode/` prefixes cover the files of that
slice, and `.cursor/` and `.devin/` Cursor's and Devin's agents. Copilot's and
Kiro's agent folders were appended to the generated-path list (below).

## Settings (#379)

Declare shared defaults in `soul.json` under `harness`, with field-by-field
per-harness overrides in the top-level `harnesses` object:

```json
{
  "harness": {
    "model": "shared-model-id",
    "reasoningEffort": "medium",
    "permissionMode": "safe"
  },
  "harnesses": {
    "claude": { "model": "sonnet" },
    "codex": { "model": "gpt-5", "reasoningEffort": "high" },
    "opencode": { "model": "provider/model", "permissionMode": "autopilot" }
  }
}
```

Both objects are optional. Each settings object accepts only `model` (a
nonempty string), `reasoningEffort` (`low`, `medium`, `high`),
`permissionMode` (`safe`, `autopilot`, the same mode names as `soul mode`),
`env`, and `permissions` (both below). Overrides replace only declared fields;
omitted fields inherit shared defaults.
Model IDs are copied verbatim, so use overrides for harness-specific IDs.
The supported override names are `claude`, `codex`, `gemini`, `opencode`,
`cursor`, `copilot`, `devin`, and `muse`. Unknown names, unknown settings keys,
and invalid values fail package validation with their full declaration path.
Other top-level manifest extensions retain their existing opaque behavior.

| Harness / file | Model | Reasoning effort | Permission mode: safe / autopilot | Env | Allow / deny rules | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code / `.claude/settings.json` | `model` | `effortLevel` | `permissions.defaultMode`: `default` / `bypassPermissions` | `env` | `permissions.allow` / `permissions.deny` | `env.ANTHROPIC_BASE_URL` (endpoint only) |
| Codex / `.codex/config.toml` | `model` | `model_reasoning_effort` | `approval_policy`: `on-request` / `never`; `sandbox_mode`: `workspace-write` / `danger-full-access` | `[shell_environment_policy.set]` | Unsupported | `model_provider` + `[model_providers.<id>]` |
| Gemini / `.gemini/settings.json` | `model` | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported |
| OpenCode / `opencode.json` | `model` | Unsupported | `permission.edit` and `permission.bash`: `ask` / `allow` | Unsupported | `Bash`, `Bash(…)` → `permission.bash`; `Edit` / `Write` / `MultiEdit` → `permission.edit` | `provider.<id>` with `{env:KEY}` |
| Cursor, Copilot, Devin, Muse, Kiro | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported |

`provider` (`harnesses.<h>.provider`, [soul-providers.md](soul-providers.md))
renders the non-secret half only; the secret itself is stored with
`agent-bot soul secret` and injected at launch, never written by the builder.

Claude's installed 2.1.290 settings schema describes `effortLevel` as
“Persisted effort level for supported models.” The builder uses that native
key; it does not create a `reasoningEffort` key in Claude settings. Support is
an adapter capability, independent of whether a particular model honors effort.

**Launch-time model selection wins.** The per-soul model selected with
`agent-bot soul model` or GeniusBar's model picker (GeniusBar #128) overrides
the package's model at launch. This builder writes portable defaults only;
it does not change `soul-model.mjs`, the daemon, or launch-time model state.

Settings render independently of `comms`; turning comms off does not disable
settings. Only declared, supported keys are written. Authored settings supplied
through `authored` retain unrelated keys, nested permission entries, and MCP
servers. The declaration replaces its corresponding native keys. JSON carries
the usual first `_comment` marker; TOML carries a leading comment marker and
keeps unrelated statements, comments and tables in order. Codex settings are
root keys, so similarly named keys in profiles remain untouched. Rebuilding
with the same declaration over the builder's own output is byte-identical;
text is normalized to LF. Invalid JSON or incompatible nested permission
objects are refused rather than discarded.

`harnessReport(output, { manifest, comms })` takes the source manifest explicitly
so even declarations unsupported everywhere can be reported without hidden
Map metadata. Each harness adds `settings: {received: [keys], rendered: [keys]}`
and `unsupported.settings: [keys]`, with byte-sorted keys after applying its
overrides. `soul build --check --json` includes these fields; `rendered` gains
`settings` when at least one setting was rendered and `files` includes its path.
The `.claude/`, `.codex/`, `.gemini/` prefixes and `opencode.json` already cover
these files; the fixed generated-path list and its order are unchanged.

### Environment and permission rules (slice 2)

```json
{
  "harness": {
    "env": { "LOG_LEVEL": "debug" },
    "permissions": { "allow": ["Bash(git:*)", "Edit"], "deny": ["Bash(rm *)", "Read(./.env)"] }
  },
  "harnesses": { "codex": { "env": { "LOG_LEVEL": "info" } } }
}
```

`env` maps names matching `^[A-Z_][A-Z0-9_]*$` to string values. An override's
`env` merges per variable over the shared `env`: a variable it names takes the
override's value, every other shared variable is kept, and none can be removed.
**Secrets never go in a soul.** Validation refuses any name with the word
`TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`, `API_KEY`, `APIKEY`,
`CREDENTIAL(S)` or `AUTH` between underscores or at either end (any case;
`TOKENIZER_MODE` and `AUTHOR_NAME` pass), and any value that looks like a credential: a `ghp_`/`github_pat_`,
`sk-`, `xox?-`, `glpat-`, `AKIA` or `AIza` token, a `-----BEGIN` key, a hex run
of 32 or more characters, or a 32-character base64 run mixing digits and both
cases. Errors name the path, never the value. Credentials are referenced by
name (soul.json `credentials`, see [soul-package.md](soul-package.md)) and
resolved at launch.

`permissions` holds `allow` and/or `deny` lists of rules in Claude Code's
`Tool` / `Tool(pattern)` syntax, the portable form: nonempty, no duplicates
within a list, and deny wins when a rule is in both. An override replaces each
list it declares (`[]` clears it) and inherits the other.

Claude Code takes both verbatim. Codex applies `shell_environment_policy.set` to
the commands it runs. OpenCode gets the rules its config can spell: bare `Bash`
is the `*` pattern, a legacy `prefix:*` becomes both `prefix` and `prefix *`,
and since OpenCode applies the last matching pattern, a `permissionMode` `*`
comes first and every deny last. Bare `Edit`, `Write` and `MultiEdit` set
`permission.edit`, `deny` if any is denied. Every other rule, everywhere, is
listed in the report rather than dropped. No harness gets a `.env` file.

On merge, declared variables replace their own names in Claude's `env` and in
a Codex `[shell_environment_policy.set]` table (rebuilt at the end of the
file); other authored variables stay. A declared rule list replaces Claude's
native list; `ask`, `defaultMode` and other permission keys stay. OpenCode's
`permission.bash` / `permission.edit` are replaced when a rule renders there.
A non-object `env`, a root or inline `shell_environment_policy.set`, or a
nested `[shell_environment_policy.set.*]` table is refused.

Verified against: the settings schema in the installed Claude Code 2.1.290
binary (“Environment variables to set for Claude Code sessions”; “List of
permission rules for allowed/denied operations”); Codex 0.160.0, whose
`ShellEnvironmentPolicyToml` has `set` (a map) and whose `codex sandbox` showed a
rendered `set` variable in the child environment; and OpenCode 1.18.34, whose
bundled config reference documents per-pattern `bash`/`edit` objects with
last-match-wins and whose `opencode debug config` accepted the rendered file.
Gemini CLI is not installed and no settings key for env is documented here, so
env is unsupported for it.

The report adds `env` / `permissions` to `settings.received` and
`settings.rendered` (OpenCode renders `permissions` only when at least one rule
maps), and `unsupported.permissions`: `[{effect, rule}]` for each rule a harness
did not render, allow before deny in declared order.

Additional sandbox controls and other native settings are later slices; hooks
are declared as files, below. Existing authored values for those keys are
preserved during a merge.

## The soul's MCP entry (#378)

One server, in the registered placement the daemon already documents: the reach
and agent-comms channel, `agent-bot reach-mcp`, the same subcommand the drive
engine injects for a daemon-run turn. The command is `agent-bot` from PATH —
every install adds it — never an absolute machine path, so one package renders
the same bytes on every host.

| File | Entry |
| --- | --- |
| `.mcp.json` | `"mcpServers": { "agent-reach": { "command": "agent-bot", "args": ["reach-mcp"] } }` |
| `.gemini/settings.json` | `"mcpServers": { "agent-reach": { "command": "agent-bot", "args": ["reach-mcp"] } }` |
| `.codex/config.toml` | `[mcp_servers.agent-reach]` with `command` and `args` |
| `opencode.json` | `"mcp": { "agent-reach": { "type": "local", "command": ["agent-bot", "reach-mcp"] } }` |
| `.cursor/mcp.json` | `"mcpServers": { "agent-reach": { "command": "agent-bot", "args": ["reach-mcp"] } }` |
| `.kiro/settings/mcp.json` | `"mcpServers": { "agent-reach": { "command": "agent-bot", "args": ["reach-mcp"] } }` |
| `.qwen/settings.json` | `"mcpServers": { "agent-reach": { "command": "agent-bot", "args": ["reach-mcp"] } }` |

Copilot CLI and Devin CLI read the shared `.mcp.json` natively, so they get no
file of their own; their report lists `mcp` with `.mcp.json`.

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
adds or refreshes its own `agent-reach` entry and leaves every other server,
key, table and comment verbatim: JSON is merged object-wise, and TOML is merged
by section — only the `[mcp_servers.agent-reach]` table and its sub-tables are
replaced, because this repository parses no TOML. The result is the builder's
file (marked, rewritten on every build), so a rebuild over its own output is a
no-op. Content that cannot be merged into — invalid JSON, a JSON array, binary
bytes — is refused with a named error and never overwritten; an unmarked file at
any other generated path is still a conflict.

`--check` reports every merge as `{path, harness, kept}` in `merged`, naming
the servers the soul's own file declared.


## Hooks (#378, slice 3)

Declare a hook as an executable file in `hooks/<event>/<name>`, the same
folder contract as the toolkit's [agent-hooks](../agent-hooks/README.md): one
script per file, run in lexicographic order (`10-` before `50-`), reading the
normalized envelope on stdin or the `AGENT_HOOK_*` environment mirror, and
answering with its exit status (0 allow, 2 deny with stderr as the reason) or an
`agent-hook: {"decision": …}` line. Fail mode belongs to the event, not the
hook, exactly as there.

```text
hooks/
  README.md                         optional; documents the folder
  pre-command/50-no-force-push      chmod +x
  session-start/10-greet.sh         chmod +x
```

The events are the harness events of `CANONICAL_EVENTS`: `session-start`,
`session-end`, `prompt-submit`, `pre-tool-use`, `pre-command`,
`pre-file-write`, `post-tool-use` and `agent-stop`. `spawn` (the daemon's
own), `pre-commit` and `pre-push` (served by the git layer, not a harness) are
refused, because a soul hook on them would never fire. Names follow the
primitive grammar (lowercase letters, digits, single hyphens) with one optional
extension such as `.sh`, at most 64 characters. A file without its executable
bit, a nested directory, an unknown event or a malformed name fails the build:
the runner skips non-executables, so accepting one would be a hook that
silently never runs.

Why files rather than a `hooks` block in `soul.json`: a hook is code, and the
package already carries code as files (skills, agents, commands) with its
executable bit preserved through revisions, forks and home copies. A block in
`soul.json` would put command strings (and the temptation of inline tokens) in
the manifest every revision hashes and every export ships. **Keep secrets out
of hook scripts:** they are package content like any other file. A hook that
needs a credential reads it at run time from the soul's credential store or the
environment, never from bytes in the package.

### What is rendered

One native entry per declared event, in each harness whose
[hook dialect](../hook-dialects.mjs) can express it. Every entry runs the
vendor-neutral runner over the soul's own folder, so each harness hands the
script the same envelope and reads the same verdict:

```sh
D="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; B=agent-bot; command -v "$B" >/dev/null 2>&1 || { echo "agent-bot is not on PATH; soul pre-command hooks did not run" >&2; exit 2; }; AGENT_BOT_HOOKS_DIR="$D/hooks" exec "$B" agent-hook --event pre-command --dialect claude # agent-bot soul hook
```

Only the Claude row reads `CLAUDE_PROJECT_DIR` (another harness started from a
Claude shell inherits it); the others use the git top level, which in a soul's
home is the package root. `agent-bot` comes from PATH like the MCP entry, so the
bytes are the same on every host. Without it, a blocking event exits 2 (deny)
and a non-blocking one exits 0, so a missing runner never fails open. Entry
shapes, matchers, timeouts and Cursor's `failClosed` flag come from
`nativeHookEntry` in `hook-dialects.mjs`, the same function `sync-hooks.mjs`
uses for the lifecycle adapters.

| Harness | File | Notes |
| --- | --- | --- |
| Claude Code, Devin CLI | `.claude/settings.json` `hooks` | Shares the file with rendered settings; Devin CLI reads it natively |
| Codex | `.codex/hooks.json` | Hooks need `[features] hooks = true`, which the user-level policy `sync-hooks` writes |
| Cursor | `.cursor/hooks.json` | `version: 1`; blocking events carry `failClosed: true` |
| Copilot CLI | `.github/hooks/agent-bot-soul.json` | A dedicated file; other `.github/hooks/*.json` files stay the soul's |
| Gemini CLI, OpenCode, Muse, Kiro | None | No dialect row yet (OpenCode hooks are JS plugins); every hook is listed under `unsupported.hooks` |

Cursor's and Copilot's project hook files, like their `hook-dialects.mjs` rows,
assume the harness tolerates the leading `_comment` marker key; Cursor's row is
marked unverified there.

### Who owns what

- **Soul-declared hooks** are the builder's: entries whose command ends in
  `# agent-bot soul hook` (`SOUL_HOOK_MARKER`), in the soul's project files above.
- **Identity lifecycle hooks** stay with `sync-hooks.mjs`: entries marked
  `agent-bot agent-hook` (`MANAGED_MARKER`) in each harness's *user* directory,
  running the toolkit's own `agent-hooks/`. The soul builder never writes them.
- Neither recognizer matches the other's entries (the soul command spells the
  runner as `"$B" agent-hook --event …` so it never contains `MANAGED_MARKER` or
  `agent-hook --dialect`), and `sync-hooks` explicitly skips soul entries.
- **Every other entry** in a shared file is the soul's: kept verbatim, in place,
  with event keys in their original order. Only the builder's own entries are
  replaced, so a rebuild over its output is byte-identical. An authored hook file
  is merged the way an authored MCP file is (named in `merged`); invalid JSON, a
  non-object `hooks`, or a non-array event is refused and never overwritten.
- When a declaration goes away, its entries go with it. A file that held only
  builder entries is removed (with any empty parents, such as `.github/hooks/`);
  a merged file keeps the soul's own entries.

Both runners check confinement, so a soul with hooks reports a confined write
from each of the two entries on the same event.

### Report

Each harness adds `hooks: {received, rendered}` and `unsupported.hooks`, with
hook names spelled `<event>/<name>` and byte-sorted; `rendered` gains `hooks`
and `files` includes the hook file when at least one hook rendered. A harness
whose dialect cannot express an event lists that event's hooks under
`unsupported.hooks` rather than dropping them. The plain summary prints the
same: `gemini: instructions, mcp (unsupported: hooks pre-command/50-no-force-push)`.

`.claude/`, `.codex/` and `.cursor/` already cover their hook files. Copilot's
`.github/hooks/agent-bot-soul.json` is appended to the format-2 ignore list
(exactly that file, not `.github/hooks/`). A soul carrying the list from before
this slice still validates; see [soul-package](soul-package.md).

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
prints `{drift, writes, removals, merged, warnings, harnesses}`, where `harnesses` maps
each known harness to `{rendered, files, subagents, commands, settings, hooks, unsupported}`
as described above. New package homes build after copying, before dependency
installation and git initialization; a failed build removes the half-created home.
An existing home is rebuilt before each launch, so a soul made by an earlier
release gains what the builder renders now; a conflict there is reported on the
daemon's stderr and the launch proceeds. A format-2 soul carrying an ignore list
an earlier release wrote (before `.mcp.json` and `opencode.json`, 0.10.25,
before Copilot's soul hook file, or before the adapters slice's
`.github/agents/`, `.kiro/agents/` and `.kiro/settings/mcp.json`, or before
#247's `.qwen/settings.json`) still validates; only an unknown list is refused. The list names only those folders,
so a soul's other files in `.github/`, `.kiro/` or `.qwen/` (workflows,
steering, Qwen skills) stay its own; files it authors in `.github/agents/` or `.kiro/agents/` are kept on
build, but, like `.claude/`, are not copied out of a template.

Format 2 ignores only exact expected bytes. Editing a marked generated file
changes the revision until rebuilt; the marker cannot hide arbitrary authored
content. Build/rebuild leave the v2 revision unchanged. Format 1 still covers
all files, including generated output; there is no implicit format upgrade.

One exception is worth knowing: for a soul that ships its **own** MCP or settings config,
the merged file holds more than the pure builder can derive from package entries
alone, so it is not exact expected bytes and therefore participates in the
revision (stably — a rebuild reproduces it byte for byte). Letting
`readSoulPackageEntries` pass generated-path entries into the pure builder would
close that gap.

## Follow-ups

Not yet covered: Muse (MCP, subagents, commands, hooks); subagents for Codex
and for Gemini CLI (until `.gemini/agents/` is documented as stable); commands
for Codex, Cursor (replaced by skills) and Kiro (`.kiro/prompts/` file format
undocumented); hooks for Gemini CLI, OpenCode (plugins), Muse and Kiro; a
signed-in check that Cursor and Kiro accept the `_comment` marker key; and
mapping MCP tool names into Kiro's and Devin's subagent tool lists; Qwen Code
skills, subagents and commands.

The renderer, injected entry and `reachPolicyRules()` now share the
`agent-reach` name through `reach-contract.mjs`. Rebuilds remove the old
`agent-bot` entry only when the file has the generated marker and the entry
still has exactly the generated command/arguments. Modified legacy entries
are preserved. A custom `agent-reach` entry is a conflict: the builder refuses
before writing any output, rather than replacing its configuration. Rename
that custom entry explicitly before rebuilding. Existing user permission
rules or prompts naming `mcp__agent-bot__...` must be updated to
`mcp__agent-reach__...` when they refer to the generated reach server; a
custom server named `agent-bot` can still be intentional. The builder does
not rewrite user-authored policies.

With comms enabled, `soul build` and `soul build --check` report
`legacy-reach-tool-name` warnings for these references in definition text
and native configuration inputs. JSON output includes a `warnings` array
with `code`, package-relative `path`, one-based `line`, and a migration
message. The warning never includes the matching line's contents. Locations
refer to inputs read before the build; generated instruction/skill copies
are not scanned again. Binary content is skipped. These are advisory
references to review, not proof that an authored rule is invalid. Warnings
alone do not change the exit status or count as generated-file drift;
comms-off builds do not suggest migrating a server they do not render.

[Codex ACP's session configuration](https://github.com/zed-industries/codex-acp/blob/296069e841634cd4bb9bc4515602d836e49231ec/src/codex_agent.rs#L335)
merges injected entries into the configured server map by name for both new
and loaded sessions, so the injected invocation context wins without a second
name. [Claude Code's scope contract](https://code.claude.com/docs/en/mcp#scope-hierarchy-and-precedence)
says duplicate names connect once. These source contracts and deterministic
migration/policy fixtures establish the name reconciliation; they do not
prove every supported adapter's live mount precedence. Signed-in duplicate
mount checks across the harness matrix remain part of #378/#379.

`mcp.json`, `tools.json` and `policy.json` are opaque package extensions in
`docs/soul-package.md`; no common machine-readable translation schema is
defined here, and README placement snippets and hook JSON dialects do not define
one. A follow-up must define that schema, verify each target's marker tolerance,
and stay within the fixed v2 paths. Muse's definition adapter and lossless
ownership of opaque sibling assets also need explicit contracts.
