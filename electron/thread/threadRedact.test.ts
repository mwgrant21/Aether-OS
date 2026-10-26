import { describe, expect, it } from 'vitest';
import { isSensitivePath, redactText, redactToolInput, redactToolOutput } from './threadRedact';
import { secretLevel } from './threadRedactLexicon';

// Every secret below is an obvious FAKE. Each entry: [label, input, substring that must vanish].
const MIXED32 = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF'; // 32 chars, upper+lower+digit
const POSITIVE: Array<[string, string, string]> = [
  ['anthropic key', 'key is sk-ant-TESTabcdefghijklmnopqrstuv', 'sk-ant-TEST'],
  ['openai key', 'sk-TESTabcdefghijklmnopqrstuvwx', 'sk-TESTabcdefgh'],
  ['github pat', 'ghp_TESTabcdefghijklmnopqrstuvwxyz0123456', 'ghp_TEST'],
  ['github fine pat', 'github_pat_TESTabcdefghijklmnopqrstuvwxyz0123456789ab', 'github_pat_TEST'],
  ['aws access key id', 'id AKIATESTTESTTESTTEST', 'AKIATESTTESTTESTTEST'],
  ['aws sts key id', 'id ASIATESTTESTTESTTEST', 'ASIATESTTESTTESTTEST'],
  ['slack token', 'xoxb-1234567890-TESTTESTTEST', 'xoxb-1234567890'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJURVNUIn0.TESTsignature123', 'eyJhbGciOiJIUzI1NiJ9'],
  ['stripe live', 'sk_live_TESTabcdefghijkl', 'sk_live_TEST'],
  ['npm token', 'npm_TESTabcdefghijklmnopqrstuvwxyz0123', 'npm_TEST'],
  ['gitlab pat', 'glpat-TESTabcdefghijklmnop', 'glpat-TEST'],
  ['google api key', 'AIzaTESTabcdefghijklmnopqrstuvwxyz012345', 'AIzaTEST'],
  ['hf token', 'hf_TESTabcdefghijklmnopqrstuvwx', 'hf_TEST'],
  ['sendgrid', 'SG.TESTabcdefghijklmnop.TESTabcdefghijklmnop', 'SG.TEST'],
  ['slack webhook', 'curl https://hooks.slack.com/services/T0TEST/B0TEST/TESTsecretpart', 'T0TEST/B0TEST'],
  ['authorization basic', 'Authorization: Basic dXNlcjpURVNUcGFzcw==', 'dXNlcjpURVNUcGFzcw'],
  ['authorization bearer short', 'authorization: Bearer abc123', 'abc123'],
  ['proxy-authorization', 'Proxy-Authorization: Digest TESTVALUE9', 'TESTVALUE9'],
  ['curl -H bearer', `curl -H "Authorization: Bearer TESTtoken12345678901234" https://x.test`, 'TESTtoken12345678901234'],
  ['curl --header', `curl --header 'Authorization: token TESTSECRETVALUE' https://x.test`, 'TESTSECRETVALUE'],
  ['x-api-key', 'X-API-Key: TESTkeyvalue', 'TESTkeyvalue'],
  ['api-key header', 'api-key: TESTkeyvalue2', 'TESTkeyvalue2'],
  ['x-auth-token', 'x-auth-token: TESTauthvalue', 'TESTauthvalue'],
  ['x-amz-security-token', 'X-Amz-Security-Token: TESTamzvalue', 'TESTamzvalue'],
  ['cookie', 'Cookie: sid=TESTcookie; theme=dark', 'TESTcookie'],
  ['set-cookie', 'Set-Cookie: session=TESTsetcookie; HttpOnly', 'TESTsetcookie'],
  ['json header key', '{"Authorization": "Bearer TESTjsonvalue99"}', 'TESTjsonvalue99'],
  ['curl -u', 'curl -u admin:TESTpassw0rd https://x.test', 'TESTpassw0rd'],
  ['curl --user', 'curl --user admin:TESTpassw0rd2 https://x.test', 'TESTpassw0rd2'],
  ['curl -u quoted', `curl -u "admin:TEST pass3" https://x.test`, 'TEST pass3'],
  ['--password flag', 'tool login --password TESTflagpass', 'TESTflagpass'],
  ['--token=', 'tool --token=TESTflagtoken', 'TESTflagtoken'],
  ['docker login -p', 'docker login -u me -p TESTdockerpw reg.test', 'TESTdockerpw'],
  ['mysql -p', 'mysql -h db -u root -pTESTmysqlpw app', 'TESTmysqlpw'],
  ['sshpass -p', 'sshpass -p TESTsshpw ssh host', 'TESTsshpw'],
  ['ps -Password bare', 'Connect-Foo -User bob -Password hunter22xx', 'hunter22xx'],
  ['ps -Password quoted', "Connect-Foo -Password 'S3cretPwd99'", 'S3cretPwd99'],
  ['ps ConvertTo-SecureString arg', 'ConvertTo-SecureString "P@ssw0rd!Hunter" -AsPlainText -Force', 'P@ssw0rd!Hunter'],
  ['ps ConvertTo-SecureString pipe', '$s = "hunter2hunter2" | ConvertTo-SecureString -AsPlainText', 'hunter2hunter2'],
  ['ps PSCredential', 'New-Object PSCredential("bob",(ConvertTo-SecureString "Tr0ub4dor&3x" -AsPlainText))', 'Tr0ub4dor'],
  ['env DB_PASS', 'DB_PASS=hunter2hunter2', 'hunter2hunter2'],
  ['env SSHPASS inline', 'SSHPASS=hunter2hunter2 sshpass -e ssh h', 'hunter2hunter2'],
  ['url pass param', 'https://x.test/login?user=bob&pass=correcthorse', 'correcthorse'],
  ['line-wrapped sk-ant tail', 'key sk-ant-' + 'TESTabcdefghijklmnopqrstuv\nStUvWxYz0123456789_-AbCdEf done', 'StUvWxYz0123456789'],
  ['line-wrapped ghp tail', 'ghp_' + 'TESTabcdefghijklmnopqrstuvwx\nyz0123456789ABCD', 'yz0123456789ABCD'],
  ['az login -p', 'az login -u x -p hunter2hunter2', 'hunter2hunter2'],
  ['7z -p', '7z a out.7z in -pSECRETTEST1', 'SECRETTEST1'],
  ['openssl -pass pass:', 'openssl enc -aes256 -pass pass:TESTsslpw -in a', 'TESTsslpw'],
  ['setx secret', 'setx MY_SECRET TESTsetxvalue', 'TESTsetxvalue'],
  ['netrc one line', 'machine h login u password TESTnetrcpw', 'TESTnetrcpw'],
  ['netrc multi line', 'machine h\nlogin u\npassword TESTnetrcpw2\n', 'TESTnetrcpw2'],
  ['htpasswd -b', 'htpasswd -b .htpasswd bob TESThtpw', 'TESThtpw'],
  ['aws secret env', 'AWS_SECRET_ACCESS_KEY=TESTawssecret/value+x', 'TESTawssecret'],
  ['export openai env', 'export OPENAI_API_KEY=TESTopenaikeyvalue', 'TESTopenaikeyvalue'],
  ['env with spaces in value', 'DB_PASSWORD=TEST pass with spaces', 'TEST pass with spaces'],
  ['env quoted', `GITHUB_TOKEN="TESTquoted value"`, 'TESTquoted value'],
  ['powershell env', '$env:STRIPE_SECRET = "TESTpsvalue"', 'TESTpsvalue'],
  ['inline env', 'MY_API_TOKEN=TESTinline node app.js', 'TESTinline'],
  ['dsn env', 'SENTRY_DSN=https://TESTpub@o1.ingest.sentry.test/1', 'TESTpub'],
  ['url userinfo', 'git clone https://alice:TESTurlpass@host.test/r.git', 'TESTurlpass'],
  ['url userinfo postgres', 'postgres://app:TEST!pw@db.test:5432/x', 'TEST!pw'],
  ['url token-only userinfo', 'https://TESTtokenonlyuserinfo1234@host.test/r', 'TESTtokenonlyuserinfo1234'],
  ['access_token query', 'GET /cb?access_token=TESTquerytoken&x=1', 'TESTquerytoken'],
  ['sig query', 'https://s.test/b?sig=TESTsigvalue%3D&se=2030', 'TESTsigvalue'],
  ['fragment id_token', 'https://x.test/#id_token=TESTidtoken&state=1', 'TESTidtoken'],
  ['api_key query', 'https://x.test/?api_key=TESTqueryapikey', 'TESTqueryapikey'],
  ['code query', 'https://x.test/cb?code=TESTauthcode&state=s', 'TESTauthcode'],
  ['conn string Password', 'Server=db;User Id=sa;Password=TESTconnpass;Encrypt=true', 'TESTconnpass'],
  ['conn string AccountKey', 'DefaultEndpointsProtocol=https;AccountKey=TESTaccountkey==;EndpointSuffix=x', 'TESTaccountkey'],
  ['conn string SAS', 'SharedAccessSignature=TESTsas;Foo=1', 'TESTsas'],
  ['pem block', '-----BEGIN RSA PRIVATE KEY-----\nTESTpemline1\nTESTpemline2\n-----END RSA PRIVATE KEY-----', 'TESTpemline1'],
  ['openssh block', '-----BEGIN OPENSSH PRIVATE KEY-----\nTESTosshline\n-----END OPENSSH PRIVATE KEY-----', 'TESTosshline'],
  ['json token field', '{"refresh_token":"TESTrefreshvalue"}', 'TESTrefreshvalue'],
  ['json client_secret', '{"client_secret": "TESTclientsecret"}', 'TESTclientsecret'],
  ['password field', 'password: hunter2TEST', 'hunter2TEST'],
  ['mixed-case 32 token', `value ${MIXED32} end`, MIXED32],
  ['40-char mixed token', 'x aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF2gH4jK6m y', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF2gH4jK6m'],
  ['base64 key with slash', 'k=wJalrXUtnFEMI/K7MDENG/bPxRfiCYTESTKEY00', 'wJalrXUtnFEMI/K7MDENG'],
  ['padded base64 run', `v ${MIXED32}== v`, MIXED32],
  ['bare pem body line', 'MIIEowIBAAKCAQEAtestTESTtestTESTtestTESTtestTEST0123456789abcdef', 'MIIEowIBAAKCAQEA'],
  ['discord webhook', 'https://discord.com/api/webhooks/123456/TESTwebhooktoken', 'TESTwebhooktoken'],
];

const NEGATIVE: string[] = [
  'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', // git sha
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // sha256
  '123e4567-e89b-12d3-a456-426614174000',
  '123E4567-E89B-12D3-A456-426614174000', // uppercase uuid
  'A1B2C3D4E5F6A7B8C9D0a1b2c3d4e5f6a7b8c9d0', // mixed-case 40 hex
  'const secret: string',
  'secret: string | undefined;',
  'function add(a: number, b: number) { return a + b; }',
  'C:\\Users\\Matt\\projects\\aether-os\\src\\main.ts',
  'npm run typecheck:electron && git status --short',
  'git push -u origin feat/v3-a3-t2',
  'Please fix the layout of the settings page.',
  'The basic information is shown here.',
  'Bearer tokens are described in the docs.',
  'https://example.com/docs/page?id=42&lang=en',
  'const maxTokens = 4000;',
  'for (let i = 0; i < 10; i++) {}',
  'import { redactText } from "./threadRedact";',
  'ls -la /home/matt',
  'auth: AuthState',
  'const sessionId = useSessionId()',
  'line one\nplain next line',
  'mkdir -p build/out && docker run -p 8080:80 img',
];

describe('redactText positive corpus', () => {
  it('has at least 40 shapes', () => {
    expect(POSITIVE.length).toBeGreaterThanOrEqual(40);
  });
  for (const [label, input, secret] of POSITIVE) {
    it(`masks ${label}`, () => {
      const out = redactText(input);
      expect(out).not.toContain(secret);
      expect(out).toContain('[redacted]');
    });
  }
});

describe('redactText negative corpus', () => {
  it('has at least 15 strings', () => {
    expect(NEGATIVE.length).toBeGreaterThanOrEqual(15);
  });
  for (const s of NEGATIVE) {
    it(`leaves unchanged: ${s.slice(0, 40)}`, () => {
      expect(redactText(s)).toBe(s);
    });
  }
});

describe('redactText env-style names stay masked', () => {
  it('masks an uppercase env name even when the value looks like code', () => {
    expect(redactText('API_KEY=process.env.TESTvalue')).not.toContain('process.env');
  });
  it('does not absorb the next line after a masked line when it is ordinary text', () => {
    expect(redactText('Authorization: Bearer x\nContent-Type: json')).toContain('Content-Type');
  });
});

describe('redactText properties', () => {
  it('is idempotent over the whole positive and negative corpus', () => {
    for (const [, input] of POSITIVE) {
      const once = redactText(input);
      expect(redactText(once)).toBe(once);
    }
    for (const s of NEGATIVE) expect(redactText(redactText(s))).toBe(redactText(s));
  });

  it('is case-insensitive for header names and env-free flags', () => {
    expect(redactText('AUTHORIZATION: Basic dGVzdDp0ZXN0Zm9v==')).not.toContain('dGVzdDp0');
    expect(redactText('cOoKiE: a=TESTmixedcase')).not.toContain('TESTmixedcase');
    expect(redactText('--PASSWORD TESTupper')).not.toContain('TESTupper');
  });

  it('keeps header names and surrounding prose so output stays readable', () => {
    const out = redactText('before\nAuthorization: Bearer TESTkeep12345\nafter');
    expect(out).toContain('before');
    expect(out).toContain('Authorization:');
    expect(out).toContain('after');
  });
});

describe('redactToolOutput caps', () => {
  it('masks before capping: a secret straddling byte 4096 leaves no prefix', () => {
    const secret = 'sk-ant-TESTabcdefghijklmnopqrstuvwxyz0123456789';
    const text = 'x'.repeat(4096 - 12) + ' ' + secret + ' tail';
    const { text: out } = redactToolOutput(text, { sensitivePath: false });
    expect(out).not.toContain('sk-ant');
    expect(out).not.toContain('sk-');
    expect(out).not.toContain('TESTabc');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('caps at 4096 bytes without splitting a code point; more is 1 when only bytes hit', () => {
    const text = '\u{1F600}'.repeat(2000); // 4 bytes each, one line
    const { text: out, more } = redactToolOutput(text, { sensitivePath: false });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096);
    expect(out).not.toContain('\uFFFD');
    expect([...out].every((c) => c === '\u{1F600}')).toBe(true);
    expect(more).toBe(1);
  });

  it('caps at 60 lines and reports the omitted count', () => {
    const text = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n');
    const { text: out, more } = redactToolOutput(text, { sensitivePath: false });
    expect(out.split('\n')).toHaveLength(60);
    expect(out.endsWith('l59')).toBe(true);
    expect(more).toBe(40);
  });

  it('passes a short output through with more 0', () => {
    expect(redactToolOutput('hello\nworld\n', { sensitivePath: false })).toEqual({
      text: 'hello\nworld',
      more: 0,
    });
  });

  it('replaces the whole output on a sensitive path', () => {
    const r = redactToolOutput('API_KEY=plain\nanything', { sensitivePath: true });
    expect(r).toEqual({ text: '[redacted: sensitive file]', more: 0 });
  });
});

describe('redactToolInput caps (S7/S8)', () => {
  it('masks secrets in a command', () => {
    const r = redactToolInput(`curl -H "Authorization: Bearer TESTinput123456" x`, {
      sensitivePath: false,
    });
    expect(r.text).not.toContain('TESTinput123456');
  });

  it('caps at 2048 bytes', () => {
    const r = redactToolInput('y'.repeat(5000), { sensitivePath: false });
    expect(Buffer.byteLength(r.text, 'utf8')).toBe(2048);
    expect(r.more).toBe(1);
  });

  it('caps at 30 lines', () => {
    const text = Array.from({ length: 50 }, (_, i) => `n${i}`).join('\n');
    const r = redactToolInput(text, { sensitivePath: false });
    expect(r.text.split('\n')).toHaveLength(30);
    expect(r.more).toBe(20);
  });

  it('masks a secret straddling byte 2048', () => {
    const text = 'z'.repeat(2048 - 5) + ' ghp_TESTabcdefghijklmnopqrstuvwxyz012345';
    expect(redactToolInput(text, { sensitivePath: false }).text).not.toContain('ghp_');
  });

  it('replaces content wholesale when the path is sensitive', () => {
    const r = redactToolInput('old_string: hunter2', { sensitivePath: true });
    expect(r).toEqual({ text: '[redacted: sensitive file]', more: 0 });
  });
});

describe('isSensitivePath', () => {
  const yes = [
    'C:\\Users\\u\\.claude\\.credentials.json',
    'app/secrets/foo.txt',
    '/home/u/.pypirc',
    '/home/u/.vault-token',
    'gcp/service-account-prod.json',
    '/home/u/.claude.json',
    '/home/u/.config/gh/hosts.yml',
    'fn/local.settings.json',
    '/app/.env',
    'C:\\proj\\.env.local',
    'a/b/.env.production',
    '/home/u/.ssh/config',
    'C:\\Users\\u\\.aws\\credentials',
    '/home/u/.gnupg/pubring.kbx',
    'cert/server.pem',
    'k/private.KEY',
    'x/store.pfx',
    'x/a.p12',
    'x/a.ppk',
    'x/vault.kdbx',
    '/home/u/id_rsa',
    '/home/u/id_ed25519.pub',
    'cfg/credentials.json',
    'cfg/secrets.yaml',
    'cfg/secret',
    '/home/u/.npmrc',
    '/home/u/.netrc',
    '/home/u/.pgpass',
  ];
  const no = ['src/main.ts', 'README.md', 'docs/environment.md', 'src/envelope.ts', 'a/b/keyboard.ts', 'C:\\proj\\src\\secretary.ts'];
  for (const p of yes) it(`flags ${p}`, () => expect(isSensitivePath(p)).toBe(true));
  for (const p of no) it(`allows ${p}`, () => expect(isSensitivePath(p)).toBe(false));
});

// ---------------------------------------------------------------------------------------
// Engine corpora (redesign 2026-10-26). Each case is [label, input, substring that must vanish].
// Four independent probes: round 1 (86 shapes), round 2 (110 shapes, UNC and registry paths as
// real backslashes), the engine probe written against the lexicon (every syntax family) and a
// tool-output probe (docker, k8s, aws, azure, java, go, CI shapes).
// Every secret is an obvious FAKE. The keep lists are over-redaction negatives: they must come
// back unchanged.
// ---------------------------------------------------------------------------------------
type Case = [label: string, input: string, secret: string];

// Accepted classes: prose with no name anchor ("the password is X", "api key is X"), a
// zero-width-split token, an unprefixed 32-hex vendor key. They stay out of the must-vanish set.
const ACCEPTED = new Set([
  'hex 32 api key prose',
  'lowercase 48 prose token',
  'prose password',
  'prose pw (known class)',
  'prose api key (known class)',
]);

const ROUND1 = (() => {
  const BS = String.fromCharCode(92);
  const cases: Case[] = [
['aws creds file', '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n', 'wJalrXUtnFEMI'],
['aws akid only', 'key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
['aws secret bare', 'secret is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok', 'bPxRfiCYEXAMPLEKEY'],
['gh fine-grained', 'token github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ12 done', '11ABCDEFG0abcdef'],
['anthropic json', '{"api_key":"sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf"}', 'sk-ant-api03'],
['openai json', '{"apiKey": "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd"}', 'sk-proj'],
['openai json other key', '{"key": "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd"}', 'AbCdEfGhIjKl'],
['PEM', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\nVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK\n-----END RSA PRIVATE KEY-----', 'VTLw7onLRnrq0'],
['PEM no end', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Ul8cKj\nMzEfYyjiWA4R4/M2bS1GB4t7NXp9', 'MIIEvQIBADANBg'],
['PEM openssh short lines', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAt\n-----END OPENSSH PRIVATE KEY-----', 'AAAAEbm9uZQ'],
['postgres', 'postgres://admin:Sup3rS3cret!@db.example.com:5432/app', 'Sup3rS3cret'],
['mongo srv', 'mongodb+srv://appuser:hunter2pass@cluster0.abcde.mongodb.net/test?retryWrites=true', 'hunter2pass'],
['redis no user', 'redis://:p4ssw0rdXYZ@cache:6379', 'p4ssw0rdXYZ'],
['azure sas', 'https://acct.blob.core.windows.net/c/f.txt?sv=2022-11-02&ss=b&sig=AbCdEf%2FGh1JkLmNoPqRsTuVwXyZ%3D&se=2030-01-01', 'AbCdEf%2FGh1'],
['pw url query', 'https://x.example.com/login?user=bob&password=correcthorse&next=/', 'correcthorse'],
['pass url query', 'https://x.example.com/login?user=bob&pass=correcthorse&next=/', 'correcthorse'],
['export FOO_SECRET', 'export FOO_SECRET=abc123def\n', 'abc123def'],
['export FOO_SECRET quoted', 'export FOO_SECRET="abc 123 def"', 'abc 123'],
['npmrc', '//registry.npmjs.org/:_authToken=abcd1234-ef56-7890-abcd-ef1234567890', 'abcd1234-ef56'],
['npmrc _auth', '_auth=dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
['docker config', '{"auths":{"https://index.docker.io/v1/":{"auth":"bXl1c2VyOm15cGFzc3dvcmQ="}}}', 'bXl1c2VyOm15cGFzc3dvcmQ'],
['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3'],
['slack curl data', 'curl -X POST https://slack.com/api/chat.postMessage --data-urlencode token=xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', 'xoxb-1234'],
['slack curl H', 'curl -H "X-Slack: xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx" https://x', 'AbCdEfGhIjKl'],
['ps securestring dq', 'ConvertTo-SecureString "P@ssw0rd!Hunter" -AsPlainText', 'P@ssw0rd!Hunter'],
['ps -Password (CTSS sq)', `New-LocalUser -Name x -Password (ConvertTo-SecureString 'S3cretPwd99' -AsPlainText)`, 'S3cretPwd99'],
['ps -Password plain', 'Connect-Foo -Username bob -Password hunter22xx', 'hunter22xx'],
['ps $password', '$password = "Tr0ub4dor&3"', 'Tr0ub4dor'],
['ps pscredential', 'New-Object PSCredential("bob", (ConvertTo-SecureString "Tr0ub4dor&3x" -AsPlainText))', 'Tr0ub4dor'],
['pipe to CTSS', '$s = "hunter2hunter2" | ConvertTo-SecureString -AsPlainText', 'hunter2hunter2'],
['line wrap split sk-ant', 'key=sk-ant-api03-AbCdEfGhIjKlMnOpQr\nStUvWxYz0123456789_-AbCdEf done', 'StUvWxYz0123456789'],
['line wrap split ghp', 'ghp_abcdefghijklmnopqrstuvwx\nyz0123456789ABCD', 'yz0123456789ABCD'],
['edit old_string env', 'OPENAI_API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz\nDATABASE_URL=postgres://u:pw1234@h/db', 'pw1234'],
['env lowercase', 'db_password=hunter2hunter2', 'hunter2hunter2'],
['env MY_PASS', 'MY_PASS=hunter2hunter2', 'hunter2hunter2'],
['env DB_PASS', 'DB_PASS=hunter2hunter2', 'hunter2hunter2'],
['env spaced', 'DB_PASSWORD = "hunter 2 hunter"', 'hunter 2'],
['json password', '{"password":"hunter2hunter2"}', 'hunter2hunter2'],
['json passwd', '{"passwd":"hunter2hunter2"}', 'hunter2hunter2'],
['json client_secret', '{"client_secret":"abcdEFGH1234"}', 'abcdEFGH1234'],
['yaml password', 'password: hunter2hunter2', 'hunter2hunter2'],
['yaml secret', 'secret: hunter2hunter2', 'hunter2hunter2'],
['sshpass', 'sshpass -p hunter2hunter2 ssh a@b', 'hunter2hunter2'],
['mysql -p', 'mysql -u root -phunter2hunter2 db', 'hunter2hunter2'],
['PGPASSWORD', 'PGPASSWORD=hunter2hunter2 psql -h x', 'hunter2hunter2'],
['curl -d pass', 'curl -d "username=a&password=hunter2hunter2" https://x', 'hunter2hunter2'],
['curl -d json', `curl -d '{"password":"hunter2hunter2"}' https://x`, 'hunter2hunter2'],
['az login -p', 'az login -u bob@x.com -p hunter2hunter2', 'hunter2hunter2'],
['az sp -p', 'az login --service-principal -u app -p 8Q~abcdefghijklmnopqrstuvwxyz012345 --tenant t', '8Q~abcdefg'],
['git clone ghp url', 'git clone https://bob:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y', 'ghp_abcdef'],
['bearer short', 'curl -H "Authorization: Bearer abcdefgh" x', 'abcdefgh'],
['cookie', 'Cookie: session=abc123; other=xyz', 'abc123'],
['gcp private_key json', '{"private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\n"}', 'MIIEvQIBADAN'],
['azure storage conn', 'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abc123def456ghi789jkl012mno345pqr678stu901vwx234yz==;EndpointSuffix=core.windows.net', 'abc123def456'],
['sas qs', 'sv=2022-11-02&sr=b&sig=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA%3D%3D&sp=r', 'Zm9vYmFyYmF6'],
['secret_key_base hex json', '"secret_key_base": "9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c"', '9f8a7b6c5d4e3f'],
['hex 32 api key prose', 'api key is 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c', '9f8a7b6c5d4e3f2a'],
['lowercase 48 prose token', 'token abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv', 'abcdefghijklmnopqrstuv'],
['stripe rk', 'rk_live_abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqr'],
['sendgrid env', 'SENDGRID_API_KEY=SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABCDE', 'abcdefghijklmnop'],
['openai bare', 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz', 'AbCdEfGhIjKlMnOp'],
['gitlab url', 'https://oauth2:glpat-abcdefghij1234567890@gitlab.com/x.git', 'glpat-abcdefghij'],
['heroku uuid key', 'HEROKU_API_KEY=12345678-1234-1234-1234-123456789012', '12345678-1234-1234'],
['uuid bearer', 'Authorization: Bearer 12345678-1234-1234-1234-123456789012', '12345678-1234'],
['zero width', 'sk-ant-api03-AbCdEfGhIj​KlMnOpQrStUvWxYz0123456789', 'StUvWxYz'],
['CRLF env', 'FOO_TOKEN=abcdefghi\r\nBAR=1', 'abcdefghi'],
['prose password', 'the password is hunter2hunter2 ok', 'hunter2hunter2'],
['sshpass -e env', 'SSHPASS=hunter2hunter2 sshpass -e ssh a@b', 'hunter2hunter2'],
['openssl pass:', 'openssl enc -aes-256-cbc -pass pass:hunter2hunter2 -in a', 'hunter2hunter2'],
['7z -p', '7z a -phunter2hunter2 x.7z y', 'hunter2hunter2'],
['Authorization: token', 'curl --header "Authorization: token ghx12345" x', 'ghx12345'],
['git extraheader', 'git -c http.extraheader="AUTHORIZATION: basic dXNlcjpwYXNz" fetch', 'dXNlcjpwYXNz'],
['netrc line', 'machine example.com login bob password hunter2hunter2', 'hunter2hunter2'],
['htpasswd -b', 'htpasswd -b file bob hunter2hunter2', 'hunter2hunter2'],
['sftp url pw', 'sftp://bob:hunter2hunter2@host/x', 'hunter2hunter2'],
['ps -Password sq', `-Password 'S3cretPwd99'`, 'S3cretPwd99'],
['twilio curl -u', 'curl -u ACabcdef0123456789abcdef0123456789:0123456789abcdef0123456789abcdef https://api.twilio.com', '0123456789abcdef0123456789abcdef'],
['wget password', 'wget --http-password=hunter2hunter2 http://x', 'hunter2hunter2'],
['git remote add', 'git remote add origin https://bob:hunter2hunter2@git.example.com/x.git', 'hunter2hunter2'],
['aws cli', 'aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
['kubectl token', 'kubectl --token=eyJhbGciOiJSUzI1NiIsImtpZCI6IiJ9.eyJpc3MiOiJrdWJlcm5ldGVzL3NlcnZpY2VhY2NvdW50In0.abcDEF123ghiJKL456', 'abcDEF123ghi'],
['terraform var', 'terraform apply -var "db_password=hunter2hunter2"', 'hunter2hunter2'],
['docker run -e', 'docker run -e DB_PASSWORD=hunter2hunter2 img', 'hunter2hunter2'],
['setx', 'setx GITHUB_TOKEN ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdef'],
['setx plain', 'setx MYAPP_SECRET hunter2hunter2', 'hunter2hunter2'],
['PEM CRLF', '-----BEGIN RSA PRIVATE KEY-----\r\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\r\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAu1SU'],
  ];
  const keep: string[] = ['commit 2fc8e04a1b2c3d4e5f60718293a4b5c6d7e8f901', 'sha 2fc8e04', 'id 550e8400-e29b-41d4-a716-446655440000',
['C:', 'Users', 'Matt', 'projects', 'aether-os', 'electron', 'thread', 'threadRedact.ts'].join(BS), 'const x = foo(bar, baz);', 'import { redactText } from "./threadRedact";',
'const secret: string = "";', 'git log --oneline -5', 'npm run typecheck:electron',
['C:', 'Users', 'Matt', 'AppData', 'Local', 'Temp', 'claude', 'C--Users-Matt', '8c9e8abd-fbfc-4cca-b6d3-1d8af925c9eb', 'scratchpad'].join(BS),
'node_modules/.vite/deps/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.js', 'src/shared/remote/ThreadMessageHandlerFactoryImplementation2.ts',
'function getTokenCount(): number { return 1 }', 'const tokenizer = new Tokenizer(opts)', 'const keyboard = 1; let author = "x"',
'for key in keys: print(key)', 'ssh-keygen -t ed25519', 'tokenCount: 5', 'if (auth) { return }',
'sha256:9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a', 'https://github.com/mwgrant21/aether-os/pull/121',
'Read the file electron/thread/threadRedact.ts and its test', 'const authorName = getAuthor(commit)', 'const key = event.key', 'export const THREAD_TOKEN_LIMIT = 100;',
'const apiKey = process.env.API_KEY;', 'password: string', 'passwordField.focus()', '- keyboard: ok', 'src/components/Authentication/LoginForm.tsx',
'const author = commit.author', 'auth: AuthState', 'const sessionId = useSessionId()', 'tokens: number[]', 'function authenticate(user) {', 'const keyMap = new Map()', 'git rev-parse HEAD~1 abc1234', '"tokenizer": "bpe"', 'private readonly authService: AuthService', 'authToken: string | null', 'secret = getSecret()', 'x-forwarded-for: 1.2.3.4'];
  return { cases, keep };
})();

const ROUND2 = (() => {
const PW = 'Zx9kLm2Qw8rT';
const PW2 = 'Qw8rT-Zx9kLm2!x';
const GH = 'gh' + 'p_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const GHS = 'gh' + 's_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const YA = 'ya' + '29.' + 'a0AfH6SMBxQz1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789';
const SKL = 'sk_' + 'live_' + '51HxAbCdEfGhIjKlMnOpQrSt';
const AK = 'Zm9vYmFy' + 'QmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZkdoSWpLbE1uT3A=';
const B64BASIC = 'dXNlcm5hbWU6c3VwZXJzZWNyZXRwYXNzd29yZDEyMw==';
const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\nMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu\nNMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ';
const VAULT = 'hv' + 's.' + 'CAESIJlBbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQ';
const AZ = '8Q' + '~' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345.67';
const MG = 'key' + '-' + '9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c';
const TG = '123456789' + ':' + 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const KEY64 = 'q7Zr1LmN8xWc3VbT5yHd9KfJ2sPa6GeU4oXiR0tYnMvB1cQw8ZkL3hDfS5jA7uEg';

  const cases: Case[] = [
  ['ps splat Password', `$p = @{Password='${PW}'; User='bob'}`, PW],
  ['ps splat spaced dq', `$p = @{ Username = "bob"; Password = "${PW}" }`, PW],
  ['ps env API_KEY', `$env:API_KEY = '${PW}'`, PW],
  ['ps env nospace dq', `$env:GITHUB_TOKEN="${PW}"`, PW],
  ['ps Set-Secret', `Set-Secret -Name Foo -Secret '${PW}'`, PW],
  ['ps Set-Secret vault', `Set-Secret -Name Foo -Secret "${PW}" -Vault V`, PW],
  ['ps $secret var', `$secret = '${PW}'`, PW],
  ['ps $clientSecret var', `$clientSecret = "${PW}"`, PW],
  ['ps $pw var', `$pw = '${PW}'`, PW],
  ['ps NetworkCredential', `[System.Net.NetworkCredential]::new('bob','${PW}')`, PW],
  ['ps PSCredential newobj positional', `New-Object System.Management.Automation.PSCredential('bob', (ConvertTo-SecureString '${PW}' -AsPlainText -Force))`, PW],
  ['ps headers X-Api-Key', `Invoke-RestMethod -Headers @{ 'X-Api-Key' = '${PW}' } -Uri https://x`, PW],
  ['ps headers Authorization bearer', `-Headers @{Authorization = "Bearer ${PW}9"}`, PW],
  ['yaml password list', `services:\n  db:\n    - password: ${PW}\n`, PW],
  ['yaml api_key', `  api_key: ${PW}\n`, PW],
  ['yaml client-secret', `client-secret: ${PW}`, PW],
  ['yaml quoted password', `password: "${PW} with space"`, PW],
  ['env spaced eq', `DB_PASSWORD = ${PW}\nAPI_KEY =  '${PW2}'`, PW],
  ['env spaced eq 2', `API_KEY =  '${PW2}'`, PW2],
  ['auth token header', `Authorization: token ${GH}`, GH.slice(4)],
  ['git remote token', `origin\thttps://${GH}@github.com/mwgrant21/x.git (fetch)`, GH.slice(4)],
  ['git remote x-access-token', `https://x-access-token:${GHS}@github.com/o/r.git`, GHS.slice(4)],
  ['git remote oauth2 glab', `https://oauth2:${PW}@gitlab.com/o/r.git`, PW],
  ['az storage account-key', `az storage blob list --account-name a --account-key ${AK} -c x`, AK.slice(5)],
  ['az storage account-key quoted', `az storage blob list --account-key "${AK}"`, AK.slice(5)],
  ['az storage connection-string', `az storage x --connection-string "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${AK};"`, AK.slice(5)],
  ['gcloud ya29', `$ gcloud auth print-access-token\n${YA}\n`, YA.slice(8)],
  ['stripe sk_live', `STRIPE=${SKL}`, SKL.slice(8)],
  ['stripe in json', `{"stripe": "${SKL}"}`, SKL.slice(8)],
  ['basic header', `Authorization: Basic ${B64BASIC}`, B64BASIC.slice(5)],
  ['basic curl H', `curl -H 'Authorization: Basic ${B64BASIC}' https://x`, B64BASIC.slice(5)],
  ['proxy-auth', `Proxy-Authorization: Basic ${B64BASIC}`, B64BASIC.slice(5)],
  ['basic lowercase header json', `"authorization":"Basic ${B64BASIC}"`, B64BASIC.slice(5)],
  ['pem openssh write', `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY}\n-----END OPENSSH PRIVATE KEY-----\n`, 'MzEfYyjiWA4R4'],
  ['pem rsa indented', `   -----BEGIN RSA PRIVATE KEY-----\n   ${BODY.split('\n').join('\n   ')}\n   -----END RSA PRIVATE KEY-----`, 'NMoSfm76oqFvAp8'],
  ['pem crlf', `-----BEGIN PRIVATE KEY-----\r\n${BODY.split('\n').join('\r\n')}\r\n-----END PRIVATE KEY-----`, 'NMoSfm76oqFvAp8'],
  ['pem escaped \n in json', `{"private_key":"-----BEGIN PRIVATE KEY-----\n${BODY.split('\n').join('\n')}\n-----END PRIVATE KEY-----\n"}`, 'NMoSfm76oqFvAp8'],
  ['pem truncated no header', `${BODY}\n-----END RSA PRIVATE KEY-----`, 'NMoSfm76oqFvAp8'],
  ['json client_secret', `{"client_secret": "${PW}"}`, PW],
  ['py dict client_secret', `cfg = {'client_secret': '${PW}'}`, PW],
  ['json clientSecret camel', `{"clientSecret":"${PW}"}`, PW],
  ['json pretty password', `{\n  "db": {\n    "password": "${PW}"\n  }\n}`, PW],
  ['json pwd', `{"pwd":"${PW}"}`, PW],
  ['json pass', `{"pass": "${PW}"}`, PW],
  ['json secret', `{"secret":"${PW}"}`, PW],
  ['json db_pass', `{"db_pass":"${PW}"}`, PW],
  ['json apiSecret', `{"apiSecret":"${PW}"}`, PW],
  ['xml password', `<password>${PW}</password>`, PW],
  ['xml add key value', `<add key="secret" value="${PW}"/>`, PW],
  ['toml password', `password = "${PW}"`, PW],
  ['ini Password', `[db]\nPassword=${PW}\n`, PW],
  ['cmdkey pass', `cmdkey /add:srv01 /user:bob /pass:${PW}`, PW],
  ['cmdkey pass quoted', String.raw`cmdkey /add:srv01 /user:CORP\bob /pass:"${PW} x"`, PW],
  ['net use positional', String.raw`net use Z: \\srv\share ${PW} /user:bob`, PW],
  ['net use user then pw', String.raw`net use \\srv\ipc$ /user:bob ${PW}`, PW],
  ['net use quoted pw', String.raw`net use \\srv\ipc$ "${PW} z" /user:bob`, PW],
  ['net user add', `net user bob ${PW} /add`, PW],
  ['sqlcmd -P', `sqlcmd -S srv -U sa -P ${PW} -Q "select 1"`, PW],
  ['sqlcmd -P quoted', `sqlcmd -S srv -U sa -P "${PW}"`, PW],
  ['sqlcmd -P attached', `sqlcmd -S srv -U sa -P${PW}`, PW],
  ['curl --user', `curl --user bob:${PW} https://x`, PW],
  ['curl -u', `curl -u bob:${PW} https://x`, PW],
  ['curl --user=', `curl --user=bob:${PW} https://x`, PW],
  ['curl -u quoted', `curl -u "bob:${PW} 2" https://x`, PW],
  ['curl -ubob', `curl -ubob:${PW} https://x`, PW],
  ['wrap sk-ant at 10', `sk-ant-api03-AbCdEfGhIj\nKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl`, 'KlMnOpQrStUvWxYz0123'],
  ['wrap raw 64 at 30', `${KEY64.slice(0, 30)}\n${KEY64.slice(30)}`, KEY64.slice(30, 50)],
  ['wrap raw 64 at 20', `${KEY64.slice(0, 20)}\n${KEY64.slice(20)}`, KEY64.slice(20, 40)],
  ['wrap raw 64 at 50', `${KEY64.slice(0, 50)}\n${KEY64.slice(50)}`, KEY64.slice(0, 40)],
  ['wrap raw 64 thirds', `${KEY64.slice(0, 22)}\n${KEY64.slice(22, 44)}\n${KEY64.slice(44)}`, KEY64.slice(22, 40)],
  ['wrap ghp at 10', `${GH.slice(0, 10)}\n${GH.slice(10)}`, GH.slice(14)],
  ['wrap env key', `OPENAI_API_KEY=sk-proj-${KEY64.slice(0, 20)}\n${KEY64.slice(20)}\n`, KEY64.slice(22, 40)],
  ['wrap CRLF', `${KEY64.slice(0, 30)}\r\n${KEY64.slice(30)}`, KEY64.slice(30, 50)],
  ['mysql --password=', `mysql -u root --password=${PW} db`, PW],
  ['psql libpq string', `psql "host=h user=u password=${PW} dbname=x"`, PW],
  ['redis-cli -a', `redis-cli -h h -a ${PW}`, PW],
  ['gpg passphrase', `gpg --batch --passphrase ${PW} -d f.gpg`, PW],
  ['openssl -k', `openssl enc -aes-256-cbc -k ${PW} -in f`, PW],
  ['terraform -var', `terraform apply -var 'db_password=${PW}'`, PW],
  ['kubectl from-literal', `kubectl create secret generic x --from-literal=password=${PW}`, PW],
  ['aws configure set', `aws configure set aws_secret_access_key ${KEY64.slice(0, 40)}`, KEY64.slice(0, 40)],
  ['vault hvs', `X-Vault-Token: ${VAULT}`, VAULT.slice(8)],
  ['vault hvs bare', `token: ${VAULT}`, VAULT.slice(8)],
  ['azure ad secret bare', `value: ${AZ}`, AZ.slice(3, 20)],
  ['mailgun key-hex', `api ${MG}`, MG.slice(8)],
  ['telegram bot', `bot ${TG}`, TG.slice(12)],
  ['url pw with @', `https://bob:p@ssw0rd${PW}@host.example.com/x`, PW],
  ['reg add password', String.raw`reg add HKLM\SOFTWARE\X /v Password /t REG_SZ /d ${PW}`, PW],
  ['schtasks rp', `schtasks /create /tn x /tr y /sc daily /ru bob /rp ${PW}`, PW],
  ['psexec -p', String.raw`psexec \\host -u bob -p ${PW} cmd`, PW],
  ['wmic password', `wmic /node:h /user:bob /password:${PW} os get`, PW],
  ['js const password', `const dbPassword = '${PW}';`, PW],
  ['js obj password', `const cfg = { user: 'u', password: '${PW}' };`, PW],
  ['ts secret const', `const secret = "${PW}";`, PW],
  ['bash var', `DB_PASS='${PW}' ./run.sh`, PW],
  ['bash lower var', `password=${PW}`, PW],
  ['git config url', `git config --global url."https://${GH}@github.com/".insteadOf https://github.com/`, GH.slice(4)],
  ['npm authToken', `//registry.npmjs.org/:_authToken=${PW}`, PW],
  ['docker -e', `docker run -e "MYSQL_ROOT_PASSWORD=${PW}" mysql`, PW],
  ['header in code', `headers: { 'Authorization': 'Bearer ${PW}9' }`, PW],
  ['curl header no space', `curl -H "Authorization:Bearer ${PW}9" x`, PW],
  ['dd-api-key hdr', `curl -H "DD-API-KEY: ${MG.slice(4)}" x`, MG.slice(8)],
  ['private-token hdr', `curl -H "PRIVATE-TOKEN: ${PW}" x`, PW],
  ['cookie', `Cookie: sid=${PW}; theme=dark`, PW],
  ['set-cookie', `Set-Cookie: sid=${PW}; Path=/; HttpOnly`, PW],
  ['url sas sig', `https://a.blob.core.windows.net/c?sv=2022&sig=${KEY64.slice(0, 30)}%3D&se=2030`, KEY64.slice(0, 20)],
  ['url auth param', `https://x/?auth=${PW}`, PW],
  ['smtp pass yaml', `smtp_pass: ${PW}`, PW],
  ['prose pw (known class)', `the password is ${PW}`, PW],
  ['prose api key (known class)', `my api key: ${PW}`, PW],
  ];
  const keep: string[] = [
  `-Credential (Get-Credential)`,
  `$cred = Get-Credential`,
  `commit 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a`,
  `sha256:9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a`,
  `id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 ok`,
  `const x: Record<string, number> = {}; for (const [k, v] of Object.entries(x)) { console.log(k, v); }`,
  String.raw`Get-ChildItem -Path C:\Users\Matt\AppData\Local\Programs\Microsoft VS Code\resources -Recurse | Where-Object { $_.Length -gt 1MB }`,
  String.raw`C:\Users\Matt\Documents\GitHub\aether-os\electron\thread\threadRedact.test.ts`,
  `git log --oneline -5\n9f8a7b6 fix thread\n1a2b3c4 feat redact`,
  `function Get-Thing { param([string]$Name) Write-Output $Name }`,
  `import { describe, it, expect } from 'vitest';`,
  `export function tokenize(input: string): string[] { return input.split(' '); }`,
  `const keyboardLayout = 'qwerty';`,
  `Authors: Matt <m@x.com>`,
  `error TS2322: Type 'string' is not assignable to type 'number'.`,
  ];
  return { cases, keep };
})();

const ENGINE = (() => {

const PW = 'Zx9kLm2Qw8rT';
const PW2 = 'qW3rTy7uIo1P';
const HASH = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
const RAW = 'Qh7Zr1LmN8xWc3VbT5yHd9KfJ2sPa6GeU4oXiR0tYnMvB1cQw8ZkL3hDfS5jA7uEg';

  const cases: Case[] = [
  ['compose env list', `environment:\n  - POSTGRES_PASSWORD=${PW}\n  - X=1`, PW],
  ['compose env map', `environment:\n  MYSQL_ROOT_PASSWORD: ${PW}\n`, PW],
  ['k8s secret data', `data:\n  password: ${RAW.slice(0, 24)}=\n`, RAW.slice(0, 24)],
  ['java props', `spring.datasource.password=${PW}`, PW],
  ['jdbc query', `jdbc:mysql://h:3306/db?user=u&password=${PW}`, PW],
  ['jdbc sqlserver', `jdbc:sqlserver://h;databaseName=x;user=sa;password=${PW};`, PW],
  ['gradle', `credentials {\n  username 'u'\n  password '${PW}'\n}`, PW],
  ['groovy apiKey dq', `apiKey "${PW}"`, PW],
  ['ruby ENV', `ENV['API_KEY'] = '${PW}'`, PW],
  ['python environ', `os.environ["DB_PASSWORD"] = "${PW}"`, PW],
  ['python dict set', `config['password'] = '${PW}'`, PW],
  ['python headers set', `headers["Authorization"] = "Bearer ${PW}"`, PW],
  ['python auth tuple', `requests.get(u, auth=('bob', '${PW}'))`, PW],
  ['python HTTPBasicAuth', `HTTPBasicAuth("bob", "${PW}")`, PW],
  ['python kwargs', `connect(host="h", user="u", password="${PW}")`, PW],
  ['node set header', `req.setHeader('X-Api-Key', '${PW}')`, PW],
  ['env set call', `Environment.SetEnvironmentVariable("API_KEY", "${PW}", "User")`, PW],
  ['ps setenv', `[Environment]::SetEnvironmentVariable('GITHUB_TOKEN','${PW}','User')`, PW],
  ['useradd -p', `useradd -m bob -p '${HASH}'`, HASH.slice(8, 30)],
  ['bcrypt value', `password_hash: ${HASH}`, HASH.slice(8, 30)],
  ['mysql -p quoted', `mysql -u root -p'${PW}' db`, PW],
  ['sqlcmd -P quoted sq', `sqlcmd -S s -U sa -P '${PW}'`, PW],
  ['ldapsearch -w', `ldapsearch -x -D cn=admin -w ${PW} -b dc=x`, PW],
  ['ssh-keygen -N', `ssh-keygen -t ed25519 -N '${PW}' -f k`, PW],
  ['smbclient', `smbclient //h/s -U bob%${PW}`, PW],
  ['smbclient quoted', `smbclient //h/s -U "bob%${PW}"`, PW],
  ['mount cifs', `mount -t cifs //h/s /mnt -o username=u,password=${PW},vers=3`, PW],
  ['xfreerdp', `xfreerdp /v:h /u:bob /p:${PW}`, PW],
  ['rclone obscure', `rclone obscure ${PW}`, PW],
  ['ssm put-parameter', `aws ssm put-parameter --name /x --value ${PW} --type SecureString`, PW],
  ['az kv set', `az keyvault secret set --vault-name v --name n --value ${PW}`, PW],
  ['gh secret set', `gh secret set NAME --body ${PW}`, PW],
  ['kubectl literal other name', `kubectl create secret generic s --from-literal=db=${PW}`, PW],
  ['echo sudo -S', `echo ${PW} | sudo -S apt update`, PW],
  ['echo docker secret', `echo "${PW}" | docker secret create dbpw -`, PW],
  ['echo gh with-token', `echo ${RAW.slice(0, 30)} | gh auth login --with-token`, RAW.slice(0, 30)],
  ['chpasswd', `echo "bob:${PW}" | chpasswd`, PW],
  ['sql identified by', `CREATE USER u IDENTIFIED BY '${PW}';`, PW],
  ['sql alter login', `ALTER LOGIN sa WITH PASSWORD = '${PW}'`, PW],
  ['sql PASSWORD()', `SET PASSWORD FOR 'u'@'h' = PASSWORD('${PW}')`, PW],
  ['reg export hex', `"Password"=hex:41,00,42,00,43,00,44,00,45,00`, '45,00'],
  ['reg export sz', `"Password"="${PW}"`, PW],
  ['sc config', `sc config svc obj= DOM\\u password= ${PW}`, PW],
  ['keytool', `keytool -genkey -storepass ${PW} -keypass ${PW2} -alias a`, PW2],
  ['plink -pw', `plink -ssh -pw ${PW} bob@h`, PW],
  ['dsadd -pwd', `dsadd user "cn=bob,dc=x" -pwd ${PW}`, PW],
  ['html input password', `<input type="password" value="${PW}">`, PW],
  ['xml setting child value', `<setting name="ApiKey" serializeAs="String"><value>${PW}</value></setting>`, PW],
  ['xml element secret', `<ClientSecret>${PW}</ClientSecret>`, PW],
  ['xml connection string', `<add name="db" connectionString="Server=a;User Id=u;Password=${PW};" />`, PW],
  ['json escaped', `{\\"password\\":\\"${PW}\\"}`, PW],
  ['json spaced key', `{"password" : "${PW}"}`, PW],
  ['json nested', `{"a":{"b":{"client_secret":"${PW}"}}}`, PW],
  ['json single quoted', `{'token': '${PW}'}`, PW],
  ['yaml dash', `- token: ${PW}`, PW],
  ['yaml quoted', `password: '${PW} x'`, PW],
  ['yaml trailing comment', `password: ${PW} # prod`, PW],
  ['toml', `[db]\npassword = "${PW}"\n`, PW],
  ['hcl', `password = "${PW}"`, PW],
  ['dotenv export', `export STRIPE_SECRET_KEY=${PW}`, PW],
  ['dockerfile ENV', `ENV API_TOKEN ${PW}`, PW],
  ['dockerfile ENV eq', `ENV API_TOKEN=${PW}`, PW],
  ['dockerfile ARG', `ARG NPM_TOKEN=${PW}`, PW],
  ['rails master key', `RAILS_MASTER_KEY=${PW}`, PW],
  ['django', `DJANGO_SECRET_KEY='${PW}'`, PW],
  ['google creds env', `GOOGLE_APPLICATION_CREDENTIALS=C:/k/${PW}.json`, PW],
  ['mfa token code', `aws sts get-session-token --token-code 123456`, '123456'],
  ['aws sigv4', `Authorization: AWS4-HMAC-SHA256 Credential=AKIAXXXXXXXXXXXXXXXX/20260101/us/s3/aws4_request, Signature=${RAW.slice(0, 40)}`, RAW.slice(0, 40)],
  ['x-amz-signature', `https://b.s3.amazonaws.com/o?X-Amz-Signature=${RAW.slice(0, 40)}&X-Amz-Date=1`, RAW.slice(0, 40)],
  ['x-amz-credential', `?X-Amz-Credential=AKIAXXXXXXXXXXXXXXXX%2F20260101%2Fus%2Fs3&x=1`, 'AKIAXXXXXXXXXXXXXXXX'],
  ['subscription key hdr', `Ocp-Apim-Subscription-Key: ${PW}`, PW],
  ['functions key', `x-functions-key: ${PW}`, PW],
  ['ntlm', `Authorization: NTLM ${RAW.slice(0, 30)}`, RAW.slice(0, 30)],
  ['curl form', `curl -d "grant_type=password&username=u&password=${PW}&client_secret=${PW2}" https://x`, PW2],
  ['log line', `login attempt user=bob password=${PW} from 1.2.3.4`, PW],
  ['pip index url', `pip install --index-url https://bob:${PW}@pypi.example.com/simple x`, PW],
  ['ftp url', `ftp://bob:${PW}@h/f`, PW],
  ['ps convertto pipeline', `"${PW}" | ConvertTo-SecureString -AsPlainText -Force`, PW],
  ['ps newpassword', `Set-ADAccountPassword -Identity bob -NewPassword (ConvertTo-SecureString -AsPlainText "${PW}" -Force)`, PW],
  ['ps new-object arglist', `New-Object -TypeName PSCredential -ArgumentList 'bob','${PW}'`, PW],
  ['ps new-object spaced', `New-Object System.Management.Automation.PSCredential ("bob", "${PW}")`, PW],
  ['ps splat multiline', `$p = @{\n  Uri = 'https://x'\n  Password = ${PW}\n}`, PW],
  ['ps invoke-sqlcmd', `Invoke-Sqlcmd -ServerInstance s -Username sa -Password '${PW}' -Query 'select 1'`, PW],
  ['ps -Token', `Connect-Service -Token ${PW}`, PW],
  ['ps env colon dq', `$env:OPENAI_API_KEY = "${PW}"`, PW],
  ['ps secret var typed', `[string]$ApiKey = '${PW}'`, PW],
  ['ps param default', `param([string]$Password = '${PW}')`, PW],
  ['bash read', `PASSWORD='${PW}'; export PASSWORD`, PW],
  ['bash inline cmd', `DB_PASS=${PW} ./run.sh --flag`, PW],
  ['heroku config', `heroku config:set SECRET_KEY=${PW}`, PW],
  ['wrapped bearer', `Authorization: Bearer ${RAW.slice(0, 20)}\n${RAW.slice(20)}`, RAW.slice(20, 40)],
  ['raw 64 base64 line', `${RAW}`, RAW.slice(10, 40)],
  ['raw 40 mixed', `token-like ${RAW.slice(0, 40)} done`, RAW.slice(5, 30)],
  ['ssh pubkey like', `AAAAC3NzaC1lZDI1NTE5AAAAIBmZ${PW}XyZ1234567890`, PW],
  ['telegram', `bot 123456789:AAH${RAW.slice(0, 32)}`, RAW.slice(0, 32)],
  ['discord token', `MTAxMTExMTExMTExMTExMTEx.GaBcDe.${RAW.slice(0, 27)}`, RAW.slice(0, 27)],
  ['notion', `secret_${RAW.slice(0, 43)}`, RAW.slice(0, 43)],
  ['mailchimp', `${'9f1c3e5b7d2f4a6c8e0b1d3f5a7c9e2d'}-us14`, '9f1c3e5b7d2f4a6c8e0b'],
  ['dockerhub pat', `dckr_pat_${RAW.slice(0, 27)}`, RAW.slice(0, 27)],
  ['uuid-looking secret kv', `API_KEY=12345678-1234-1234-1234-123456789012`, '12345678-1234'],
  ['basic base64 bare', `Basic ${RAW.slice(0, 24)}==`, RAW.slice(0, 24)],
  ['cookie quoted curl', `curl -H 'Cookie: sid=${PW}; a=b' https://x`, PW],
  ['cookie curl -b', `curl -b "session=${PW}" https://x`, PW],
  ['url fragment token', `https://x/cb#access_token=${PW}&token_type=bearer`, PW],
  ['query secret', `https://x/?client_secret=${PW}&x=1`, PW],
  ['url userinfo at', `https://bob:p@ss${PW}@h/x`, PW],
  ['nuget source', `nuget sources add -Name n -Source https://h/v3 -Username u -Password ${PW}`, PW],
  ['npm login token', `npm config set //registry.npmjs.org/:_authToken ${PW}`, PW],
  ['aws set session', `aws configure set aws_session_token ${RAW.slice(0, 40)}`, RAW.slice(0, 40)],
  ];
  const keep: string[] = [
  `const x = { password: undefined, token: null, secret: true }`,
  `if (!password) throw new Error('missing password')`,
  `export interface Opts { password?: string; token: string | null; apiKey: Secret<string> }`,
  `function login(user: string, password: string): Promise<Token> {`,
  `await signIn({ username, password })`,
  `const { token, refreshToken } = await auth.login(creds)`,
  `this.token = token; this.password = password;`,
  `user.password = hash(raw)`,
  `password = getpass.getpass()`,
  `def connect(host, password=None, token=None):`,
  `self.api_key = api_key`,
  `headers = {"Authorization": f"Bearer {token}"}`,
  `Authorization: \${TOKEN}`,
  `password: \${DB_PASSWORD}`,
  `api_key: <your-api-key>`,
  `token: $TOKEN`,
  `-Password $securePw`,
  `-Credential $cred`,
  `curl -H "Authorization: $AUTH" https://x`,
  `PWD=/c/Users/Matt/projects`,
  `OLDPWD=/home/matt`,
  `tokenCount: 5`,
  `max_tokens: 4096`,
  `passwordMinLength: 12`,
  `--password-file /run/secrets/pw`,
  `--token-url https://x/oauth/token`,
  `secret_name: my-secret`,
  `docker login --password-stdin ghcr.io`,
  `git config --global user.name "Matt"`,
  `git commit -m "fix auth redirect loop"`,
  `Merge pull request #12 from mwgrant21/feat/auth-token-refresh`,
  `src/auth/tokenStore.ts`,
  `export class AuthTokenStore {`,
  `console.log('token refreshed')`,
  `ls -la ~/.ssh`,
  `ssh-keygen -t ed25519 -C "matt@x"`,
  `keyboard shortcut: ctrl+k`,
  `author: Matt`,
  `sort --key=2`,
  `{"keys": ["a", "b"], "authors": []}`,
  `const sessionTimeout = 3600;`,
  `https://example.com/a/b/c?utm_source=x&page=2`,
  `commit a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0 (HEAD -> main)`,
  `node_modules/@typescript-eslint/eslint-plugin-react-hooks/dist/index.js`,
  `feature/very-long-branch-name-for-the-thread-redactor-rewrite`,
  `ThreadMessageHandlerFactoryImplementationRegistry`,
  `thread_session_state_machine_transition_table_v2`,
  `getAuthenticationTokenFromRequestContext`,
  `--max-old-space-size=4096`,
  `2026-10-26T01:29:00.000Z build 1234567890`,
  `sha512 of file: da39a3ee5e6b4b0d3255bfef95601890afd80709`,
  `C:\\Program Files\\Microsoft VS Code\\resources\\app\\node_modules\\x.js`,
  `error TS2345: Argument of type '{ token: string; }' is not assignable`,
  `Get-Credential -Message "Enter admin credentials"`,
  `# password policy: minimum 12 characters`,
  `Passwords must be changed every 90 days.`,
  ];
  return { cases, keep };
})();

const TOOLS = (() => {

const PW = 'Qm7xKd2Lp9Zr';
const PW2 = 'Vt4nBc8Hw1Ys';
const RAW = 'rT5yHd9KfJ2sPa6GeU4oXiR0tYnMvB1cQw8ZkL3hDfS5jA7uEgQh7Zr1LmN8xWc3Vb';
const B64 = 'cGFzc3dvcmQxMjM0NTY3ODkw';

  const cases: Case[] = [
  ['docker inspect env', `"Env": [\n  "DB_PASSWORD=${PW}",\n  "PATH=/usr/bin"\n]`, PW],
  ['k8s secret yaml', `apiVersion: v1\nkind: Secret\ndata:\n  password: ${B64}\n  username: YWRtaW4=\n`, B64],
  ['sts json', `{"Credentials": {"AccessKeyId": "x", "SecretAccessKey": "${RAW.slice(0, 40)}", "SessionToken": "${RAW.slice(0, 30)}"}}`, RAW.slice(0, 30)],
  ['az sp json', `{\n  "appId": "x",\n  "password": "${PW}",\n  "tenant": "t"\n}`, PW],
  ['tf plan', `  + secret_key = "${PW}"`, PW],
  ['http body', `POST /login HTTP/1.1\r\nHost: x\r\n\r\nusername=u&password=${PW}`, PW],
  ['python repr', `{'user': 'u', 'password': '${PW}'}`, PW],
  ['python namespace', `Namespace(password='${PW}', user='u')`, PW],
  ['java toString', `User{id=1, name='bob', password=${PW}, role=ADMIN}`, PW],
  ['go struct', `{Name:bob Password:${PW} Token:${PW2}}`, PW2],
  ['env table', `Name                           Value\nOPENAI_KEY_X                   x\nGITHUB_PAT    ${PW}\nPATH   C:\\x`, PW],
  ['systemd env', `Environment=API_KEY=${PW}`, PW],
  ['s3cfg', `[default]\naccess_key = ${PW}\nsecret_key = ${PW2}\n`, PW2],
  ['my.cnf', `[client]\nuser=root\npassword=${PW}\n`, PW],
  ['set-variable', `Set-Variable -Name dbPassword -Value '${PW}' -Scope Global`, PW],
  ['k8s env name/value', `env:\n  - name: DB_PASSWORD\n    value: ${PW}\n  - name: MODE\n    value: prod`, PW],
  ['k8s env flow', `- {name: API_TOKEN, value: ${PW}}`, PW],
  ['appsettings array', `[{"name": "Stripe__SecretKey", "value": "${PW}", "slotSetting": false}]`, PW],
  ['json key/value', `{ "Key": "ApiKey", "Value": "${PW}" }`, PW],
  ['yaml block scalar', `stringData:\n  password: |\n    ${PW}\n    ${PW2}\n  other: x`, PW2],
  ['yaml folded', `password: >-\n  ${PW}\nnext: 1`, PW],
  ['clixml', `<S N="UserName">bob</S><SS N="Password">${RAW.slice(0, 40)}</SS>`, RAW.slice(0, 40)],
  ['html password input', `<input name="pw" type="password" value="${PW}"/>`, PW],
  ['maven settings', `<server><id>x</id><username>u</username><password>${PW}</password></server>`, PW],
  ['yarnrc', `npmAuthToken: "${PW}"`, PW],
  ['spring yaml', `jwt:\n  secret: ${PW}\n`, PW],
  ['ansible', `ansible_become_pass: ${PW}\nansible_password: ${PW2}`, PW2],
  ['totp uri', `otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&issuer=y`, 'JBSWY3DPEHPK3PXP'],
  ['curl cookie jar flag', `curl -b "sid=${PW}; x=1" https://x`, PW],
  ['curl --cookie', `curl --cookie "${PW}=1" https://x`, PW],
  ['wget header', `wget --header="X-Api-Key: ${PW}" https://x`, PW],
  ['gh auth status', `  - Token: gho_${RAW.slice(0, 36)}`, RAW.slice(0, 36)],
  ['json one-line pw', `{"user":"u","pwd":"${PW}"}`, PW],
  ['cs conn', `Data Source=h;Initial Catalog=d;User ID=u;Pwd=${PW};Encrypt=True;`, PW],
  ['odbc', `Driver={SQL Server};Server=h;Uid=u;Pwd=${PW};`, PW],
  ['ldap url', `ldap://cn=admin,dc=x:${PW}@h:389`, PW],
  ['git credential store', `https://bob:${PW}@github.com`, PW],
  ['proxy env', `export https_proxy=http://bob:${PW}@proxy:8080`, PW],
  ['github actions env', `env:\n  NPM_TOKEN: ${PW}\n`, PW],
  ['gha with', `with:\n  password: ${PW}\n`, PW],
  ['ps pscredential variable', `$cred = New-Object PSCredential('bob', (ConvertTo-SecureString '${PW}' -AsPlainText -Force))`, PW],
  ['ps invoke-webrequest', `Invoke-WebRequest -Uri https://x -Headers @{Authorization = "Basic ${B64}"}`, B64],
  ['ps convertfrom', `$p = ConvertTo-SecureString '${PW}' -AsPlainText -Force; $c = New-Object PSCredential('u',$p)`, PW],
  ['bash curl here', `curl -s -X POST -d 'client_secret=${PW}&grant_type=client_credentials' https://x`, PW],
  ['wget ftp', `wget --ftp-user=u --ftp-password=${PW} ftp://h/f`, PW],
  ['lftp', `lftp -u bob,${PW} sftp://h`, PW],
  ['mongosh', `mongosh "mongodb://h" --username u --password ${PW}`, PW],
  ['psql url', `psql postgresql://u:${PW}@h:5432/db`, PW],
  ['azcopy sas', `azcopy copy "https://a.blob.core.windows.net/c?sv=2022&sig=${RAW.slice(0, 30)}%3D&sp=r" .`, RAW.slice(0, 30)],
  ['nmap script', `nmap --script smb-brute --script-args userdb=u.txt,passdb=p.txt,smbpassword=${PW} h`, PW],
  ['hydra', `hydra -l bob -p ${PW} ssh://h`, PW],
  ['vault login', `vault login -method=userpass username=bob password=${PW}`, PW],
  ['bw login', `bw login bob@x.com ${PW}`, PW],
  ['wifi', `netsh wlan add profile name=x key=${PW}`, PW],
  ['redis auth', `redis-cli -u redis://:${PW}@h:6379`, PW],
  ['rabbit', `amqp://guest:${PW}@h:5672/`, PW],
  ['jdbc pw prop', `-Dspring.datasource.password=${PW}`, PW],
  ['java -D', `java -Djavax.net.ssl.keyStorePassword=${PW} -jar a.jar`, PW],
  ['maven -D', `mvn deploy -Dgpg.passphrase=${PW}`, PW],
  ['gradle -P', `gradle publish -PsigningPassword=${PW}`, PW],
  ['dotnet user-secrets', `dotnet user-secrets set "ConnectionStrings:Db" "Server=a;Password=${PW}"`, PW],
  ['dotnet user-secrets2', `dotnet user-secrets set "Stripe:SecretKey" "${PW}"`, PW],
  ['az webapp settings', `az webapp config appsettings set --settings DB_PASSWORD=${PW} MODE=x`, PW],
  ['az functionapp key', `x-functions-key=${PW}`, PW],
  ['smtp auth', `AUTH PLAIN ${B64}`, B64],
  ['base64 basic header lowercase', `authorization: basic ${B64}`, B64],
  ['nuget config', `<add key="ClearTextPassword" value="${PW}" />`, PW],
  ['xml attr password', `<connection user="u" password="${PW}" />`, PW],
  ['plist', `<key>password</key>\n<string>${PW}</string>`, PW],
  ['psk kv', `wifi.psk=${PW}`, PW],
  ['nmcli psk', `nmcli connection modify x wifi-sec.psk ${PW}`, PW],
  ['wpa_passphrase', `wpa_passphrase MyNet ${PW}`, PW],
  ['set-itemproperty', `Set-ItemProperty -Path HKCU:\\X -Name Password -Value '${PW}'`, PW],
  ['certutil -p', `certutil -importpfx -p ${PW} c.pfx`, PW],
  ['signtool /p', `signtool sign /f c.pfx /p ${PW} app.exe`, PW],
  ['sqlplus', `sqlplus system/${PW}@orcl`, PW],
  ['sqlplus quoted', `sqlplus "sys/${PW}@orcl as sysdba"`, PW],
  ['rman', `rman target sys/${PW}@db`, PW],
  ['c define', `#define API_KEY ${PW}`, PW],
  ['c define quoted', `#define DB_PASSWORD "${PW}"`, PW],
  ['android string', `<string name="api_key">${PW}</string>`, PW],
  ['perl env hash', `$ENV{API_KEY} = '${PW}';`, PW],
  ['php define', `define('DB_PASSWORD', '${PW}');`, PW],
  ['php array', `$cfg = ['password' => '${PW}'];`, PW],
  ['go assign', `token := "${PW}"`, PW],
  ['rust let', `let api_key = "${PW}";`, PW],
  ['helm set', `helm install x y --set mysql.auth.rootPassword=${PW}`, PW],
  ['vpncmd', `vpncmd /CLIENT localhost /CMD AccountPasswordSet vpn /PASSWORD:${PW}`, PW],
  ['docker build-arg', `docker build --build-arg NPM_TOKEN=${PW} .`, PW],
  ['set quoted', `set "PASSWORD=${PW}"`, PW],
  ['kubectl docker-registry', `kubectl create secret docker-registry r --docker-password=${PW}`, PW],
  ['aws rds master pw', `aws rds create-db-instance --master-user-password ${PW}`, PW],
  ['rails nested param', `user[password]=${PW}&user[email]=a`, PW],
  ['array param', `password[]=${PW}`, PW],
  ];
  const keep: string[] = [
  `credential.helper=manager`,
  `credential.username=bob`,
  `credentialsId: 'jenkins-github'`,
  `user.name=Matt`,
  `session_id: 5`,
  `  imagePullSecrets:\n    - name: regcred`,
  `kind: Secret`,
  `type: Opaque`,
  `secretKeyRef:\n  name: db\n  key: password`,
  `{"name": "bob", "value": "abc"}`,
  `- name: MODE\n  value: prod`,
  `export const API_KEYS = ['a', 'b'];`,
  `authenticated: true`,
  `token_type: Bearer`,
  `expires_in: 3600`,
  `passwordless: true`,
  `PASSWORD_MIN_LENGTH=12`,
  `Name                           Value\nPATH                           C:\\x\nTEMP    C:\\tmp`,
  `HOME=/home/matt`,
  `SHELL=/bin/bash`,
  `LS_COLORS=rs=0:di=01;34`,
  `TERM=xterm-256color`,
  `sessionStorage.setItem('theme', 'dark')`,
  `console.log('auth ok')`,
  `Authentication succeeded for user bob`,
  `password reset email sent`,
  `if (!token) return;`,
  `git log --format='%an %s' -3`,
  `import { signToken } from './jwt';`,
  `const SECRET_NAMES = ['a'];`,
  `<div class="password-field"></div>`,
  `<label for="password">Password</label>`,
  `<input type="text" name="user" value="bob">`,
  `#define MAX_TOKEN_LEN 5`,
  `const MAX_TOKENS = 4096;`,
  `PassThrough streams emit 'data' events`,
  `for pass in 1 2 3; do echo $pass; done`,
  `pass: true`,
  `export const AUTH_PROBE_TIMEOUT_MS = 15_000;`,
  `spawnedSessionId = sessionId;`,
  `pinnedLaunchSessionId = bundle.sessionId ?? null;`,
  `sessionUpdate: 'agent_message_chunk'`,
  `auth: auth!,`,
  `// Token-free: prints one line`,
  ];
  return { cases, keep };
})();

const PROBES: Array<[string, { cases: Case[]; keep: string[] }]> = [
  ['round 1', ROUND1],
  ['round 2', ROUND2],
  ['engine', ENGINE],
  ['tool output', TOOLS],
];

for (const [round, { cases, keep }] of PROBES) {
  describe(`probe ${round}: secrets vanish`, () => {
    for (const [label, input, secret] of cases) {
      if (ACCEPTED.has(label)) continue;
      it(label, () => {
        expect(redactText(input)).not.toContain(secret);
        expect(redactToolInput(input, { sensitivePath: false }).text).not.toContain(secret);
      });
    }
  });

  describe(`probe ${round}: ordinary text stays readable`, () => {
    for (const k of keep) {
      it(`keeps ${JSON.stringify(k).slice(0, 56)}`, () => {
        expect(redactText(k)).toBe(k);
      });
    }
  });
}

describe('engine layer 2: the secret-name lexicon', () => {
  const secretNames = [
    'password', 'PASSWORD', 'db_pass', 'DB_PASS', 'smtpPass', 'apiSecret', 'client-secret', 'clientSecret', 'pw', '$pw',
    'pwd', 'passphrase', 'PGPASSWORD', 'SSHPASS', 'x-api-key', 'DD-API-KEY', 'OPENAI_API_KEY', 'apiKey', 'accountkey',
    'AccountKey', 'SharedAccessKey', 'secret_key_base', 'AWS_SECRET_ACCESS_KEY', 'private_key', 'authToken', '_authToken',
    'refresh_token', 'access_token', 'id_token', 'Authorization', 'Proxy-Authorization', 'Set-Cookie', 'sig',
    'signature', 'sas', 'credentials', 'connection-string', 'ConnectionString', 'SENTRY_DSN', 'session_id', 'sessionId',
    'JSESSIONID', 'RAILS_MASTER_KEY', 'storepass', 'cOoKiE', 'GITHUB_PAT', 'npmAuthToken', 'ansible_become_pass',
  ];
  const plainNames = [
    'tokenizer', 'keyboard', 'author', 'authors', 'Authentication', 'sortKey', 'key', 'event.key', 'monkey', 'bypass',
    'compass', 'passthrough', 'maxTokens', 'tokenCount', 'THREAD_TOKEN_LIMIT', 'password_file', 'passwordField',
    'secret_name', 'token_url', 'auth_type', 'accessKeyId', 'client_id', 'private_key_id', 'secretary', 'keyMap',
    'username', 'user', 'name', 'value', 'credentialsId', 'credential.helper', 'credential.username', 'pat',
    'session_timeout', 'passwordless',
  ];
  for (const n of secretNames) it(`${n} is a secret name`, () => expect(secretLevel(n)).toBeGreaterThan(0));
  for (const n of plainNames) it(`${n} is not a secret name`, () => expect(secretLevel(n)).toBe(0));
  it('treats code, query and ?code= names as secrets only in a URL query', () => {
    expect(secretLevel('code')).toBe(0);
    expect(secretLevel('code', true)).toBeGreaterThan(0);
    expect(secretLevel('key')).toBe(0);
    expect(secretLevel('key', true)).toBeGreaterThan(0);
  });
});

describe('engine layer 3: one tokenizer across every syntax', () => {
  const V = 'Zx9kLm2Qw8rT';
  const names = ['password', 'db_pass', 'smtpPass', 'apiSecret', 'PASSWORD', 'x-api-key', 'accountkey', 'client_secret', 'authToken'];
  const syntaxes: Array<[string, (n: string) => string]> = [
    ['name=value', (n) => `${n}=${V}`],
    ['name = value', (n) => `${n} = ${V}`],
    ['name: value', (n) => `${n}: ${V}`],
    ['name = "value"', (n) => `${n} = "${V}"`],
    ['json', (n) => `{"${n}": "${V}"}`],
    ['json single quotes', (n) => `{'${n}': '${V}'}`],
    ['json escaped', (n) => `{\\"${n}\\":\\"${V}\\"}`],
    ['xml element', (n) => `<${n}>${V}</${n}>`],
    ['xml attribute', (n) => `<add ${n}="${V}" />`],
    ['xml key/value', (n) => `<add key="${n}" value="${V}"/>`],
    ['--name value', (n) => `tool --${n} ${V} run`],
    ['--name=value', (n) => `tool --${n}=${V} run`],
    ['-Name value', (n) => `Do-Thing -${n} ${V}`],
    ['-Name quoted', (n) => `Do-Thing -${n} '${V}'`],
    ['/name:value', (n) => `cmd /${n}:${V}`],
    ['$name = value', (n) => `$${n.replace(/-/g, '_')} = '${V}'`],
    ['splat', (n) => `$p = @{ User = "bob"; ${n} = "${V}" }`],
    ['url query', (n) => `https://h.test/p?${n}=${V}&x=1`],
    ['quoted key call', (n) => `set('${n}', '${V}')`],
    ['bare word then literal', (n) => `${n} '${V}'`],
    ['env line', (n) => `export ${n}=${V}`],
  ];
  for (const [syntax, make] of syntaxes) {
    it(`masks every secret name in ${syntax}`, () => {
      for (const n of names) {
        // A URL query or XML key attribute cannot hold every spelling; the name must still be seen.
        expect(redactText(make(n)), `${syntax} / ${n}`).not.toContain(V);
      }
    });
    it(`leaves non-secret names alone in ${syntax}`, () => {
      for (const n of ['tokenizer', 'keyboard', 'author', 'username']) {
        const s = make(n);
        expect(redactText(s), `${syntax} / ${n}`).toBe(s);
      }
    });
  }

  it('keeps the quotes and the surrounding structure when it masks a value', () => {
    expect(redactText('{"password": "hunter2hunter2", "user": "bob"}')).toBe('{"password": "[redacted]", "user": "bob"}');
    expect(redactText(`curl -H "Authorization: Bearer abc12345def" https://x.test`)).toBe(
      'curl -H "Authorization: [redacted]" https://x.test',
    );
    expect(redactText('x=1 db_pass=hunter2hunter2 y=2')).toBe('x=1 db_pass=[redacted] y=2');
  });

  it('exempts code but never a quoted literal', () => {
    const unchanged = [
      'const apiKey = process.env.API_KEY;',
      'const token = await getToken();',
      'secret = getSecret()',
      'this.password = password;',
      'connect(host="h", password=password)',
      'auth: AuthState',
      'password?: string',
      'token: string | null',
      'tokenCount: 5',
      '-Password $securePw',
      '-Credential (Get-Credential)',
      'password: ${DB_PASSWORD}',
      'password="$DB_PASS"',
      'headers = {"Authorization": f"Bearer {token}"}',
      'Authorization: `Bearer ${token}`',
    ];
    for (const s of unchanged) expect(redactText(s), s).toBe(s);
    const masked: Array<[string, string]> = [
      ['const password = "hunter2hunter2";', 'hunter2hunter2'],
      ['token: "string"', '"string"'],
      ['API_KEY=process.env.TESTvalue', 'process.env'],
      ['password = hunter2hunter2', 'hunter2hunter2'],
      ['pwd=123456', '123456'],
    ];
    for (const [s, gone] of masked) expect(redactText(s), s).not.toContain(gone);
  });

  it('masks a YAML block scalar, a name entry followed by its value entry, and a prefixed string', () => {
    expect(redactText('password: |\n  line1secret\n  line2secret\nnext: 1')).toBe('password: |\n[redacted]\nnext: 1');
    expect(redactText('env:\n  - name: DB_PASSWORD\n    value: hunter2hunter2\n  - name: MODE\n    value: prod')).toBe(
      'env:\n  - name: DB_PASSWORD\n    value: [redacted]\n  - name: MODE\n    value: prod',
    );
    expect(redactText('{"name": "bob", "value": "abc"}')).toBe('{"name": "bob", "value": "abc"}');
    expect(redactText('password = f"hunter2hunter2"')).toBe('password = f"[redacted]"');
    expect(redactText('Authorization: `Bearer abc12345def`')).toBe('Authorization: `[redacted]`');
  });

  it('masks a whole header or .env line but stops at the quote that opened before the name', () => {
    expect(redactText('Cookie: sid=abc; theme=dark')).toBe('Cookie: [redacted]');
    expect(redactText('DB_PASSWORD=TEST pass with spaces')).toBe('DB_PASSWORD=[redacted]');
    expect(redactText(`git -c http.extraheader="AUTHORIZATION: basic dXNlcjpwYXNz" fetch`)).toBe(
      'git -c http.extraheader="AUTHORIZATION: [redacted]" fetch',
    );
  });

  it('masks the password half of URL userinfo up to the last @ before the path', () => {
    expect(redactText('https://bob:p@ss:w0rd@h.test/x')).toBe('https://bob:[redacted]@h.test/x');
    expect(redactText('ssh://git@github.com/o/r.git')).toBe('ssh://git@github.com/o/r.git');
    expect(redactText('redis://:p4ssw0rdXYZ@cache:6379')).toBe('redis://:[redacted]@cache:6379');
  });

  it('does not treat PWD or a pwd path as a password', () => {
    expect(redactText('PWD=/home/matt/proj')).toBe('PWD=/home/matt/proj');
    expect(redactText('PWD=hunter2hunter2')).not.toContain('hunter2');
  });
});

describe('engine layer 3: positional credential commands', () => {
  const V = 'Zx9kLm2Qw8rT';
  const secretCommands: Array<[string, string]> = [
    ['net use drive', `net use Z: \\\\srv\\share ${V} /user:bob`],
    ['net use after /user', `net use \\\\srv\\ipc$ /user:bob ${V}`],
    ['net user', `net user bob ${V} /add`],
    ['cmdkey', `cmdkey /add:srv /user:bob /pass:${V}`],
    ['sqlcmd -P', `sqlcmd -S s -U sa -P ${V} -Q "select 1"`],
    ['sqlcmd -PPW', `sqlcmd -S s -U sa -P${V}`],
    ['mysql -pPW', `mysql -u root -p${V} db`],
    ['7z -pPW', `7z a out.7z in -p${V}`],
    ['redis-cli -a', `redis-cli -h h -a ${V}`],
    ['openssl -k', `openssl enc -aes-256-cbc -k ${V} -in f`],
    ['htpasswd -nb', `htpasswd -nb bob ${V}`],
    ['htpasswd -b', `htpasswd -b .htpasswd bob ${V}`],
    ['sshpass -p', `sshpass -p ${V} ssh h`],
    ['psexec -p', `psexec \\\\host -u bob -p ${V} cmd`],
    ['schtasks /rp', `schtasks /create /tn x /tr y /ru bob /rp ${V}`],
    ['az -p', `az login -u bob -p ${V}`],
    ['docker login -p', `docker login -u bob -p ${V} reg.test`],
    ['curl -u', `curl -u bob:${V} https://x.test`],
    ['curl --user=', `curl --user=bob:${V} https://x.test`],
    ['ConvertTo-SecureString arg', `ConvertTo-SecureString "${V}" -AsPlainText -Force`],
    ['ConvertTo-SecureString -String', `ConvertTo-SecureString -AsPlainText -String '${V}' -Force`],
    ['ConvertTo-SecureString pipe', `"${V}" | ConvertTo-SecureString -AsPlainText -Force`],
    ['NetworkCredential ctor', `[System.Net.NetworkCredential]::new('bob','${V}')`],
    ['PSCredential literal', `New-Object PSCredential 'bob', '${V}'`],
    ['setx', `setx MY_SECRET ${V}`],
    ['aws configure set', `aws configure set aws_secret_access_key ${V}`],
    ['reg add', `reg add HKLM\\SOFTWARE\\X /v Password /t REG_SZ /d ${V}`],
    ['echo to sudo -S', `echo ${V} | sudo -S apt update`],
    ['netrc', `machine h login bob password ${V}`],
  ];
  for (const [label, input] of secretCommands) {
    it(`masks the secret in ${label}`, () => {
      const out = redactText(input);
      expect(out).not.toContain(V);
      expect(out).toContain('[redacted]');
    });
  }

  const readable = [
    'net use Z: \\\\srv\\share /persistent:no',
    'net use * /delete',
    'net user bob',
    'net user',
    'sqlcmd -S s -d db -Q "select 1"',
    'mysql -u root -P 3306 -h db',
    'mysql -u root -p db',
    'docker run -p 8080:80 img',
    'psexec \\\\host cmd /c dir',
    'curl -u bob https://x.test',
    'curl -sSL https://x.test/install.sh',
    'ConvertTo-SecureString $plain -AsPlainText -Force',
    'ConvertTo-SecureString -String $plain -AsPlainText -Force -ErrorAction Stop',
    'setx PATH C:\\tools',
    'reg add HKLM\\SOFTWARE\\X /v Version /t REG_SZ /d 5',
    'echo hello | sudo tee /etc/motd',
    'htpasswd -D .htpasswd bob',
  ];
  for (const s of readable) it(`leaves ${s.slice(0, 50)} alone`, () => expect(redactText(s)).toBe(s));
});

describe('engine layer 1: blocks and vendor prefixes', () => {
  it('masks a private key block with or without its END line, and what follows an unterminated one', () => {
    const body = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
    const closed = redactText(`before\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nafter`);
    expect(closed).toBe('before\n[redacted]\nafter');
    const open = redactText(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\nmore`);
    expect(open).not.toContain('MIIEow');
    expect(open).not.toContain('more');
  });

  it('keeps a PGP private block separate from a PEM block it follows', () => {
    const out = redactText('-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF\n-----END PGP PRIVATE KEY BLOCK-----\nok');
    expect(out).toBe('[redacted]\nok');
  });

  it('masks a vendor token that a terminal wrapped at any column', () => {
    const tok = 'gh' + 'p_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    for (const cut of [5, 8, 12, 20, 30]) {
      const out = redactText(`${tok.slice(0, cut)}\n${tok.slice(cut)}`);
      expect(out, `cut ${cut}`).not.toContain(tok.slice(cut));
    }
  });

  it('masks Bearer and Basic values anywhere but keeps the scheme word', () => {
    expect(redactText('retry with Bearer abc12345def now')).toBe('retry with Bearer [redacted] now');
    expect(redactText('Basic dXNlcjpwYXNzd29yZA==')).toBe('Basic [redacted]');
  });
});

describe('engine layer 4: entropy and the wrap-tail absorb', () => {
  const RAW = 'Qh7Zr1LmN8xWc3VbT5yHd9KfJ2sPa6GeU4oXiR0tYnMvB1cQw8ZkL3hDfS5jA7uEg';
  const secrets = [
    RAW,
    RAW.slice(0, 20),
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    `${RAW.slice(0, 40)}==`,
    'AbCdEfGhIjKlMnOpQrStUvWxYz',
    'K3JD9XPQ2MWNZ8RT5LVB',
    'dXNlcjpwYXNzd29yZA==',
  ];
  for (const s of secrets) it(`masks an unlabeled run: ${s.slice(0, 24)}`, () => expect(redactText(`see ${s} here`)).toBe('see [redacted] here'));

  const readable = [
    'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
    'sha256:9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a',
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    'ThreadMessageHandlerFactoryImplementationRegistry',
    'getAuthenticationTokenFromRequestContext',
    'thread_session_state_machine_transition_table_v2',
    'feature/very-long-branch-name-for-the-thread-redactor-rewrite',
    '--max-old-space-size=4096',
    'src/shared/remote/ThreadMessageHandlerFactoryImplementation2.ts',
    'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv',
  ];
  for (const s of readable) it(`leaves ${s.slice(0, 44)} alone`, () => expect(redactText(s)).toBe(s));

  it('masks a key wrapped at any column, before and after the cap', () => {
    for (const cut of [20, 30, 40, 44, 50, 56]) {
      const out = redactText(`${RAW.slice(0, cut)}\n${RAW.slice(cut)}`);
      expect(out, `cut ${cut}`).not.toContain(RAW.slice(0, 20));
      expect(out, `cut ${cut}`).not.toContain(RAW.slice(cut, cut + 8));
    }
    for (const cut of [20, 30, 50]) {
      const out = redactToolOutput(`${RAW.slice(0, cut)}\r\n${RAW.slice(cut)}\r\n`, { sensitivePath: false }).text;
      expect(out, `crlf cut ${cut}`).not.toContain(RAW.slice(cut, cut + 8));
    }
  });

  it('does not eat an ordinary next line after a masked line', () => {
    expect(redactText('password: hunter2hunter2\nserver: db01')).toBe('password: [redacted]\nserver: db01');
  });
});

describe('engine: idempotence and speed over every corpus', () => {
  const every: string[] = [];
  for (const [, { cases, keep }] of PROBES) {
    for (const [, input] of cases) every.push(input);
    every.push(...keep);
  }
  for (const [, input] of POSITIVE) every.push(input);
  every.push(...NEGATIVE);

  it('redactText(redactText(x)) === redactText(x) for every corpus string', () => {
    expect(every.length).toBeGreaterThan(400);
    for (const s of every) {
      const once = redactText(s);
      expect(redactText(once), JSON.stringify(s)).toBe(once);
    }
  });

  it('is idempotent through the capped entry points too', () => {
    for (const s of every.slice(0, 120)) {
      const once = redactToolOutput(s, { sensitivePath: false }).text;
      expect(redactToolOutput(once, { sensitivePath: false }).text).toBe(once);
    }
  });

  it('redacts 1 MB in under 200 ms, for corpus text and for plain prose', () => {
    const corpus = every.join('\n');
    let big = '';
    while (big.length < 1_000_000) big += corpus + '\n';
    const prose = 'const user = getUser(id); // fetch name=value from C:\\Users\\Matt\\x.ts on feat/v3-a3-t2\nlog: ok key=1\n'.repeat(10_000);
    redactText(prose.slice(0, 5000)); // warm up
    for (const text of [big, prose]) {
      const t0 = performance.now();
      redactText(text);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});
