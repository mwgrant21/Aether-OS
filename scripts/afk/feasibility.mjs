// Feasibility check for build items (APK / installer). Presence only: never runs a
// tool, never returns or prints a value read from a file. Details name KEYS, never values.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { getRecipe } from './recipes.mjs';

/**
 * @typedef {{repoRoot(project:string):(string|null), fileExists(absPath:string):boolean,
 *   propKeysPresent(absFile:string, keys:string[]):Record<string,boolean>,
 *   propPathExists(absFile:string, key:string):boolean}} Probes
 */

export function checkFeasibility(item, probes) {
  if (!item || item.kind !== 'build') return { ok: true, checks: [], warnings: [] };
  const recipe = getRecipe(item.project, item.artifact);
  if (!recipe) {
    return {
      ok: false,
      checks: [{ name: `no build recipe for ${item.project}/${item.artifact}`, ok: false, detail: 'no build recipe' }],
      warnings: [],
    };
  }
  const checks = [];
  const warnings = [];
  if (recipe.verified === false) warnings.push('recipe not yet verified unattended');
  const root = recipe.requires.some((r) => r.kind !== 'scratchDir') ? probes.repoRoot(item.project) : null;
  const abs = (p) => (isAbsolute(p) ? p : join(root, p));
  for (const req of recipe.requires) {
    if (req.kind === 'scratchDir') {
      checks.push({ name: 'scratch dir', ok: true, detail: 'not probed: runner supplies the scratch dir' });
      warnings.push('scratch dir is not probed until Phase 2');
      continue;
    }
    if (!root) {
      checks.push({ name: `repo ${item.project}`, ok: false, detail: `repo ${item.project} not found` });
      continue;
    }
    if (req.kind === 'file') {
      const ok = !!probes.fileExists(abs(req.path));
      checks.push({ name: req.path, ok, detail: `${req.path} ${ok ? 'present' : 'missing'}` });
    } else if (req.kind === 'propKeys') {
      const got = probes.propKeysPresent(abs(req.file), req.keys) || {};
      for (const key of req.keys) {
        const ok = got[key] === true;
        checks.push({ name: key, ok, detail: `${key} ${ok ? 'present' : 'missing'}` });
      }
    } else if (req.kind === 'propPath') {
      const ok = !!probes.propPathExists(abs(req.file), req.key);
      checks.push({ name: req.key, ok, detail: `${req.key} path ${ok ? 'exists' : 'missing'}` });
    }
  }
  return { ok: checks.every((c) => c.ok), checks, warnings };
}

function unescapeProp(v) {
  return v.replace(/\\(.)/g, '$1');
}

// Parse a .properties file into a Map. Returns an empty map on any read error.
function readProps(file) {
  const out = new Map();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

export function realProbes({ homeDir, repoRoots = {}, env = process.env } = {}) {
  const envVal = (k) => (typeof env[k] === 'string' && env[k].trim() !== '' ? env[k].trim() : '');
  return {
    repoRoot(project) {
      const root = repoRoots[project] ?? join(homeDir, 'projects', project);
      try {
        return statSync(root).isDirectory() ? root : null;
      } catch {
        return null;
      }
    },
    fileExists(absPath) {
      try {
        return existsSync(absPath);
      } catch {
        return false;
      }
    },
    propKeysPresent(absFile, keys) {
      const props = readProps(absFile);
      const out = {};
      for (const k of keys) out[k] = (props.get(k) ?? '') !== '' || envVal(k) !== '';
      return out;
    },
    propPathExists(absFile, key) {
      const fileVal = readProps(absFile).get(key);
      const p = fileVal ? unescapeProp(fileVal) : envVal(key);
      if (!p) return false;
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
  };
}
