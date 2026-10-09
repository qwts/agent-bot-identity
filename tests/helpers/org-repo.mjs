// A local organization repository for bootstrap --repair tests (#190): a
// bare repository holding org.json and the organization profile it names,
// the restricted SOP git runner allowed the file transport, and the user's
// SOP selection written into a temporary home. No network.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRunGit } from '../../sop.mjs';

export const PROFILE_PATH = 'governance/organization-profile.json';

function git(dir, ...args) {
  const result = spawnSync('git', [
    '-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function createOrgRepo(root, profile) {
  const src = join(root, 'org-src');
  const bare = join(root, 'org.git');
  mkdirSync(join(src, dirname(PROFILE_PATH)), { recursive: true });
  writeFileSync(join(src, 'org.json'), `${JSON.stringify({
    schema_version: 1,
    organization: { id: 'example', account: 'example', profile: PROFILE_PATH },
    sources: { sop: { repo: 'example/sop', ref: '22'.repeat(20), entry: 'README.md', summary: 'The SOP.' } },
    capabilities: {},
  })}\n`);
  writeFileSync(join(src, PROFILE_PATH), `${JSON.stringify(profile, null, 2)}\n`);
  spawnSync('git', ['init', '-q', '-b', 'main', src], { encoding: 'utf8' });
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'init');
  const commit = git(src, 'rev-parse', 'HEAD');
  spawnSync('git', ['clone', '--bare', '-q', src, bare], { encoding: 'utf8' });
  const runGit = createRunGit({ allowProtocols: 'file' });
  return {
    bare,
    commit,
    // The SOP reader with the file transport and this repository as the remote.
    sopOptions: { runGit, remoteUrl: () => bare },
    select(home, ref = 'main') {
      mkdirSync(join(home, '.config', 'agent-sop'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'agent-sop', 'config.toml'),
        `schema_version = 1\n\n[repos]\norg = "example/org@${ref}"\n`,
      );
    },
  };
}
