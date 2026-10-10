# Owner-signed statements

An owner decision that an agent finds in an issue, a PR or a chat is only a
claim: anything one agent writes, another can forge. An owner-signed
statement is a decision the owner signs with a key no agent can read, which
any agent, CI job or subagent can check offline. The design is
[ADR-0753](decisions/ADR-0753-owner-signed-statements.md); this page is the
contract as built.

**Built so far:** the `s1.` format, `agent-bot owner verify`, the pinned keys,
and the ssh store (`owner enroll --store ssh`, `owner sign`, `owner remove`).
**Not yet:** the keyd store (keyd's `owner/sign` RPC), the signed-challenge
fallback in the owner gate (`owner sign --challenge`), and pins from the
organization profile. Until then `owner enroll --store keyd` answers
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
- `action` is `null` for a statement and a SHA-256 hex digest for a challenge.
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
agent-bot owner enroll --store ssh --key PATH [--name NAME] [--verify-required] [--allow-software-key]
agent-bot owner keys [--json]
agent-bot owner remove NAME
```

**verify** finds the one statement block in a token, a file or stdin, checks
it against the pinned keys, and prints the verified text, scope, key and
expiry. With `--repo` and `--issue` it also checks the scope. It needs no
secret, no network and no daemon. A refusal exits 1 with one code:

| Code | Meaning |
|---|---|
| `statement-invalid` | not a well-formed statement, or the signature does not verify |
| `statement-unknown-key` | signed by a key not pinned here |
| `statement-expired` | authentic, but past its `exp` |
| `statement-scope-mismatch` | authentic, but scoped to another repository or issue |

The signature is checked first, so `statement-expired` and
`statement-scope-mismatch` are only ever said about an authentic statement.
`--json` prints `{ ok: false, code, message }` instead.

**sign** builds a statement scoped to one repository and issue or PR, prints
its text, scope and expiry, and asks `ssh-keygen -Y sign` to sign it with the
key at `--key` (its public half is read from `PATH.pub`). It refuses a caller
with soul markers or an agent harness's environment (`CLAUDECODE`,
`CODEX_*`, `CURSOR_AGENT`, and the others `detect-harness.mjs` keys on).

**enroll** pins a public key in `<state>/owner/keys.json` (0600, in a 0700
directory; `<state>` is `$XDG_STATE_HOME/agent-bot` or
`~/.local/state/agent-bot`). It goes through the owner gate (keyd presence,
or the administrator dialog where keyd cannot ask), then asks the new key to
sign an enrolment challenge and pins it only if that verifies. At most four
keys are pinned, each under its own name.

**remove** unpins one key, also through the owner gate. Removing a key is
local to this host: a lost key must be removed on every host that pinned it.

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
  a PIN, not what was signed. Run `owner sign` only on a machine or terminal
  where no agent runs in your account. Where a trusted display is needed on
  an agent host, the keyd store (not yet built) is the one to use.

## How agents use a statement

An agent treats a statement as owner approval only when `owner verify`
accepts it with `--repo` and `--issue` set to the work at hand, it is a
`statement` (or a challenge the agent itself issued), and its verified text
covers the change. The agent quotes that text, as the verifier printed it,
in the PR or comment that acts on it. A statement is approval for what
agents otherwise stop on (persisted formats, security boundaries, public
contracts); it never satisfies a runtime owner gate and grants no
credential. See ADR-0753 section 6.
