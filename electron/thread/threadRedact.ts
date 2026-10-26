// Pure redactor for the session thread feed (spec section 4.3). Every string the
// thread emits goes through redactText / redactToolOutput. Not configurable: there
// is no flag, env var or argument that turns it off. Pattern-based best effort, not
// DLP; it errs toward over-masking (fail closed). Mask THEN cap, so a secret that
// straddles a cap boundary cannot leave a prefix behind. Idempotent.
//
// No fs, no electron, no logging.
import { maskSecrets } from '../../src/shared/board/text';

// TODO(T3): reconcile with THREAD_DETAIL_BYTES / THREAD_DETAIL_LINES in
// src/shared/remote/threadTypes.ts once T1 has merged.
const DETAIL_BYTES = 4096;
const DETAIL_LINES = 60;
const INPUT_BYTES = 2048;
const INPUT_LINES = 30;

const R = '[redacted]';
const SENSITIVE_FILE_TEXT = '[redacted: sensitive file]';

// Rule 1b: well-known token prefixes that maskSecrets does not cover.
const PREFIX_RULES: RegExp[] = [
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bwhsec_[A-Za-z0-9]{8,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\b(?:glpat|glptt|gldt)-[A-Za-z0-9_-]{16,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bpypi-[A-Za-z0-9_-]{20,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bdop_v1_[a-f0-9]{20,}/g,
  /\bsh(?:pat|pca|ppa|pss)_[A-Fa-f0-9]{20,}/g,
  /\bsbp_[A-Za-z0-9]{20,}/g,
  /\btskey-[A-Za-z0-9-]{10,}/g,
  /\bSK[0-9a-f]{32}\b/g,
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  /\bhttps:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[A-Za-z0-9/_-]+/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
];

// Rule 2: credential headers. Whole value to end of line (also inside curl -H "...").
const HEADER_NAME =
  '(?:proxy-)?authorization|(?:x-)?api-?key|x-auth-token|x-access-token|x-amz-security-token|x-csrf-token|set-cookie|cookie';
const HEADER_RE = new RegExp(
  `(?<![A-Za-z0-9])(${HEADER_NAME})(["']?\\s*[:=]\\s*)[^\\r\\n]*`,
  'gi',
);
const BASIC_RE = /\b(Basic)(\s+)(?=[A-Za-z0-9+/_.=-]*[\d=])[A-Za-z0-9+/_.=-]{10,}/g;
const BEARER_RE = /\b(Bearer)(\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi;
const CURL_USER_RE =
  /(?<![\w-])(-u|--user|--proxy-user)(\s*=?\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/g;
const CLI_SECRET_FLAG_RE =
  /(--(?:password|passwd|pass|token|secret|api-?key|client-secret|access-token|auth-token|private-key|key|credentials?|bearer|cookie|sas-token|account-key|connection-string)\b)(=|\s+)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi;

// Rule 3: .env-style assignments. Line form masks to end of line; the inline form
// (VAR=value cmd) masks one token or quoted string.
const ENV_NAME =
  '[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|PRIVATE|DSN|CONNECTION_?STRING)[A-Z0-9_]*';
const ENV_LINE_RE = new RegExp(
  `^([ \\t]*(?:export[ \\t]+|set[ \\t]+|\\$env:)?${ENV_NAME}[ \\t]*=[ \\t]*)[^\\r\\n]*$`,
  'gm',
);
const ENV_INLINE_RE = new RegExp(
  `(?<![A-Za-z0-9_])(${ENV_NAME}=)("[^"\\r\\n]*"?|'[^'\\r\\n]*'?|[^\\s"']+)`,
  'g',
);

// Name ends in a credential word: token, credentials, passphrase, ... Values are
// masked unless they are a bare type/keyword (secret: string).
const NAME_ASSIGN_RE =
  /(?<![A-Za-z0-9])([A-Za-z0-9_.-]*(?:token|credentials?|passphrase|passcode|api[_-]?key|apikey|auth|signature|bearer|private[_-]?key|session[_-]?id|connection[_-]?string))\b(\\?["']?)(\s*[:=]\s*)(?:(["'])((?:\\.|(?!\4)[^\\\r\n])*)(\4)?|([^\s"',;[][^\s"',;]{5,}))/gi;
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
function isCodeShape(v: string): boolean {
  return v.split('|').every((p) => TYPE_WORDS.has(p.trim().toLowerCase()));
}

// Rule 5: URLs.
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/@]+)@/gi;
const URL_USER_ONLY_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9._~%-]{20,})@/gi;
const URL_PARAM_RE =
  /([?&#;])((?:[A-Za-z0-9_.-]*?(?:token|key|sig|signature|secret|password|passwd|pwd|credential|auth|session))|code)=([^&\s#"'<>]*)/gi;
const CONN_STRING_RE =
  /(?<![A-Za-z0-9])((?:[A-Za-z]*(?:Password|Pwd|AccountKey|SharedAccessKey|SharedAccessSignature|Secret))[ \t]*=[ \t]*)("[^"\r\n]*"?|'[^'\r\n]*'?|[^;\r\n]*)/gi;

// Rule 6: long mixed-class runs. Pure hex SHAs and UUIDs are exempt.
const ENTROPY_RE = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const HEX_ID_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function highEntropy(run: string): string {
  const core = run.replace(/=+$/, '');
  if (HEX_ID_RE.test(core) || UUID_RE.test(core)) return run;
  if (/[A-Z]/.test(core) && /[a-z]/.test(core) && /\d/.test(core)) return R;
  return run;
}

export function redactText(s: string): string {
  let out = maskSecrets(s);
  for (const re of PREFIX_RULES) out = out.replace(re, R);

  // Rule 2
  out = out.replace(HEADER_RE, (_m, name: string, sep: string) => `${name}${sep}${R}`);
  out = out.replace(BASIC_RE, `$1$2${R}`);
  out = out.replace(BEARER_RE, `$1$2${R}`);
  out = out.replace(CURL_USER_RE, (m, flag: string, sp: string, val: string) =>
    val.includes(':') ? `${flag}${sp}${R}` : m,
  );
  out = out.replace(
    CLI_SECRET_FLAG_RE,
    (m, flag: string, sep: string, val: string) => (val.startsWith('-') ? m : `${flag}${sep}${R}`),
  );

  // Rule 3
  out = out.replace(ENV_LINE_RE, (_m, head: string) => `${head}${R}`);
  out = out.replace(ENV_INLINE_RE, (_m, head: string) => `${head}${R}`);
  out = out.replace(
    NAME_ASSIGN_RE,
    (m, name: string, q1: string, sep: string, qa: string | undefined, vq: string | undefined, ca: string | undefined, vu: string | undefined) => {
      if (qa !== undefined) {
        const v = vq ?? '';
        if (v.length < 6 || isCodeShape(v) || v === R) return m;
        return `${name}${q1}${sep}${qa}${R}${ca ?? ''}`;
      }
      const v = vu ?? '';
      if (isCodeShape(v)) return m;
      return `${name}${q1}${sep}${R}`;
    },
  );

  // Rule 5
  out = out.replace(URL_USERINFO_RE, `$1$2:${R}@`);
  out = out.replace(URL_USER_ONLY_RE, `$1${R}@`);
  out = out.replace(URL_PARAM_RE, (_m, lead: string, name: string) => `${lead}${name}=${R}`);
  out = out.replace(CONN_STRING_RE, (_m, head: string) => `${head}${R}`);

  // Rule 6 last, so it only sees what the earlier rules left.
  out = out.replace(ENTROPY_RE, highEntropy);
  return out;
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
  /(^|\/)(credentials|secrets?)(\.|$)/i,
  /(^|\/)\.(npmrc|netrc|pgpass|git-credentials|htpasswd)$/i,
  /(^|\/)\.(ssh|aws|gnupg|kube|azure)(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)terraform\.tfstate(\..*)?$/i,
];

export function isSensitivePath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return SENSITIVE_PATH_RES.some((re) => re.test(norm));
}
