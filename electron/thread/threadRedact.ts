// Pure redactor for the session thread feed (spec section 4.3). Every string the
// thread emits goes through redactText / redactToolOutput. Not configurable: there
// is no flag, env var or argument that turns it off. Pattern-based best effort, not
// DLP; it errs toward over-masking (fail closed). Mask THEN cap, so a secret that
// straddles a cap boundary cannot leave a prefix behind. Idempotent.
//
// One engine, four layers, applied in this order (redactText below):
//   1. blocks    PEM/PGP private keys, JWTs, vendor token prefixes, Basic/Bearer values
//   2. lexicon   threadRedactLexicon.ts: which NAMES hold secrets, in any spelling
//   3. key-value ONE tokenizer applies the lexicon to every syntax: name=value, name: value,
//                "name": "value", -Name value, /name:value, $name = 'v', <name>v</name>,
//                URL userinfo and query; threadRedactCommands.ts covers positional
//                credential commands (net use, sqlcmd -P, ConvertTo-SecureString, ...)
//   4. entropy   long mixed-class runs that no name anchored, then the wrap-tail absorb
// Adding a tool is a lexicon word or a COMMANDS row, never a new regex family.
//
// No fs, no electron, no logging.
import { isReference, maskCommands, maskLiteral } from './threadRedactCommands';
import { MASK as R, isCwdVariable, isLineValueName, secretLevel, type SecretLevel } from './threadRedactLexicon';

// TODO(T3): reconcile with THREAD_DETAIL_BYTES / THREAD_DETAIL_LINES in
// src/shared/remote/threadTypes.ts once T1 has merged.
const DETAIL_BYTES = 4096;
const DETAIL_LINES = 60;
const INPUT_BYTES = 2048;
const INPUT_LINES = 30;

const SENSITIVE_FILE_TEXT = '[redacted: sensitive file]';

// ---------------------------------------------------------------------------------------
// Layer 1: blocks
// ---------------------------------------------------------------------------------------

// A private key block is masked whole; an unterminated block runs to the end of the input.
const BLOCK_RES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY BLOCK-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
];

// A token wrapped by a terminal can break after any character. A line break followed by a
// run of 8+ token characters with a digit continues the token.
const WRAP = String.raw`\r?\n(?=(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-]))`;
function prefixed(head: string, body: string, min: number): RegExp {
  return new RegExp(`${head}(?:${body}|${WRAP}){${min},}`, 'g');
}

// Well-known vendor prefixes.
const PREFIX_RES: RegExp[] = [
  prefixed(String.raw`\bsk-`, '[A-Za-z0-9_-]', 20),
  prefixed(String.raw`\b(?:sk|pk|rk)_(?:live|test)_`, '[A-Za-z0-9]', 8),
  prefixed(String.raw`\bgh[pousr]_`, '[A-Za-z0-9]', 20),
  prefixed(String.raw`\bgithub_pat_`, '[A-Za-z0-9_]', 20),
  prefixed(String.raw`\bxox[a-z]-`, '[A-Za-z0-9-]', 8),
  prefixed(String.raw`\bxapp-`, '[A-Za-z0-9-]', 10),
  prefixed(String.raw`\bwhsec_`, '[A-Za-z0-9]', 8),
  prefixed(String.raw`\bnpm_`, '[A-Za-z0-9]', 20),
  prefixed(String.raw`\b(?:glpat|glptt|gldt)-`, '[A-Za-z0-9_-]', 16),
  prefixed(String.raw`\bhf_`, '[A-Za-z0-9]', 20),
  prefixed(String.raw`\bAIza`, '[0-9A-Za-z_-]', 30),
  prefixed(String.raw`\bpypi-`, '[A-Za-z0-9_-]', 20),
  prefixed(String.raw`\bdop_v1_`, '[a-f0-9]', 20),
  prefixed(String.raw`\bsh(?:pat|pca|ppa|pss)_`, '[A-Fa-f0-9]', 20),
  prefixed(String.raw`\bsbp_`, '[A-Za-z0-9]', 20),
  prefixed(String.raw`\btskey-`, '[A-Za-z0-9-]', 10),
  prefixed(String.raw`\bhv[sbr]\.`, '[A-Za-z0-9_-]', 20),
  prefixed(String.raw`\b8Q~`, '[A-Za-z0-9._~-]', 24),
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
  /\bSK[0-9a-f]{32}\b/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  /\bhttps:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[A-Za-z0-9/_-]+/g,
];

