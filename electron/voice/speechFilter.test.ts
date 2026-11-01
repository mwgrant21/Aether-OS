// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { maskSecrets, SECRET_LABEL_SOURCE } from '../../src/shared/board/text';
import { createSpeechFilter } from './speechFilter';

function run(deltas: string[], opts?: Parameters<typeof createSpeechFilter>[0]) {
  const f = createSpeechFilter(opts);
  const spoken: string[] = [];
  for (const d of deltas) spoken.push(...f.push(d).spoken);
  const e = f.end();
  spoken.push(...e.spoken);
  return { spoken, display: e.display, spokenDone: e.spokenDone, all: spoken.join('') + '\n' + e.display };
}

const chars = (s: string) => Array.from(s);

describe('delimiter and spoken/display split', () => {
  it('splits at a --- line in one delta', () => {
    const r = run(['Hello there.\n---\nDetails here.']);
    expect(r.spoken.join('')).toBe('Hello there.\n');
    expect(r.display).toBe('Details here.');
    expect(r.spokenDone).toBe(true);
  });

  it('splits at a --- line split across deltas', () => {
    const r = run(['Hi.\n', '-', '--', '\n', 'More.']);
    expect(r.spoken.join('')).toBe('Hi.\n');
    expect(r.display).toBe('More.');
  });

  it('treats a trailing --- with no newline at end() as the delimiter', () => {
    const r = run(['Hi.\n---']);
    expect(r.spoken.join('')).toBe('Hi.\n');
    expect(r.display).toBe('');
    expect(r.spokenDone).toBe(true);
  });

  it('does not treat --- inside a line as the delimiter', () => {
    const r = run(['a --- b\n']);
    expect(r.spoken.join('')).toBe('a --- b\n');
    expect(r.display).toBe('');
  });

  it('speaks everything without a delimiter', () => {
    const r = run(['One. Two. ', 'Three.']);
    expect(r.spoken.join('')).toBe('One. Two. Three.');
    expect(r.display).toBe('');
    expect(r.spokenDone).toBe(false);
  });

  it('moves the remainder to display once the spoken cap is reached', () => {
    const r = run(['Aaaaa. Bbbbb. Ccccc. Ddddd. '], { spokenCap: 10 });
    expect(r.spokenDone).toBe(true);
    expect(r.spoken.join('')).toBe('Aaaaa. Bbbbb. ');
    expect(r.display).toBe('Ccccc. Ddddd.');
  });
});

describe('unit boundaries', () => {
  it('does not release mid-sentence', () => {
    const f = createSpeechFilter();
    expect(f.push('Hello wor').spoken).toEqual([]);
    expect(f.push('ld. ').spoken).toEqual(['Hello world. ']);
  });

  it('does not split 3.14', () => {
    const f = createSpeechFilter();
    expect(f.push('Pi is 3.').spoken).toEqual([]);
    expect(f.push('14 roughly. ').spoken).toEqual(['Pi is 3.14 roughly. ']);
  });

  it('treats a terminator at end of buffer as not yet a boundary', () => {
    const f = createSpeechFilter();
    expect(f.push('Done.').spoken).toEqual([]);
    expect(f.push('"').spoken).toEqual([]);
    expect(f.end().spoken).toEqual(['Done."']);
  });

  it('passes a clean sentence unchanged', () => {
    const text = 'The build passed in 3.2 seconds (all green). Next, we ship it!\n';
    expect(run(chars(text)).spoken.join('')).toBe(text);
  });

  it('force-releases through the last whitespace past holdCap', () => {
    const f = createSpeechFilter({ holdCap: 20 });
    const out = f.push('aaaa bbbb cccc dddd eeee ffff').spoken;
    expect(out).toEqual(['aaaa bbbb cccc dddd eeee ']);
  });

  it('handles empty input and a long single token', () => {
    expect(run([]).spoken).toEqual([]);
    expect(run(['']).display).toBe('');
    const tok = 'x'.repeat(5000);
    const r = run([tok]);
    expect(r.spoken.join('')).toBe(tok);
  });
});

