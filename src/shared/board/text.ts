// Pure text helpers for the Traffic feed: render-time secret masking and the
// body cap. No node imports so this file can be bundled into the renderer.
// Masking is pattern-based and conservative ("obvious secrets", not a DLP);
// always mask BEFORE capping so a secret straddling the cap cannot leak half.
// Known limits: doubly-stringified keys (\\\"password\\\") are not matched;
// a quoted value spanning a real newline is masked on its first line only;
// backtick-quoted values are masked to the first word only.

const REDACTED = '[redacted]';

// Each rule is replaced wholesale unless it carries capture groups, in which
// case the replacement keeps the label (Bearer, key name) and masks the value.
// Unquoted values exclude '[' so a masked value is not re-matched; a masked
// quoted value may re-match but yields identical output (idempotent).
// The first rule masks PEM and PGP-armored private keys whole (the armor type
// ends in "PRIVATE KEY" or "PRIVATE KEY BLOCK"), headers and checksum included.
const RULES: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    REDACTED,
  ],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{20,}/gi, `$1$2${REDACTED}`],
];

// Value is a quoted string (masked whole, through its closing quote, honouring
// backslash escapes; an unterminated quote runs to end of line, never across
// lines), an escaped-quoted string as in stringified JSON (\"...\"), or an
// unquoted run. The key may be followed by an escaped quote (\"password\").
// The quoted alternatives match any length; the 6-char threshold is applied in
// maskSecrets to the whole RAW content (an escape pair counts as 2 chars).
// Inside the escaped-quote body, a backslash run before a quote is read by
// parity: four backslashes are an escaped backslash, three plus a quote are an
// inner quote, and a \" whose backslash is unescaped ends the value,
// so a value ending in an escaped backslash stops at its real closing quote.
// Every loop iteration consumes at least one character and nothing can fail
// after the body, so matching is linear.
const ASSIGN_RE =
  /(?<![A-Za-z0-9])(password|passwd|pwd|secret[_-]?(?:access[_-]?)?key(?:[_-]?(?:base|id))?|private[_-]?key|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b(\\?["']?)(\s*[:=]\s*)(?:(?<qa>["'])(?<vqa>(?:\\.?|(?!\k<qa>)[^\\\r\n])*)(?<ca>\k<qa>)?|\\(?<qb>["'])(?<vqb>(?:(?!\\\k<qb>)(?:\\{4}|\\{3}\k<qb>|\\.?|[^\\\r\n]))*)(?<cb>\\\k<qb>)?|(?<vu>[^\s"',;[]{6,}))/gi;
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
    (m, k, q1, sep, ...rest) => {
      const g = rest[rest.length - 1] as Record<string, string | undefined>;
      if (g.vqa !== undefined) {
        if (g.vqa.length < 6 || isCodeShape(g.vqa)) return m;
        return `${k}${q1}${sep}${g.qa}${REDACTED}${g.ca ?? ''}`;
      }
      if (g.vqb !== undefined) {
        if (g.vqb.length < 6 || isCodeShape(g.vqb)) return m;
        return `${k}${q1}${sep}\\${g.qb}${REDACTED}${g.cb ?? ''}`;
      }
      if (isCodeShape(g.vu ?? '')) return m;
      return `${k}${q1}${sep}${REDACTED}`;
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
