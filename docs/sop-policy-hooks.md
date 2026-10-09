# Selected-pack policy hooks: proposed execution contract

Status: proposed for peer review under #677. This document separates the six
required boundaries from the first implementation. The pure parser/evaluator
in `sop-policy.mjs` is implemented behind fixtures, with no runtime callers.
No enforcing hook or activation command is shipped by this first PR. ADR-0274 keeps product authorization authoritative; ADR-0645
keeps policy parsing independent of process hosts. Existing installed hooks and
persona enforcement continue to use their current contracts.

## Requirements and entry points

| Boundary | Current entry point and behavior | Required enforcement point | First slice |
| --- | --- | --- | --- |
| Before bind | `agent-daemon.mjs` POST `/v0/bind` calls `bindWorktreeConversation`. Fresh binding consumes a one-time token, then ensures identity, lineage, space and population state. Reuse records a sighting. | After authenticating the caller and validating place/token/transcript/parent, before consuming the token or writing identity, binding, lineage, space or sighting state. Denial must preserve a valid unspent token. Direct binding entry points need equivalent coverage before claiming universal enforcement. | Unsupported; activation refused. Requires a token-preserving prepare/commit boundary. |
| Before spawn | POST `/v0/spawn` verifies the parent binding and authority, then mints and binds. `runSpawnHooks` joins comms and invokes installed spawn hooks afterward; refusal is a warning. Team start and package launch are additional creation routes. | After product parent/child/request validation, before mint, bind, package copy, provisioning or comms join. Every child-creation route must be inventoried; a post-spawn notification cannot enforce this boundary. | Unsupported; activation refused. Existing spawn notifications remain notifications. |
| Before launch | `createLaunchHandler` receives an authenticated launch, validates account, target, parent, harness and request fields, then evaluates persona readiness before calling `spawnPackage`/`forkCopy`, binding, provisioning and `executorFor`. | After product validation/persona refusal, before the first creation, binding, installation, provider read or harness execution. A denial can write the launch journal and audit receipt. | Initial enforcing target. Principal launch, relaunch and team-start paths through this handler must be covered; arbitrary external processes and wake/resume are not implicitly included. |
| Before send | Reach MCP `send_message` validates the bound soul, resolves a recipient, claims the thread, then invokes `agent-comms send`. Direct CLI/other clients reach the broker independently. | In the broker's authenticated send path before append, enqueue, wake, delivery or idempotency-key consumption. If a client-side check exists, it is additional and must release its local send claim on denial. | Unsupported here; activation refused. Requires an agent-comms broker contract and fixtures, not a wrapper-only claim. |
| Before commit | `hooks/pre-commit` performs identity checks, invokes the installed `agent-hook`, then chains the configured hook. | Preserve product identity refusal first; evaluate policy before Git creates the commit. Preserve chained hooks and exit behavior. Git Data API signed-commit publishing is a separate path to inventory. | Unsupported; activation refused. Reuse the installed Git hook runner rather than add another process hierarchy. |
| Before push | `hooks/pre-push` buffers Git's ref input, runs identity/installed hooks, and forwards the same input to the chained hook. | Preserve product credential/identity checks; deny before remote ref updates. Retain exact stdin for downstream hooks. API-based publishing needs its own equivalent boundary. | Unsupported; activation refused. Direct API writes cannot be covered by a Git-hook claim. |

This matrix is based on source at `1974edd6`. Authentication, parsing and bounded
read-only discovery may happen before a policy decision. Identity creation,
credential minting, binding-token consumption, installs, message persistence,
remote mutation and harness execution may not happen before an enforcing
policy permits continuation. Journal/audit writes describing a refusal are
allowed and must not include credentials or user message contents.

The issue remains open until the reviewed initial slice has real entry-point
fixtures, and the supported/unsupported boundary inventory is accurate. Later
slices must not infer full coverage from tests of the pure evaluator alone.

## Data-only v1 policy

