// Positional credential commands and call syntax for the thread redactor (spec 4.3).
// Name-anchored key-value shapes live in threadRedact.ts; this file covers the shapes
// where the secret is identified by WHERE it sits, not by a name next to it:
//   net use \\srv\share PW        sqlcmd -P PW        redis-cli -a PW
//   ConvertTo-SecureString "PW"   NetworkCredential('u', 'PW')   echo PW | sudo -S
// Each command is one row in COMMANDS: a regex that finds the command word, and a picker
// that selects the secret ranges from the tokens that follow it on the same line.
import { MASK, secretLevel } from './threadRedactLexicon';

interface Range {
  start: number;
  end: number;
}
interface Tok extends Range {
  text: string;
  quoted: boolean;
}
type Pick = (toks: Tok[], src: string) => Range[];

const MAX_TOKENS = 16;
const MAX_SPAN = 400;

// Splits the rest of a command line into tokens. Quoted tokens report the range INSIDE the
// quotes. An unquoted | ; & ) or a line break ends the command.
function tokenize(s: string, from: number): Tok[] {
  const out: Tok[] = [];
  const limit = Math.min(s.length, from + MAX_SPAN);
  let i = from;
  while (out.length < MAX_TOKENS) {
    while (i < limit && (s[i] === ' ' || s[i] === '\t')) i += 1;
    if (i >= limit) break;
    const c = s[i]!;
    if ('\r\n|;&)'.includes(c)) break;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < limit && s[j] !== c && s[j] !== '\r' && s[j] !== '\n') j += 1;
      out.push({ start: i + 1, end: j, text: s.slice(i + 1, j), quoted: true });
      i = s[j] === c ? j + 1 : j;
      continue;
    }
    let j = i;
    while (j < limit && !' \t\r\n|;&)'.includes(s[j]!)) j += 1;
    out.push({ start: i, end: j, text: s.slice(i, j), quoted: false });
    i = j;
  }
  return out;
}