describe('display', () => {
  it('masks and caps display at 4000', () => {
    const r = run(['Spoken.\n---\n' + 'ok '.repeat(3000) + 'sk-ant-' + 'a'.repeat(30)]);
    expect(r.display.length).toBe(4000);
    const r2 = run(['Spoken.\n---\nkey sk-ant-' + 'a'.repeat(30) + ' end']);
    expect(r2.display).toBe('key [redacted] end');
  });
});

describe('leak property', () => {
  const FILL = 'Status looks fine so far and the deploy is progressing nicely. ';
  const samples: Array<[string, string, string]> = [
    ['sk-ant key', 'sk-ant-api03-' + 'AbCdEf012345'.repeat(3), 'AbCdEf012345'],
    ['ghp token', 'ghp_' + 'a1B2c3D4e5'.repeat(4), 'a1B2c3D4e5'],
    ['AKIA key', 'AKIAIOSFODNN7EXAMPLE', 'IOSFODNN7EXAMPLE'],
    ['Bearer', 'Bearer abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx'],
    ['password=', 'password=hunter2hunter2', 'hunter2hunter2'],
    ['api_key quoted', 'api_key: "abcdef123456ghijkl"', 'abcdef123456ghijkl'],
    [
      'PEM',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\nAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0B',
    ],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fw', 'SflKxwRJSMeKKF2QT4fw'],
  ];

  for (const [name, secret, needle] of samples) {
    const text = FILL + 'Here it is: ' + secret + '\nAll done now. Thanks.\n---\nExtra detail ' + secret + ' end.';
    it(`${name}: no split position leaks`, () => {
      expect(text.length).toBeLessThan(400);
      expect(run([text]).all).not.toContain(needle);
      for (let i = 0; i <= text.length; i++) {
        const r = run([text.slice(0, i), text.slice(i)]);
        expect(r.all, `split at ${i}`).not.toContain(needle);
      }
      // hits the secret region: also mask must still have happened
      expect(run([text]).all).toContain('[redacted]');
    });

    it(`${name}: 3-way and 1-char deltas do not leak`, () => {
      const step = 7;
      for (let i = 0; i <= text.length; i += step) {
        for (let j = i; j <= text.length; j += step + 4) {
          const r = run([text.slice(0, i), text.slice(i, j), text.slice(j)]);
          expect(r.all, `split at ${i},${j}`).not.toContain(needle);
        }
      }
      expect(run(chars(text)).all).not.toContain(needle);
    });

    it(`${name}: no leak without the delimiter either`, () => {
      const plain = FILL + 'Here it is: ' + secret + ' and that is all.';
      for (let i = 0; i <= plain.length; i++) {
        expect(run([plain.slice(0, i), plain.slice(i)]).all, `split at ${i}`).not.toContain(needle);
      }
    });
  }

  it('holds a PEM block longer than holdCap whole', () => {
    const body = ('MIIEvQIBADANBgkqhkiG9w0B\n').repeat(40);
    const pem = '-----BEGIN PRIVATE KEY-----\n' + body + '-----END PRIVATE KEY-----\n';
    const r = run(chars(pem + 'After.'));
    expect(r.all).not.toContain('MIIEvQIBADANBgkqhkiG9w0B');
    expect(r.spoken.join('')).toContain('After.');
  });

  it('masks a PEM block larger than PEM_HOLD_MAX streamed in 200-char deltas', () => {
    const line = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n';
    const pem = '-----BEGIN ' + 'PRIVATE KEY-----\n' + line.repeat(400) + '-----END ' + 'PRIVATE KEY-----\n';
    expect(pem.length).toBeGreaterThan(16 * 1024);
    const text = 'Key follows.\n' + pem + 'After it.';
    const deltas: string[] = [];
    for (let i = 0; i < text.length; i += 200) deltas.push(text.slice(i, i + 200));
    const r = run(deltas);
    expect(r.all).not.toContain('MIIEvQIBADANBg');
    expect(r.all).toContain('[redacted]');
    expect(r.spoken.join('')).toContain('After it.');
  });

  // A unit boundary must never separate a secret's label from its value.
  const splitCases: Array<[string, string, string]> = [
    ['label then newline then value', 'Here:\npassword:\nhunter2hunter2 done.', 'hunter2hunter2'],
    ['Bearer then newline then token', 'Header: Bearer\nabcdefghijklmnopqrstuvwx ok.', 'abcdefghijklmnopqrstuvwx'],
    ['quoted value with a period', 'Set password: "correct horse. battery staple" now.', 'battery staple'],
    ['quoted value with a question mark', 'api_key = "what? is this secret value" ok', 'is this secret value'],
  ];
  for (const [name, text, needle] of splitCases) {
    it(`${name}: whole text, 2-way split and 1-char deltas mask`, () => {
      expect(run([text]).all).not.toContain(needle);
      for (let i = 0; i <= text.length; i++) {
        expect(run([text.slice(0, i), text.slice(i)]).all, `split at ${i}`).not.toContain(needle);
      }
      expect(run(chars(text)).all).not.toContain(needle);
      expect(run(chars(text)).all).toContain('[redacted]');
    });
  }
});

