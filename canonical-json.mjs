// Canonical JSON: the byte form soul revisions and genesis IDs hash. Shared
// because identity derives soul IDs from it and soul hashes packages with it;
// changing a byte here changes every revision and derived soul ID.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// JSON.stringify supplies scalar encoding; object keys sort by UTF-16 code units.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('soul.json numbers must be finite');
  return JSON.stringify(value);
}
