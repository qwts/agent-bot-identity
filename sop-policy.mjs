// Bounded, data-only policy parsing and evaluation (#677). No runtime entry
// point calls this module yet: activation and enforcing launch wiring remain
// separate work. The host supplies its canonical execution-harness vocabulary.
export const SOP_POLICY_LIMITS = Object.freeze({ bytes: 64 * 1024, rules: 64, harnesses: 32, reason: 256 });
export const SOP_POLICY_EVENTS = Object.freeze(['before-launch']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const code = (name, message) => { throw Object.assign(new Error(message), { code: name }); };
const invalid = message => code('policy-invalid', message);
const key = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
function exact(value, keys, required = keys) {
  if (!object(value) || Object.keys(value).some(name => !keys.includes(name)) || required.some(name => !Object.hasOwn(value, name))) {
    invalid('policy contains missing or unsupported fields');
  }
}
function vocabulary(canonicalHarnesses) {
  if (!Array.isArray(canonicalHarnesses) || !canonicalHarnesses.length || canonicalHarnesses.length > 128
    || canonicalHarnesses.some(name => !key(name)) || new Set(canonicalHarnesses).size !== canonicalHarnesses.length) {
    code('policy-context-invalid', 'the host must provide distinct canonical execution harness keys');
  }
  return new Set(canonicalHarnesses);
}
function validate(value, { canonicalHarnesses } = {}) {
  const known = vocabulary(canonicalHarnesses);
  exact(value, ['schemaVersion', 'rules']);
  if (value.schemaVersion !== 1) invalid('unsupported policy schemaVersion');
  if (!Array.isArray(value.rules) || value.rules.length > SOP_POLICY_LIMITS.rules) invalid('policy rules exceed the supported bound');
  const ids = new Set();
  const rules = value.rules.map(rule => {
    exact(rule, ['id', 'event', 'decision', 'when', 'reason']);
    if (typeof rule.id !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(rule.id) || ids.has(rule.id)) invalid('policy rule IDs must be distinct ASCII identifiers');
    ids.add(rule.id);
    if (!SOP_POLICY_EVENTS.includes(rule.event)) code('policy-event-unsupported', 'this policy evaluator supports only before-launch');
    if (rule.decision !== 'deny') invalid('policy rules may only deny continuation');
    if (typeof rule.reason !== 'string' || !rule.reason.trim() || [...rule.reason].length > SOP_POLICY_LIMITS.reason
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(rule.reason)) invalid('policy reason must be bounded text without controls');
    exact(rule.when, ['harnesses'], []);
    let when = {};
    if (Object.hasOwn(rule.when, 'harnesses')) {
      const list = rule.when.harnesses;
      if (!Array.isArray(list) || !list.length || list.length > SOP_POLICY_LIMITS.harnesses || new Set(list).size !== list.length
        || list.some(name => !known.has(name))) invalid('policy harness matches must be distinct canonical execution keys');
      when = { harnesses: Object.freeze([...list]) };
    }
    return Object.freeze({ id: rule.id, event: rule.event, decision: 'deny', when: Object.freeze(when), reason: rule.reason });
  });
  return Object.freeze({ schemaVersion: 1, rules: Object.freeze(rules) });
}

/** Parse exact UTF-8 bytes; never fetch, interpret, or execute policy content. */
export function parseSopPolicy(input, options = {}) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) invalid('policy must be UTF-8 JSON text');
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  if (bytes.byteLength > SOP_POLICY_LIMITS.bytes) invalid('policy exceeds 64 KiB');
  let text, value;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    // Strings with lone surrogates must not silently acquire replacement bytes.
    if (typeof input === 'string' && text !== input) throw new Error('invalid Unicode');
    value = JSON.parse(text);
  } catch { invalid('policy must be valid UTF-8 JSON'); }
  return validate(value, options);
}

/**
 * The host must provide the actual resolved execution key, not a request alias
 * or an identity-record harness label. Unsupported/missing context refuses;
 * a no-match only continues product checks and is never authorization.
 */
export function evaluateSopPolicy(policy, context, options = {}) {
  const validated = validate(policy, options);
  if (!object(context) || !SOP_POLICY_EVENTS.includes(context.event)) code('policy-event-unsupported', 'this policy evaluator supports only before-launch');
  if (!vocabulary(options.canonicalHarnesses).has(context.harness)) {
    code('policy-context-invalid', 'policy requires the resolved canonical execution harness');
  }
  const match = validated.rules.find(rule => rule.event === context.event && (!rule.when.harnesses || rule.when.harnesses.includes(context.harness)));
  return match
    ? { decision: 'deny', code: 'policy-denied', event: context.event, ruleId: match.id, reason: match.reason }
    : { decision: 'continue', event: context.event, ruleId: null, reason: null };
}
