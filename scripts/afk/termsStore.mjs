// The live standing-terms file: the single owner (AFK Phase 1, T3).
import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './fsJson.mjs';
import { DEFAULT_TERMS, validateTerms } from './terms.mjs';

export const afkDir = (aetherDir) => join(aetherDir, 'afk');
export const termsPath = (aetherDir) => join(afkDir(aetherDir), 'terms.json');

/** Never throws. Missing file = defaults, no warning. Anything unreadable or invalid = defaults + one warning (reason only, never content). */
export function readLiveTerms(aetherDir) {
  const r = readJsonSafe(termsPath(aetherDir));
  if (!r.ok) {
    if (r.reason === 'missing') return { terms: DEFAULT_TERMS, source: 'defaults', warnings: [] };
    return { terms: DEFAULT_TERMS, source: 'defaults', warnings: [`terms.json ${r.reason}; using defaults`] };
  }
  const v = validateTerms(r.value);
  if (!v.ok) {
    return { terms: DEFAULT_TERMS, source: 'defaults', warnings: [`terms.json invalid (${v.errors.join('; ')}); using defaults`] };
  }
  return { terms: v.terms, source: 'file', warnings: [] };
}

/** Validates first; invalid input writes nothing. Returns the readback from disk. */
export function writeLiveTerms(aetherDir, terms) {
  const v = validateTerms(terms);
  if (!v.ok) return { ok: false, terms: readLiveTerms(aetherDir).terms, errors: v.errors };
  writeJsonAtomic(termsPath(aetherDir), v.terms);
  const back = readLiveTerms(aetherDir);
  if (back.source !== 'file') return { ok: false, terms: back.terms, errors: back.warnings };
  return { ok: true, terms: back.terms, errors: [] };
}
