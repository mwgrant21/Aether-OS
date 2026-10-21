import { describe, expect, it } from 'vitest';
import { capBody, maskSecrets } from './text';

describe('maskSecrets', () => {
  it('masks an Anthropic key', () => {
    const key = 'sk-ant-' + 'a'.repeat(30);
    const out = maskSecrets('key ' + key);
    expect(out).toContain('[redacted]');
    expect(out).not.toContain(key);
  });

  it('masks GitHub tokens', () => {
    for (const t of ['ghp_' + 'A'.repeat(36), 'github_pat_' + 'B'.repeat(50)]) {
      const out = maskSecrets('t ' + t);
      expect(out).toBe('t [redacted]');
    }
  });

  it('masks AWS access key id', () => {
    expect(maskSecrets('id ' + 'AKIA' + 'ABCDEFGHIJKLMNOP')).toBe('id [redacted]');
  });

  it('masks Slack token', () => {
    expect(maskSecrets('x ' + 'xoxb-' + '1234567890-abcdefghij')).toBe('x [redacted]');
  });

  it('masks a JWT', () => {
    expect(maskSecrets('jwt ' + 'eyJhbGciOi.eyJzdWIiOiIx.abcdefghijk')).toBe('jwt [redacted]');
  });

  it('masks a PEM private key block, including an unterminated one', () => {
    const begin = '-----BEGIN RSA PRIVATE ' + 'KEY-----';
    const end = '-----END RSA PRIVATE ' + 'KEY-----';
    expect(maskSecrets(`a\n${begin}\nMIIBOgIBAAJB\nline2\n${end}\nb`)).toBe('a\n[redacted]\nb');
    const out = maskSecrets(`a\n${begin}\nMIIBOgIBAAJB\nline2`);
    expect(out).toBe('a\n[redacted]');
  });

  it('masks Bearer token but keeps the word', () => {
    expect(maskSecrets('Authorization: Bearer ' + 'x'.repeat(30))).toBe(
      'Authorization: Bearer [redacted]',
    );
  });

  it('masks assigned secrets, keeping the key name', () => {
    expect(maskSecrets('password=hunter2hunter2')).toBe('password=[redacted]');
    expect(maskSecrets('api_key: "abcdef123456"')).toBe('api_key: "[redacted]"');
    expect(maskSecrets('client_secret = abcdef123456')).toBe('client_secret = [redacted]');
    expect(maskSecrets('password: hunter22')).toBe('password: [redacted]');
  });

  it('leaves ordinary prose alone', () => {
    const prose = 'token budget: 5000 tokens, secret sauce, password reset flow, my sk-8 plan';
    expect(maskSecrets(prose)).toBe(prose);
    const long =
      'The token: refresh-handling logic should store the token in memory only, and the token ' +
      'lifetime is a separate concern. '.repeat(20);
    expect(maskSecrets(long)).toBe(long);
    const path = 'C:\\Users\\Matt\\projects\\aether-os';
    expect(path).toContain('C:\\Users');
    expect(maskSecrets(path)).toBe(path);
    const sha = 'c4344ae792e3e5fdde924f09270d6aebac29561a';
    expect(maskSecrets(sha)).toBe(sha);
  });

  it('masks env-var and quoted-JSON assignment shapes', () => {
    expect(maskSecrets('ANTHROPIC_API_KEY=abcdefghijk')).toBe('ANTHROPIC_API_KEY=[redacted]');
    expect(maskSecrets('{"password": "hunter2hunter2"}')).toBe('{"password": "[redacted]"}');
    const once = maskSecrets('MY_CLIENT_SECRET: abcdefghijk "api_key":"abcdef123456"');
    expect(once).toBe('MY_CLIENT_SECRET: [redacted] "api_key":"[redacted]"');
    expect(maskSecrets(once)).toBe(once);
  });

  it('masks secret_key, AWS_SECRET_ACCESS_KEY, private_key and export shapes', () => {
    expect(maskSecrets('secret_key=abcdefgh')).toBe('secret_key=[redacted]');
    expect(maskSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY')).toBe(
      'AWS_SECRET_ACCESS_KEY=[redacted]',
    );
    expect(maskSecrets('"private_key": "abcd1234efgh"')).toBe('"private_key": "[redacted]"');
    expect(maskSecrets('export SECRET_ACCESS_KEY=abcdefghijk')).toBe(
      'export SECRET_ACCESS_KEY=[redacted]',
    );
  });

  it('leaves exact type/keyword values alone', () => {
    for (const c of [
      'secret: string;',
      'password: required',
      'token: number',
      'apiKey: string | null',
    ]) {
      expect(maskSecrets(c)).toBe(c);
    }
  });

  it('masks code-looking assignments and dotted/paren secrets (fail-closed)', () => {
    for (const [inp, out] of [
      ['const secret = getSecret();', 'const secret = [redacted];'],
      ['password = req.body.password;', 'password = [redacted];'],
      ['this.password = x1234567', 'this.password = [redacted]'],
      ['secret=abc.def', 'secret=[redacted]'],
      ['password=pw(Xk!mQrTzLp', 'password=[redacted]'],
      ['password=correct.Horse', 'password=[redacted]'],
      ['access_token=abc.def.ghi', 'access_token=[redacted]'],
      ['{"password":"john.smith"}', '{"password":"[redacted]"}'],
      ['export API_KEY=abc.defghijk', 'export API_KEY=[redacted]'],
      ['password=pass(word)', 'password=[redacted]'],
    ]) {
      expect(maskSecrets(inp)).toBe(out);
    }
  });

  it('still masks plain secret-looking values (fail-closed)', () => {
    expect(maskSecrets('password=correcthorsebattery')).toBe('password=[redacted]');
    expect(maskSecrets('password: hunter2hunter2')).toBe('password: [redacted]');
    expect(maskSecrets('api_key=abcdefghijk')).toBe('api_key=[redacted]');
  });

  it('masks real secrets that merely contain dots, parens or digits', () => {
    for (const [inp, out] of [
      ['password=My.Pass2024', 'password=[redacted]'],
      ['"password":"My.Pass2024"', '"password":"[redacted]"'],
      ['password=Foo.Bar_Baz', 'password=[redacted]'],
      ['api_key=AbCd.EfGh1234', 'api_key=[redacted]'],
      ['access_token=ya29.a0AfH6SMBx', 'access_token=[redacted]'],
      ['auth_token=v1.abcdef123456', 'auth_token=[redacted]'],
      ['password=Pass(word1)', 'password=[redacted]'],
      ['{"password": "Hunter(2024)x"}', '{"password": "[redacted]"}'],
    ]) {
      expect(maskSecrets(inp)).toBe(out);
    }
  });

  it('masks Bearer in any case', () => {
    expect(maskSecrets('bearer ' + 'x'.repeat(30))).toBe('bearer [redacted]');
    expect(maskSecrets('BEARER ' + 'x'.repeat(30))).toBe('BEARER [redacted]');
  });

  it('is idempotent', () => {
    const x = [
      'sk-ant-' + 'a'.repeat(30),
      'Bearer ' + 'x'.repeat(30),
      'password=hunter2hunter2',
      'api_key: "abcdef123456"',
      '-----BEGIN PRIVATE ' + 'KEY-----\nabc',
    ].join('\n');
    const once = maskSecrets(x);
    expect(maskSecrets(once)).toBe(once);
  });
});

describe('capBody', () => {
  it('returns text unchanged under the cap', () => {
    expect(capBody('hello', 10)).toEqual({
      body: 'hello',
      bodyLength: 5,
      truncated: false,
    });
  });

  it('slices at the cap and reports the full length', () => {
    expect(capBody('abcdefghij', 4)).toEqual({
      body: 'abcd',
      bodyLength: 10,
      truncated: true,
    });
  });

  it('defaults the cap to 8000', () => {
    const r = capBody('a'.repeat(9000));
    expect(r.body.length).toBe(8000);
    expect(r.bodyLength).toBe(9000);
    expect(r.truncated).toBe(true);
  });

  it('does not split a surrogate pair', () => {
    const s = 'ab' + '\u{1F600}' + 'cd';
    expect(capBody(s, 3).body).toBe('ab');
    expect(capBody(s, 4).body).toBe('ab\u{1F600}');
  });

  it('masking before capping leaves no half secret', () => {
    const x = 'a'.repeat(7989) + ' sk-ant-' + 'z'.repeat(40);
    expect(capBody(maskSecrets(x)).body).not.toContain('sk-ant-');
    expect(capBody(x).body).toContain('sk-ant-');
  });
});
