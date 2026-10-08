# Soul providers and `soul secret`

A soul declares which model provider each of its harnesses talks to, and
which secret that provider needs ([ADR-0583](decisions/ADR-0583-the-soul-root-owns-the-environment.md)
decision 7). The builder renders the provider's non-secret configuration
into the soul's harness files; the owner stores the secret once with
`agent-bot soul secret`; the daemon reads it back at every launch and sets
it in the launched harness's environment and nowhere else. Two souls on
the same Mac can run the same harness against different providers with
nothing installed or configured on the host: one Codex soul on GitHub
Models with a GitHub token, one Codex soul on OpenAI with an OpenAI key.

```sh
agent-bot soul secret <agentId|name> set <name> [--json] [--principal-stdin]    # value on stdin
agent-bot soul secret <agentId|name> clear <name> [--json] [--principal-stdin]
agent-bot soul secret <agentId|name> status [--json]
```

## Declaring

```json
{
  "harnesses": {
    "codex": {
      "provider": { "id": "github", "baseUrl": "https://models.github.ai/inference", "credential": "github-models" }
    }
  },
  "credentials": {
    "secrets": { "github-models": { "store": "keychain" } }
  }
}
```

`harnesses.<h>.provider` is strict: `id`, `baseUrl`, `envKey`, `wireApi`
and `credential`, nothing else.

- `id` is one of the ids the harness documents (below). An unknown id, or a
  provider under a harness that has no provider rendering (`gemini`,
  `kiro`, …), fails package validation with the field path.
- `baseUrl` is the endpoint. It is required where the provider has no
  fixed endpoint (`github`, `*-compatible`) and optional where it does. It
  must be `https://`; `http://` is accepted for `localhost`, `127.0.0.1`
  and `[::1]` only, and never with credentials in the URL.
- `envKey` is the variable the harness reads the secret from. It defaults
  per provider (`OPENAI_API_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`),
  must match `^[A-Z][A-Z0-9_]*$`, and may not be a name the launch owns
  (`HOME`, `PATH`, `CODEX_HOME`, …, or any `AGENT_BOT_*`, `QWTS_*`, `XDG_*`,
  `UV_*`).
- `wireApi` is Codex only: `responses` (the default for `openai`) or `chat`
  (the default for `github` and `openai-compatible`).
- `credential` names a `credentials.secrets.<name>` entry. A name the soul
  does not declare fails validation. Without `credential`, the harness runs
  with whatever its own sign-in gives it; nothing is injected.

