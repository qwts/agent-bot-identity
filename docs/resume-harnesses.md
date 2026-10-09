# Adding a resume harness

Resume wake (#323) starts one headless turn of a soul's own harness for each
message. Each harness is one row in `RESUME_HARNESSES` in `wake-resume.mjs`.
Adding one is a row of about 30 lines, a unit test, and a live pong test. It
needs no other code.

Rows today: `codex`, `opencode`, `devin`, `grok`.

## Which harness runs, and with what environment

The executor composes each turn's environment through the daemon's shared
`composeTurnEnv`, the same composition ACP turns use (#617 slice 3b). The base is
the host environment, with `resumePath` and the soul's binding and thread key.
On top of it go the soul's declared runtimes and harness installs, first on
PATH with their variables, and the provider secret for the harness. The row's
`command` is then resolved on that PATH, so a harness the soul installed wins
over the host's copy. A soul that declares nothing runs the host CLI as before.

Before any process starts, including Devin's session listing, a turn is refused
with a coded error when:

- a declared runtime or harness install is missing, mismatched or unsupported
  (`runtime-install-failed`, `runtime-unsupported-platform`);
- the provider secret cannot be read;
- the row's command is not on the composed PATH (`harness-tool-missing`).

The wake stays unacked and the recorded session is kept.

Tool-home routing (`CODEX_HOME`, OpenCode's XDG bases) is not applied on this
lane yet. Its recorded sessions live in the host store, and moving the store
would strand them. That stays open on #617.

The harness name is the row's key, so it must name the client that answers.
`grok` is Grok Build, the `grok` CLI. Grok Bot, the desktop app, has no
headless CLI; it joins as `--harness grokbot` and wakes by webhook (#334), not
by a row here. A soul that joined under the wrong name gets the wrong
harness answering as it.

Harnesses with no row:

| Harness | Wake |
| --- | --- |
| Grok Bot (desktop) | Webhook wake: a routine with a webhook trigger, set with `soul cold-wake <agentId> webhook`. |
| Copilot in VS Code | None. It sees messages when the user prompts it. |

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
| What environment does it need under launchd? | `plan().env`; the executor already composes HOME, PATH and the soul's runtimes |

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
and send it a message. Setting it is an owner action (#293): run it as the
owner, outside any soul's worktree, and approve the prompt (Touch ID or the
login password through GeniusBar's keyd, otherwise the administrator dialog), or
present the owner's principal with `--principal-stdin`. It should reply, and the census `lastWake` should read
`cold`.

## 4. Docs

Add the harness to the list in `skills/agent-bot/references/execution-identities.md`
and to this page, and add a changelog fragment (`changes/<slug>.md`, see [changes/README.md](../changes/README.md)).
