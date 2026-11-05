// Safe JSON read and atomic write (AFK Phase 1, T2).
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Largest JSON file readJsonSafe will read; every AFK JSON file is a few KB. */
export const MAX_JSON_BYTES = 1024 * 1024;

/** Files over MAX_JSON_BYTES are refused without being read. Never throws.
 * @returns {{ok:true, value:unknown} | {ok:false, reason:'missing'|'unreadable'|'too-large'|'invalid-json'}} */
export function readJsonSafe(path) {
  let text;
  let fd;
  try {
    fd = openSync(path, 'r');
    if (fstatSync(fd).size > MAX_JSON_BYTES) return { ok: false, reason: 'too-large' };
    text = readFileSync(fd, 'utf8');
  } catch (e) {
    return { ok: false, reason: e && e.code === 'ENOENT' ? 'missing' : 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
  try {
    return { ok: true, value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}

/** Write via a sibling temp file then rename. Throws if the target is a symlink. */
export function writeJsonAtomic(path, value) {
  let st = null;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  if (st && st.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.afktmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw e;
  }
}
