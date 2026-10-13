// The raw Ed25519 public key, base64url (a JWK `x`), read from the key's SPKI
// DER export: the 32 bytes after its fixed 12-byte prefix. Tests use this, not
// `export({ format: 'jwk' })`: on Node 20.20.2, JWK export of a generated
// Ed25519 key aborts the process (SIGABRT) after enough calls without a GC
// in between, and the owner-decision tests make many keys (#1111).
export function rawEd25519(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (der.length !== 44) throw new Error('not an Ed25519 SPKI public key');
  return der.subarray(12).toString('base64url');
}
