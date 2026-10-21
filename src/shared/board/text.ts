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
  [/\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{20,}/g, `$1$2${REDACTED}`],
  [
    /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b(\s*[:=]\s*)(["']?)([^\s"',;[]{6,})/gi,
    `$1$2$3${REDACTED}`,
  ],
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
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
