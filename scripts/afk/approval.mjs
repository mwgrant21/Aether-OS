// The self-hashing approved record and its pointer (AFK Phase 1, T12).
import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './fsJson.mjs';
import { canonicalSha256, termsSha256, validateTerms } from './terms.mjs';
import { afkDir } from './termsStore.mjs';

export const approvedPath = (aetherDir) => join(afkDir(aetherDir), 'approved.json');
export const pointerPath = (aetherDir) => join(afkDir(aetherDir), 'last-approved.json');

const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

/** canonicalSha256 of the record without its recordSha256 field. */
export function recordHash(record) {
  const { recordSha256: _omit, ...rest } = record;
  return canonicalSha256(rest);
}

/** Throws if either terms object is invalid or allowRules is not an array of strings. */
export function buildRecord({ nightId, approvedAtMs, targetWindowStartMs, standingTerms, amendments, terms, items, held, allowRules }) {
  if (!validateTerms(standingTerms).ok) throw new Error('standingTerms invalid');
  if (!validateTerms(terms).ok) throw new Error('terms invalid');
  if (!Array.isArray(allowRules) || !allowRules.every((r) => typeof r === 'string')) throw new Error('allowRules must be an array of strings');
  // JSON round trip first, so an undefined field cannot make the hash differ from the file.
  const body = JSON.parse(JSON.stringify({
    v: 1, via: 'tty', nightId, approvedAtMs, targetWindowStartMs,
    standingTerms, amendments, terms, termsSha256: termsSha256(terms), items, held, allowRules,
  }));
  return { ...body, recordSha256: recordHash(body) };
}

/** Record first, then the pointer: a crash in between reads as pointer-missing or pointer-mismatch. */
export function writeApproved(aetherDir, record) {
  writeJsonAtomic(approvedPath(aetherDir), record);
  writeJsonAtomic(pointerPath(aetherDir), {
    v: 1, nightId: record.nightId, recordSha256: record.recordSha256, approvedAtMs: record.approvedAtMs,
  });
}

function shapeOk(r) {
  return isObj(r) && r.v === 1 && r.via === 'tty'
    && typeof r.nightId === 'string' && Number.isFinite(r.approvedAtMs) && Number.isFinite(r.targetWindowStartMs)
    && isObj(r.standingTerms) && isObj(r.amendments) && isObj(r.terms)
    && typeof r.termsSha256 === 'string' && typeof r.recordSha256 === 'string'
    && Array.isArray(r.items) && Array.isArray(r.held)
    && Array.isArray(r.allowRules) && r.allowRules.every((x) => typeof x === 'string');
}

/** @returns {{ok:true, record:object} | {ok:false, reason:'missing'|'invalid'|'hash-mismatch'|'terms-invalid'|'pointer-missing'|'pointer-mismatch'}} */
export function readApproved(aetherDir) {
  const f = readJsonSafe(approvedPath(aetherDir));
  if (!f.ok) return { ok: false, reason: f.reason === 'missing' ? 'missing' : 'invalid' };
  const record = f.value;
  if (!shapeOk(record)) return { ok: false, reason: 'invalid' };
  if (recordHash(record) !== record.recordSha256) return { ok: false, reason: 'hash-mismatch' };
  if (!validateTerms(record.standingTerms).ok || !validateTerms(record.terms).ok || termsSha256(record.terms) !== record.termsSha256) {
    return { ok: false, reason: 'terms-invalid' };
  }
  const p = readJsonSafe(pointerPath(aetherDir));
  if (!p.ok) return { ok: false, reason: 'pointer-missing' };
  if (!isObj(p.value) || p.value.recordSha256 !== record.recordSha256) return { ok: false, reason: 'pointer-mismatch' };
  return { ok: true, record };
}
