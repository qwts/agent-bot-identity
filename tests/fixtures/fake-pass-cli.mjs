// In-memory pass-cli command fixture. Never executes a process or accesses HOME.
// The first vault's share ID is `test-vault`; any others get their own.
export function fakePassCli({ vaults = ['Agent Identities'] } = {}) {
  const shares = vaults.map((name, index) => ({ name, share_id: index ? `test-vault-${index + 1}` : 'test-vault' }));
  const items = new Map();
  const calls = [];
  let sequence = 0;
  const run = (args, { input } = {}) => {
    calls.push([...args]); // Deliberately excludes secret stdin.
    const option = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === 'vault' && args[1] === 'list') {
      return JSON.stringify(shares);
    }
    const share = option('--share-id');
    if (args[0] !== 'item' || !shares.some((entry) => entry.share_id === share)) throw new Error('unexpected fake command');
    if (args[1] === 'list') return JSON.stringify([...items.values()].filter((item) => item.state === 'Active' && item.share_id === share));
    if (args[1] === 'create') {
      if (args[2] !== 'note' || option('--from-template') !== '-') throw new Error('expected stdin template');
      const content = JSON.parse(input);
      const id = `test-item-${++sequence}`;
      items.set(id, { id, share_id: share, state: 'Active', content });
      return JSON.stringify({ id });
    }
    const id = option('--item-id');
    const item = items.get(id);
    if (!item || item.share_id !== share) throw Object.assign(new Error('missing fake item'), { code: 'missing-item' });
    if (args[1] === 'view') return JSON.stringify({ item });
    if (args[1] === 'trash') { item.state = 'Trashed'; return ''; }
    if (args[1] === 'delete' && item.state === 'Trashed') { items.delete(id); return ''; }
    throw new Error('unexpected fake command');
  };
  return { run, calls, items };
}
