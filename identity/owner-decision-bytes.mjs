// Exact byte input for the disabled owner-decision decoders (agent-comms#77).
// A caller's Uint8Array can carry own `length`, `byteLength`, `buffer`,
// `byteOffset` or `subarray` properties, or be a Proxy, while TextDecoder and
// friends read the view's intrinsic bytes; checking the overridable ones lets
// an oversized view through a cap. This reads only the intrinsic
// %TypedArray%.prototype getters, by Reflect.apply, and returns a private
// bounded copy that callers decode instead of the input.
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic = (name) => Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, name).get;
const TAG = intrinsic(Symbol.toStringTag), BYTE_LENGTH = intrinsic('byteLength'), BUFFER = intrinsic('buffer'), BYTE_OFFSET = intrinsic('byteOffset');

// The intrinsic byte length of a genuine Uint8Array (Buffer included), or
// null for anything else. Nothing is copied.
export function intrinsicByteLength(value) {
  return Reflect.apply(TAG, value, []) === 'Uint8Array' ? Reflect.apply(BYTE_LENGTH, value, []) : null;
}

// A private copy of exactly `min`..`max` bytes from a genuine Uint8Array
// (Buffer included), or null for anything else: another typed array, a
// lookalike, a Proxy, a detached view or a length out of bounds.
export function exactBytes(value, { max, min = 1 } = {}) {
  // The tag getter answers undefined, never throws, for anything that is not
  // a typed array (a Proxy included).
  if (Reflect.apply(TAG, value, []) !== 'Uint8Array') return null;
  const length = Reflect.apply(BYTE_LENGTH, value, []);
  if (length < min || length > max) return null;
  const copy = Buffer.alloc(length);
  if (length > 0) copy.set(new Uint8Array(Reflect.apply(BUFFER, value, []), Reflect.apply(BYTE_OFFSET, value, []), length));
  return copy;
}
