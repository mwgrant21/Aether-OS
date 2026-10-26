import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  THREAD_DIFF_INLINE_LINES,
  THREAD_LABEL_CAP,
  THREAD_TEXT_CAP,
  type ThreadToolEntry,
} from '../../src/shared/remote/threadTypes';
import { createParseCtx, parseThreadLine, type ThreadOp, type ThreadParseCtx } from './threadParser';

// Synthetic lines only. Secrets are obvious fakes; the canary is the string that must never surface.
const CANARY = 'CANARYTOOLUSERESULT';
const SECRET = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const BEARER = 'Bearer TESTtoken12345678901234abcd';
const TS = '2026-01-01T00:00:00.000Z';

const j = (o: unknown): string => JSON.stringify(o);
const asst = (content: unknown[], extra: Record<string, unknown> = {}, msg: Record<string, unknown> = {}): string =>
  j({ type: 'assistant', timestamp: TS, isSidechain: false, message: { role: 'assistant', content, ...msg }, ...extra });
const toolUse = (id: string, name: string, input: unknown): string => asst([{ type: 'tool_use', id, name, input }]);
const result = (id: string, content: unknown, isError = false, extra: Record<string, unknown> = {}): string =>
  j({
    type: 'user', timestamp: TS, isSidechain: false, ...extra,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  });
const prompt = (text: string, extra: Record<string, unknown> = {}): string =>
  j({ type: 'user', timestamp: TS, isSidechain: false, ...extra, message: { role: 'user', content: text } });

function run(lines: string[], ctx: ThreadParseCtx = createParseCtx()): ThreadOp[] {
  return lines.flatMap((l, i) => parseThreadLine(l, i * 100, ctx));
}
const entry = (ops: ThreadOp[], k: string) =>
  ops.flatMap((o) => ((o.op === 'add' || o.op === 'upd') && o.e.k === k ? [o.e] : []));
const tool = (ops: ThreadOp[], i = 0): ThreadToolEntry => entry(ops, 't')[i] as ThreadToolEntry;

describe('threadParser entry kinds', () => {
  it('parses the synthetic fixture: prompt, thinking, tool run->ok, reply, drops sidechain and junk', () => {
    const lines = readFileSync(join(__dirname, '__fixtures__', 'basic-session.jsonl'), 'utf8').split('\n');
    const ctx = createParseCtx();
    const ops = lines.flatMap((l, i) => parseThreadLine(l, i, ctx));
    expect(
      ops.filter((o) => o.op === 'add' || o.op === 'upd').map((o) => (o as { e: { k: string } }).e.k),
    ).toEqual(['u', 'th', 't', 't', 'a']);
    expect(JSON.stringify(ops)).not.toContain('CANARY-TOOLUSERESULT');
    expect(JSON.stringify(ops)).not.toContain('subagent chatter');
    expect(ops.find((o) => o.op === 'usage' && o.endTurn)).toMatchObject({ ctxTok: 1112, outTok: 7 });
    expect(ctx.open.size).toBe(0);
  });

  it('human prompt: add u + prompt op; meta, wrapper and sidechain lines are not prompts', () => {
    const ops = run([
      prompt('hello there'),
      prompt('<system-reminder>x</system-reminder>'),
      prompt('meta', { isMeta: true }),
      prompt('side', { isSidechain: true }),
    ]);
    expect(entry(ops, 'u')).toMatchObject([{ k: 'u', x: 'hello there', tr: false }]);
    expect(ops.filter((o) => o.op === 'prompt')).toHaveLength(1);
  });

  it('assistant text joins all text items into one entry', () => {
    const ops = run([asst([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])]);
    expect(entry(ops, 'a')).toMatchObject([{ k: 'a', x: 'one\ntwo' }]);
  });

  it('thinking: d false and no detail when empty; d true with redacted detail when present', () => {
    const empty = run([asst([{ type: 'thinking', thinking: '', signature: 's' }], { thinkingDurationMs: 2500 })]);
    expect(entry(empty, 'th')).toMatchObject([{ ms: 2500, d: false }]);
    expect((empty[0] as { detail?: unknown }).detail).toBeUndefined();
    const full = run([asst([{ type: 'thinking', thinking: `ponder ${BEARER}` }])]);
    const op = full[0] as Extract<ThreadOp, { op: 'add' }>;
    expect(op.e).toMatchObject({ k: 'th', ms: null, d: true });
    expect(op.detail?.x).toContain('ponder');
    expect(op.detail?.x).not.toContain('TESTtoken1234567890');
  });

  it('ids are stable for the same offset key and distinct within a line', () => {
    const l = asst([{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }]);
    const a = parseThreadLine(l, 4242, createParseCtx());
    const b = parseThreadLine(l, 4242, createParseCtx());
    expect(a).toEqual(b);
    expect(entry(a, 'a')[0]!.id).toBe('4242:0');
    expect(entry(a, 't')[0]!.id).toBe('4242:1');
  });

  it('malformed, empty and non-message lines yield no ops', () => {
    expect(run(['not json', '', '{"type":"summary"}', '{"type":"assistant"}'])).toEqual([]);
  });

  it('a 1 MB line parses without exceeding the text cap', () => {
    const ops = run([prompt('x'.repeat(1_000_000))]);
    const u = entry(ops, 'u')[0] as { x: string; tr: boolean };
    expect(u.x.length).toBeLessThanOrEqual(THREAD_TEXT_CAP);
    expect(u.tr).toBe(true);
  });
});

