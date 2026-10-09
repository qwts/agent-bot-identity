import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const codeql = readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8');
const linuxBundleRelease = readFileSync(new URL('../.github/workflows/linux-bundle-release.yml', import.meta.url), 'utf8');

test('lifecycle workflow has governed triggers, actor fields, and draft skipping', () => {
  assert.match(ci, /^  pull_request:\n/m);
  assert.match(ci, /^  push:\n    branches: \[main\]$/m);
  assert.match(ci, /^  workflow_dispatch:\n/m);
  assert.doesNotMatch(ci, /^  merge_group:/m);
  assert.match(ci, /github\.event\.pull_request\.draft == false/);
  assert.match(ci, /CI_POLICY_ACTOR: \$\{\{ github\.actor \}\}/);
  assert.match(ci, /CI_POLICY_TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/);
  assert.match(ci, /public forks/);
  assert.match(ci, /ci-policy@[0-9a-f]{40}/);
  assert.match(ci, /name: Workflow runtime policy/);
  assert.match(ci, /runtime-policy\.mjs --root/);
});

test('PR concurrency is scoped and cancels obsolete runs', () => {
  assert.match(ci, /format\('pr-\{0\}', github\.event\.pull_request\.number\)/);
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}/);
});

test('preflight evidence is exact-SHA and falls back to the complete suite', () => {
  assert.match(ci, /event=workflow_dispatch&head_sha=\$TARGET_SHA/);
  assert.match(ci, /\.path == "\.github\/workflows\/ci\.yml"/);
  assert.doesNotMatch(ci, /\.workflow_runs\[\].*\.name == "CI"/);
  assert.match(ci, /\.display_title == "CI purpose=exact-sha-preflight"/);
  assert.match(ci, /needs\.preflight-evidence\.outputs\.validated != 'true'/);
  assert.match(ci, /name: Complete suite/);
  assert.match(ci, /run: npm test/);
});

test('stable CI gate covers manual, PR, and main fallback lanes', () => {
  assert.match(ci, /name: CI\n/);
  assert.match(ci, /case "\$MODE" in/);
  assert.match(ci, /manual\)/);
  assert.match(ci, /post-merge\)/);
  assert.match(ci, /test "\$CODEQL" = success/);
  assert.match(ci, /test "\$WORKFLOW_RUNTIME" = success/);
  assert.match(ci, /test "\$SKILL_GATE" = success/);
});

test('the ENG-0055 skill gate checks the packaged tree in every lane', () => {
  assert.match(ci, /cli-skill-gate@[0-9a-f]{40}/);
  assert.match(ci, /git archive HEAD \| tar -x/);
  assert.match(ci, /skill-workflows\.test\.mjs/);
  assert.match(ci, /needs: \[policy, merge-evidence, preflight-evidence, complete, codeql, workflow-runtime, skill-gate, linux-bundle, keyd\]/);
});

// ADR-0332 decision 1 makes the headless-Linux archives a release artifact, so
// CI builds and installs one per platform and the stable gate depends on it.
test('the Linux bundle lane builds and installs an archive on both platforms', () => {
  assert.match(ci, /^  linux-bundle:\n/m);
  assert.match(ci, /runs-on: \$\{\{ matrix\.platform\.runner \}\}/);
  // Each lane's runner is a repo variable with the hosted label as the
  // default, so a hosted-runner outage is survived by setting LINUX_RUNNER
  // and LINUX_ARM_RUNNER to a self-hosted label, with no workflow change.
  assert.match(ci, /runner: \$\{\{ vars\.LINUX_RUNNER \|\| 'ubuntu-latest' \}\}\n\s+target: linux-x64/);
  assert.match(ci, /runner: \$\{\{ vars\.LINUX_ARM_RUNNER \|\| 'ubuntu-24\.04-arm' \}\}\n\s+target: linux-arm64/);
  assert.doesNotMatch(ci, /runs-on: ubuntu-latest/);
  assert.match(ci, /timeout-minutes: 25/);
  // The build is a plain node invocation; the archive is what CI tests, not a
  // hand-assembled copy of the tree.
  assert.match(ci, /TARGET: \$\{\{ matrix\.platform\.target \}\}/);
  assert.match(ci, /node scripts\/linux-bundle\/build\.mjs --platform "\$TARGET" --out dist/);
  assert.doesNotMatch(ci, /matrix\.target\b/);
  assert.match(ci, /sha256sum --check --strict SHA256SUMS/);
  // The fake systemctl is what keeps this lane off the runner's user manager.
  assert.match(ci, /sh scripts\/linux-bundle\/ci-smoke\.sh dist/);
  assert.match(ci, /test "\$LINUX_BUNDLE" = success/);
});