The proposed source is exactly `policy-hooks.json` at an explicitly selected
SOP commit. It is not discovered by crawling Markdown, links or arbitrary paths.
The refresh implementation must extend the narrow SOP reader with this exact
filename; it must not permit general fetched-code execution.

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "no-codex-launch",
      "event": "before-launch",
      "decision": "deny",
      "when": { "harnesses": ["codex"] },
      "reason": "This account is not approved for Codex launches."
    }
  ]
}
```

The parser rejects unknown keys, events, conditions or schema versions, including
executable/script/URL fields. It accepts at most 64 KiB of strict UTF-8 JSON and
64 rules. Rule IDs are unique ASCII identifiers of at most 64 characters; reason
text is at most 256 Unicode characters without controls. `decision` is exactly
`deny`. `when` is either `{}` (all operations for the event) or a nonempty
`harnesses` list of at most 32 distinct canonical execution keys supplied by the host. Match lists are
exact and case-sensitive. Unknown or alias execution keys refuse evaluation;
the host must resolve them using its actual launch route before calling the
evaluator. `claude-code` is an identity label, while the ACP execution key is
`claude`. Do not collapse `vscode` and `copilot`: the profile retains them as
distinct identities. Test the actual resolved key, including defaults and
overrides, rather than infer it from the raw request. There is no regex, interpolation, shell, JavaScript, WASM or
external function is evaluated. Empty rules are a valid no-additional-policy
result.

The first slice accepts only `before-launch`. A document naming another event
is refused during activation with `policy-event-unsupported`; it is not partially
activated or ignored. Expanding that set requires the corresponding product
entry-point implementation and its side-effect-order fixtures.

The host supplies the validated event and selected harness to the pure evaluator.
Names, free-form task instructions, message bodies, filesystem contents, env
values, credentials and principal secrets are not policy inputs. The first
matching rule yields a denial with its ID; no match permits the product to
continue its own checks. Policy can only restrict an operation. It cannot grant
identity authority, obtain credentials, enable an add-on, choose a human login,
override consent, or turn a product refusal into success.

Bounded parsing and matching use no subprocess or network. There is no executable
hook timeout to configure. Acquisition has a bounded network/Git timeout and
never happens on the launch path. Future executable contributions require their
own reviewed isolation, authority, timeout and output protocol; this schema does
not reserve an escape hatch for them.

## Explicit activation and immutable selection

First scope: one owner-selected account policy, applied to all launches handled
by that account's daemon. It does not silently activate a soul-supplied SOP or
merge account and soul policy. Soul selections cannot weaken this account
policy. Per-soul activation/composition remains a separate reviewed extension.

Proposed command family:

```text
agent-bot sop policy show [--json]
agent-bot sop policy activate [--principal-stdin] [--json]
agent-bot sop policy deactivate [--principal-stdin] [--json]
```

`show` is a bounded offline read. Both show and activation output must list
covered entry points and say that wake/resume and external processes are not
covered; a deny rule is not a promise that the harness can never run. `activate` and `deactivate` use the existing
owner action gate; a bot binding, a selected SOP, reference-document trust, a
pack file, or another agent's message is not owner authorization. The principal
channel remains stdin and never appears in argv, output or the activation record.

Activation resolves the owner's explicit SOP selection using the supported
resolver and selection trust, reads the exact policy file from the resolved
immutable commit, validates it completely, and atomically records the policy
bytes/digest with repository, full commit, schema, activation time, account scope
and the local selection fingerprint. A absent policy file is an explicit error
when activation was requested; it is not an implicit deactivation. An empty
valid rules list can be activated and shown as having no additional rules.
Failed refresh leaves the previous active record intact.

The proposed state lives at `<existing account SOP state>/sop-policy/`, with
`state.json` pointing to content-addressed `records/<digest>.json`. Records
publish before the atomic pointer swap; first activation stages and renames
the entire directory. Launch reads the pointer and verifies the named record
without taking the transition lock. Confinement must protect this directory
from recognized soul file writes, and readiness must report its active state.
The record uses the existing account SOP state resolver; its path, schema and
write protections must be specified before implementation. Active state must be
distinguishable from a never-configured policy when the record is absent or
corrupt. A separate durable activation marker is required so deleting the policy
payload cannot silently turn a required check off. Activation/deactivation of the
marker and record must be recoverable under a lock: an interrupted transition
refuses affected operations until repaired, never treats a partial write as off.

Activation pins the chosen commit until the owner explicitly activates a newer
one. Launch does not follow moving refs, perform network refresh, or pick a
last-known record from a different selection. A changed local selection
fingerprint requires explicit reactivation. A branch advancing upstream does not
silently change an already activated revision; `show` reports the active immutable
commit. This is an explicit owner activation pin, not a freshness promise about
an unqueried remote branch.

Reference trust and policy activation are distinct records and user actions.
The policy record must validate its digest, schema, repository/commit identity,
selection fingerprint, account scope and supported-event set on every use.
Policy bytes never confer trust on themselves. Read-only file modes and existing
cooperative guards reduce accidental writes; they are not an OS boundary against
another process with the same account's authority. The product's authenticated
entry points remain the authority boundary.

## Runtime outcomes and ordering

| State | Outcome |
| --- | --- |
| No activation marker and no policy state | Existing product behavior, no network or policy work. A selected SOP alone does not activate hooks. |
| Explicitly inactive, valid owner-written state | Existing product behavior; retain an auditable deactivation receipt. |
| Active, validated policy, no matching rule | Continue existing product checks and behavior. |
| Active, matching deny rule | `policy-denied`, including safe rule ID and source commit; no prohibited side effects. |
| Active marker with missing/corrupt/mismatched policy | `policy-unavailable`; fail closed and name the owner repair command. |
| Unsupported schema/event/condition or interrupted transition | `policy-unavailable`; no fallback or partial evaluation. |

Product validation and persona policy failure take precedence over additional
pack policy. The launch integration uses an injected evaluator composed by the
host, keeping policy parsing out of identity and harness knowledge modules.
Library callers cannot supply an allow result that bypasses product authorization.
The host must wire the evaluator on every declared supported path; a missing
implementation for active policy fails closed.

Launch refusals use the existing journal/report path with an explicit stable code.
The whole rendered diagnostic, including code prefix, must fit the broker's
512-character budget. Audit receipts contain event, outcome, policy digest,
repository/commit and rule ID, without request payloads or credentials. Failure
to send a notification cannot change a denied operation into an executed one.
An audit-write failure still denies, with `policy-denied-audit-failed` or
`policy-unavailable-audit-failed`; it cannot turn into an allow or an automatic
retry loop.

## Initial implementation acceptance

1. Pure schema/evaluator fixtures cover limits, unknown fields/events, duplicate
   IDs, exact matching, deny/no-match and malicious executable-looking fields.
2. Acquisition uses a real fixture Git repository with two commits: advancing a
   branch cannot change an activated policy. Test changed local selection,
   foreign trust refusal and explicit owner refresh.
3. Activation tests cover unauthorized callers, exact principal handling,
   interrupted writes, missing payload with active marker, explicit deactivation,
   preserved previous state on refresh failure, and offline evaluation.
4. Actual `createLaunchHandler` fixtures count all downstream calls. Denied or
   unavailable policy must make zero spawn/fork/bind/provision/provider/executor
   calls for package launches, relaunches and team launches. Journal/audit refusal
   evidence is checked separately from those side effects.
5. No-policy tests preserve zero-SOP/default behavior and both add-on gates. A
   policy no-match never bypasses failed product auth or persona readiness.
6. Real daemon composition proves the injected evaluator is present for all
   supported launch entry points, and the bounded refusal reaches the broker/UI.
7. Existing harness/Git hooks and post-spawn warning behavior remain unchanged.
   Tests and docs must label unsupported bind/spawn/send/commit/push activation
   explicitly. No test may imply control of uninstrumented external processes.
