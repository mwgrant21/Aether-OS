// Safe JSON read and atomic write (AFK Phase 1, T2).
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** @returns {{ok:true, value:unknown} | {ok:false, reason:'missing'|'unreadable'|'invalid-json'}} */
export function readJsonSafe(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reason: e && e.code === 'ENOENT' ? 'missing' : 'unreadable' };
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
