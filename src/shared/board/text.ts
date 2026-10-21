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

// Value is either a quoted string (masked whole, through its closing quote,
// honouring backslash escapes; an unterminated quote runs to end of line, never
// across lines) or an unquoted run. The 6-char threshold applies to the whole
// value. Alternatives start on disjoint characters, so matching is linear.
const ASSIGN_RE =
  /(?<![A-Za-z0-9])(password|passwd|pwd|secret[_-]?(?:access[_-]?)?key(?:[_-]?(?:base|id))?|private[_-]?key|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b(["']?)(\s*[:=]\s*)(?:(["'])((?:\\.?|(?!\4)[^\\\r\n]){6,})(\4)?|(["']?)([^\s"',;[]{6,}))/gi;
const TYPE_WORDS = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'true',
  'false',
  'required',
  'optional',
]);

// The only skip is an exact type/keyword value (or a | union of only those
// words), e.g. "secret: string;". Everything else in a key=value secret
// position is masked, so code assignments like "const secret = getSecret();"
// may be over-masked by design (fail-closed).
function isCodeShape(v: string): boolean {
  return v.split('|').every((p) => TYPE_WORDS.has(p.toLowerCase()));
}

export function maskSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out.replace(
    ASSIGN_RE,
    (m, k, q1, sep, qa: string | undefined, vq: string | undefined, qc: string | undefined, qb: string, vu: string | undefined) => {
      if (isCodeShape(vq ?? vu ?? '')) return m;
      return qa !== undefined
        ? `${k}${q1}${sep}${qa}${REDACTED}${qc ?? ''}`
        : `${k}${q1}${sep}${qb}${REDACTED}`;
    },
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
