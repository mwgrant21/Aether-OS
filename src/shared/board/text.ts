// Pure text helpers for the Traffic feed: render-time secret masking and the
// body cap. No node imports so this file can be bundled into the renderer.
// Masking is pattern-based and conservative ("obvious secrets", not a DLP);
// always mask BEFORE capping so a secret straddling the cap cannot leak half.

const REDACTED = '[redacted]';

// Each rule is replaced wholesale unless it carries capture groups, in which
// case the replacement keeps the label (Bearer, key name) and masks the value.
// Values exclude '[' so an already-masked value never re-matches (idempotent).
const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{20,}/gi, `$1$2${REDACTED}`],
];

// Assignment rule, applied with a function so obvious code shapes are kept.
const ASSIGN_RE =
  /(?<![A-Za-z0-9])(password|passwd|pwd|secret[_-]?(?:access[_-]?)?key|private[_-]?key|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b(["']?)(\s*[:=]\s*)(["']?)([^\s"',;[]{6,})/gi;
const TYPE_WORDS = new Set([
  'string', 'number', 'boolean', 'null', 'undefined', 'true', 'false', 'required', 'optional',
]);

// A value is a code shape (not a secret) when it is a call (ident followed by
// "("), a member access (a.b), or a type/keyword token (optionally a | union).
// Plain secret-looking words stay masked (fail-closed).
function isCodeShape(v: string): boolean {
  if (/^[A-Za-z_$][\w$]*\(/.test(v)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return true;
  return v.split('|').every((p) => TYPE_WORDS.has(p.toLowerCase()));
}

export function maskSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out.replace(ASSIGN_RE, (m, k, q1, sep, q2, v: string) =>
    isCodeShape(v) ? m : `${k}${q1}${sep}${q2}${REDACTED}`,
  );
}

// Default mirrors BODY_CAP in ./types; T3 passes BODY_CAP explicitly.
export function capBody(
  text: string,
  cap = 8000,
): { body: string; bodyLength: number; truncated: boolean } {
  const bodyLength = text.length;
  if (bodyLength <= cap) return { body: text, bodyLength, truncated: false };
  let end = cap;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { body: text.slice(0, end), bodyLength, truncated: true };
}
