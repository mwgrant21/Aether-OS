// Secret-name lexicon for the thread redactor (spec 4.3). One place decides whether a NAME
// (env var, JSON key, CLI flag, XML tag, HTTP header, URL query parameter) holds a secret;
// the key-value tokenizer in threadRedact.ts applies it across every syntax. Pure; no I/O.

export const MASK = '[redacted]';

// 0 = not a secret name, 1 = secret name (short numbers are not masked: token: 5),
// 2 = password-class name (everything is masked, numbers included).
export type SecretLevel = 0 | 1 | 2;

// Whole segments of a name. A name is split on separators and camelCase, so db_pass,
// smtpPass, DB-PASS and $pw all expose their secret word; `tokenizer` and `author` do not.
const STRONG_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'passcode',
  'pwd',
  'pw',
  'secret',
  'credential',
  'credentials',
]);
const WEAK_WORDS = new Set([
  'pass',
  'token',
  'apikey',
  'auth',
  'authorization',
  'cookie',
  'sig',
  'signature',
  'sas',
  'bearer',
  'dsn',
  'connectionstring',
  'session',
  'sessionid',
  'sessid',
  'jsessionid',
  'phpsessid',
  'sessionkey',
]);

// Compounds written without a separator: PGPASSWORD, SSHPASS, accountkey, secretkey.
const FLAT_STRONG_RE = /(?:password|passwd|passphrase|secret|credentials?)$/;
const FLAT_WEAK_RE = /(?:token|apikey|accesskey|accountkey|secretkey|privatekey|signingkey|authkey)$/;
const FLAT_PASS_RE = /^[a-z]{2,}(?:pass|pwd)$/;
const NOT_PASS = new Set(['bypass', 'compass', 'surpass', 'trespass', 'overpass', 'underpass', 'encompass', 'impass']);

// `key` alone is never a secret word (event.key, sortKey); it counts only as the last
// segment of a compound whose previous segment says what kind of key it is.
const KEY_QUALIFIERS = new Set([
  'api',
  'access',
  'account',
  'secret',
  'private',
  'shared',
  'signing',
  'encryption',
  'decryption',
  'master',
  'auth',
  'ssh',
  'license',
  'service',
  'app',
  'session',
  'deploy',
  'storage',
  'subscription',
  'functions',
  'admin',
  'hmac',
  'jwt',
  'csrf',
  'gpg',
  'pgp',
]);

// A name that ends in one of these refers to a secret instead of holding one:
// password_file, token_url, secret_name, auth_type, token_ttl.
const REFERENCE_TAILS = new Set([
  'file',
  'path',
  'dir',
  'name',
  'url',
  'uri',
  'host',
  'endpoint',
  'length',
  'len',
  'count',
  'size',
  'limit',
  'max',
  'min',
  'type',
  'kind',
  'mode',
  'method',
  'scheme',
  'policy',
  'field',
  'label',
  'prompt',
  'placeholder',
  'hint',
  'regex',
  'pattern',
  'rule',
  'rules',
  'required',
  'enabled',
  'expiry',
  'expires',
  'ttl',
  'timeout',
  'stdin',
  'fd',
]);

// Extra names that only mean a secret inside a URL query or fragment: ?code=, ?key=, ?sid=.
const QUERY_NAMES = new Set(['code', 'key', 'sid', 'session', 'jwt', 'otp']);

function segmentsOf(name: string, camel = true): string[] {
  return (camel ? name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') : name)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((s) => s.replace(/\d+$/, ''))
    .filter(Boolean);
}

// A name is read twice: split on camelCase (smtpPass, apiSecret) and unsplit (cOoKiE, DB_PASS).
function compute(name: string, query: boolean): SecretLevel {
  return Math.max(levelOf(segmentsOf(name), query), levelOf(segmentsOf(name, false), query)) as SecretLevel;
}

function levelOf(segs: string[], query: boolean): SecretLevel {
  if (segs.length === 0) return 0;
  let level: SecretLevel = 0;
  const last = segs.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const s = segs[i]!;
    const prev = i > 0 ? segs[i - 1] : '';
    if (STRONG_WORDS.has(s) || FLAT_STRONG_RE.test(s)) level = 2;
    else if (WEAK_WORDS.has(s) || FLAT_WEAK_RE.test(s) || (FLAT_PASS_RE.test(s) && !NOT_PASS.has(s))) level = Math.max(level, 1) as SecretLevel;
    else if (s === 'key' && i === last && KEY_QUALIFIERS.has(prev!)) level = Math.max(level, 1) as SecretLevel;
    else if (s === 'string' && prev === 'connection') level = Math.max(level, 1) as SecretLevel;
    else if (s === 'id' && prev === 'session') level = Math.max(level, 1) as SecretLevel;
  }
  if (level === 0 && query && QUERY_NAMES.has(segs.join(''))) level = 1;
  if (level > 0 && REFERENCE_TAILS.has(segs[last]!)) return 0;
  return level;
}

const cache = new Map<string, SecretLevel>();

export function secretLevel(name: string, query = false): SecretLevel {
  const key = query ? `?${name}` : name;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const level = compute(name, query);
  if (cache.size > 4096) cache.clear();
  cache.set(key, level);
  return level;
}

// Headers whose value is a whole line (Authorization: Bearer x, Cookie: a=b; c=d).
export function isLineValueName(name: string): boolean {
  const segs = [...segmentsOf(name), ...segmentsOf(name, false)];
  return segs.includes('authorization') || segs.includes('cookie');
}

// PWD / OLDPWD are the shell's working directory, not a password.
export function isCwdVariable(name: string): boolean {
  return /^(?:old)?pwd$/i.test(name);
}
