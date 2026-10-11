// Text shown to the owner in signed statements and presence prompts.
export const MAX_TEXT_BYTES = 500;
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_TEXT_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

export function textProblem(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'the text is empty';
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return `the text is longer than ${MAX_TEXT_BYTES} bytes`;
  if (UNSAFE_TEXT.test(text)) return 'the text has a control, line-break or bidirectional character';
  return null;
}

// Keep the human-readable summary within the statement wire contract while
// preserving whole Unicode code points and the existing short-summary bound.
export function boundedOwnerSummary(value, maxCodePoints = 400) {
  const summary = String(value).replace(UNSAFE_TEXT_GLOBAL, ' ');
  const points = Array.from(summary);
  if (points.length <= maxCodePoints && Buffer.byteLength(summary, 'utf8') <= MAX_TEXT_BYTES) return summary;

  const prefix = [];
  let bytes = 0;
  for (const point of points) {
    if (prefix.length >= maxCodePoints - 1) break;
    const pointBytes = Buffer.byteLength(point, 'utf8');
    // Reserve room for the visible truncation mark.
    if (bytes + pointBytes + Buffer.byteLength('…', 'utf8') > MAX_TEXT_BYTES) break;
    prefix.push(point);
    bytes += pointBytes;
  }
  return `${prefix.join('')}…`;
}