describe('threadParser tools', () => {
  it('label rules per tool', () => {
    const ops = run([
      toolUse('1', 'Bash', { command: 'npm test\nsecond line' }),
      toolUse('2', 'Read', { file_path: 'C:\\proj\\src\\a.ts' }),
      toolUse('3', 'Edit', { file_path: '/home/x/b.ts', old_string: 'a', new_string: 'b' }),
      toolUse('4', 'Write', { file_path: '/x/c.ts', content: 'z' }),
      toolUse('5', 'Grep', { pattern: 'foo.*bar' }),
      toolUse('6', 'Glob', { pattern: '**/*.ts' }),
      toolUse('7', 'Agent', { subagent_type: 'builder', description: 'd' }),
      toolUse('8', 'Task', { description: 'only desc' }),
      toolUse('9', 'mcp__srv__do', { note: 'zzz' }),
      toolUse('10', 'NotebookEdit', { notebook_path: '/n/nb.ipynb' }),
    ]);
    expect(entry(ops, 't').map((e) => (e as ThreadToolEntry).l)).toEqual([
      'npm test', 'a.ts', 'b.ts', 'c.ts', 'foo.*bar', '**/*.ts', 'builder', 'only desc', 'mcp__srv__do', 'nb.ipynb',
    ]);
  });

  it('st run -> ok/err through upd; sz is the result length; list content joins text items only', () => {
    const ctx = createParseCtx();
    const ops = run(
      [
        toolUse('a', 'Bash', { command: 'x' }),
        toolUse('b', 'Bash', { command: 'y' }),
        result('a', 'twelve chars'),
        result('b', [{ type: 'text', text: 'one' }, { type: 'image', source: { data: 'IMGBYTES' } }, { type: 'text', text: 'two' }], true),
      ],
      ctx,
    );
    const adds = ops.filter((o) => o.op === 'add');
    const upds = ops.filter((o) => o.op === 'upd') as Array<Extract<ThreadOp, { op: 'upd' }>>;
    expect((adds[0] as { e: ThreadToolEntry }).e).toMatchObject({ st: 'run', sz: null });
    expect(upds[0]!.e).toMatchObject({ id: '0:0', st: 'ok', sz: 12 });
    expect(upds[1]!.e).toMatchObject({ id: '100:0', st: 'err', sz: 7 });
    expect(upds[1]!.detail?.x).toBe('one\ntwo');
    expect(JSON.stringify(ops)).not.toContain('IMGBYTES');
    expect(ctx.open.size).toBe(0);
  });

  it('an orphan result (no open tool_use) is ignored', () => {
    expect(run([result('nope', 'x')])).toEqual([]);
  });

  it('diff comes from the input, capped at 8 lines with dn, lines capped at 200 chars', () => {
    const oldS = Array.from({ length: 6 }, (_, i) => `old${i}`).join('\n');
    const newS = Array.from({ length: 6 }, (_, i) => `new${i}`).join('\n') + '\n' + 'w'.repeat(500);
    const t = tool(run([toolUse('e', 'Edit', { file_path: '/a/b.ts', old_string: oldS, new_string: newS })]));
    expect(t.df).toHaveLength(THREAD_DIFF_INLINE_LINES);
    expect(t.df![0]).toEqual(['-', 'old0']);
    expect(t.df![6]).toEqual(['+', 'new0']);
    expect(t.dn).toBe(13 - THREAD_DIFF_INLINE_LINES);
    const w = tool(run([toolUse('w', 'Write', { file_path: '/a/c.ts', content: 'w'.repeat(500) })]));
    expect(w.df![0]![1]).toHaveLength(200);
    expect(tool(run([toolUse('b', 'Bash', { command: 'x' })])).df).toBeUndefined();
  });

  it('expanded input (S7): Edit old/new and the output arrive in detail; d reflects input presence', () => {
    const ops = run([
      toolUse('e', 'Edit', { file_path: '/a/b.ts', old_string: 'before', new_string: 'after' }),
      result('e', 'edited ok'),
    ]);
    const add = ops[0] as Extract<ThreadOp, { op: 'add' }>;
    expect(add.detail).toMatchObject({ x: null });
    expect(add.detail!.input).toContain('/a/b.ts');
    expect(add.detail!.input).toContain('before');
    expect(add.detail!.input).toContain('after');
    expect((ops[1] as Extract<ThreadOp, { op: 'upd' }>).detail).toMatchObject({ x: 'edited ok', more: 0 });
    expect(tool(run([toolUse('b', 'Bash', { command: 'npm run build' })])).d).toBe(true);
    expect(tool(run([toolUse('b', 'Bash', {})])).d).toBe(false);
  });

  it('sensitive path (S8): output, input content and diff are replaced; path and tool name stay', () => {
    const ops = run([
      toolUse('r', 'Read', { file_path: '/home/me/.env' }),
      result('r', 'API_TOKEN=hunter2hunter2'),
      toolUse('w', 'Write', { file_path: '/home/me/.ssh/id_rsa', content: 'PRIVATEBODY' }),
      toolUse('e', 'Edit', { file_path: 'C:\\x\\server.pem', old_string: 'OLDBODY', new_string: 'NEWBODY' }),
    ]);
    const upd = ops.find((o) => o.op === 'upd') as Extract<ThreadOp, { op: 'upd' }>;
    expect(upd.detail).toMatchObject({ x: '[redacted: sensitive file]', more: 0 });
    expect(upd.detail!.input).toContain('/home/me/.env');
    expect(upd.detail!.input).toContain('[redacted: sensitive file]');
    expect(upd.e.d).toBe(true);
    const all = JSON.stringify(ops);
    for (const s of ['hunter2', 'PRIVATEBODY', 'OLDBODY', 'NEWBODY']) expect(all).not.toContain(s);
    expect(entry(ops, 't').every((e) => (e as ThreadToolEntry).df === undefined)).toBe(true);
  });

  it('usage op carries context tokens and end_turn from message.usage / stop_reason', () => {
    const ops = run([
      asst([{ type: 'text', text: 'hi' }], {}, {
        usage: { input_tokens: 1, output_tokens: 9, cache_creation_input_tokens: 20, cache_read_input_tokens: 300 },
        stop_reason: 'end_turn',
      }),
    ]);
    expect(ops.find((o) => o.op === 'usage')).toEqual({ op: 'usage', ctxTok: 321, outTok: 9, ts: Date.parse(TS), endTurn: true });
  });
});