// A value that is already masked, a variable reference or a prompt marker is not a secret.
// A crypt hash ($6$salt$..., $argon2id$...) starts with $ but is a credential.
const REFERENCE_RE = /^(?:\$(?!\d\w?\$|[A-Za-z][\w-]*\$)|[%<(*])/;
export function isReference(v: string): boolean {
  return v === '' || v === MASK || REFERENCE_RE.test(v);
}

// Replaces the inner text of a captured literal, keeping its quotes. For regex rules.
export function maskLiteral(v: string): string {
  const q = v.charAt(0);
  if (q === '"' || q === "'") {
    const closed = v.length > 1 && v.endsWith(q);
    const inner = v.slice(1, closed ? -1 : undefined);
    return isReference(inner) ? v : `${q}${MASK}${closed ? q : ''}`;
  }
  return isReference(v) ? v : MASK;
}

const SWITCH_RE = /^(?:-{1,2}[A-Za-z][\w-]*(?:[:=].*)?|\/[A-Za-z][\w-]*(?::.*)?)$/;
const isSwitch = (x: Tok): boolean => !x.quoted && SWITCH_RE.test(x.text);
// net use targets: a drive or device (Z:, LPT1:), a * prompt, a UNC path or a WebDAV URL.
const isTarget = (x: Tok): boolean =>
  /^(?:[A-Za-z0-9_]{1,8}:|\*)$/.test(x.text) || /^(?:\\\\|\/\/)/.test(x.text) || x.text.includes('://');

// The token after a bare flag (-p PW).
const after =
  (flag: RegExp): Pick =>
  (t) => {
    const out: Range[] = [];
    for (let i = 0; i + 1 < t.length; i += 1) if (!t[i]!.quoted && flag.test(t[i]!.text)) out.push(t[i + 1]!);
    return out;
  };

// The rest of a token after an attached flag (-pPW, --value=PW).
const glued =
  (flag: RegExp): Pick =>
  (t) => {
    const out: Range[] = [];
    for (const x of t) {
      const m = x.quoted ? null : flag.exec(x.text);
      if (m && x.text.length > m[0].length) out.push({ start: x.start + m[0].length, end: x.end });
    }
    return out;
  };

const either =
  (...picks: Pick[]): Pick =>
  (t, s) =>
    picks.flatMap((p) => p(t, s));

const first: Pick = (t) => t.slice(0, 1);

// net use [Z:] \\srv\share PW /user:bob   -> the first positional that is not a target.
const netUse: Pick = (t) => t.filter((x) => !isSwitch(x) && !isTarget(x)).slice(0, 1);
// net user bob PW /add, bw login me@x.com PW -> the second positional.
const secondPositional: Pick = (t) => {
  const pos = t.filter((x) => !isSwitch(x) && x.text !== '*');
  return pos.length >= 2 ? [pos[1]!] : [];
};

// htpasswd -b file user PW / htpasswd -nb user PW -> the last positional, batch mode only.
const htpasswd: Pick = (t) => {
  if (!t.some((x) => !x.quoted && /^-[A-Za-z]*b/.test(x.text))) return [];
  const pos = t.filter((x) => x.quoted || !x.text.startsWith('-'));
  return pos.length >= 2 ? [pos[pos.length - 1]!] : [];
};

// curl -u user:PW, --user user:PW, -uuser:PW (smbclient -U user%PW): the part after the first
// delimiter of the user argument.
const userCredential =
  (flags: RegExp, attached: RegExp, delim: string): Pick =>
  (t, s) => {
    const out: Range[] = [];
    const afterDelim = (r: Range): void => {
      const i = s.slice(r.start, r.end).indexOf(delim);
      if (i >= 0) out.push({ start: r.start + i + 1, end: r.end });
    };
    for (let i = 0; i < t.length; i += 1) {
      const x = t[i]!;
      if (x.quoted) continue;
      if (flags.test(x.text)) {
        if (t[i + 1]) afterDelim(t[i + 1]!);
        continue;
      }
      const m = attached.exec(x.text);
      if (m) afterDelim({ start: x.start + m[0].length, end: x.end });
    }
    return out;
  };
const curlUser = either(
  userCredential(/^(?:-u|-U|--user|--proxy-user)$/, /^(?:--user=|--proxy-user=|-u(?=[^\s-])|-U(?=[^\s-]))/, ':'),
  after(/^(?:--oauth2-bearer|-b|--cookie)$/),
);
const smbUser = userCredential(/^(?:-U|--user)$/, /^(?:--user=|-U(?=[^\s-]))/, '%');
const lftpUser = userCredential(/^-u$/, /^-u(?=[^\s-])/, ',');

// ConvertTo-SecureString "PW" -AsPlainText -Force: every literal argument is the secret.
const FLAGS_WITH_VALUE = /^-(?:ErrorAction|EA|WarningAction|WA|InformationAction|IA|Key|SecureKey|OutVariable|OV|ErrorVariable|EV)$/i;
const secureString: Pick = (t) => {
  const out: Range[] = [];
  for (let i = 0; i < t.length; i += 1) {
    const x = t[i]!;
    if (!x.quoted && x.text.startsWith('-')) {
      if (FLAGS_WITH_VALUE.test(x.text)) i += 1;
      continue;
    }
    out.push(x);
  }
  return out;
};

// setx NAME VALUE, aws configure set NAME VALUE, npm config set NAME VALUE: the value when
// the NAME is a secret name.
const namedValue: Pick = (t) => {
  const pos = t.filter((x) => !isSwitch(x));
  return pos.length >= 2 && secretLevel(pos[0]!.text) > 0 ? [pos[1]!] : [];
};

// nmcli connection modify x wifi-sec.psk PW: any secret-named token takes the next one.
const nameThenValue: Pick = (t) => {
  const out: Range[] = [];
  for (let i = 0; i + 1 < t.length; i += 1) {
    if (!t[i]!.quoted && !isSwitch(t[i]!) && secretLevel(t[i]!.text) > 0) out.push(t[i + 1]!);
  }
  return out;
};

// Set-Variable -Name pw -Value 'x'
const setVariable: Pick = (t) => {
  const n = t.findIndex((x) => !x.quoted && /^-Name$/i.test(x.text));
  if (n < 0 || !t[n + 1] || secretLevel(t[n + 1]!.text) === 0) return [];
  const v = t.findIndex((x) => !x.quoted && /^-Value$/i.test(x.text));
  return v >= 0 && t[v + 1] ? [t[v + 1]!] : [];
};

// reg add KEY /v Password /d PW
const regAdd: Pick = (t) => {
  const v = t.findIndex((x) => !x.quoted && /^\/v$/i.test(x.text));
  if (v < 0 || !t[v + 1] || secretLevel(t[v + 1]!.text) === 0) return [];
  const d = t.findIndex((x) => !x.quoted && /^\/d$/i.test(x.text));
  return d >= 0 && t[d + 1] ? [t[d + 1]!] : [];
};

const COMMANDS: Array<[RegExp, Pick]> = [
  [/(?<![\w-])net1?[ \t]+use\b/gi, netUse],
  [/(?<![\w-])net1?[ \t]+user\b/gi, secondPositional],
  [/(?<![\w-])(?:sqlcmd|osql|bcp|isql)(?:\.exe)?(?![\w-])/gi, either(after(/^-P$/), glued(/^-P/))],
  [/(?<![\w-])(?:mysql\w*|mariadb\w*|7z[a-z]?|7za|u?nrar|rar)(?:\.exe)?(?![\w-])/gi, glued(/^-p/)],
  [/(?<![\w-])(?:un)?zip(?:\.exe)?(?![\w-])/gi, after(/^-P$/)],
  [/(?<![\w-])redis-cli(?![\w-])/gi, after(/^-a$/)],
  [/(?<![\w-])openssl(?![\w-])/gi, after(/^-k$/)],
  [/(?<![\w-])htpasswd(?![\w-])/gi, htpasswd],
  [/(?<![\w-])sshpass(?![\w-])/gi, either(after(/^-p$/), glued(/^-p/))],
  [/(?<![\w-])(?:psexec6?4?|paexec)(?:\.exe)?(?![\w-])/gi, after(/^-p$/i)],
  [/(?<![\w-])schtasks(?:\.exe)?(?![\w-])/gi, after(/^\/rp$/i)],
  [/(?<![\w-])winrs(?![\w-])/gi, glued(/^[-/]p:/i)],
  [/(?<![\w-])az(?:\.cmd)?(?![\w.-])/gi, either(after(/^-p$/), glued(/^-p/))],
  [
    /(?<![\w-])(?:docker|podman|nerdctl|buildah|skopeo|helm|crane|oras)(?![\w-])(?=[^\r\n]*\blogin\b)/gi,
    either(after(/^-p$/), glued(/^-p/)),
  ],
  [/(?<![\w-])curl(?:\.exe)?(?![\w-])/gi, curlUser],
  [/(?<![\w-])ConvertTo-SecureString\b/gi, secureString],
  [/(?<![\w-])setx(?:\.exe)?(?![\w-])/gi, namedValue],
  [/(?<![\w-])aws[ \t]+configure[ \t]+set\b/gi, namedValue],
  [/(?<![\w-])(?:npm|yarn|pnpm)[ \t]+config[ \t]+set\b/gi, namedValue],
  [/(?<![\w-])reg(?:\.exe)?[ \t]+add\b/gi, regAdd],
  [/(?<![\w-])(?:Set|New)-Variable(?![\w-])/gi, setVariable],
  [/(?<![\w-])(?:Set|New)-ItemProperty(?![\w-])/gi, setVariable],
  [/(?<![\w-])certutil(?:\.exe)?(?![\w-])/gi, after(/^-p$/i)],
  [/(?<![\w-])signtool(?:\.exe)?(?![\w-])/gi, after(/^[-/]p$/i)],
  [/(?<![\w-])wpa_passphrase(?![\w-])/gi, secondPositional],
  [/(?<![\w-])nmcli(?![\w-])/gi, nameThenValue],
  [/(?<![\w-])secret[ \t]+set\b/gi, either(after(/^(?:--value|--body|-b)$/), glued(/^--(?:value|body)=/))],
  [/(?<![\w-])put-parameter\b/gi, either(after(/^--value$/), glued(/^--value=/))],
  [/(?<![\w-])create[ \t]+secret\b/gi, glued(/^--from-literal=[^=]+=/)],
  [/(?<![\w-])login[ \t]+\S+[ \t]+password\b/gi, first],
  [/(?<![\w-])ldap(?:search|add|modify|delete|passwd|compare|whoami)(?![\w-])/gi, after(/^-w$/)],
  [/(?<![\w-])ssh-keygen(?![\w-])/gi, after(/^-[NP]$/)],
  [/(?<![\w-])user(?:add|mod)(?![\w-])/gi, after(/^-p$/)],
  [/(?<![\w-])[wx]freerdp(?![\w-])/gi, glued(/^[-/]p:/)],
  [/(?<![\w-])rdesktop(?![\w-])/gi, after(/^-p$/)],
  [/(?<![\w-])smbclient(?![\w-])/gi, smbUser],
  [/(?<![\w-])rclone[ \t]+obscure\b/gi, first],
  [/(?<![\w-])lftp(?![\w-])/gi, lftpUser],
  [/(?<![\w-])bw[ \t]+login\b/gi, secondPositional],
  [/(?<![\w-])netsh(?![\w-])/gi, glued(/^key=/i)],
  [/(?<![\w-])hydra(?![\w-])/gi, after(/^-p$/)],
  [/(?<![\w-])user-secrets[ \t]+set\b/gi, namedValue],
];

function splice(text: string, spans: Range[]): string {
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const r of spans) {
    if (r.start < at) continue;
    out += text.slice(at, r.start) + MASK;
    at = r.end;
  }
  return out + text.slice(at);
}

