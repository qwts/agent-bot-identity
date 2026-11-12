// The administrator-account check behind the web UI warning (#1408).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostAccount } from '../host-account.mjs';

const as = (username, uid = 501) => () => ({ username, uid });

test('an account in the administrator group is reported with the group', () => {
  assert.deepEqual(
    hostAccount({ platform: 'darwin', user: as('owner'), groups: () => ['staff', 'admin'] }),
    { checked: true, account: 'owner', admin: true, reason: 'group admin' },
  );
  for (const group of ['sudo', 'wheel', 'admin']) {
    const got = hostAccount({ platform: 'linux', user: as('owner', 1000), groups: () => ['owner', group] });
    assert.equal(got.admin, true);
    assert.equal(got.reason, `group ${group}`);
  }
});

test('a standard account is not an administrator', () => {
  assert.deepEqual(
    hostAccount({ platform: 'darwin', user: as('user'), groups: () => ['staff', 'everyone'] }),
    { checked: true, account: 'user', admin: false, reason: null },
  );
  // `wheel` on macOS does not grant sudo; only `admin` does.
  assert.equal(hostAccount({ platform: 'darwin', user: as('user'), groups: () => ['staff', 'wheel'] }).admin, false);
});

test('root is an administrator without asking for groups', () => {
  const got = hostAccount({ platform: 'linux', user: as('root', 0), groups: () => { throw new Error('not asked'); } });
  assert.deepEqual(got, { checked: true, account: 'root', admin: true, reason: 'root' });
});

test('a host that cannot be asked is unchecked, never an administrator', () => {
  const failing = () => { throw new Error('id: not found'); };
  assert.deepEqual(
    hostAccount({ platform: 'linux', user: as('owner', 1000), groups: failing }),
    { checked: false, account: 'owner', admin: false, reason: null },
  );
  assert.equal(hostAccount({ platform: 'linux', user: failing }).checked, false);
  assert.equal(hostAccount({ platform: 'win32', user: as('owner') }).checked, false);
});

test('the real host answers', () => {
  const got = hostAccount();
  assert.equal(typeof got.checked, 'boolean');
  assert.equal(typeof got.admin, 'boolean');
});
