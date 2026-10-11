# Owner-signed statements

An owner decision that an agent finds in an issue, a PR or a chat is only a
claim: anything one agent writes, another can forge. An owner-signed
statement is a decision the owner signs with a key no agent can read. Any
agent, CI job or subagent can check its signature offline against the pinned
keys; it counts as the owner's approval only where agent-bot-keyd vouches
for those pins on that call, which needs keyd on the host. The design is
[ADR-0753](decisions/ADR-0753-owner-signed-statements.md); this page is the
contract as built.

**Built so far:** the `s1.` format, `agent-bot owner verify`, pinned keys,
the ssh store, and signed-challenge fallbacks for the owner gate: a terminal
prompt (#822) and the daemon's decision routes. Each trusts the owner pins
only on a request where agent-bot-keyd vouches for them (see below); on any
other request the owner gate is answered by keyd presence or the
administrator dialog, as before. There is no inbox delivery yet. **Not yet:**
the keyd store (keyd's `owner/sign` RPC) and pins from the organization
profile. Until then `owner enroll --store keyd` answers
`owner-store-unavailable`.

## The statement

```text
-----BEGIN AGENT-BOT OWNER STATEMENT-----
s1.<base64url(payload JSON)>.<base64url(signature)>
-----END AGENT-BOT OWNER STATEMENT-----

payload: { v: 1, aud: "agent-bot-owner-statement", kind, alg, key,
           text, scope, action, nonce, iat, exp }
```

- The signature covers the ASCII bytes of the payload segment.
- `kind` is `statement` or `challenge`. `alg` is `ed25519` (keyd) or `sshsig`
  (an SSH signature, namespace `agent-bot-owner-statement`, as
  `ssh-keygen -Y sign` writes it, unarmored).
- `key` is the signing key's fingerprint as `ssh-keygen -l` prints it:
  `SHA256:` and unpadded base64 of the SHA-256 of its SSH public key blob. A
  raw Ed25519 key is fingerprinted as the `ssh-ed25519` blob it encodes to.
- `text` is one paragraph, at most 500 bytes of UTF-8, with no control,
  line-break or bidirectional characters.
- `scope` is `{ repo, number }` for a statement; `{ host }` or
  `{ host, repo, number }` for a challenge.
- `action` is `null` for a statement and a SHA-256 hex digest of the raw
  command-shaped action for a challenge. The bounded human-readable summary
  is carried separately in `text`; both fields are checked against the
  pending challenge.
- `nonce` is 16 to 64 base64url characters.
- `iat` and `exp` are Unix seconds. A statement lasts at most 30 days
  (7 by default), a challenge at most 15 minutes (10 by default). Clocks may
  differ by 30 seconds.

A verifier refuses any other version, any missing or unknown field, and any
shape not listed here.

## Commands

```text
agent-bot owner verify <token|file|-> [--repo OWNER/NAME --issue N] [--json]
agent-bot owner sign "<text>" --repo OWNER/NAME --issue N --key PATH [--expires 7d]
agent-bot owner sign --challenge <JSON> --key PATH
agent-bot owner enroll --store ssh --key PATH [--name NAME] [--verify-required] [--allow-software-key]
agent-bot owner keys [--json]
agent-bot owner remove NAME
```

**verify** finds the one statement block in a token, a file or stdin, checks
it against the pinned keys, and prints the verified text, scope, key and
expiry. With `--repo` and `--issue` it also checks the scope. It needs no
secret and no network. A file must be a regular file, not a
symbolic link, FIFO or device, and a file or stdin is read up to 1 MiB.

**verify says the owner approved only when agent-bot-keyd vouches for the
pins.** `<state>/owner/keys.json` is writable by anything running as the
owner, a soul included, and a security key made in software looks the same
as hardware, so a soul could pin its own key and sign its own statement
(#753). So after the signature checks out, verify asks keyd, on this call,
for its signed record of the owner keys (`owner/pins-status`, see
[the keyd protocol](keyd-protocol.md#readers)) and compares it with the pins
it just read. Only when they match does a valid statement print `verified
owner statement ...` and exit 0. Otherwise (no keyd on this host, as in CI
or over SSH; another key set; a record keyd does not control; an older
record) it is printed as `NOT owner approval: ... (<why>)` followed by
`signature valid for owner statement ...` and its text, and exits 1 with
`owner-pins-unprotected` (`--json`: `{ ok: false, code:
"owner-pins-unprotected", signature: "valid", message, pins: { code, reason
}, kind, text, scope, key, fingerprint, issuedAt, expiresAt }`). That is a
diagnostic of the signature, not a decision. Asking keyd shows no prompt.

Any other refusal exits 1 with one code:

| Code | Meaning |
|---|---|
| `statement-invalid` | not a well-formed statement, or the signature does not verify |
| `statement-unknown-key` | signed by a key not pinned here |
| `statement-expired` | authentic, but past its `exp` |
| `statement-scope-mismatch` | authentic, but scoped to another repository or issue |
| `owner-pins-unprotected` | the signature is valid against the local pins, but agent-bot-keyd did not vouch for them on this call; not approval |

The signature is checked first, so `statement-expired` and
`statement-scope-mismatch` are only ever said about an authentic statement.
`--json` prints `{ ok: false, code, message }` instead.

**sign** builds a statement scoped to one repository and issue or PR, prints
its text, scope and expiry, and asks `ssh-keygen -Y sign` to sign it with the
key at `--key` (its public half is read from `PATH.pub`). It refuses a caller
with soul markers or an agent harness's environment (`CLAUDECODE`,
`CODEX_*`, `CURSOR_AGENT`, and the others `detect-harness.mjs` keys on).

**When the challenge fallbacks answer.** `<state>/owner/keys.json` is
writable by anything running as the owner, a soul included, and a security
key made in software (`sk-ssh-ed25519` carries no attestation) looks the
same as hardware. A soul that clears its markers could pin its own key and
sign its own challenge. So no owner gate trusts the pin file on its own:
when presence is unavailable, the gate asks agent-bot-keyd, on that request
and with a fresh nonce, for its signed record of the owner keys, and uses the
pins only if it matches them ([keyd protocol](keyd-protocol.md#readers)).
There is no switch that turns this on for every request. With no keyd to
ask, another key set, a record keyd does not control or cannot read, or an
older record than seen before, the gate does what it did before pins
existed: the administrator dialog, or a refusal where nobody can see one.
A missing or malformed pin file never blocks the owner either.

The terminal fallback, on a request where keyd vouches for the pins, works
as follows.

**sign --challenge** accepts the JSON challenge shown by the waiting owner gate.
Run it on a trusted terminal with the matching SSH key, inspect the displayed
summary and host scope, then paste its armored output into the waiting prompt.
The gate accepts one reply only while that request is pending and the signing
key remains pinned. The prompt requires a TTY, reads at most 1 MiB, and waits
for at most ten minutes; EOF, blank input, cancellation, timeout, malformed
input or a bad signature refuses the action. If keyd vouches for the
enrolled owner keys but no enrolled SSH key can answer, a challenge-eligible
action refuses instead of falling back to administrator consent. The older
administrator fallback remains for hosts with no enrolled owner keys and for
pins keyd does not vouch for on that request. Enrolment and
removal go through keyd's owner key record (below) and cannot use a signed
challenge.

**On a decision route.** Deciding a soul's waiting tool request through
`POST /v0/approvals/decide` (`agent-bot approvals approve|deny`) or
`POST /v1/proposals/<id>/decision` never prompts on the daemon's terminal.
It is answered by keyd presence; when keyd cannot ask, by a signed challenge
on a request where keyd vouches for the owner pins (below); otherwise by the
administrator dialog.
The receipt of each decision records how it was authorized (`authorized:
presence`, `consent`, or `statement <key>`). A missing or malformed pin
file never blocks a decision.

Signed challenges on these routes count only on a request where
agent-bot-keyd vouches for the owner pins, as for the terminal fallback:
`<state>/owner/keys.json` is writable by anything running as the owner, a
soul included, and a security key made in software (`sk-ssh-ed25519`
carries no attestation) looks the same as hardware, so a soul could pin its
own key and sign its own approval. Pins keyd does not vouch for are no pins:
the route asks the dialog, and a reply sent with the decision is spent
unused. Where keyd vouches for them:
when keyd cannot ask and an SSH security key (`sk-ssh-ed25519` or
`sk-ecdsa`) is pinned, the route decides nothing and answers 409 with
`code: "owner-challenge-required"` and `challenges: [{ name, fingerprint,
payload }]`, one per security-key pin; the audit log records
`owner-challenged`. The owner signs one payload with `owner sign --challenge`
and the caller repeats the same decision with `statement` set to the signed
token or armored block (`agent-bot approvals approve <id> --statement
'<signed>'`). The daemon keeps one set of challenges per open proposal, in
memory, for that exact decision (approve or deny, and the scope). Any reply
spends them, verified or not; a new request without a statement replaces
them; a restart drops them. A reply for another proposal or decision, a
replay, an expired challenge or a key no longer pinned is refused with 403.
A software key pinned with `--allow-software-key` never answers a decision
route: a soul runs in the owner's account and could read it. With no
security key pinned, the route uses the administrator dialog, as it does
with no owner key at all, and so does a pin file that cannot be read.
Anything holding the daemon token can ask for a
fresh challenge or send a bad reply, which replaces or spends the pending
one for that proposal; that can only make the owner sign again, never
decide.

**enroll** pins a public key in `<state>/owner/keys.json` (0600, in a 0700
directory; `<state>` is `$XDG_STATE_HOME/agent-bot` or
`~/.local/state/agent-bot`). It asks the new key to sign an enrolment
challenge, then asks agent-bot-keyd to record the whole new key set
(`owner/pins-attest`, #753): keyd shows the owner every key the set holds,
by name and fingerprint, those already pinned included, and records it only
when they approve with Touch ID or the login password. Only then is the key
pinned. At most four keys are pinned, each under its own name.

**remove** unpins one key, also by having keyd record the remaining set.
A caller carrying a soul's Agent ID, binding or App identity is refused
before keyd is asked, as the owner gate refuses it. Neither falls back to
the administrator dialog: with no keyd that can ask
(none installed, none running, a keyd too old for `owner/pins-attest`, or
no GUI session) the pins do not change. Both write the pins under a lock,
only if the file still holds the set keyd was shown; a change made while
the owner was asked refuses with `owner-keys-changed`, and running the
command again asks afresh. The owner is never asked while the lock is held.
Removing a key is local to this host: a lost key must be removed on every
host that pinned it.

Every enroll and remove attempt leaves an `owner-key` audit receipt
(`operation: enroll|remove`, `decision: approved|refused|failed`, the key's
name and fingerprint), whether it changed the pins or not. A statement never
enrols, rotates or removes a key.

## The ssh store

- A FIDO key (`sk-ssh-ed25519@openssh.com`) is the expected key. Its
  signature must carry the user-presence flag, and the user-verified flag
  when it was enrolled with `--verify-required` (a key made with
  `ssh-keygen -O verify-required`). Signatures with extension data are
  refused.
- A plain `ssh-ed25519` key file can be read by any agent running in the
  owner's account, so it is pinned only with `--allow-software-key`, and
  enrolment says it is weaker.
- **The ssh store has no trusted display.** A security key proves a touch or
  a PIN, not what was signed. Run `owner sign` and `owner sign --challenge`
  only on a machine or terminal where no agent runs in your account. The
  challenge flow is a user-mediated CLI path; a trusted display on an agent
  host and keyd signing remain future work.

## How agents use a statement

**A statement is owner approval only where keyd vouches for the pins.**
Where it does not (no keyd on the host, as in CI or over SSH, or any of the
cases above), `owner verify` answers `owner-pins-unprotected` for every
valid signature, and an agent does not act on a statement: it asks the owner
directly, as it would without one.

An agent treats a statement as owner approval only
when `owner verify` accepts it (exit 0) with `--repo` and `--issue` set to the
work at hand, it is a
`statement` (or a challenge the agent itself issued), and its verified text
covers the change. The agent quotes that text, as the verifier printed it,
in the PR or comment that acts on it. A statement is approval for what
agents otherwise stop on (persisted formats, security boundaries, public
contracts); it never satisfies a runtime owner gate and grants no
credential. See ADR-0753 section 6.
