# Adding a resume harness

Resume wake (#323) starts one headless turn of a soul's own harness for each
message. Each harness is one row in `RESUME_HARNESSES` in `wake-resume.mjs`.
Adding one is a row of about 30 lines, a unit test, and a live pong test. It
needs no other code.

Rows today: `codex`, `opencode`, `devin`, `grok`.

## 1. Answer the questions

Get these from the harness's own help and docs (the mailbox wake survey asks
for them), then confirm each one live:

| Question | Goes into |
| --- | --- |
| How do you run one non-interactive turn, and how do you continue a session by id? | `plan().args` |
| Can the prompt come from stdin or `--prompt-file /dev/stdin`? | `plan().stdin`; otherwise put the prompt last, after `--` |
| Where is the session id: in the output, or only in a session list? | `parse().sessionId`; otherwise `listArgs` and `sessionsIn` (see `devin`) |
| Which output is the final answer, and how is a failure reported? | `parse().reply`, `parse().failure` |
| What makes the turn run with nobody to approve anything, confined to the worktree? | `workspace` |
| What makes it answer but change nothing, with every other call denied rather than asked? | `read-only` |
| Is the sandbox or permission mode fixed when the session starts? | `policyFixedAtStart: true` |
| What environment does it need under launchd? | `plan().env`; the executor already sets HOME and PATH |

A policy must never leave a tool call waiting for approval. A turn that hangs
on an approval holds the message until it times out. Prefer an OS sandbox and
explicit deny rules over a mode that only "usually" asks.

## 2. Write the row

```js
example: Object.freeze({
  command: 'example',
  plan({ sessionId, prompt, policy }) {
    const mode = policy === 'workspace' ? [/* sandboxed, approve all */] : [/* deny edits and shell */];
    const args = [...(sessionId ? ['--resume', sessionId] : []), '--json', ...mode];
    return { args, stdin: prompt, env: {} };
  },
  parse(stdout) {
    // → { reply, sessionId, failure }; failure is a short string or null
  },
}),
```

Add a test next to the others in `tests/wake-resume.test.mjs`. Use output
recorded from a real run. Assert the flags for each policy, and assert that
`parse` handles the reply, the session id and a failure.

## 3. Pong test live

Run each step with a bare environment, as the daemon does
(`env -i HOME=$HOME PATH=/usr/bin:/bin:$HOME/.local/bin`), in a scratch git
worktree:

1. A fresh `read-only` turn replies, gives a session id, and cannot create a
   file. The denied call fails at once and does not hang.
2. Resuming that id keeps the context: ask what the last reply was.
3. A `workspace` turn can create and commit a file in a `git worktree`. Its
   git data lives outside the directory, which a sandbox can block.
4. If the policy is fixed at start, check what a mismatched resume does.

Then set a joined soul to `agent-bot soul cold-wake <agentId> resume read-only`
and send it a message. It should reply, and the census `lastWake` should read
`cold`.

## 4. Docs

Add the harness to the list in `skills/agent-bot/references/execution-identities.md`
and to this page, and add a CHANGELOG line.