`credentials.secrets.<name>` sits beside `credentials.github` (the App key,
[soul-credentials.md](soul-credentials.md)) and accepts `store` only:
`keychain` (the macOS default), `file` (the default elsewhere; DPAPI on
Windows) or `pass-cli`. `keyd` is not a secret store: keyd never returns a
value, and a provider secret has to be in the harness's environment. A
name is `^[a-z][a-z0-9-]{0,63}$`. The value is never in `soul.json`; a
`harnesses.<h>.env` entry that looks like a key is still refused by
[validation](soul-builder.md#environment-and-permission-rules-slice-2).

### Provider ids

| Harness | `id` | `envKey` default | `baseUrl` | Rendered |
| --- | --- | --- | --- | --- |
| Codex | `openai` (default) | `OPENAI_API_KEY` | optional | `model_provider` + `[model_providers.openai]`, `wire_api = "responses"` |
| Codex | `github` | `GITHUB_TOKEN` | required | `[model_providers.github]`, `wire_api = "chat"` |
| Codex | `openai-compatible` | `OPENAI_API_KEY` | required | `[model_providers.openai-compatible]`, `wire_api = "chat"` |
| Claude Code | `anthropic` (default) | `ANTHROPIC_API_KEY` | optional | `env.ANTHROPIC_BASE_URL` when `baseUrl` is set; nothing otherwise |
| Claude Code | `anthropic-compatible` | `ANTHROPIC_API_KEY` | required | `env.ANTHROPIC_BASE_URL` |
| OpenCode | `openai` (default), `anthropic` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | optional | `provider.<id>.options.baseURL` and `apiKey: "{env:KEY}"` when `baseUrl` or a credential is set |
| OpenCode | `github`, `openai-compatible` | `GITHUB_TOKEN`, `OPENAI_API_KEY` | required | `provider.<id>` with `npm: "@ai-sdk/openai-compatible"` |

## What the builder renders

`agent-bot soul build` writes the non-secret half, and `--check` reports a
changed provider as drift like any other generated setting. For the
declaration above, `.codex/config.toml` gets:

```toml
# <!-- agent-bot soul-builder: generated -->
model_provider = "github"

[mcp_servers.agent-bot]
…

[model_providers.github]
name = "GitHub"
base_url = "https://models.github.ai/inference"
env_key = "GITHUB_TOKEN"
wire_api = "chat"
```

An authored `.codex/config.toml` keeps its other tables; its own
`[model_providers.<id>]` table for the declared id is replaced whole, and
an inline `model_providers = { … }` cannot be merged and fails the build.
Claude Code gets `env.ANTHROPIC_BASE_URL` in `.claude/settings.json` only
when there is an endpoint to name (its key is read from the environment,
not from settings), and OpenCode gets a `provider.<id>` block in
`opencode.json` whose `apiKey` is the `{env:KEY}` reference OpenCode
resolves at runtime. No rendered file ever holds the value; the builder
has no access to it. `harnessReport` lists `provider` under
`settings.received` and, where something was written, `settings.rendered`.

## Storing the secret

```sh
printf '%s' "$TOKEN" | agent-bot soul secret billy set github-models
agent-bot soul secret billy status
agent-bot soul secret billy clear github-models
```

- The value arrives on stdin and nowhere else: never on argv (which every
  local process can read), never echoed, never in a log, a receipt or a
  journal. Trailing newlines are the shell's and are dropped; an empty
  value or one with control characters is refused (`secret-value-invalid`).
- `set` and `clear` are owner actions, gated like `soul revision edit`: a
  soul-marked caller is refused, the owner's presence or consent is asked
  otherwise. With `--principal-stdin`, stdin carries one JSON object
  `{ "principal": …, "value": "…" }` for `set` and the principal credential
  alone for `clear`, since stdin carries one thing.
- The value goes to the declared store under a service and account
  namespaced by soul id and secret name: Keychain service
  `agent-bot.soul.<agentId>`, account `secret/<name>`; file store
  `.soul-state/credentials/secret-<name>.json` (0700/0600, owner-checked;
  `.dpapi` on Windows); Proton Pass note `agent-bot.soul.<agentId>/secret/<name>`.
  A soul copied to another machine carries a file-store secret with its
  folder; a Keychain or Pass secret is stored again there.
- Each `set` and `clear` appends an audit receipt `soul-secret` with the
  operation, the decision (`stored`, `cleared`, `absent`) and
  `secret: <name> (<store>)`. Never the value, never its length.
- `status` is read-only and says `present` or `missing` per declared
  secret and `ready`, `secret-missing` or `unsupported` per provider, with
  the fixing command. `--json` prints `{ schemaVersion, agentId, soulDir,
  providers[], secrets[], invalid[], ready }`, every key always present.
- A name the soul does not declare is refused (`secret-not-declared`): the
  declaration is the soul's, in a revision; the value is the owner's.

## At launch

Every turn, the daemon reads the launched harness's provider secret from
the soul's store and sets `envKey` in that harness process's environment.
The reach MCP server and keyd's relay are spawned from the same turn env
with that variable removed, and the reach server's entry carries
`AGENT_BOT_REACH_STRIP_ENV=<envKey>`, so a harness that merges its own
environment into every MCP child still leaves the server without it (the
server drops the named variables from its own environment, and so from
any child of its own, before it serves). A harness that is launched with
no provider declared gets nothing injected and nothing stripped.

A launch of a soul whose provider names a secret runs a `provider` stage
before the soul joins. A secret that is not stored fails the launch with
`provider-secret-missing` and the `agent-bot soul secret <id> set <name>`
command; a store that cannot answer fails with
`provider-secret-unreadable`; a declaration the engine refuses fails with
`provider-declaration-invalid`. The value never reaches the launch
journal, a receipt or the daemon's log. `agent-bot soul env` reports the
same as `providers { declared[], secrets[], invalid[] }`, lists the
`envKey` under `launch.routing.env`, and raises `provider-secret-missing`
as an error for the selected harness (a warning for another harness).

## Two Codex souls, two providers

The owner's goal: one Codex soul on GitHub Models with a GitHub token, one
Codex soul on OpenAI with an OpenAI key, on the same Mac, with nothing
installed or configured on the host.

`Billy.soul/soul.json`:

```json
{
  "formatVersion": 2,
  "name": "Billy",
  "preferredHarnesses": ["codex"],
  "harnesses": {
    "codex": {
      "provider": { "id": "github", "baseUrl": "https://models.github.ai/inference", "credential": "github-models" },
      "model": "openai/gpt-4.1"
    }
  },
  "credentials": { "secrets": { "github-models": { "store": "keychain" } } }
}
```

`Cleo.soul/soul.json`:

```json
{
  "formatVersion": 2,
  "name": "Cleo",
  "preferredHarnesses": ["codex"],
  "harnesses": {
    "codex": { "provider": { "id": "openai", "credential": "openai-key" } }
  },
  "credentials": { "secrets": { "openai-key": { "store": "keychain" } } }
}
```

```sh
agent-bot soul spawn Billy.soul --name billy
agent-bot soul spawn Cleo.soul --name cleo
printf '%s' "$GITHUB_MODELS_TOKEN" | agent-bot soul secret billy set github-models
printf '%s' "$OPENAI_API_KEY" | agent-bot soul secret cleo set openai-key
agent-bot soul secret billy status     # provider codex: github … ready
agent-bot soul secret cleo status      # provider codex: openai … ready
agent-bot soul env billy --json | jq .providers
```

Billy's `.codex/config.toml` says `model_provider = "github"` with the
GitHub Models endpoint and `env_key = "GITHUB_TOKEN"`; Cleo's says
`model_provider = "openai"` with `env_key = "OPENAI_API_KEY"`. At launch
Billy's Codex sees `GITHUB_TOKEN` and Cleo's sees `OPENAI_API_KEY`, each
from its own Keychain item, neither in the other soul's process, in any
MCP child, in a journal or on the host's shell. Clearing a secret or
changing a provider in a revision takes effect at the next launch.

## Limits

- The injection and strip cover the ACP lane (`acpExecutorFor`). The
  resume lane (`wake-resume`) and a user-run `agent-bot mcp` child are
  outside this slice.
- A harness that spawns its own MCP children from its own environment hands
  them its env; the reach server strips the named variables from itself,
  other MCP servers the soul configures are not touched.
- `status` probes each store for presence by reading the item in the
  `agent-bot` process; the value is discarded there and never printed.
