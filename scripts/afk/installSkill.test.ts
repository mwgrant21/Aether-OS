// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERBS } from './cli.mjs';
import { defaultTemplatePath, installSkill, renderSkill } from './installSkill.mjs';
const templatePath = fileURLToPath(new URL('../../skills/afk-preflight/SKILL.md', import.meta.url));
const template = readFileSync(templatePath, 'utf8');
describe('renderSkill', () => {
  it('replaces every token', () => {
    const out = renderSkill('a {{AFK_CLI}} b {{AFK_CLI}}', 'C:/x/afk.mjs');
    expect(out).toBe('a C:/x/afk.mjs b C:/x/afk.mjs');
  });
  it.each(['C:/x"y', 'a\nb', 'a`b'])('rejects a path containing %j', (p) => { expect(() => renderSkill('{{AFK_CLI}}', p)).toThrow(); });
  it('throws when the template has no token', () => { expect(() => renderSkill('nothing', 'C:/x')).toThrow(); });
});
describe('installSkill', () => {
  it('writes under the given home only', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-skill-'));
    const dest = installSkill({ homeDir: home, templatePath, cliPath: 'C:/r/scripts/afk/afk.mjs' });
    expect(dest).toBe(join(home, '.claude', 'skills', 'afk-preflight', 'SKILL.md'));
    expect(readFileSync(dest, 'utf8')).toContain('C:/r/scripts/afk/afk.mjs');
    expect(readFileSync(dest, 'utf8')).not.toContain('{{AFK_CLI}}');
  });
});
describe('template location', () => {
  // Resolved from this file, not process.cwd(): collector/vitest.config.ts runs these tests from collector/.
  const yml = readFileSync(fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)), 'utf8');
  it('electron-builder.yml ships SKILL.md to the folder defaultTemplatePath() reads in a packaged install', () => {
    const m = yml.match(/- from: skills\/afk-preflight\r?\n\s+to: (\S+)\r?\n\s+filter:\r?\n\s+- '?SKILL\.md'?\r?\n/);
    expect(m, 'extraResources has no skills/afk-preflight entry for SKILL.md').not.toBeNull();
    // <resources>/scripts/afk/installSkill.mjs + ../../skills/afk-preflight/SKILL.md
    expect(posix.normalize('scripts/afk/../../skills/afk-preflight/SKILL.md')).toBe(`${m![1]}/SKILL.md`);
  });
  it('in the repo, defaultTemplatePath() is the real template', () => {
    expect(defaultTemplatePath()).toBe(templatePath); expect(existsSync(defaultTemplatePath())).toBe(true);
  });
  it('a copy laid out like resources/ finds the template beside it', () => {
    const res = mkdtempSync(join(tmpdir(), 'afk-res-'));
    mkdirSync(join(res, 'scripts', 'afk'), { recursive: true }); mkdirSync(join(res, 'skills', 'afk-preflight'), { recursive: true });
    const copy = join(res, 'scripts', 'afk', 'installSkill.mjs');
    copyFileSync(fileURLToPath(new URL('./installSkill.mjs', import.meta.url)), copy);
    copyFileSync(templatePath, join(res, 'skills', 'afk-preflight', 'SKILL.md'));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(copy).href)}).then((m) => console.log(m.defaultTemplatePath()))`], { encoding: 'utf8', cwd: tmpdir() });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(r.stdout.trim(), 'utf8')).toBe(template);
  });
});

describe('SKILL.md template', () => {
  it('has the frontmatter name and the overnight phrases', () => {
    expect(template).toMatch(/^---\r?\nname: afk-preflight\r?\n/);
    for (const p of ['going to bed', 'heading to bed', 'off to bed', 'going afk']) expect(template).toContain(p);
  });
  it('every `afk.mjs <verb>` it tells the agent to run is a real verb', () => {
    const verbs = [...template.matchAll(/\{\{AFK_CLI\}\}"\s+([a-z-]+(?: set| show)?)/g)].map((m) => m[1]);
    expect(verbs.length).toBeGreaterThan(3);
    for (const v of verbs) expect(VERBS, v).toContain(v);
  });
  it('forbids the agent from the TTY verbs and from editing the afk dir', () => {
    expect(template).toMatch(/never run[^.]*terms set[^.]*amend[^.]*confirm[^.]*approve/i);
    expect(template).toContain('~/.aether-os/afk');
  });
  it('settles answered questions by a source edit and a fresh compile before any confirm, and never edits a source line itself', () => {
    expect(template).toContain('compile again after editing the source line, BEFORE any confirm');
    expect(template).toMatch(/never edit or reword[^.]*(handoff|ledger|plan)/i);
    expect(template).toMatch(/heading/i); expect(template).toContain('[pending'); expect(template).toContain('[todo]');   // the two edits one line cannot do
    expect(VERBS).not.toContain('resolve');   // Phase 1 has no state transition from question to ready (Open item 11)
  });
  it('never mentions bypassPermissions', () => { expect(template).not.toMatch(/bypassPermissions/i); });
  it('sends Matt to a plain PowerShell window and never suggests the ! escape', () => {
    expect(template).toContain('plain PowerShell window');
    expect(template).not.toMatch(/`!|\s!\s|the !|! escape/);
  });
  it('step 8 reports a resolve-failed reason as an error, and what unfinished and none mean', () => {
    expect(template).toContain('resolve failed:');
    expect(template).toMatch(/resolve failed:[^.]*error/i);
    expect(template).toMatch(/unfinished[^.]*no items[^.]*nothing will run/i);
    expect(template).toMatch(/none[^.]*no night is approved/i);
  });
});
