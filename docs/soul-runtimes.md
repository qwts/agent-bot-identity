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
  the `bin` it installs, and needs `runtimes.python`. It may add `lock`:
  every package the tool installs, itself included, as
  `{ "name", "version", "sha256": ["<hex>", ...] }` with each entry's
  digests sorted ascending (#617). The adapter harnesses
  (`claude`, `codex`) are pinned in `package.json` and refuse `install`.
- `runtimes.integrity: "required"` (#617, owner decision "Per soul in
  soul.json") is the soul's install policy, not a runtime. With it, an
  install without integrity evidence is refused: a uv tool without a `lock`
  is `unsupported` (`runtime-install-failed`, action: add the lock), and a
  Python installed before the catalog pinned its digest is reinstalled.
  An executable override is `unverified-external`, so the soul refuses it
  too (ADR-0322 decision 4: an override cannot bypass a required policy):
  its row is `invalid` with `runtime-override-invalid`, launch and install
  refuse, and setting a new one is refused; clearing it, or removing the
  policy in a revision, is the way out. Without it (the default) those installs are allowed and reported
  `verification: "unverified"`. Any other value is invalid. Like every
  declaration it is part of the revision.
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
| python | 3.12.15, 3.13.16 | python-build-standalone 20261003 archives, installed by uv held to the pinned digest |
| go | 1.27.1 | go.dev tarballs (zip on Windows) |
| uv | 0.12.23 | github.com/astral-sh/uv release archives |

A range resolves to the newest pin it matches (`24` → 24.21.0). A bump adds
the new pin and keeps the one it supersedes, so a soul that recorded the older
version can still reinstall it from a verified source (#617, "Pin per
install"); `catalogPin(name, version)` finds a pin by exact version. An exact
version the catalog does not pin is unsupported unless the soul declares its
own `sources`. The catalog version is `RUNTIME_CATALOG_VERSION` 1, and
`catalogReleaseHash()` is the SHA-256 of `{ version: RUNTIME_CATALOG_VERSION,
catalog }` in canonical JSON (sorted keys, no whitespace).

### Pins

`.soul-state/runtime-pins.json` records the exact version each runtime and
each `harnesses.<name>.install` harness was installed as (npm ACP adapters are
pinned by their own package lock and are not listed), so a newer agent-bot does not move a soul to a newer
pin on its own (#617, owner decision "the new pins file"):

```json
{ "schemaVersion": 1,
  "runtimes": { "node": { "version": "24.21.0", "catalogRelease": "<64 hex>" } },
  "harnesses": { "opencode": { "version": "1.2.3", "catalogRelease": null } } }
```

- Install writes it, under a lock and as one atomic replace (mode 0600), after
  every `soul runtimes install` and launch provisioning, a failed one included,
  for what is installed then, inspected under that lock so a concurrent
  installer's pin is seen and kept. `catalogRelease` follows the install's
  receipt: the catalog release its bytes came from, null for a package's own
  `sources` (the same bytes moved into `sources` keep the catalog install and
  its release). Harness installs record null; `soul.json` already names their
  exact version. uv is recorded when python or a uv tool needs it. A failure
  to record is `runtime-install-failed` naming the pins file, with the action
  to retry the install (after fixing or deleting a malformed file).
- An entry changes only when the installed version, or its catalog-versus-
  package provenance per the receipt, changes; otherwise it keeps its original
  `catalogRelease`, even after a reinstall from a newer catalog whose stamp
  names that newer release. An entry is added when none exists. A revision
  that moves a version into `sources` with the same bytes keeps the catalog
  install, so its entry stays as it was. Inspection never writes the file, so
  a soul installed before #617 has none until its next install.
- Resolution reuses a recorded version the declaration still allows, from the
  catalog's own pin for it, instead of the newest pin. Removing
  `.soul-state/runtimes` and installing again brings back the same versions.
  A recorded version this catalog no longer pins is `unsupported` with
  `runtime-install-failed` and the action `update agent-bot to a release whose
  catalog pins <name> <version>`; it is never silently moved.
- With no file, resolution uses the current catalog, as before #617. A file
  that is not valid JSON of this shape (both maps present; runtime versions
  exact `x.y.z`) is reported under `invalid` and blocks
  every install and launch with the action `fix or delete
  .soul-state/runtime-pins.json`; deleting it re-resolves.
- It is durable soul state: `soul env export` and transfer carry it (its
  `.lock` is transient and excluded), while `.soul-state/runtimes` is
  reconstructible and is not carried. A fresh host installs the recorded
  versions.
- Only `soul runtimes upgrade --apply` moves a recorded version forward (see
  Commands). `catalogRelease` is provenance and
  is not enforced: a recorded version installs from the running agent-bot's
  verified pin for it.
- The file is soul-writable state, like the rest of `.soul-state`. It holds
  only versions, and a catalog version installs only from the catalog's
  verified URL and digest, so an edit can select another verified pin and
  nothing else. It can select a superseded pin, which is an older but
  verified version.

## Commands

```sh
agent-bot soul runtimes <agentId|name> [--json]
agent-bot soul runtimes install <agentId|name> [--json] [--runtime NAME] [--principal-stdin]
agent-bot soul runtimes upgrade <agentId|name> [--runtime NAME] [--apply] [--json] [--principal-stdin]
agent-bot soul runtimes override <agentId|name> <node|npm|npx|go|gofmt|python3|uv|uvx> /absolute/path/to/executable [--json] [--principal-stdin]
agent-bot soul runtimes override <agentId|name> <node|npm|npx|go|gofmt|python3|uv|uvx> --clear [--json] [--principal-stdin]
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

`soul runtimes upgrade` shows the diff first: for each runtime recorded in
`.soul-state/runtime-pins.json` from the catalog, the move to the newest
catalog pin its declaration allows (`node: 24.21.0 -> 24.22.1`), uv
included, or `up to date`. It reads only and asks nobody. `--runtime` limits
it to one runtime. `--apply` is the owner action: the owner gate's prompt
names the same changes; then, under the pins lock and only if each entry
still records the version shown, it rewrites those entries (with the current
catalog release), installs them, and leaves an audit receipt (`soul-runtimes`,
operation `upgrade`). If the install fails, the entries are put back, so the
soul keeps running what it had, and the error says the upgrade was undone.
Unrecorded runtimes already follow the current catalog; a package's own
`sources` and harness installs move by a `soul.json` revision. A recorded
version this catalog no longer pins moves to the newest pin its declaration
allows, which is how a soul refused for a dropped pin recovers. A malformed
pins file is refused like an install.

`--json` prints one object with every key present:

- `schemaVersion` 1, `agentId`, `soulDir`, `platform` (`null` when the host
  is not one the catalog knows), `root` (`.soul-state/runtimes`), `cache`
  (the shared download cache), `integrity` (`"required"` or `null`), `ready`.
- `runtimes[]`: `{ name, declared, requiredBy, version, source
  ("catalog" | "package"), status ("installed" | "missing" |
  "unsupported"), reason, path, bin, verification, lastError, code, action,
  via }`. `verification` is `"verified"` when the receipt carries the digest
  the declaration pins, `"unverified"` when it has none (only a Python
  installed before #617), and `null` when not installed; the text output
  marks the latter `[unverified]`. `code` and `action` are `null` unless the
  integrity policy refuses the row. `uv` appears as a
  row when python or a uv tool needs it, with `requiredBy` naming them.
  `lastError` is `{ code, message, at }` from the last failed install of
  that version, `null` otherwise.
- `harnesses[]`: `{ name, kind, package, version, executable, status,
  reason, path, bin, verification, lastError, code, action, archive, lock }`
  for each `harnesses.<name>.install`. An archive or a locked uv tool is
  `verified`; an unlocked uv tool is `unverified`.
- `overrides[]`: `{ name, runtime, status, executable, verification, code,
  action, reason }` for each owner-selected executable. A selected external
  path is reported as `verification: "unverified-external"`; its bytes and
  provenance are not covered by the managed archive pins.
- `invalid[]`: `{ path, message }` for declarations the package refuses.
- `install` adds `installed[]`, `skipped[]` (already there).

`override` is an owner-gated, host-local selection for one executable name.
It accepts only an absolute path that resolves to a regular executable with
execute permission; the canonical real path is recorded. Names are closed to
`node`, `npm`, `npx`, `go`, `gofmt`, `python3`, `uv`, and `uvx`. `--clear`
removes one selection, and every set or clear appends a `soul-runtimes`
receipt. The command does not alter `soul.json` or claim a managed install.

At launch, agent-bot puts one-name symlinks under
`.soul-state/runtimes/overrides/bin` at the front of `PATH`. It never adds the
selected executable's parent directory, so selecting `node` does not also
select a sibling `npm` or `npx`. A node override leaves installed managed
`npm` and `npx` bins behind its shim; harness bins then precede managed runtime
bins. A selected `uv` supplies the `uv` command for Python and uv-tool
provisioning, but does not select `python3` or `uvx`. A Python override makes
the implicit `uv` runtime unnecessary unless a uv-tool harness is declared;
uv-tool installs use the selected Python path explicitly and refuse to
download a substitute. `install` reports selected external executables and
skips only those exact names; clear a selection before provisioning its
managed copy. Runtime variables owned by a selected executable are removed
from the child environment. A declared managed runtime may still show as
missing in status while its launch route uses the external selection, so
managed readiness stays honest while pending launch requirements reflect
usable selections. If a stored path becomes invalid, launch refuses with
`runtime-override-invalid`, shows the recorded path and names the `--clear`
command. Overrides are
unsupported on Windows, where a carried selection can still be cleared.
They live below `.soul-state/runtimes`, which is
host-local runtime state and is excluded from export/import.

Override records and their one-name shim directory are owner-managed state.
Recognized soul file-write tools cannot edit them in any confinement mode,
including `off`; direct shell commands naming the state are refused too. Set
or clear selections with the owner-gated command above. This is a cooperative
hook guardrail: records are not signed, and it does not stop arbitrary code
running as the same OS user from bypassing the hooks. It adds no OS-level
custody boundary or different record format/location.

## Layout

```
<soul>/.soul-state/runtimes/
  overrides/<name>.json   one canonical external executable selection
  overrides/bin/<name>    one-name launch symlink; no target siblings
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
kind, version, platform, URL, `sha256`, `bin` and `installedAt`. `archive`
and `uv-python` stamps also record `catalogRelease`: the catalog release a
catalog runtime was installed from, else null (a package's own `sources`, a
harness archive); it is absent before #617, and any other value makes the receipt invalid, so the install is repaired. `uv-tool` and npm adapter stamps
do not carry it. Archive stamps
record the digest verified by agent-bot. A `uv-python` stamp records the
python-build-standalone archive's URL and `sha256` from the catalog: uv is
given a one-entry downloads list (`--python-downloads-json-url`) naming only
that archive, so it can install nothing else and refuses bytes that do not
hash to it. A Python stamp from before #617 has `sha256: null`; it stays
usable and `unverified` unless the soul requires integrity, which reinstalls
it. A receipt with another digest is `missing`. `uv-tool` stamps record
`url: null` and `sha256: null`; they do not attest that agent-bot verified
every downloaded dependency byte. A uv
tool without a `lock` installs `package==version` with no dependency hashes. A
locked tool installs into its own `venv/` with `uv pip install --require-hashes
-r requirements.lock.txt`, so uv refuses any artifact or dependency the lock
does not hash, and only its `bin` is linked into the install's `bin/`. Its
venv is created with `--no-python-downloads`, so it uses the soul's managed
Python (or the owner's Python override) and fails rather than fetch an
interpreter of its own. The managed Python is digest-pinned unless it is a
receipt from before #617, which is labelled `unverified` (and reinstalled when
the soul requires integrity). An owner override stays `unverified-external`:
the catalog digest does not cover it. A
uv-tool stamp records `lockSha256`, the SHA-256 of the requirements text it
was filled from (`null` when unlocked). Readiness requires it to match the
declaration, so adding or changing a lock rebuilds that version. Locked
tools are unsupported on Windows until a launcher for the linked executable
is verified. Under `runtimes.integrity: "required"` an unlocked tool is
refused before anything is written. The stamp is what
`soul runtimes` and `soul env` inspect; absence or an incomplete-install marker
must not be presented as a completed installation. Readiness compares the
receipt's schema, runtime/harness name, kind, exact version and platform with
the current selection. Archive receipts must also match its SHA-256 and
executable directory. The executable must resolve to a regular file this
account may execute (the execute bit on POSIX) inside the installation, and the installation must resolve inside the soul. A
mismatch reports `missing` with a reason and cannot route to a host fallback.
Internal executable symlinks remain supported; links outside the install do not.

These checks validate receipt consistency and path containment. They do not
rehash the extracted installation on every launch, detect arbitrary changes
to its file contents, or provide Python dependency provenance. Those stronger
integrity requirements remain #617.

Archive installs are staged and published per artifact. An archive is downloaded
into the shared cache
`~/.cache/agent-bot/downloads/<sha256>` (`AGENT_BOT_CACHE_HOME`, then
`XDG_CACHE_HOME/agent-bot`), written as a partial file and renamed only
after its digest matches; a cached file that no longer hashes is dropped and
fetched again. The archive is extracted into
`.soul-state/runtimes/<runtime>/.installing-<uuid>/`, checked for its
executable, stamped, and renamed to its version directory. If that version
already exists with a mismatched receipt or unusable executable, publication
moves it to `<version>.retained-<uuid>` before installing the replacement and
logs the retained path. A per-target publication lock prevents two repairs
from replacing one another; a matching concurrent install is reused. A failed
replacement rename restores the retained directory. If a process stops between
these renames, the old bytes remain at the retained path and the next launch
reprovisions the missing version. Runtime cleanup does not delete these
retained directories. A failed install
removes its staging directory and leaves a previous version available for
recovery. A launch requiring the failed newer resolution still refuses; retaining
node 24.21.0 does not automatically select it as a fallback. Python installs the
same way through `uv python install` with
`UV_PYTHON_INSTALL_DIR` in the staging directory; a uv tool, locked or not,
installs in place (its virtualenv holds absolute paths) with an `.installing` marker
beside it, and is reinstalled when the marker is left behind. Nothing writes
to `~/.local`, `~/.cache/uv`, `~/go` or the login shell's PATH through these
provisioning paths. The overall multi-artifact operation is not a transaction:
a later failure can leave earlier successful installs while refusing launch;
uv-tool marker recovery is not an atomic directory swap.

## Launch routing

At launch, an owner-managed per-soul selection takes precedence for that exact
executable name, then harness bins, managed runtime bins, GeniusBar's bundled
Node for an undeclared Node, and the host PATH. Selecting `node` does not
select `npm` or `npx`. The owner CLI and exact executable validation are
implemented above; a per-launch override request remains deferred and is not
wired through the daemon. Remaining resume evidence stays in #617.
The harness installs come before the runtimes on PATH, and a declared
runtime without a matching valid per-soul override is installed at launch or
fails the launch; it never falls through to a host copy. Every daemon ACP turn
rechecks declared runtime readiness before creating an executor, including ACP
cold wakes and session restoration on `/v1`. The owner-selected `resume <policy>` wake lane
(`createResumeExecutor`) composes the same runtime and provider env and refuses
the same way (#707). Tool-home routing and recorded session-store checks are
implemented separately by #818. Missing selected installations, unsupported declarations,
invalid runtime declarations, an unreadable existing manifest, or a runtime
lookup error refuse the turn. A surviving install stamp and bin directory do
not count as ready when the runtime executable is missing or has lost its
execute bit, so the engine never skips it for the daemon's own Node. This is a file
presence and mode check, not a rehash of installed bytes or dependency provenance.
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
| ACP cold wake | `coldTurnExecutor` calls the same `acpExecutorFor` for each turn | Runtime/factory fixtures remove an executable after a successful turn and verify refusal before another executor is created. |
| Resume wake lane (`resume <policy>`) | `createResumeExecutor` composes the turn env through `runtimeEnvFor`/`toolHomeEnvFor`/`providerEnvFor`, then resolves the harness CLI on that PATH (#707, #818) | Runtime fixtures refuse a removed or mismatched declared runtime with no run recorded. Separately merged #818 records the host or soul session store and refuses a moved store as `resume-session-store-moved`; `tests/wake-resume.test.mjs` covers recorded and legacy stores and refusal before spawning. An owner who changes a tool home can retire the recorded session with `soul tool-home <harness> soul\|global --soul <agentId\|name> --fresh-session` (#827); the old transcript is kept. |
| Native `/v1` turns, including resumed sessions | `agent-daemon.mjs` calls the same factory before the ACP engine loads or creates a session | The same readiness check applies before session restoration or spawning. |
| Declared environment | `soulRuntimeEnv` inspects the current manifest and selected installation | Runtime/factory fixtures cover missing/unsupported declarations, invalid manifests, missing selected harnesses and missing runtime executables; undeclared runtimes retain the host routes. |
| npm provisioning | Both managed homes and joined adapters prepare declared runtimes through `soulInstallEnv` before npm | Fixtures verify the selected distribution's exact Node and npm CLI, reject a host npm override, and refuse missing files or failed provisioning before npm. Undeclared Node retains the host route. |
| Archive and Python integrity | `fetchArchive`, installation stamps, uv installers, `runtimes.integrity` | Archive checksum refusal exists; the Python archive is pinned per platform and uv is held to it; locked uv tools install with `--require-hashes`; a soul requiring integrity refuses unlocked tools and digestless Python receipts, others are labelled unverified. Installed-byte verification remains open. |
| Per-soul executable overrides | `soulRuntimesCommand` owner-gates set/clear; `inspectRuntimeOverrides` and `ensureOverrideShims` feed `runtimeLaunchEnv` | Set/clear selects one exact executable name, revalidates its absolute executable path at use, and routes it through a one-name shim ahead of managed and host paths without inferring sibling tools. Managed companion bins remain available when installed. External paths are marked `unverified-external`; overrides are unsupported on Windows. Per-launch wire overrides remain deferred. |
| Catalog and transfer | Inspection resolves against the supplied catalog | Retained resolution and owner-visible upgrade semantics remain open. |
| Migration / platforms | #583 lifecycle paths; deterministic runtime fixtures; `whichOnPath` resolves `name.exe` on Windows for every turn lane, the sign-in probe and harness defaults | Migration evidence is tracked separately. Injected-platform fixtures do not establish live Windows support. npm `.cmd` shims are not executed, because `spawn()` refuses them without a shell, so a harness installed only as a shim is reported missing. |

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
an exact owner-selected `node` or `npm` is used for that executable only;
otherwise the managed Node distribution supplies Node and its bundled npm CLI
(`lib/node_modules/npm/bin/npm-cli.js` on Unix, `node_modules/npm/bin/npm-cli.js`
on Windows). A host `AGENT_BOT_NPM` cannot replace this declared-runtime
route, and selecting `node` never selects `npm` or `npx` by implication.
Missing files or failed provisioning refuse installation. Without a Node
declaration, the host route and its npm override remain available. The soul's
npm cache stays contained.
Windows layout fixtures verify selection; they do not establish live Windows
execution. Installed-byte integrity and deferred per-launch override requests
remain in #617.

A launch resolves the adapter in order: the checkout's own `node_modules`,
the runtimes installs newest version first, then the legacy
`.soul-state/harnesses` a release before slice 8 made. The legacy install
still launches until `agent-bot soul env migrate <soul>
--harnesses-into-runtimes` (also run by `--complete`) moves it under the
runtimes with its stamp; see
[soul-environment.md](soul-environment.md#moving-the-npm-adapter-under-the-runtimes).