describe('label/value cross-product', () => {
  const LABELS = [
    'password',
    'api_key',
    'client_secret',
    'private_key',
    'pwd',
    'auth_token',
    'access-token',
    'secret_key_base',
    'SECRET-KEY-BASE',
    'secret_key_id',
    'db_password',
    '"password"',
    '\\"password\\"',
  ];
  const SEPS = [': ', ':\n', ':\r\n', '=\n\n'];
  const QUOTED_VALUE = 'correct horse. battery staple? done';
  const BARE_VALUE = 'hunter2Hunter2xyz';
  const STYLES: Array<[string, string, string]> = [
    ['none', '', BARE_VALUE],
    ['double', '"', QUOTED_VALUE],
    ['single', "'", QUOTED_VALUE],
    ['escaped', '\\"', QUOTED_VALUE],
  ];
  const windows = (v: string) => {
    const w: string[] = [];
    for (let k = 0; k + 8 <= v.length; k += 4) w.push(v.slice(k, k + 8));
    return w;
  };
  const leaks = (all: string, v: string) => windows(v).some((w) => all.includes(w));

  it('never leaks where whole-text maskSecrets hides the value', () => {
    let checked = 0;
    for (const label of LABELS) {
      for (const sep of SEPS) {
        for (const [style, quote, value] of STYLES) {
          const text = 'Intro line. ' + label + sep + quote + value + quote + ' and then more words. Last.';
          if (leaks(maskSecrets(text), value)) continue;
          checked++;
          const tag = JSON.stringify([label, sep, style]);
          expect(leaks(run([text]).all, value), 'whole ' + tag).toBe(false);
          for (let i = 0; i <= text.length; i++) {
            expect(leaks(run([text.slice(0, i), text.slice(i)]).all, value), 'split ' + i + ' ' + tag).toBe(false);
          }
          expect(leaks(run(chars(text)).all, value), '1-char ' + tag).toBe(false);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('never leaks across a holdCap forced release', () => {
    const prose = 'Status looks fine and the deploy is progressing nicely today '.repeat(6);
    expect(prose.length).toBeGreaterThan(300);
    for (const [label, sep, value] of [
      ['password', ': ', BARE_VALUE],
      ['secret_key_base', ':\n', BARE_VALUE],
      ['api_key', ' = "', QUOTED_VALUE + '"'],
    ]) {
      const text = prose + label + sep + value + ' done.';
      expect(leaks(maskSecrets(text), value)).toBe(false);
      expect(leaks(run([text]).all, value)).toBe(false);
      for (let i = 0; i <= text.length; i++) {
        expect(leaks(run([text.slice(0, i), text.slice(i)]).all, value), 'split ' + i + ' ' + label).toBe(false);
      }
      expect(leaks(run(chars(text)).all, value), '1-char ' + label).toBe(false);
    }
  });

  it('drift: every label maskSecrets treats as a secret key holds the filter open', () => {
    for (const label of LABELS) {
      const bare = label.replace(/\\?"/g, '');
      expect(maskSecrets(bare + ': ' + BARE_VALUE), bare).toContain('[redacted]');
      const f = createSpeechFilter();
      expect(f.push('Note. ' + bare + ':\n').spoken.join(''), bare).toBe('Note. ');
    }
    expect(SECRET_LABEL_SOURCE).toContain('secret');
    expect(SECRET_LABEL_SOURCE).toContain('base|id');
  });
});
