// The raw Ed25519 public key, base64url (a JWK `x`), read from the key's SPKI
// DER export: the 32 bytes after its fixed 12-byte prefix. Tests use this, not
// `export({ format: 'jwk' })`: on Node 20.20.2, JWK export of a generated
// Ed25519 key aborts the process (SIGABRT) after enough calls without a GC
// in between, and the owner-decision tests make many keys (#1111).
// Ed25519's fixed SPKI prefix (RFC 8410): only an Ed25519 key passes, never
// another 44-byte SPKI key such as X25519.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function rawEd25519(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('not an Ed25519 SPKI public key');
  }
  return der.subarray(12).toString('base64url');
}
