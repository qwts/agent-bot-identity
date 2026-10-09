import test from 'node:test';
import assert from 'node:assert/strict';

// Adapter-independent state/history contract. A fixture supplies two valid
// successive transactions, a store, reopen(), and crash(transaction, boundary).
export function dreamStoreConformance(name, fixture, { skip = false } = {}) {
  test(`${name}: commits state and history together, persists across reopen, and refuses stale revisions`, { skip }, async t => {
    const f = await fixture(t);
    assert.equal(f.store.read(), null);
    assert.equal(f.store.commit(f.first), true);
    assert.deepEqual(f.store.read(), f.first.state);
    assert.equal(f.store.commit(f.first), false);
    let reopened = f.reopen();
    assert.deepEqual(reopened.read(), f.first.state);
    assert.deepEqual(reopened.history().records, [{ revision: 1, events: f.first.events }]);
    assert.equal(reopened.commit(f.second), true);
    reopened = f.reopen();
    assert.deepEqual(reopened.read(), f.second.state);
    const page = reopened.history({ limit: 1 });
    assert.deepEqual(page, { records: [{ revision: 1, events: f.first.events }], nextRevision: 1, remaining: 1 });
    assert.deepEqual(reopened.history({ afterRevision: page.nextRevision }).records, [{ revision: 2, events: f.second.events }]);
  });
  for (const boundary of ['before-create', 'after-create', 'after-partial-write', 'after-write', 'after-file-fsync', 'after-publish', 'after-directory-fsync']) {
    test(`${name}: process interruption at ${boundary} recovers a complete old or new state/history pair`, { skip }, async t => {
      const f = await fixture(t);
      assert.equal(f.store.commit(f.first), true);
      await f.crash(f.second, boundary);
      const reopened = f.reopen(), state = reopened.read(), history = reopened.history();
      assert.ok(state.revision === 1 || state.revision === 2);
      const expected = state.revision === 1 ? f.first : f.second;
      assert.deepEqual(state, expected.state);
      assert.deepEqual(history.records, state.revision === 1
        ? [{ revision: 1, events: f.first.events }]
        : [{ revision: 1, events: f.first.events }, { revision: 2, events: f.second.events }]);
      assert.equal(history.remaining, 0);
      if (boundary === 'after-directory-fsync') assert.equal(state.revision, 2, 'acknowledgeable transaction survives process exit');
    });
  }
}
