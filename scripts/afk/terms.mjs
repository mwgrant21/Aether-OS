// Standing terms schema, validation, amendments and canonical hash (AFK Phase 1, T1).
import { createHash } from 'node:crypto';

/**
 * @typedef {{v:1, window:{start:string,end:string}, push:boolean, merge:'gated'|'off',
 *   delete:false, forcePush:false, codexReviewsPerPush:number, opusEscalation:boolean,
 *   fableElevation:boolean, notifications:'silent'}} Terms
 */

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

export const DEFAULT_TERMS = deepFreeze({
  v: 1,
  window: { start: '01:00', end: '07:00' },
  push: true,
  merge: 'gated',
  delete: false,
  forcePush: false,
  codexReviewsPerPush: 3,
  opusEscalation: false,
  fableElevation: false,
  notifications: 'silent',
});

export const AMENDABLE_KEYS = ['window', 'push', 'merge', 'codexReviewsPerPush', 'opusEscalation', 'fableElevation'];

const KEYS = Object.keys(DEFAULT_TERMS);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** @returns {{ok:true, terms:Terms} | {ok:false, errors:string[]}} */
export function validateTerms(input) {
  if (!isObj(input)) return { ok: false, errors: ['terms must be an object'] };
  const errors = [];
  for (const k of Object.keys(input)) if (!KEYS.includes(k)) errors.push(`unknown key: ${k}`);
  for (const k of KEYS) if (!(k in input)) errors.push(`missing key: ${k}`);
  if (errors.length) return { ok: false, errors };

  if (input.v !== 1) errors.push('v must be 1');
  const w = input.window;
  if (!isObj(w) || Object.keys(w).sort().join() !== 'end,start' || !CLOCK.test(w.start) || !CLOCK.test(w.end)) {
    errors.push('window must be {start,end} as HH:MM');
  } else if (w.start === w.end) {
    errors.push('window start and end must differ');
  }
  if (typeof input.push !== 'boolean') errors.push('push must be a boolean');
  if (input.merge !== 'gated' && input.merge !== 'off') errors.push("merge must be 'gated' or 'off'");
  if (input.delete !== false) errors.push('delete must be false');
  if (input.forcePush !== false) errors.push('forcePush must be false');
  const c = input.codexReviewsPerPush;
  if (!Number.isInteger(c) || c < 0 || c > 3) errors.push('codexReviewsPerPush must be an integer 0..3');
  if (typeof input.opusEscalation !== 'boolean') errors.push('opusEscalation must be a boolean');
  if (typeof input.fableElevation !== 'boolean') errors.push('fableElevation must be a boolean');
  else if (input.fableElevation && input.opusEscalation !== true) errors.push('fableElevation requires opusEscalation');
  if (input.notifications !== 'silent') errors.push("notifications must be 'silent'");
  if (errors.length) return { ok: false, errors };
  return { ok: true, terms: structuredClone(input) };
}

/** Apply a one-night patch of amendable keys; returns a new validated terms object. */
export function applyAmendments(base, patch) {
  if (!isObj(patch)) return { ok: false, errors: ['patch must be an object'] };
  const bad = Object.keys(patch).filter((k) => !AMENDABLE_KEYS.includes(k));
  if (bad.length) return { ok: false, errors: bad.map((k) => `not amendable: ${k}`) };
  return validateTerms({ ...structuredClone(base), ...structuredClone(patch) });
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const canonicalSha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const termsSha256 = (terms) => canonicalSha256(terms);
