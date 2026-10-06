# Soul profile

```sh
agent-bot soul profile <agentId|name> [--json]
agent-bot soul profile <agentId|name> --file RELATIVE_PATH [--json]
```

Names resolve exactly as `soul show`: census handle first, then display name;
ambiguous names require an Agent ID. Unknown souls fail with `soul-not-found`
and exit 1. This command does not provision, repair, fetch, start a harness,
read credential stores, or update a moved soul's census registration.

The JSON contract always includes these fields (unknown scalars are `null`,
collections are `[]`):

```json
{
  "agentId": "agent_…",
  "profile": {
    "name": null, "displayName": null, "description": null, "harness": null,
    "package": null, "revision": null, "template": null,
    "parentId": null, "status": null
  },
  "files": [],
  "skills": [],
  "credentials": [],
  "sop": { "resolved": null, "override": null },
  "errors": []
}
```

`name` is the census handle; `displayName` prefers the census display name,
then the package name. `harness` comes from the execution identity, not the
package's preference list. `package` is the absolute installed package path,
`revision` is its declared revision, and `template` is its boolean template
flag. Reading does not validate the entire package or recompute its revision.

- Files are `{path, kind, size, modifiedAt, text}`. Paths are relative to the
  soul directory, sizes are bytes, and timestamps are ISO 8601. Kinds are
  `soul`, `generated`, `harness-settings`, `context`, or `skill`. `text` is a
  UTF-8/NUL check of an initial bounded sample; a contents request validates
  the entire file. At most 500 files are returned, with a truncation error.
- Skills are `{name, source, path, commit}`. Package `skills/NAME/SKILL.md`
  entries have source `soul` and commit `null` (the package uses a revision,
  not a Git commit). Generated skill copies appear in files only. SOP skills,
  when resolvable offline, use source `sop` and their pinned Git commit.
  Skills in a local `sop/` override are available without an online selection;
  their paths start with `sop/` and their commit is `null`.
- Credentials are `{name, provider, status}`. The current declaration schema
  supports GitHub Apps: `name` is the declared App slug, provider is `github`,
  and status is `declared`. There is no existing secret-free existence probe,
  so the profile never claims `present` or `missing` and never returns a store
  path or a value.
- SOP is `{resolved, override}`. Resolved selections use `{source, commit}`
  (repository and pinned commit). The current SOP resolver needs online
  organization pins for configured selections; profiles return `null` and an
  `errors` entry instead. They do not infer selection or trust from a document
  cache. Overrides use `{path, workflows}`: a relative `agent-sop.toml`, `sop`,
  or `workflows` path and a list of relative `workflows/NAME.toml` paths.
- Errors are `{area, message}` for partial, unavailable or unsafe data.

The inventory includes soul instructions, native skill files and assets,
known harness instruction aliases and settings. The same allowlist applies
inside `.soul-state/home/`, where provisioned harness files live. Other state,
credential/auth/token/key/environment files, `.git`, `node_modules`, links,
and special files are excluded. Unknown harness subdirectories are not walked.

`--file` requires an exact inventory path. Absolute paths, traversal, unsafe
links and non-UTF-8 data fail with `soul-profile-file-denied`. Files larger
than 256 KiB fail with `soul-profile-file-too-large`; the exported reader's
`maxBytes` option can lower that limit. Plain output is the exact text;
JSON is `{agentId, path, size, contents}`.

`GET /v0/soul/profile?agentId=…` returns the profile object directly, with the
same loopback and bearer authentication as population reads. Missing `agentId`
is HTTP 400 and an unknown soul is HTTP 404 with code `soul-not-found`.
`daemonClient(...).soulProfile(agentId)` calls it. There is no daemon file
contents route.
