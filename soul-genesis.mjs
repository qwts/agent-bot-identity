// Genesis v1: see docs/soul-genesis.md for the byte-level UUIDv8 contract.
import { createHash, randomBytes } from 'node:crypto';
import { validateAgentId } from './agent-identity.mjs';
import { canonicalJson } from './canonical-json.mjs';

export function validateGenesis(genesis) {
  if (!genesis || typeof genesis !== 'object' || Array.isArray(genesis)
    || Object.keys(genesis).sort().join(',') !== 'parentSoul,revision') {
    throw new Error('genesis must contain only revision and parentSoul');
  }
  if (typeof genesis.revision !== 'string' || !/^sha256:[0-9a-f]{64}$(?![\s\S])/.test(genesis.revision)) {
    throw new Error('genesis revision must be sha256:<64 lowercase hex digits>');
  }
  if (genesis.parentSoul !== null) validateAgentId(genesis.parentSoul);
  return genesis;
}

export function spawnNonce() {
  return randomBytes(32).toString('hex');
}

export function deriveSoulId({ revision, parentSoul = null, nonce }) {
  validateGenesis({ revision, parentSoul });
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(nonce)) {
    throw new Error('spawn nonce must be 32 bytes encoded as 64 lowercase hex digits');
  }
  const bytes = createHash('sha256').update(canonicalJson({ revision, parentSoul, nonce }), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `agent_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
