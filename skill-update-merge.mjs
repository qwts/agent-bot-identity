// Exact-file three-way comparison for reviewed library updates. The caller
// supplies inventories already validated by the skill acquisition boundary.
// This mechanism never rewrites text or inserts conflict markers.
const same = (left, right) => left === undefined ? right === undefined
  : right !== undefined && left.mode === right.mode && left.bytes.equals(right.bytes);
function files(entries) {
  const result = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || !Buffer.isBuffer(entry.bytes)
      || !['100644', '100755'].includes(entry.mode) || result.has(entry.path)) throw new Error('invalid update inventory');
    result.set(entry.path, entry);
  }
  return result;
}
export function mergeSkillUpdate(baseEntries, localEntries, upstreamEntries) {
  const base = files(baseEntries), local = files(localEntries), upstream = files(upstreamEntries);
  const entries = [], conflicts = [], decisions = [];
  for (const file of [...new Set([...base.keys(), ...local.keys(), ...upstream.keys()])].sort()) {
    const b = base.get(file), l = local.get(file), u = upstream.get(file);
    let selected, decision;
    if (same(l, u)) { selected = l; decision = 'same-result'; }
    else if (same(l, b)) { selected = u; decision = 'take-upstream'; }
    else if (same(u, b)) { selected = l; decision = 'keep-local'; }
    else { conflicts.push({ path: file, reason: !b ? 'both-added' : !l || !u ? 'delete-modify' : 'both-modified' }); continue; }
    decisions.push({ path: file, decision, removed: selected === undefined });
    if (selected) entries.push({ path: selected.path, bytes: Buffer.from(selected.bytes), mode: selected.mode });
  }
  // Two independently valid inventories can merge into a file/directory or
  // portable-name collision. Detect it before any filesystem publication.
  const paths = new Map(entries.map(entry => [entry.path.normalize('NFC').toLowerCase(), entry.path]));
  const seen = new Map();
  for (const entry of entries) {
    const normalized = entry.path.normalize('NFC').toLowerCase(), prior = seen.get(normalized);
    if (prior) conflicts.push({ path: entry.path, otherPath: prior, reason: 'portable-name-collision' });
    seen.set(normalized, entry.path);
    const parts = normalized.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = paths.get(parts.slice(0, i).join('/'));
      if (parent) conflicts.push({ path: entry.path, otherPath: parent, reason: 'file-directory-collision' });
    }
  }
  return { status: conflicts.length ? 'conflicted' : 'ready', entries, conflicts, decisions };
}
