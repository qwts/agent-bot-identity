# Soul runtimes and harness installs

A soul declares the runtimes and non-npm harnesses it needs, and the engine
provisions them inside the soul folder ([ADR-0583](decisions/ADR-0583-the-soul-root-owns-the-environment.md)
decision 6, [ADR-0322](decisions/ADR-0322-souls-carry-their-runtimes-and-non-npm-harnesses.md)).
The target is to provision declared, supported tools without a host package
manager. Exact sources and catalog resolutions determine the artifacts used;
a range can resolve differently on a fresh machine with a newer engine catalog.
[#617](https://github.com/qwts/agent-bot-identity/issues/617) tracks remaining
integrity, override, resume and host-npm conformance; this page describes the
implemented slice and its limits.

## Declaring

```json
{
  "runtimes": { "node": "24", "python": "3.12", "go": "1.x" },
  "harnesses": {
    "opencode": { "install": { "kind": "archive", "version": "1.2.3",
      "url": "https://github.com/sst/opencode/releases/download/v{version}/opencode-{platform}.zip",
      "sha256": { "darwin-arm64": "…64 hex…", "linux-x64": "…64 hex…" } } },
    "goose": { "install": { "kind": "uv-tool", "package": "goose-ai", "version": "1.9.0", "bin": "goose" } }
  }
}
```

- `runtimes.<name>` is `node`, `python` or `go`, as a version or range:
  a major (`24`), a prefix (`24.21`, `24.x`, `3.12`) or an exact version.
  The object form `{ version, via, sources }` lets a soul pin its own
  downloads: `sources` maps platforms (`darwin-arm64`, `darwin-x64`,
  `linux-x64`, `linux-arm64`, `win32-x64`) to `{ url, sha256, bin }`, needs an
  exact `version`, and wins over the catalog. Python is always provided by
  uv (`via: "uv"`, the only value), so it takes no `sources`.
- `harnesses.<name>.install` pins a harness the soul cannot get from npm.
  `archive` takes a `version`, an https `url` (one template with
  `{version}` and `{platform}`, or a per-platform map), `sha256` per
  platform, and `bin` (the executable inside the archive; defaults to the
  harness command). `uv-tool` takes a PyPI `package`, exact `version` and
  the `bin` it installs, and needs `runtimes.python`. The adapter harnesses
  (`claude`, `codex`) are pinned in `package.json` and refuse `install`.
- Validation is strict: unknown keys, bad digests, non-https URLs and
  unknown platforms are refused by every package reader, and a declaration
  is definition, so adding or changing one (including a digest) changes the
  revision like any other `soul.json` edit.

## Catalog

`runtime-catalog.mjs` is pure data: per runtime and platform, the download
URL and SHA-256 the engine trusts. Every digest was verified by downloading
the archive once and checking it against the publisher's checksum file.

| Runtime | Pins | Source |
| --- | --- | --- |
| node | 22.23.3, 24.21.0 | nodejs.org tarballs (zip on Windows); npm comes with it |
| python | 3.12.15, 3.13.16 | `uv python install` (python-build-standalone), via uv |
| go | 1.27.1 | go.dev tarballs (zip on Windows) |
| uv | 0.12.23 | github.com/astral-sh/uv release archives |

A range resolves to the newest pin it matches (`24` → 24.21.0). An exact
version the catalog does not pin is unsupported unless the soul declares its
own `sources`. The catalog version is `RUNTIME_CATALOG_VERSION` 1. Inspection
resolves against the currently supplied catalog; it does not lock a range to an older install
receipt. If a new matching pin becomes current, that version can be reported
missing and the existing launch provisioning path can install it. A prior
installed directory is retained, but retention alone does not select it.
Owner-visible upgrade and retained-resolution guarantees remain #617.

## Commands

```sh
agent-bot soul runtimes <agentId|name> [--json]
agent-bot soul runtimes install <agentId|name> [--json] [--runtime NAME] [--principal-stdin]
```

`soul runtimes` is read-only and prints what is declared, resolved and
installed. `soul runtimes install` is an owner action behind the owner gate
(`--principal-stdin` carries the principal JSON like `soul revision edit`);
it installs every declared runtime and harness that is missing, or one with
`--runtime` (`node`, `python`, `go`, `uv`, or a harness name), and leaves an
audit receipt (`soul-runtimes`, no secrets). The daemon runs the same
install at launch when a declared runtime is missing, as the `runtimes`
launch stage, and a launch whose install fails reports the coded error
instead of starting the harness.

`--json` prints one object with every key present:

- `schemaVersion` 1, `agentId`, `soulDir`, `platform` (`null` when the host
  is not one the catalog knows), `root` (`.soul-state/runtimes`), `cache`
  (the shared download cache), `ready`.
- `runtimes[]`: `{ name, declared, requiredBy, version, source
  ("catalog" | "package"), status ("installed" | "missing" |
  "unsupported"), reason, path, bin, lastError, via }`. `uv` appears as a
  row when python or a uv tool needs it, with `requiredBy` naming them.
  `lastError` is `{ code, message, at }` from the last failed install of
  that version, `null` otherwise.
- `harnesses[]`: `{ name, kind, package, version, executable, status,
  reason, path, bin, lastError }` for each `harnesses.<name>.install`.
- `invalid[]`: `{ path, message }` for declarations the package refuses.
- `install` adds `installed[]`, `skipped[]` (already there).

## Layout

```
<soul>/.soul-state/runtimes/
  node/24.21.0/            the tarball's tree; bin/node, bin/npm
  node/npm-cache/
  node/last-install.json   { version, status: ok | failed, code, message, at }
  uv/0.12.23/uv            the uv binary; uv/cache, uv/tools
  python/3.12.15/cpython-3.12.15-<platform>/bin/python3
  go/1.27.1/               GOROOT; go/gopath (GOPATH, GOMODCACHE under it), go/cache
  harnesses/opencode/1.2.3/opencode
  harnesses/goose/1.9.0/   bin/goose and tools/ (UV_TOOL_BIN_DIR, UV_TOOL_DIR)
  harnesses/claude/0.16.2/ the npm ACP adapter: package.json, package-lock.json, node_modules/.bin/claude-code-acp
```

Every completed install directory carries `.agent-bot-install.json`: the name,
kind, version, platform, URL, `sha256`, `bin` and `installedAt`. Archive stamps
record the digest verified by agent-bot. `uv-python` and `uv-tool` stamps instead
record `url: null` and `sha256: null`; they do not attest that agent-bot verified
every downloaded dependency byte. Python acquisition is delegated to uv, and
uv tools currently use `package==version` without a dependency lock/hash input.
That missing integrity contract is tracked in #617. The stamp is what
`soul runtimes` and `soul env` inspect; absence or an incomplete-install marker
must not be presented as a completed installation.

Archive installs are staged and published per artifact. An archive is downloaded
into the shared cache
`~/.cache/agent-bot/downloads/<sha256>` (`AGENT_BOT_CACHE_HOME`, then
`XDG_CACHE_HOME/agent-bot`), written as a partial file and renamed only
after its digest matches; a cached file that no longer hashes is dropped and
fetched again. The archive is extracted into
`.soul-state/runtimes/<runtime>/.installing-<uuid>/`, checked for its
executable, stamped, and renamed to its version directory. A failed install
removes its staging directory and leaves a previous version available for
recovery. A launch requiring the failed newer resolution still refuses; retaining
node 24.21.0 does not automatically select it as a fallback. Python installs the
same way through `uv python install` with
`UV_PYTHON_INSTALL_DIR` in the staging directory; a uv tool installs in
place (its virtualenv holds absolute paths) with an `.installing` marker
beside it, and is reinstalled when the marker is left behind. Nothing writes
to `~/.local`, `~/.cache/uv`, `~/go` or the login shell's PATH through these
provisioning paths. The overall multi-artifact operation is not a transaction:
a later failure can leave earlier successful installs while refusing launch;
uv-tool marker recovery is not an atomic directory swap.

## Launch routing

The runtime environment helper routes the soul's installs in this order per
runtime ([ADR-0322](decisions/ADR-0322-souls-carry-their-runtimes-and-non-npm-harnesses.md)
decision 4): a supplied override, the soul's install, the node bundled with
the host (GeniusBar's, for an undeclared node only), then the host PATH. The
managed daemon turn path supplies the soul environment, but does not wire a
per-agent override request into this helper. A durable per-soul override CLI,
exact override executable validation and remaining resume evidence stay in #617; the helper
argument is not evidence that these user-facing paths exist.
The harness installs come before the runtimes on PATH, and a declared
runtime that is not installed is installed at launch or fails the launch; it
never falls through to a host copy. Every daemon ACP turn rechecks declared
runtime readiness before creating an executor, including cold wakes and native
session resumes. Missing selected installations, unsupported declarations,
invalid runtime declarations, an unreadable existing manifest, or a runtime
lookup error refuse the turn. A surviving install stamp and bin directory do
not count as ready when the runtime executable is missing. This is a file
presence check, not a rehash of installed bytes or dependency provenance.
Souls without a manifest retain the undeclared host-tool behavior.
Beside PATH the turn gets
`npm_config_cache`; `GOROOT`, `GOPATH`, `GOMODCACHE`, `GOCACHE`;
`UV_PYTHON_INSTALL_DIR`, `UV_PYTHON_PREFERENCE=only-managed`,
`UV_CACHE_DIR`, `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR`, all inside the soul.
`HOME` is never changed by this routing (see
[soul-environment.md](soul-environment.md) for the tool-home contract).
`soul env --json` shows the result as `launch.routing.runtimes` (`node`,
`python`, `go` and `harness:<name>`, each `{ source, version, bin }` with
`source` one of `override`, `soul`, `host-bundled`, `host`, `missing`,
`unsupported`), `launch.routing.env` (the variable names set) and
`launch.routing.PATH` (`soul-runtimes`, `host-bundled` or `host`).

## Errors

### Launch enforcement audit (#617)

The bounded readiness slice covers the shared daemon executor before a harness
is created. It does not complete the remaining integrity or override contracts.

| Requirement / consumer | Implementation path | Evidence and remaining work |
| --- | --- | --- |
| Managed launch | `daemon-launch.mjs` provisions pending runtimes, then calls `acpExecutorFor` | Existing launch tests cover installation refusal; runtime/factory fixtures cover rejection of stale or invalid readiness. |
| Cold wake and resumed turns | `coldTurnExecutor` calls the same `acpExecutorFor` for each turn | Runtime/factory fixtures remove an executable after a successful turn and verify refusal before another executor is created. |
| Native `/v1` turns, including resumed sessions | `agent-daemon.mjs` calls the same factory before the ACP engine loads or creates a session | The same readiness check applies before session restoration or spawning. |
| Declared environment | `soulRuntimeEnv` inspects the current manifest and selected installation | Runtime/factory fixtures cover missing/unsupported declarations, invalid manifests, missing selected harnesses and missing runtime executables; undeclared runtimes retain the host routes. |
| npm provisioning | Both managed homes and joined adapters prepare declared runtimes through `soulInstallEnv` before npm | Fixtures verify the selected distribution's exact Node and npm CLI, reject a host npm override, and refuse missing files or failed provisioning before npm. Undeclared Node retains the host route. |
| Archive and Python integrity | `fetchArchive`, installation stamps, uv installers | Archive checksum refusal exists; complete dependency lock/hash provenance and installed-byte verification remain open. |
| Overrides | Helper argument in `runtimeLaunchEnv` | Owner-managed override interface, exact executable validation and policy precedence remain open. |
| Catalog and transfer | Inspection resolves against the supplied catalog | Retained resolution and owner-visible upgrade semantics remain open. |
| Migration / platforms | #583 lifecycle paths; deterministic runtime fixtures | Migration evidence is tracked separately; fixtures do not establish live Windows support. |

Every failure is coded, names the runtime, and carries the command that
fixes it (`action`); the CLI prints `{ error: { code, message, runtime,
action } }` with `--json` and exits 1. `soul env` reports the last failure
of each runtime as a readiness problem with the same code.

| Code | Meaning |
| --- | --- |
| `runtime-download-failed` | The archive could not be fetched (offline, DNS, a non-200 answer); retry with the network up |
| `runtime-checksum-mismatch` | The download did not hash to the pinned digest; it was discarded and never cached |
| `runtime-unsupported-platform` | Neither the catalog nor the package has a download for this host; declare `sources` (or `install.sha256`) for it in a revision |
| `runtime-install-failed` | The archive did not extract, lacked its executable, uv could not install, or the declaration is invalid |

## npm ACP adapters

A joined soul's ACP adapter (`@zed-industries/claude-code-acp`,
`@agentclientprotocol/codex-acp`) is `npm ci`-installed from the soul's
pinned lockfile into `harnesses/<harness>/<adapterVersion>/` beside the other
installs: `package.json`, `package-lock.json`, `node_modules/` and the stamp
`{ schemaVersion: 1, name, kind: "npm", package, version, platform: null,
url: null, sha256: null, bin: "node_modules/.bin", installedAt }`. The
version is the lockfile's `packages["node_modules/<package>"].version`. The
install is staged as `.installing-<uuid>` beside the target and renamed in
once `node_modules/.bin/<adapter>` exists, so an interrupted one is a
`soul env clean` candidate and a finished one never is; when two installs of
one version race, the first to land stands. Both joined adapters and managed
homes provision declared runtimes before invoking npm. With `runtimes.node`,
the selected distribution supplies Node and its bundled npm CLI
(`lib/node_modules/npm/bin/npm-cli.js` on Unix, `node_modules/npm/bin/npm-cli.js`
on Windows); a host `AGENT_BOT_NPM` cannot override it. Missing files or failed
provisioning refuse installation. Without a Node declaration, the host route
and its npm override remain available. The soul's npm cache stays contained.
Windows layout fixtures verify selection; they do not establish live Windows
execution. Installed-byte integrity and owner-managed overrides remain in #617.

A launch resolves the adapter in order: the checkout's own `node_modules`,
the runtimes installs newest version first, then the legacy
`.soul-state/harnesses` a release before slice 8 made. The legacy install
still launches until `agent-bot soul env migrate <soul>
--harnesses-into-runtimes` (also run by `--complete`) moves it under the
runtimes with its stamp; see
[soul-environment.md](soul-environment.md#moving-the-npm-adapter-under-the-runtimes).
