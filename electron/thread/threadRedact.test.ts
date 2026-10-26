import { describe, expect, it } from 'vitest';
import { isSensitivePath, redactText, redactToolInput, redactToolOutput } from './threadRedact';

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