describe('threadParser redaction and caps', () => {
  it('toolUseResult content (canary) never reaches any op', () => {
    const tur = { originalFile: CANARY, structuredPatch: [{ lines: [CANARY] }], stdout: CANARY };
    const ops = run([
      toolUse('a', 'Read', { file_path: '/a/b.ts' }),
      result('a', 'fine', false, { toolUseResult: tur }),
      j({ type: 'user', timestamp: TS, toolUseResult: tur, message: { role: 'user', content: 'plain prompt' } }),
      j({ type: 'assistant', timestamp: TS, toolUseResult: tur, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    ]);
    expect(ops.length).toBeGreaterThan(3);
    expect(JSON.stringify(ops)).not.toContain(CANARY);
  });

  it('every string field passes the redactor: secrets in prompt, reply, label, diff, input, result, thinking', () => {
    const ops = run([
      prompt(`my token ${SECRET}`),
      asst([{ type: 'text', text: `reply ${SECRET}` }, { type: 'thinking', thinking: `think ${SECRET}` }]),
      toolUse('b', 'Bash', { command: `curl -H "Authorization: ${BEARER}" ${SECRET}` }),
      toolUse('e', 'Edit', { file_path: '/a/b.ts', old_string: `k=${SECRET}`, new_string: `${SECRET}` }),
      toolUse('m', 'mcp__x__y', { api_key: SECRET, note: `see ${SECRET}` }),
      toolUse('g', 'Grep', { pattern: SECRET }),
      result('b', `out ${SECRET}\nAuthorization: ${BEARER}`),
    ]);
    const all = JSON.stringify(ops);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('TESTtoken1234567890');
    expect(all).toContain('[redacted]');
  });

  it('caps hold AFTER redaction on worst cases (marker longer than the secret it replaces)', () => {
    const many = 'sk-ant-TESTabcdefgh '.repeat(400);
    const lines = Array.from({ length: 80 }, () => `Authorization: ${BEARER}`).join('\n');
    const ops = run([
      prompt(many),
      asst([{ type: 'text', text: many }]),
      toolUse('b', 'Bash', { command: many + '\n' + lines }),
      toolUse('e', 'Edit', { file_path: '/a/b.ts', old_string: lines, new_string: many }),
      toolUse('l', 'Grep', { pattern: 'x'.repeat(5000) }),
      result('b', lines.repeat(200)),
    ]);
    const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
    let checked = 0;
    for (const o of ops) {
      if (o.op !== 'add' && o.op !== 'upd') continue;
      const e = o.e;
      if (e.k === 'u' || e.k === 'a') {
        expect(e.x.length).toBeLessThanOrEqual(THREAD_TEXT_CAP);
        checked++;
      }
      if (e.k === 't') {
        expect(e.l.length).toBeLessThanOrEqual(THREAD_LABEL_CAP);
        expect(e.n.length).toBeLessThanOrEqual(40);
        expect((e.df ?? []).length).toBeLessThanOrEqual(8);
        for (const [, t] of e.df ?? []) expect(t.length).toBeLessThanOrEqual(200);
        checked++;
      }
      if (o.detail) {
        if (o.detail.input !== null) {
          expect(bytes(o.detail.input)).toBeLessThanOrEqual(2048);
          expect(o.detail.input.split('\n').length).toBeLessThanOrEqual(30);
          checked++;
        }
        if (o.detail.x !== null) {
          expect(bytes(o.detail.x)).toBeLessThanOrEqual(4096);
          expect(o.detail.x.split('\n').length).toBeLessThanOrEqual(60);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(8);
    expect(entry(ops, 'u')[0]).toMatchObject({ tr: true });
  });

  it('text cap never splits a surrogate pair', () => {
    const e = entry(run([prompt('\u{1F600}'.repeat(2500))]), 'u')[0] as { x: string };
    expect(e.x.length).toBeLessThanOrEqual(THREAD_TEXT_CAP);
    expect(/[\ud800-\udbff]$/.test(e.x)).toBe(false);
  });
});