test('the Linux bundle release is tag-driven, verified, and uploaded beside the formula tag', () => {
  assert.match(linuxBundleRelease, /^on:\n  push:\n    tags: \['v\*'\]$/m);
  assert.doesNotMatch(linuxBundleRelease, /^  pull_request:/m);
  assert.doesNotMatch(linuxBundleRelease, /^  workflow_dispatch:/m);
  assert.match(linuxBundleRelease, /timeout-minutes: 30/);
  // A release must ship a working pair or nothing: the agent-comms pin is
  // verified, and the tag must match the runtime it names.
  assert.match(linuxBundleRelease, /build\.mjs --platform all --out dist --require-verified/);
  assert.match(linuxBundleRelease, /tagged=\$\{GITHUB_REF_NAME#v\}/);
  assert.match(linuxBundleRelease, /sh scripts\/linux-bundle\/ci-smoke\.sh dist/);
  assert.match(linuxBundleRelease, /sha256sum --check --strict SHA256SUMS/);
  // The archives land on the release for the tag, created if it is not there.
  assert.match(linuxBundleRelease, /gh release create "\$tag"/);
  assert.match(linuxBundleRelease, /gh release upload "\$tag" dist\/agent-bot-linux-\*\.tar\.gz dist\/SHA256SUMS --clobber/);
  assert.match(linuxBundleRelease, /permissions:\n  contents: write/);
});

test('advanced CodeQL is callable only through governed CI for both languages', () => {
  assert.match(codeql, /^  workflow_call:$/m);
  assert.doesNotMatch(codeql, /^  (?:pull_request|push|workflow_dispatch|schedule):$/m);
  assert.match(codeql, /language: \[actions, javascript-typescript\]/);
  assert.match(codeql, /github\/codeql-action\/init@[0-9a-f]{40}/);
  assert.match(codeql, /github\/codeql-action\/analyze@[0-9a-f]{40}/);
});

test('every third-party action reference is immutable', () => {
  for (const source of [ci, codeql, linuxBundleRelease]) {
    for (const match of source.matchAll(/uses:\s+[^\s@]+@([^\s]+)/g)) {
      assert.match(match[1], /^[0-9a-f]{40}$/);
    }
  }
});

// #767: keyd builds and tests unsigned on a GitHub-hosted macOS runner. The
// runner is a literal hosted label, not a repo variable, so outside pull
// requests never reach a self-hosted runner (#752), and the lane holds no
// signing secret: GeniusBar signs the binary.
test('the keyd lane builds and tests unsigned on a hosted macOS runner', () => {
  const lane = ci.slice(ci.indexOf('\n  keyd:\n'), ci.indexOf('\n  gate:\n'));
  assert.match(lane, /runs-on: macos-latest\n/);
  assert.match(lane, /working-directory: keyd/);
  assert.match(lane, /cargo test --locked/);
  assert.doesNotMatch(lane, /runs-on:.*(?:vars\.|self-hosted)/);
  assert.doesNotMatch(lane, /\$\{\{\s*secrets\./);
  assert.match(ci, /test "\$KEYD" = success/);
});
