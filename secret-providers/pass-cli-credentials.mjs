// Per-soul values use note templates on stdin. App-key imports and this store
// share the same bounded process runner and redacted provider errors.
import { runPass, passCliFailure } from './pass-cli.mjs';
import { CREDENTIAL_VAULT } from '../credential-names.mjs';

export const SOUL_CREDENTIAL_VAULT = CREDENTIAL_VAULT;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const malformed = () => fail('provider-failure', 'pass-cli returned malformed credential data');

export function createPassCredentialStore({ env = process.env, run = runPass } = {}) {
  const call = (args, input) => {
    try { return run(args, { env, input }); }
    catch (error) { throw passCliFailure(error); }
  };
  const json = (args) => {
    try { return JSON.parse(call(args)); }
    catch (error) { if (error instanceof SyntaxError) malformed(); throw error; }
  };
  const list = (data, key) => {
    const entries = Array.isArray(data) ? data : data?.[key];
    if (!Array.isArray(entries)) malformed();
    return entries;
  };
  const vault = () => {
    const matches = list(json(['vault', 'list', '--output', 'json']), 'vaults')
      .filter((entry) => entry?.name === SOUL_CREDENTIAL_VAULT);
    if (matches.length !== 1) fail('provider-failure', 'pass-cli credential vault is missing or ambiguous');
    const id = matches[0].share_id ?? matches[0].shareId;
    if (typeof id !== 'string' || !id) malformed();
    return id;
  };
  const find = (shareId, title) => {
    const matches = list(json(['item', 'list', '--share-id', shareId, '--filter-state', 'active', '--output', 'json']), 'items')
      .filter((entry) => (entry?.title ?? entry?.content?.title) === title);
    if (matches.length > 1) fail('ambiguous-item', 'pass-cli credential item is ambiguous');
    if (!matches.length) return null;
    const item = matches[0];
    const id = item.id ?? item.item_id ?? item.itemId;
    if (typeof id !== 'string' || !id || (item.share_id ?? item.shareId) !== shareId
      || String(item.state).toLowerCase() !== 'active') malformed();
    return id;
  };
  const read = (shareId, itemId, title) => {
    const data = json(['item', 'view', '--share-id', shareId, '--item-id', itemId, '--output', 'json']);
    const item = data?.item ?? data;
    if ((item?.id ?? item?.item_id ?? item?.itemId) !== itemId
      || (item?.share_id ?? item?.shareId) !== shareId
      || (item?.content?.title ?? item?.title) !== title
      || String(item?.state).toLowerCase() !== 'active'
      || typeof item?.content?.note !== 'string') malformed();
    return item.content.note;
  };
  const missing = () => fail('missing-item', 'pass-cli credential item was not found');
  return {
    read(title) {
      const shareId = vault();
      const itemId = find(shareId, title);
      if (!itemId) missing();
      return read(shareId, itemId, title);
    },
    write(title, value) {
      const shareId = vault();
      const itemId = find(shareId, title);
      if (itemId) {
        if (read(shareId, itemId, title) === value) return;
        // pass-cli update accepts secret fields on argv, unlike create's
        // stdin template. Refuse destructive replacement or secret argv.
        fail('credential-conflict', 'pass-cli credential item already holds a different value; the existing item was kept');
      }
      call(['item', 'create', 'note', '--share-id', shareId, '--from-template', '-', '--output', 'json'],
        JSON.stringify({ title, note: value }));
      const created = find(shareId, title);
      if (!created || read(shareId, created, title) !== value) {
        fail('provider-failure', 'pass-cli credential readback failed');
      }
    },
    delete(title) {
      const shareId = vault();
      const itemId = find(shareId, title);
      if (!itemId) missing();
      call(['item', 'trash', '--share-id', shareId, '--item-id', itemId]);
      call(['item', 'delete', '--share-id', shareId, '--item-id', itemId]);
    },
  };
}