// Call syntax and pipes, where a literal sits between known punctuation.
const LITERAL = `(?:"[^"\\r\\n]*"|'[^'\\r\\n]*')`;
const REGEX_RULES: Array<[RegExp, (m: string, ...g: string[]) => string]> = [
  // "PW" | ConvertTo-SecureString
  [
    new RegExp(`(${LITERAL})([ \\t]*\\|[ \\t]*ConvertTo-SecureString)`, 'gi'),
    (_m, lit, tail) => `${maskLiteral(lit)}${tail}`,
  ],
  // [Net.NetworkCredential]::new('u', 'PW'), New-Object PSCredential 'u', 'PW', HTTPBasicAuth('u', 'PW')
  [
    new RegExp(
      `(\\b(?:NetworkCredential|PSCredential|HTTPBasicAuth|HTTPDigestAuth)\\b(?:\\]::new[ \\t]*\\([ \\t]*|[ \\t]*\\([ \\t]*|[ \\t]+(?:-ArgumentList[ \\t]+)?)(?:${LITERAL}|[^\\s,()"']+)[ \\t]*,[ \\t]*)(${LITERAL}|[^\\s,()"'$][^\\s,()"']*)`,
      'gi',
    ),
    (_m, head, lit) => `${head}${maskLiteral(lit)}`,
  ],
  // sqlplus user/PW@db, rman target sys/PW
  [
    /((?<![\w-])(?:sqlplus(?:64)?|rman[ \t]+target|expdp|impdp)[ \t]+(?:-\w+[ \t]+)*"?[\w$#.]+\/)([^@\s"'/]+)(?=@|\s|"|$)/gi,
    (_m, head, pw) => `${head}${isReference(pw) ? pw : MASK}`,
  ],
  // requests.get(url, auth=('u', 'PW'))
  [
    new RegExp(`(\\bauth[ \\t]*=[ \\t]*\\([ \\t]*${LITERAL}[ \\t]*,[ \\t]*)(${LITERAL})`, 'gi'),
    (_m, head, lit) => `${head}${maskLiteral(lit)}`,
  ],
  // echo PW | sudo -S, echo PW | docker login --password-stdin, echo u:PW | chpasswd
  [
    new RegExp(
      `\\b((?:echo|printf|Write-Output)[ \\t]+(?:-[A-Za-z]+[ \\t]+)*)(${LITERAL}|[^\\s"'|]+)([ \\t]*\\|[ \\t]*(?:sudo[ \\t]+-S\\b|chpasswd\\b|kinit\\b|docker[ \\t]+secret[ \\t]+create\\b|[^\\r\\n|]*(?:--password-stdin|--with-token|--token-stdin)\\b|passwd\\b[^\\r\\n|]*--stdin\\b))`,
      'gi',
    ),
    (_m, head, lit, tail) => `${head}${maskLiteral(lit)}${tail}`,
  ],
  // CREATE USER u IDENTIFIED BY 'PW', SET PASSWORD = PASSWORD('PW')
  [
    new RegExp(`(\\bIDENTIFIED[ \\t]+BY[ \\t]+(?:PASSWORD[ \\t]+)?)(${LITERAL}|[^\\s;,)'"]+)`, 'gi'),
    (_m, head, lit) => `${head}${maskLiteral(lit)}`,
  ],
  [new RegExp(`(\\bPASSWORD[ \\t]*\\([ \\t]*)(${LITERAL})`, 'gi'), (_m, head, lit) => `${head}${maskLiteral(lit)}`],
  // netrc: a bare "password X" line
  [/^([ \t]*password[ \t]+)(\S+)([ \t]*)$/gim, (_m, head, v, tail) => `${head}${isReference(v) ? v : MASK}${tail}`],
];

export function maskCommands(text: string): string {
  let out = text;
  for (const [re, pick] of COMMANDS) {
    re.lastIndex = 0;
    const spans: Range[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      const toks = tokenize(out, m.index + m[0].length);
      for (const r of pick(toks, out)) if (!isReference(out.slice(r.start, r.end))) spans.push(r);
    }
    if (spans.length > 0) out = splice(out, spans);
  }
  for (const [re, fn] of REGEX_RULES) out = out.replace(re, fn);
  return out;
}
