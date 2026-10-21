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
    const path = 'C:\Users\Matt\projects\aether-os';
    expect(maskSecrets(path)).toBe(path);
    const sha = 'c4344ae792e3e5fdde924f09270d6aebac29561a';
    expect(maskSecrets(sha)).toBe(sha);
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
    expect(capBody('hello', 10)).toEqual({ body: 'hello', bodyLength: 5, truncated: false });
  });

  it('slices at the cap and reports the full length', () => {
    expect(capBody('abcdefghij', 4)).toEqual({ body: 'abcd', bodyLength: 10, truncated: true });
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
