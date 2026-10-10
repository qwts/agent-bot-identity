# ADR-0274 conformance inventory

Audit for [#611](https://github.com/qwts/agent-bot-identity/issues/611),
2026-10-09. Runtime baseline: `460cd7a8d27c70ee5a9770ea842c4ba44e5420e1`.
The [accepted ADR](decisions/ADR-0274-product-is-mechanism-add-ons-and-sop-packs-carry-policy.md)
defines the requirements; acceptance does not certify their implementation.

**Result:** isolated zero-SOP and selected-pack bind/chat/wake journeys are
covered. Full organization-pack conformance is **not complete**. Configured
persona policy now fails closed at daemon launch (#613 slice 1, #681), and
the record is matched strictly to the selection and checked again at every
daemon-run turn (#613 strict selection); several policy
extension and host-naming seams remain incomplete. This audit changes no
authorization, credential, persona, or hook behavior.

## Decision-to-evidence matrix

“Covered” means the stated fixture or mechanism is tested, not that every live
harness, operating system or account has been exercised. “Missing” identifies
a runtime gap. “Unsupported” means intentionally outside the current interface.
“Decision needed” identifies a contract choice before that slice is implemented.

| ADR decision / requirement | Implementation and executable evidence | Status and remaining owner |
| --- | --- | --- |
| 1: souls, binding, chat and wake without organization policy or GitHub | `soul-join.mjs`, `agent-daemon.mjs`, `wake-plane.mjs`; `tests/product-policy-conformance.test.mjs`, zero-SOP case | **Covered** through real loopback bind/chat and scripted ACP subprocesses. No native app installation or live model is claimed. |
| 1: product authorization and consent remain authoritative | The journey refuses missing bearer and unknown principal; join requires its owner gate. `tests/owner-approval.test.mjs` covers canceled/unavailable consent. `tests/cred-mint-via-daemon.test.mjs` covers missing/unreadable binding and down-daemon refusals. | **Covered** at these boundaries. Broader grant/presence/custody contracts remain #104, #107, #108, #109, #110 and #594. |
| 1: bot credential failure cannot select human credentials | `git-credential-bot.mjs`, `gh-shim.mjs`, `resolve-agent.mjs`; `tests/gh-shim.test.mjs` “mint failure diagnostic” cases assert refusal and empty output, explicit human tokens are rejected; `tests/cred-mint-via-daemon.test.mjs` refuses local fallback | **Covered** by existing targeted negative tests; the new chat journey is not offered as proof of all credential protocols. |
| 2: named config-only gates, default off, invalid values refused | `config.mjs`; `tests/feature-gates.test.mjs`, `tests/credential-helper.test.mjs` | **Covered**. Environment markers alone cannot enable a gate. |
| 2: selecting a pack does not enable add-ons; ordinary chat does not require GitHub | All three new journeys inspect gates before and after bind/chat/wake. Selected profile projection contains no features; only the explicit-on fixture writes both flags. Daemon mint/keyd callbacks fail the test if called. | **Covered** for the exercised path, including chat with an App record present. |
| 2: a disabled capability required by policy blocks the affected launch | `sandbox.mjs` `personaRefusal` → `persona-policy-requires-addon`, refused by `sandboxLaunchProblem` before mint; `tests/sandbox.test.mjs` gate-off case, `tests/daemon-launch.test.mjs` refusal cases | **Covered** for daemon launches (#613 slice 1, #681). The gate is never enabled by the pack. |
| 3: identity-provider extension | `agent-identity.mjs`, `resolve-agent.mjs`, `organization-profile.mjs`: no App or configured GitHub App; profile roster and lifecycle metadata, explicit choice/pin/account/harness resolution | **Covered** for none/GitHub via journey and `tests/organization-profile.test.mjs`, `tests/resolve-agent.test.mjs`. **Unsupported:** arbitrary third-party identity providers; ADR says later others, not a shipped plugin ABI. |
| 3: persona-mapping extension | `sop.mjs` records pinned `persona.toml`; `sandbox.mjs` parses soul/role/default rules. Selected fixture proves an offline reviewer mapping overrides a conflicting soul override. `tests/sandbox.test.mjs` covers precedence, account readiness and fail-closed refusals. | **Partial:** mapping, launch-time and per-turn enforcement work (#681, #613 strict selection); account provisioning and in-account sign-in remain #376. |
| 3: policy before bind and spawn | Bind enforces product identity/consent. `agent-hook.mjs::runSpawnHooks` joins after binding and reports a failed spawn hook as a warning. | **Missing:** no complete selected-pack pre-bind/pre-spawn enforcement contract. Do not describe the post-bind notification as an enforcing pre-spawn hook. **Decision needed: #677.** |
| 3: policy before launch and send | `daemon-launch.mjs` consults persona before execution; daemon session/principal authorization and turn policy govern interaction. No unified selected-pack callback spans launch, message send and wake. | **Partial:** product gates are present; persona #613 and selected-pack lifecycle contract #677 remain. |
| 3: policy before commit and push | Installed `agent-hook.mjs` runner, `hook-dialects.mjs`, committed Git hooks; `tests/agent-hook.test.mjs`, `tests/identity-hooks.test.mjs`, `tests/uninstalled-identity-hook.test.mjs` | **Covered** installed hook normalization, blocking verdicts/timeouts and identity checks. **Missing:** a selected, pinned pack's contribution/activation contract (#677); installing an executable hook is not proof of SOP selection. |
| 3: skill-source extension | `skill.mjs` bundles three application skills and reads bounded, pinned catalog entries; `tests/skill-catalog.test.mjs`, `tests/skill.test.mjs` | **Covered (#674):** the selected SOP supplies the catalog at its resolved commit, with foreign-selection trust and bounded full-commit entry reads; isolated organization fixtures cover selection and refusal. Remote disclosure remains online-only; bundled disclosure is offline. Imported-skill lifecycle/capture stay #603/#312. |
| 3: harness-adapter extension | `acp-registry.mjs`, `hook-dialects.mjs`, `soul-builder.mjs`; `tests/soul-builder-adapters.test.mjs`, `tests/hook-dialects.test.mjs`, real scripted ACP journeys | **Covered** declared built-in adapter/config contracts. **Unsupported:** arbitrary pack code registering adapters. Primitive parity #378/#379, external descriptor ownership #645, live Kiro resume #523 remain. |
| 4: selected org refs and org.json SOP pin, bounded untrusted reads | `sop.mjs`; `tests/sop.test.mjs` covers absent vs broken config, immutable org pins, bounded git and no execution; `tests/sop-soul.test.mjs` covers selection, foreign trust and safe document reads | **Covered** resolver boundary. New local repository fixture follows the org.json SOP commit, not a guessed repository. |
| 4: configured policy failures block; absence/no-match differs from failure | Detailed table below; `loadPersona`, `readSopPersonaRecord`, `personaRefusal`, `sandboxLaunchProblem` | **Covered** for daemon launches (#681) and, with the strict ref/pin/`configPath` check, for every daemon-run turn, interactive principal turns included (#613). |
| 4: sufficient immutable local policy evidence permits offline use | New selected fixture records policy at a commit, removes the local remote, then reads and matches the record. `tests/sop-soul.test.mjs` also tests offline record reads. | **Covered** valid matching evidence, including a selected 40-hex pin offline; a changed ref, pin or config path is stale (`tests/sandbox.test.mjs`). Upstream branch movement is not detectable offline. |
| 5: qwts mapping comes from selected policy, not hard-coded slugs | Secret-free selected org/profile fixture; `organizationProfileToConfig` and shared harness resolver produce `qwts-claude-agent`; persona role comes from pinned text | **Covered** these seams. **Missing:** compiled author exception #675 and the remaining #613 freshness/turn-scope work. This is not a complete replay of the live qwts fleet. |
| 6: both conformance journeys | `tests/product-policy-conformance.test.mjs`: three complete bind/chat/wake cases | **Covered** isolated journey evidence. Full pack conformance remains incomplete for the gaps in this matrix. |
| 7: 0.x compatibility names | `resolve-agent.mjs` key arrays, `hooks/chain-hook`, `scripts/ensure-identity.sh`, environment compatibility readers; `tests/resolve-agent.test.mjs`, `tests/identity-hooks.test.mjs` | **Covered** legacy reads retained. No alias removed by this audit. |
| 7: host-supplied user-visible names | `AGENT_BOT_SERVICE_LABEL` and `AGENT_BOT_KEYD_SERVICE_LABEL` validated by daemon/keyd code; `tests/daemon-supervisor.test.mjs` host-label cases; keyd install/uninstall tests | **Covered** service-label seam. **Missing / decision needed: #676** for credential-store names and compatibility migration. |

## Persona enforcement: requirement versus current behavior

This table records the audited baseline, updated for #613 slice 1 (#681). The scope is
the accepted launch requirement. It does not silently settle whether a
previously launched soul must re-evaluate policy on every later turn.

| Evidence state | ADR-0274 requirement | Baseline result / evidence |
| --- | --- | --- |
| No selected SOP config | Explicit user settings may apply | Works; new zero-SOP journey plus `tests/sop.test.mjs` missing-config case. |
| Selected immutable revision verified to have no persona file | Explicit user settings may apply | `recordSopPersona` records null and `readSopPersonaRecord` returns absent; `tests/sop-soul.test.mjs`. |
| Valid policy, no matching rule/default | Explicit user settings may apply | `matchPersona` returns null; sandbox matching tests. |
| Selected policy unrecorded or unreadable | Block affected launch before side effects | **Refused** (`persona-policy-unavailable`) before mint, bind, provisioning or the harness; `tests/sandbox.test.mjs`, `tests/daemon-launch.test.mjs`. |
| Invalid persona text | Block affected launch | **Refused** (`persona-policy-unavailable`). |
| Different policy selection or revision | Block until repaired/reselected through an authorized path | **Refused** (`persona-policy-stale`) when the record is not for the selected ref, pin or config path, or predates selection tracking, at launch and every daemon-run turn. A principal's launch asks the owner to verify instead (owner decision on #613); a team start does not. |
| Valid policy requires sandbox but gate is off | Refuse affected launch, explain owner action; do not enable gate | **Refused** (`persona-policy-requires-addon`), naming `agent-bot sandbox on` as the owner's action; the gate is untouched. |
| Valid policy, required account unavailable/wrong | Refuse execution | Works once resolved as sandboxed: `sandboxLaunchProblem`, `tests/sandbox.test.mjs` and daemon-launch tests. Policy failures are now refused before that point instead of falling back. |
| Valid record matches selected immutable revision; remote unavailable | Evaluate offline | New selected-pack fixture removes its remote before evaluation; succeeds without a network refresh. |

Only the daemon launch path currently calls `sandboxFor`, before mint, bind,
provisioning and executor startup. Principal launches and team launches use
that path. Cold/task/resume/webhook wakes, `/v1` turns, join and harness-auth
do not all perform this policy evaluation. #613 owns the consumer inventory
and enforcement changes together. Its remaining questions about legacy
records lacking selection metadata and re-evaluation of existing turns must
be recorded explicitly; they do not justify the known new-launch fallback.

## Compiled organization policy audit

The audit searched runtime `.mjs`, hook scripts and installation scripts for
`qwts`, `QWTS`, `ai9d` and governance references, then inspected each active
use. A repository URL or an ENG citation alone is not an authorization rule.

| Occurrence | Classification | Disposition |
| --- | --- | --- |
| `skill.mjs::CATALOG_PATH` names `skills/README.md` | Product catalog path; repository and commit come from selected SOP | #674 removes the compiled qwts source and mutable index read; existing bundled ownership metadata is unchanged. |
| `hooks/agent-context`, `sync-hooks.mjs`, `readiness.mjs` default `AGENT_BOT_UNMANAGED_AUTHORS` to `ai9d` | Active person-specific authorization exception, including a zero-policy install | #675: explicit organization configuration and reviewed migration; do not simply remove guards. |
| `qwts.agentApp`, `qwts.agentId`, `qwts.chainedHooksPath`; `QWTS_*`, `PLAYBOOK_HOME` aliases | Deliberate compatibility input; `qwts.*` and `PLAYBOOK_HOME` through 0.x, `QWTS_*` indefinitely per #752 | Retain as read-only aliases. New behavior should use canonical names; existing consumers must not lose identity unexpectedly. |
| GeniusBar names: `app.geniusbar.*` labels, the `geniusbar-agent` sandbox account, `/Applications/GeniusBar.app`, `QWTS_*` aliases | The owner's host app, private once it moves to truline as Dudles | Owner, 2026-10-10 (#752): new code and text say "the host app"; the old names stay recognised indefinitely and nothing installed is renamed. `tests/org-neutral-runtime.test.mjs` refuses new GeniusBar or Dudles names in shipped code. |
| `dev.qwts.agent-bot.daemon` / `.keyd` defaults | Compatibility deployment names with host overrides | Host label validation and propagation already exist; no claim that defaults themselves decide persona policy. |
| Fixed `agent-bot.soul.*`, `agent-bot.app.*`, credential item display names | Product naming, not qwts authority; incomplete host naming seam | #676: namespace/collision/migration contract, no live secret movement in this audit. |
| `skill.mjs::OWN_REPOSITORY`, Linux component pins, documentation URLs | Runtime/source provenance and distribution dependencies | Keep; not an org roster or permission rule. |
| Harness/account resolver and profile model vocabulary | Product mechanism applied to a configured roster | Generic custom-profile tests exist; no hard-coded qwts App slug is needed for the journey. Broader module/descriptor extraction stays #645. |
| Comments, examples and ENG references | Documentation/provenance | Not executable policy. Do not bulk-delete strings to manufacture conformance. |

## Reproduction and limits

Run from a checkout of this change:

```sh
env -u AGENT_BOT_ID node --test tests/product-policy-conformance.test.mjs
env -u AGENT_BOT_ID npm test
```

Each case owns a temporary HOME, explicit environment allowlist, identity
store, population, principal store, worktree, broker fixture and loopback
daemon. It performs real binding and authenticated chat, starts the existing
scripted ACP harness subprocess for chat and cold wake, checks output and
receipts, and verifies both executions use the same identity/worktree/binding.
No real broker membership, harness sign-in, account, keychain or GitHub App
credential is created. npm installation is a fixture; these tests do not
claim to exercise a desktop installer, download runtime integrity, or live
vendor inference.

The selected cases build a local git repository with secret-free org/profile
and persona data. They resolve the org.json pin, project the profile through
the bootstrap converter, and separately opt into gates only in the enabled
case. Automatic profile installation from SOP selection is **not** claimed.
The fixture's qwts names demonstrate configurable mappings; it does not
download or assert the current organization roster. Reviewer mapping is
evaluated without switching OS accounts. The chat/wake path does not exercise
all launch-policy consumers; its success cannot mask #613.

Closing the audit issue may record this inventory and link the implementation
issues. It must not close those issues, assert full ADR conformance, or treat
passing current fallback tests as evidence that fail-closed policy shipped.
