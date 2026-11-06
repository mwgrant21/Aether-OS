// Renders and installs the afk-preflight skill (AFK Phase 1, T19). Node builtins only, so a copy of this file runs from the
// packaged resources/scripts/afk/. install-skill is run by Matt and writes exactly one file: <home>/.claude/skills/afk-preflight/SKILL.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = '{{AFK_CLI}}';

/** Replaces every {{AFK_CLI}} token. Throws if the token is absent or cliPath holds a quote, newline or backtick. */
export function renderSkill(template, cliPath) {
  if (!template.includes(TOKEN)) throw new Error('template has no {{AFK_CLI}} token');
  if (typeof cliPath !== 'string' || cliPath === '' || /["'`\r\n]/.test(cliPath)) throw new Error('cliPath is empty or contains a quote, newline or backtick');
  return template.split(TOKEN).join(cliPath);
}

/** Correct in both layouts: <repo>/scripts/afk -> <repo>/skills/..., <resources>/scripts/afk -> <resources>/skills/... */
export function defaultTemplatePath() {
  return fileURLToPath(new URL('../../skills/afk-preflight/SKILL.md', import.meta.url));
}

/** @returns {string} the path written */
export function installSkill({ homeDir, templatePath, cliPath }) {
  const text = renderSkill(readFileSync(templatePath, 'utf8'), cliPath);
  const dir = join(homeDir, '.claude', 'skills', 'afk-preflight');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'SKILL.md');
  writeFileSync(dest, text, 'utf8');
  return dest;
}
