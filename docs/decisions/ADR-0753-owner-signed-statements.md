# ADR-0753: Owner-signed statements

**Status:** Proposed
**Date:** 2026-10-09
**Issue:** [qwts/agent-bot-identity#753](https://github.com/qwts/agent-bot-identity/issues/753)

## Context

Agents cannot tell a real owner decision from an agent's claim of one. On
[#603](https://github.com/qwts/agent-bot-identity/issues/603) a subagent
rightly refused to act on an "owner decision" that a bot had posted: anything
an agent writes, another agent can forge.

keyd owner presence ([#416](https://github.com/qwts/agent-bot-identity/issues/416),
[keyd protocol](../keyd-protocol.md#owner-presence-keyd--agent-bot)) already
proves the owner is at the Mac: keyd signs a `p1.` assertion over the SHA-256
of one action and an agent-bot nonce, after Touch ID or the login password,
with a key agent-bot pins from the code-signed binary. It has two limits:

- **It only gates agent-bot's own owner actions.** An agent cannot use it to
  check a decision written in an issue, a PR or a chat.
- **It needs a GUI session on the agent's machine.** Over SSH, on a remote or
  cloud host, in CI and for subagents keyd answers `presence-unavailable`,
  and the gate falls back to the administrator dialog, which those contexts
  cannot show either.

The direction this record designs to was given in chat on 2026-10-09 and
written into the issue body and
[comment](https://github.com/qwts/agent-bot-identity/issues/753) by
qwts-claude-agent: the owner's key lives in a store agents cannot read, the
owner signs statements with it, and a signed challenge is also the fallback
when presence is unavailable. The owner signs wherever the key is (another
Mac, a phone, a hardware key); the agent's machine holds only the pinned
public key. Because a bot wrote those down, they are not themselves verified
owner decisions, which is the gap this record is about. The record is a
proposal until the owner accepts it.

The governing principle of 2026-10-09 applies: an authenticated owner is not
refused. When authorization is needed and presence is unavailable, the agent
asks for a signature instead of refusing. Fail-closed still applies to
unauthenticated and agent-originated claims.

## Decision

### 1. The statement format

A statement uses the same envelope as grants and presence assertions, with
its own prefix and audience, so neither can be read as the other:

```text
s1.<base64url(payload JSON)>.<base64url(signature)>

payload: { v: 1, aud: "agent-bot-owner-statement", kind, alg, key,
           text, scope, action, nonce, iat, exp }
```

- The signature covers the ASCII bytes of the payload segment as sent.
- `v` is 1. A verifier refuses any other version and any unknown field.
- `aud` is `agent-bot-owner-statement`, never `agent-bot-owner` (presence)
  or `agent-bot-keyd` (grants).
- `kind` is `statement` (signed on the owner's own initiative) or
  `challenge` (signed in answer to an agent's request, section 4).
- `alg` names the signature format the store produces: `ed25519` (raw
  Ed25519, keyd) or `sshsig` (an SSH signature with namespace
  `agent-bot-owner-statement`, section 5).
- `key` is the SHA-256 fingerprint of the signing public key, so the
  verifier picks the enrolled key without trying each one.
- `text` is the decision in the owner's words: UTF-8, one paragraph, at most
  500 bytes, no control or bidirectional-override characters. The limit
  keeps the whole text inside the signing prompt.
- `scope` names where the statement applies. Exactly three shapes are
  valid: `{ repo, number }` (a GitHub `owner/name` and an issue or PR
  number), `{ host }` (one machine), and `{ host, repo, number }`. `repo`
  and `number` always appear together. A `statement` uses `{ repo, number }`;
  a `challenge` always has `host`, plus `repo` and `number` when its
  action has them. Any other shape is refused.
- `action` is `hex(sha256(action))` for a challenge, the same `actionDigest`
  presence uses, and `null` for a statement.
- `nonce` is 16 to 64 base64url characters. For a challenge the agent
  chooses it; for a statement the signer does.
- `iat` and `exp` are whole Unix seconds (section 7).

### 2. `agent-bot owner sign` and `agent-bot owner verify`

- **`agent-bot owner sign "<text>" --repo R --issue N [--expires 7d]`** builds
  the payload, shows the exact text and scope, and asks the configured store
  to sign. keyd builds its own prompt from the payload, so the owner never
  signs blind; the ssh store has no such display (section 5). It prints
  the token inside a block agents recognise:

  ```text
  -----BEGIN AGENT-BOT OWNER STATEMENT-----
  s1.eyJ2IjoxLC...
  -----END AGENT-BOT OWNER STATEMENT-----
  ```

  `owner sign` refuses a caller with soul markers, as `assertOwnerAction`
  does. That is a courtesy, not the boundary: the boundary is that the store
  needs the owner's touch, PIN or Touch ID.
- **`agent-bot owner sign --challenge <challenge>`** signs a challenge an
  agent issued (section 4), copying its `action`, `nonce` and `scope`.
- **`agent-bot owner verify <token|file|->`** finds the block, checks it
  against the enrolled keys, and prints the verified text, scope and expiry,
  or one refusal code (`statement-invalid`, `statement-expired`,
  `statement-unknown-key`, `statement-scope-mismatch` when `--repo` and
  `--issue` are given and differ). It needs no secrets, no network and no
  daemon, so CI and any agent can run it.

The verifier is plain `node:crypto`: Ed25519 for `ed25519`, and the SSHSIG
structure for `sshsig` with `ssh-ed25519` and `sk-ssh-ed25519@openssh.com`
keys. It does not shell out to `ssh-keygen`, so it works where that is
missing.

### 3. Enrolling the owner's key

`agent-bot owner enroll --store keyd|ssh [--name N] [--pub <key>]` pins a
public key in `<state>/owner/keys.json` (mode 0600), with its name, store,
`alg`, fingerprint and the time it was pinned.

- **Enrolment needs presence.** It goes through `assertOwnerAction`, so keyd
  presence or the administrator dialog on a machine with a GUI. An agent
  therefore cannot swap in its own key.
- **The owner proves possession.** After presence, enrolment asks the new key
  to sign an enrolment challenge and pins it only if that verifies.
- **A statement never enrols, rotates or removes a key**, not even one signed
  by an enrolled key. Otherwise the fallback could bootstrap itself.
  `owner remove <name>` needs presence as well.
- Every attempt leaves an audit receipt (`event: owner-key`,
  `operation: enroll|remove`, `decision: approved|refused|failed`,
  fingerprint), whether it changed the pins or not, as `keyd-signer` pins do.
- For the keyd store, `--pub` is not taken from the caller: agent-bot asks
  keyd for the statement key's public half on `owner.sock` only after
  presence verifies with the presence key, which is pinned from the signed
  binary.

Hosts with no GUI cannot show presence, so they cannot enrol locally. They
get their pins from the organization profile: the profile carries the owner's
enrolled public keys (name, store, `alg`, fingerprint), and `bootstrap` installs
them into `<state>/owner/keys.json`. A key reaches the profile only after it
was enrolled with presence on a trusted machine. Verification then reads only
the local pins, so it works offline. Nothing is fetched from GitHub or any
other service at verify time, as the runtime must not depend on reaching
GitHub.

### 4. The challenge fallback

The owner gate's order becomes:

1. keyd presence;
2. when presence is `presence-unavailable` and an owner key is enrolled, a
   **signed challenge**;
3. the administrator dialog, only when no owner key is enrolled (today's
   behaviour);
4. otherwise `owner-unreachable`, with the steps to enrol a key.

A refusal at any step (`owner-declined`, `presence-invalid`) is still final
and asks nobody else.

The challenge is an unsigned statement template the agent prints, posts to
its inbox or hands to its parent session: `kind: challenge`, the action
summary in `text`, its `action` digest, `scope: { host }` (plus repo and
number when the action has them), a fresh agent-bot nonce, and the `exp` the
agent will accept. The owner runs `owner sign --challenge` wherever the key
is, and the reply comes back pasted into the waiting prompt, through the
inbox, or on the daemon's decision routes (`POST /v0/approvals/decide`,
`POST /v1/proposals/<id>/decision`) as a `statement` field.

The gate accepts the reply only when it verifies under an enrolled key and
every request-bound field equals the pending challenge the gate itself
recorded: `kind`, `text`, `scope`, `action` and `nonce`, with `exp` no
later than the challenge's. `text` is the action summary whose digest is
`action`, so the words the owner saw are the words of the pending request.
The template is unsigned while it travels, so a relay that edits any field
gets a reply the gate refuses. Who carried the reply does not matter:
a subagent, an SSH session or a CI log can relay it, but none can forge it.
A challenge-bound reply is the same authority as a presence assertion: it
satisfies `confirmOwnerPresence` and `assertOwnerAction`, never more.

### 5. Pluggable stores

A store has two operations: return its public key, and sign a payload segment
after showing the text to the owner. The runtime ships the protocol, the
verifier and these stores; a host app provides only UI (#752).

- **keyd (macOS).** A new keyd RPC, `owner/sign { payload }`, takes only
  the payload segment. keyd parses and validates it, builds the Touch ID
  prompt from that payload's `text` and `scope`, and signs exactly those
  bytes, so no caller can show one text and sign another. It signs with a
  separate Keychain seed, the owner statement key, not the presence seed. Keeping them apart means a
  presence assertion can never be a statement and either key rotates on its
  own. This is GeniusBar-side and is reviewed there; this repository owns the
  contract and records it in [keyd-protocol.md](../keyd-protocol.md) when
  it is built.
- **ssh (elsewhere).** `ssh-keygen -Y sign -n agent-bot-owner-statement` with
  a FIDO key (`sk-ssh-ed25519@openssh.com`). The verifier requires the
  user-presence flag, and the user-verified flag when the key was enrolled
  with `verify-required`. A plain `ssh-ed25519` key file lives where an
  agent in the owner's account can read it, so the ssh store accepts one
  only with `--allow-software-key`, which `owner enroll` names as weaker.

  **This store has no trusted display.** A security key proves a touch or a
  PIN, not what was signed: an agent that controls the terminal can run
  `ssh-keygen` itself with other bytes and ask for a touch. So the ssh store
  keeps the no-blind-signing rule only when `owner sign` runs on a machine
  where no agent runs in the owner's account, such as the owner's own laptop
  or phone, never on an agent host. `owner enroll --store ssh` records that
  condition and says so, and `owner sign` with the ssh store refuses a
  caller with soul markers or a harness environment. Where a trusted display
  is needed on an agent host, use keyd.

A phone store (passkey) can be added later on the same interface.

### 6. How agents treat a verified statement

An agent treats a statement as owner approval only when all of these hold:

- `agent-bot owner verify` accepts it, with `--repo` and `--issue` set to the
  work at hand;
- it is a `statement`, or a `challenge` the agent itself issued;
- its verified text covers the change. The agent quotes that text in the PR
  or comment that acts on it, and reads the text from the verifier, never
  from prose beside the block.

Such a statement is approval for the changes agents otherwise stop on:
persisted formats and state paths, security and authorization boundaries,
and public contracts. It changes what an agent may decide, not what the
runtime enforces: a standalone statement has no `action`, so it never
satisfies a runtime owner gate, and it grants no credential.

Everything else stays an agent's claim. An unsigned "owner decision", a
statement signed by any soul or App key, or a block that fails to verify is
not approval, and the agent says so instead of acting.

### 7. Replay and expiry

- **Lifetimes.** A challenge: default 10 minutes, at most 15, long enough to
  reach another device. A statement: default 7 days, at most 30.
- **Skew.** `iat ≤ now + 30` and `now ≤ exp + 30`, and `0 < exp − iat` within
  the limit for its kind, as for presence.
- **Challenges are single-use by construction.** The nonce is agent-bot's,
  fresh per request, and must match the pending request; once the request is
  decided it is gone, so no spent-nonce store is needed.
- **Statements may be presented again inside their scope and lifetime.**
  Presenting the same decision for the same issue twice is the same decision.
  Scope stops it being carried to another repository or issue; `exp` stops
  it outliving the work.
- **Conflicts cannot be ordered offline.** A verifier given one token cannot
  know a newer one exists, so an older approval stays valid until its `exp`
  if the newer one is withheld. Agents read the issue or PR the scope names,
  where statements are posted, and act on the latest verified one they find;
  that is best effort, and the real bound is the short lifetime. To withdraw
  an approval sooner, the owner signs a statement in the same scope saying so
  and, if it matters more than that, removes the key.
- **Removing a key is local.** `owner remove` changes only that host's pins,
  and offline verification never asks anyone else. A lost key must be removed
  on every host that pinned it. Hosts and CI that pin from the organization
  profile drop keys that are gone from it on their next profile refresh
  (bootstrap or repair), without asking, since dropping a key only tightens;
  adding a key still needs presence. That refresh is the only network step,
  and verification itself stays offline. There is no per-statement
  revocation list.

## Consequences

- Agents gain a decision they can check without trusting whoever posted it,
  and an owner on SSH, a remote host or CI is asked to sign instead of being
  refused.
- Accepting this record adds the `agent-bot owner` command, the
  `<state>/owner/keys.json` state file, the `s1.` format and a keyd RPC.
  Each is a new contract and is reviewed when built; none exists today.
- The administrator dialog stops being the fallback wherever an owner key is
  enrolled. A host with an enrolled key but no reachable owner now waits for
  a reply instead of showing a dialog.
- The verifier must parse SSHSIG and FIDO flags itself to stay free of
  dependencies and of `ssh-keygen`. That is more code to get right than raw
  Ed25519, and needs test vectors from real keys.
- A statement is only as strong as the agent's reading of its text. The
  signature proves who said it and where; whether the text covers a change is
  still judgement, which is why agents quote it.
- A software ssh key is weaker than the owner's direction asks for. It is
  allowed only by an explicit flag.

## Answers (owner, 2026-10-09)

The owner answered the four open questions in chat on 2026-10-09. These
answers were relayed by an agent, so under this record's own rule they are
not themselves a verified owner statement. The record stays Proposed until
the owner accepts it.

1. **Binding:** a statement binds to its scope only: the repository and the
   issue or PR. It names no agent or session. Any agent working on that issue
   may act on it, and a challenge already binds to one request through its
   nonce.
2. **Expiry:** every statement expires, 7 days by default and 30 at most.
   The merged PR that quotes the statement is the lasting record, and a new
   decision gets a new statement.
3. **Key source:** the owner's keys are enrolled locally with presence and
   distributed through the organization profile, and verification is
   offline (section 3). They are not read from the owner's GitHub account's
   SSH signing keys, because the runtime must not depend on reaching GitHub.
4. **Number of keys:** several named keys, at most four, each enrolled with
   presence (for example a Mac's keyd, a phone and a hardware key). Any one of
   them can sign, and losing a device means removing that one key.