// "Basic xxx" and "Bearer xxx" outside any name; the scheme word stays.
const BASIC_RE = /\b(Basic)(\s+)(?=[A-Za-z0-9+/_.=-]*[\d=])[A-Za-z0-9+/_.=-]{10,}/g;
const BEARER_RE = /\b(Bearer)(\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi;

function maskBlocks(text: string): string {
  let out = text;
  for (const re of BLOCK_RES) out = out.replace(re, R);
  for (const re of PREFIX_RES) out = out.replace(re, R);
  out = out.replace(BASIC_RE, `$1$2${R}`);
  return out.replace(BEARER_RE, `$1$2${R}`);
}

// ---------------------------------------------------------------------------------------
// Layer 3: the key-value tokenizer
// ---------------------------------------------------------------------------------------

// name <sep> value, where name is an identifier chain that may carry a flag prefix (-, --, /)
// or a PowerShell variable prefix ($, $env:). The lookbehind keeps a name from starting inside
// a path or another identifier. Group 4 is the closing quote of a quoted key ("name":), 5 the
// optional marker of a TS property (name?:).
const ASSIGN_RE =
  /(?<![\w$/\\.-])(-{1,2}(?=[A-Za-z_])|\/(?=[A-Za-z]))?(\$(?:[A-Za-z]+:)?)?([A-Za-z0-9_][\w.-]*)(\\?["']?)\]?(\??)([ \t]*(?:=>|:=|=(?!=)|:(?!:))[ \t]*)/g;
// -Name value and --name value: a flag followed by whitespace. Any other name takes a bare
// space only before a quoted literal (Gradle: password 'x'; SQL: PASSWORD 'x').
const FLAG_RE = /(?<![\w$/\\.-])(-{1,2}(?=[A-Za-z_])|\/(?=[A-Za-z]))([A-Za-z_][\w.-]*)([ \t]+)(?=\S)/g;
const QUOTED_ARG_RE = /(?<![\w$/\\.-])([A-Za-z_][\w.-]*)([ \t]+)(?=["'])/g;

interface Candidate {
  index: number; // start of the whole candidate, including a flag or $ prefix
  name: string;
  flag: boolean;
  dollar: boolean;
  sep: string; // '' for the whitespace-separated flag form
  valueAt: number;
  query: boolean; // directly after ? & # in a URL
}
interface Span {
  start: number;
  end: number;
}

const TYPE_WORDS = new Set([
  'string', 'number', 'boolean', 'null', 'undefined', 'true', 'false', 'required', 'optional', 'none',
  'nil', 'any', 'unknown', 'void', 'object', 'never', 'bigint', 'symbol', 'int', 'str', 'bool', 'float',
  'integer', 'bytes', 'list', 'dict', 'array',
]);
// Roots whose member chains are code (props.password, process.env.X, var.db_password).
const CODE_ROOTS = new Set([
  'process', 'import', 'this', 'props', 'self', 'config', 'cfg', 'options', 'opts', 'ctx', 'context', 'req',
  'request', 'res', 'args', 'argv', 'params', 'env', 'os', 'sys', 'state', 'settings', 'secrets', 'user',
  'data', 'body', 'input', 'form', 'values', 'event', 'payload', 'headers', 'var', 'local', 'module', 'each',
  'vault', 'session', 'store', 'creds', 'auth', 'cli', 'flags',
]);
const DECL_RE =
  /(?<![\w-])(?:const|let|var|val|final|readonly|private|public|protected|static|def|my|local|return|async|function|func|fn|param|using|this)\b/;
const CALL_RE = /^(?:(?:new|await)\s+)?[A-Za-z_$][\w$.]*[([]/;
const CHAIN_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z_$]*$/; // no digits: pw1 is a literal, not a variable
const AUTH_SCHEME_RE = /^(?:bearer|basic|digest|token|negotiate|ntlm|hmac|apikey|oauth|jwt|aws4-hmac-sha256)$/i;
// A line that is nothing but an assignment: .env, INI, YAML, export/set/ENV, "- name: v".
const LINE_PREFIX_RE = /^[ \t]*(?:(?:export|set|declare|local|readonly|env|setenv|arg)[ \t]+(?:-[A-Za-z]+[ \t]+)*)?(?:-[ \t]+)*$/i;
const CRYPT_HASH_RE = /^\$(?:\d\w?\$|[A-Za-z][\w-]*\$)/;
// REG_BINARY exports: "Password"=hex:aa,bb,cc is one value that contains commas.
const HEX_VALUE_RE = /^hex(?:\([0-9a-f]+\))?:/i;
const BARE_STOP = new Set([' ', '\t', '\r', '\n', ';', ',', '}', ')', '>', '<', '"', "'", '&', '|']);
const QUERY_STOP = new Set([' ', '\t', '\r', '\n', '&', '#', '"', "'", '<', '>']);

function runEnd(text: string, from: number, stop: Set<string>): number {
  let i = from;
  while (i < text.length && !stop.has(text[i]!)) i += 1;
  return i;
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  const end = nl < 0 ? text.length : nl;
  return end > from && text[end - 1] === '\r' ? end - 1 : end;
}

// A quoted value: "..." or '...' (backslash escapes, '' inside PowerShell single quotes) or an
// escaped pair \"...\" from stringified JSON. start/end are the INNER range; an unterminated
// quote runs to the end of the line, never across lines.
function readQuoted(text: string, p: number): Span | null {
  const c = text.charAt(p);
  if (c === '\\') {
    const q = text.charAt(p + 1);
    if (q !== '"' && q !== "'") return null;
    const stop = text.indexOf(`\\${q}`, p + 2);
    const eol = lineEnd(text, p);
    return { start: p + 2, end: stop >= 0 && stop <= eol ? stop : eol };
  }
  if (c !== '"' && c !== "'") return null;
  let i = p + 1;
  for (; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\r' || ch === '\n') break;
    if (ch === '\\') {
      const next = text.charAt(i + 1);
      if (next === '\r' || next === '\n') break;
      i += 1;
      continue;
    }
    if (ch === c) {
      if (c === "'" && i > p + 1 && text.charAt(i + 1) === "'") {
        i += 1;
        continue;
      }
      break;
    }
  }
  return { start: p + 1, end: i };
}

// A TS/Python type after a colon: PascalCase words (AuthState), Type<...>, Type[].
function isTypeAnnotation(tok: string): boolean {
  if (/^[A-Za-z_$][\w$.]*(?:\[\])+$/.test(tok)) return true;
  if (/^[A-Z][\w$.]*<\S*$/.test(tok)) return true;
  return /^(?:[A-Z][a-z]+){2,}$/.test(tok);
}

function codeContext(text: string, c: Candidate): boolean {
  if (c.dollar || /^(?:this|self|props|state|ctx|opts|options|config|cfg)\./i.test(c.name)) return true;
  const ls = c.index === 0 ? 0 : text.lastIndexOf('\n', c.index - 1) + 1;
  const prefix = text.slice(Math.max(ls, c.index - 240), c.index);
  if (DECL_RE.test(prefix)) return true;
  let depth = 0;
  for (const ch of prefix) {
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
  }
  return depth > 0;
}

// A bare value that is code, not a literal: a type, a short number, a call, a member chain
// (process.env.X), or an identifier inside a declaration or a call. Quoted values never get here.
function isCodeValue(text: string, p: number, tok: string, c: Candidate, level: SecretLevel): boolean {
  const lower = /[a-z]/.test(c.name);
  const colon = c.sep.includes(':') && !c.sep.includes('=');
  if (TYPE_WORDS.has(tok.toLowerCase()) && (colon || lower)) return true;
  if (level < 2 && /^\d{1,5}$/.test(tok)) return true;
  if (c.sep === '') return false;
  if (colon && isTypeAnnotation(tok)) return true;
  if (!lower) return false; // ENV_STYLE names are always masked
  if (CALL_RE.test(text.slice(p, p + 120))) return true;
  const ctx = codeContext(text, c);
  if (CHAIN_RE.test(tok) && (ctx || CODE_ROOTS.has(tok.slice(0, tok.indexOf('.')).toLowerCase()))) return true;
  return ctx && IDENT_RE.test(tok);
}

function atLineStart(text: string, index: number): boolean {
  const ls = index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
  return index - ls <= 40 && LINE_PREFIX_RE.test(text.slice(ls, index));
}

// The range of the secret value after a recognised secret name, or null when it is not one.
function valueSpan(text: string, c: Candidate): Span | null {
  const level = secretLevel(c.name, c.query);
  if (level === 0) return null;
  const p = c.valueAt;
  const first = text.charAt(p);
  if (first === '' || first === '\r' || first === '\n') return null;

  const quoted = readQuoted(text, p);
  if (quoted) {
    const inner = text.slice(quoted.start, quoted.end);
    return inner === '' || inner === R ? null : quoted;
  }
  // Compound values (arrays, objects, expressions), variable references and masked values.
  // A crypt hash ($2b$12$..., $argon2id$...) also starts with $ and is not a reference.
  if (
    '[({'.includes(first) ||
    (first === '$' && !CRYPT_HASH_RE.test(text.slice(p, p + 12))) ||
    (first === '%' && !c.query) ||
    (first === '@' && '({'.includes(text.charAt(p + 1)))
  ) {
    return null;
  }
  const end = runEnd(text, p, c.query ? QUERY_STOP : BARE_STOP);
  const tok = text.slice(p, end);
  if (tok === '') return null;
  if (c.sep === '' && /^-{1,2}[A-Za-z]/.test(tok)) return null; // next flag, not a value
  if (isCwdVariable(c.name) && /^(?:[/~.]|[A-Za-z]:[\\/])/.test(tok)) return null;
  if (!c.query && isCodeValue(text, p, tok, c, level)) return null;

  // Header-style values and whole-line assignments run to the end of the line (or to the
  // quote that opened before the name: curl -H "Authorization: Bearer x" url).
  const wholeLine =
    !c.query &&
    c.sep !== '' &&
    (isLineValueName(c.name) || AUTH_SCHEME_RE.test(tok) || HEX_VALUE_RE.test(tok) || (!c.flag && atLineStart(text, c.index)));
  if (!wholeLine) return { start: p, end };
  let stop = lineEnd(text, p);
  const opener = text.charAt(c.index - 1);
  if (opener === '"' || opener === "'") {
    const k = text.indexOf(opener, p);
    if (k >= 0 && k < stop) stop = k;
  }
  while (stop > p && (text[stop - 1] === ' ' || text[stop - 1] === '\t')) stop -= 1;
  return stop > p ? { start: p, end: stop } : null;
}

function scan(text: string, re: RegExp, candidate: (m: RegExpExecArray) => Candidate): string {
  re.lastIndex = 0;
  let out = '';
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const span = valueSpan(text, candidate(m));
    if (!span) continue; // lastIndex stays after the separator, so an inner name is still scanned
    out += text.slice(at, span.start) + R;
    at = span.end;
    re.lastIndex = span.end;
  }
  return at === 0 ? text : out + text.slice(at);
}

function maskKeyValues(text: string): string {
  let out = scan(text, ASSIGN_RE, (m) => {
    const prev = text.charAt(m.index - 1);
    const flag = m[1] !== undefined;
    const dollar = m[2] !== undefined;
    return {
      index: m.index,
      name: m[3]!,
      flag,
      dollar,
      sep: m[6]!.trim(),
      valueAt: m.index + m[0].length,
      query: !flag && !dollar && prev !== '' && '?&#'.includes(prev),
    };
  });
  out = scan(out, FLAG_RE, (m) => ({
    index: m.index,
    name: m[2]!,
    flag: true,
    dollar: false,
    sep: '',
    valueAt: m.index + m[0].length,
    query: false,
  }));
  out = scan(out, QUOTED_ARG_RE, (m) => ({
    index: m.index,
    name: m[1]!,
    flag: false,
    dollar: false,
    sep: '',
    valueAt: m.index + m[0].length,
    query: false,
  }));
  out = out.replace(ENV_SPACE_RE, (m, head: string, name: string, ws: string, value: string) =>
    secretLevel(name) > 0 && !isReference(value) ? `${head}${name}${ws}${R}` : m,
  );
  return out.replace(CALL_PAIR_RE, (m, head: string, _q: string, name: string, lit: string) =>
    secretLevel(name) > 0 ? head + maskLiteral(lit) : m,
  );
}

// setHeader('Authorization', 'Bearer x'), env.set("API_KEY", "x"): a name literal then a value literal.
const CALL_PAIR_RE = /(\(\s*(["'])([\w.-]+)\2\s*,\s*)("[^"\r\n]*"|'[^'\r\n]*')/g;
// Dockerfile ENV API_TOKEN value (a space instead of =).
const ENV_SPACE_RE = /^([ \t]*(?:ENV|ARG|setenv)[ \t]+)([A-Za-z_][\w.-]*)([ \t]+)([^\r\n=]*\S)$/gim;

// <password>PW</password>, <add key="secret" value="PW"/>, <setting name="ApiKey"><value>PW</value>
const XML_TEXT_RE = /<([A-Za-z_][\w:.-]*)((?:\s[^<>]*)?)>([^<>]+)<\/\1\s*>/g;
const XML_TAG_RE = /<[A-Za-z_][\w:.-]*(?:\s[^<>]*)?>/g;
const XML_ATTR_RE = /([A-Za-z_][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')/g;
const XML_VALUE_CHILD_RE = /(<[A-Za-z_][\w:.-]*\s[^<>]*?\b(?:key|name)\s*=\s*(["'])([^"']*)\2[^<>]*>\s*<value>)([^<]+)(<\/value>)/gi;
const isMaskableText = (t: string): boolean => t !== '' && !t.startsWith(R) && !/^[$%]/.test(t);

function maskXml(text: string): string {
  if (!text.includes('<')) return text;
  let out = text.replace(XML_TEXT_RE, (m, tag: string, attrs: string, body: string) =>
    secretLevel(tag) > 0 && isMaskableText(body.trim()) ? `<${tag}${attrs}>${R}</${tag}>` : m,
  );
  out = out.replace(XML_VALUE_CHILD_RE, (m, head: string, _q: string, name: string, body: string, tail: string) =>
    secretLevel(name) > 0 && isMaskableText(body.trim()) ? `${head}${R}${tail}` : m,
  );
  return out.replace(XML_TAG_RE, (tag) => {
    let secret = false;
    for (const a of tag.matchAll(XML_ATTR_RE)) {
      const attr = a[1]!.toLowerCase();
      const v = a[3]!.slice(1, -1);
      if ((/^(?:key|name|id|variable)$/.test(attr) && secretLevel(v) > 0) || (attr === 'type' && v.toLowerCase() === 'password')) {
        secret = true;
      }
    }
    if (!secret) return tag;
    return tag.replace(XML_ATTR_RE, (a, n: string, eq: string, v: string) => {
      if (!/^(?:value|connectionstring|data|content)$/i.test(n)) return a;
      const inner = v.slice(1, -1);
      return isMaskableText(inner) ? `${n}${eq}${v[0]}${R}${v[0]}` : a;
    });
  });
}

// URL userinfo: everything between :// and the LAST @ before the first / (a password may hold @).
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/?#]+)@/gi;
function maskUrls(text: string): string {
  if (!text.includes('://')) return text;
  return text.replace(URL_USERINFO_RE, (m, scheme: string, userinfo: string) => {
    const colon = userinfo.indexOf(':');
    if (colon >= 0) {
      const pw = userinfo.slice(colon + 1);
      return pw === '' || pw === R ? m : `${scheme}${userinfo.slice(0, colon)}:${R}@`;
    }
    return /^[A-Za-z0-9._~%-]{20,}$/.test(userinfo) ? `${scheme}${R}@` : m;
  });
}

// ---------------------------------------------------------------------------------------
// Layer 4: entropy
// ---------------------------------------------------------------------------------------

// A run of 20+ token characters with at least two of {upper, lower, digit} that does not read
// as a path, a hex digest, a UUID or a word-built identifier (camelCase, snake_case).
const ENTROPY_RE = /[A-Za-z0-9+/_-]{18,}={0,2}/g;
const HEX_RE = /^[0-9a-fA-F]{7,64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const WORD_RE = /[A-Z]?[a-z]{2,}|(?<![A-Za-z0-9])[A-Z]{3,8}(?![A-Za-z0-9])/g;

// 60% or more of the letters sit in readable words: ThreadMessageHandler, max_old_space_size.
function isWordy(core: string): boolean {
  const letters = core.match(/[A-Za-z]/g)?.length ?? 0;
  if (letters === 0) return false;
  let inWords = 0;
  for (const w of core.match(WORD_RE) ?? []) inWords += w.length;
  return inWords / letters >= 0.6;
}

function isSecretRun(run: string, prev: string): boolean {
  const core = run.replace(/=+$/, '');
  if (HEX_RE.test(core) || UUID_RE.test(core)) return false;
  const classes = Number(/[A-Z]/.test(core)) + Number(/[a-z]/.test(core)) + Number(/\d/.test(core));
  if (classes < 2) return false;
  if (core.includes('/') && ((prev !== '' && '/\\~.'.includes(prev)) || /^[a-z][a-z0-9_-]{2,}\//.test(core))) return false;
  return !isWordy(core);
}

function maskEntropy(text: string): string {
  return text.replace(ENTROPY_RE, (run: string, offset: number) =>
    run.length >= 20 && isSecretRun(run, text.charAt(offset - 1)) ? R : run,
  );
}

// A key wrapped across a line break: absorb the tail run after a masked line end. It runs
// after every other layer, so it sees the final marks.
const WRAP_TAIL_RE = /(\[redacted\][ \t]*\r?\n)([A-Za-z0-9+/_=-]{8,})(?=[ \t]|\r?\n|$)/g;
function absorbWrapTail(text: string): string {
  return text.replace(WRAP_TAIL_RE, (m, head: string, run: string) =>
    /\d/.test(run) || (run.length >= 16 && /[A-Z]/.test(run) && /[a-z]/.test(run)) ? head + R : m,
  );
}

export function redactText(s: string): string {
  let out = maskBlocks(s);
  out = maskCommands(out);
  out = maskKeyValues(out);
  out = maskXml(out);
  out = maskUrls(out);
  out = maskEntropy(out);
  return absorbWrapTail(out);
}

function utf8Prefix(s: string, maxBytes: number): { text: string; cut: boolean } {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { text: s, cut: false };
  let end = maxBytes;
  // Step back off continuation bytes so a code point is never split.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), cut: true };
}

function redactCapped(
  s: string,
  o: { sensitivePath: boolean },
  maxBytes: number,
  maxLines: number,
): { text: string; more: number } {
  if (o.sensitivePath) return { text: SENSITIVE_FILE_TEXT, more: 0 };
  const masked = redactText(s);
  const lines = masked.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const byLines = lines.slice(0, maxLines).join('\n');
  const { text, cut } = utf8Prefix(byLines, maxBytes);
  const kept = text === '' ? 0 : text.split('\n').length;
  let more = total - kept;
  if (more === 0 && cut) more = 1;
  return { text, more };
}

export function redactToolOutput(
  s: string,
  o: { sensitivePath: boolean },
): { text: string; more: number } {
  return redactCapped(s, o, DETAIL_BYTES, DETAIL_LINES);
}

// Tapped tool INPUT (S7): command, pattern, old/new strings, body. Same redactor,
// capped 2 KB / 30 lines. With sensitivePath (S8) the content is replaced wholesale;
// callers keep only the path and tool name.
export function redactToolInput(
  s: string,
  o: { sensitivePath: boolean },
): { text: string; more: number } {
  return redactCapped(s, o, INPUT_BYTES, INPUT_LINES);
}

const SENSITIVE_PATH_RES: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)[^/]*\.env$/i,
  /(^|\/)\.envrc$/i,
  /\.(pem|key|pfx|p12|ppk|kdbx|jks|keystore|tfvars)$/i,
  /id_(rsa|ed25519|ecdsa|dsa)/i,
  /(^|\/)\.?(credentials|secrets?)(\.|\/|$)/i,
  /\.(pypirc|vault-token)$/i,
  /service[-_]?account[^/]*\.json$/i,
  /(^|\/)\.claude\.json$/i,
  /(^|\/)\.config\/gh\/hosts\.yml$/i,
  /(^|\/)local\.settings\.json$/i,
  /(^|\/)\.(npmrc|netrc|pgpass|git-credentials|htpasswd)$/i,
  /(^|\/)\.(ssh|aws|gnupg|kube|azure)(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)terraform\.tfstate(\..*)?$/i,
];

export function isSensitivePath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return SENSITIVE_PATH_RES.some((re) => re.test(norm));
}
