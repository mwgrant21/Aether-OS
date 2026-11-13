import { describe, expect, it } from 'vitest';
import { claudeInputReady } from './inputBox';

const RULE = '\u2500'.repeat(100);
const PTR = '\u276f';
const NB = '\u00a0';
const screen = (...rows: string[]): string => rows.join('\n');

const PS_ONLY = screen(
  'Windows PowerShell',
  'Copyright (C) Microsoft Corporation. All rights reserved.',
  '',
  'PS C:\\Users\\Matt\\.aether-os\\gui-chat> Remove-Item Env:\\ANTHROPIC_API_KEY -ErrorAction SilentlyContin',
  'ue; Remove-Item Env:\\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue; Remove-Item Env:\\ANTHROPIC_',
  'BASE_URL -ErrorAction SilentlyContinue',
  'PS C:\\Users\\Matt\\.aether-os\\gui-chat> Remove-Item Env:\\CLAUDE_CODE_CHILD_SESSION -ErrorAction Silent',
  'lyContinue; claude --session-id 07faf54b-30fb-4fa7-90a5-ffab1e033c38 --permission-mode auto; exit',
);

const EFFORT = ' '.repeat(82) + '\u25cf high \u00b7 /effort';
const BOX_323 = [
  EFFORT,
  RULE,
  PTR + NB + 'Try "write a test for <filepath>"',
  RULE,
  '',
  '  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 1 agent',
];
const BOX_325 = [
  EFFORT,
  RULE,
  PTR + NB + 'Try "edit <filepath> to..."',
  RULE,
  '',
  '  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents',
];
const HISTORY_C = [
  PTR + ' Reply with the single word ok.',
  '',
  '\u25cf ok',
  '',
  '\u273d Photosynthesizing\u2026 (Capturing session for agent-learn...\u2026 0/3 \u00b7 19s \u00b7 \u2193 138 tokens \u00b7',
  'thinking with high effort)',
];
const BOX_C = [
  RULE,
  PTR,
  RULE,
  '  Model:' + NB + 'Sonnet' + NB + '5.5' + NB + '|' + NB + 'Ctx:' + NB + '0',
  '  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 1 agent',
];

describe('claudeInputReady', () => {
  it('is false on the bare PowerShell launch screen', () => {
    expect(claudeInputReady(PS_ONLY)).toBe(false);
  });

  it('is true on the Claude 2.1.323 gate-fire box', () => {
    expect(claudeInputReady(screen('banner', '', '\u26a0 1 MCP server needs authentication', ...BOX_323))).toBe(true);
  });

  it('is true on the 2.1.325 first frame (NBSP after the glyph, no statusline)', () => {
    expect(claudeInputReady(screen('Claude Code v2.1.325', ...BOX_325))).toBe(true);
  });

  it('is true on an empty box with statusline and history echo, false without the box', () => {
    expect(claudeInputReady(screen(...HISTORY_C, ...BOX_C))).toBe(true);
    expect(claudeInputReady(screen(...HISTORY_C))).toBe(false);
  });

  it('is false on permission dialog, model picker, usage pane and shell prompt tails', () => {
    const dashed = '\u254c'.repeat(100);
    expect(
      claudeInputReady(
        screen(dashed, ' This command requires approval', ' Do you want to proceed?', ' > 1. Yes', '   2. Yes, and do not ask again', '   3. No', ' Esc to cancel \u00b7 Tab to amend'),
      ),
    ).toBe(false);
    expect(claudeInputReady(screen(' Select model', ' > > 4. Sonnet 5.5 \u2713', '   5. Haiku', ' Enter to set as default \u00b7 Esc to cancel'))).toBe(false);
    expect(claudeInputReady(screen(' Usage', ' Current session  12% used', ' Current week  3% used', ' Esc to cancel'))).toBe(false);
    expect(claudeInputReady(screen('PS C:\\Users\\Matt> ', 'PS C:\\Users\\Matt> claude'))).toBe(false);
  });

  it('accepts > as the input glyph, rejects lone rows, missing close, 19-wide and dashed rules', () => {
    expect(claudeInputReady(screen(RULE, '> Try "how does <filepath> work?"', RULE))).toBe(true);
    expect(claudeInputReady(screen('> ', 'hello'))).toBe(false);
    expect(claudeInputReady(screen(RULE, 'hello'))).toBe(false);
    expect(claudeInputReady(screen(RULE, PTR + NB + 'Try x', 'footer'))).toBe(false);
    const r19 = '\u2500'.repeat(19);
    expect(claudeInputReady(screen(r19, PTR, r19))).toBe(false);
    const dashed = '\u254c'.repeat(100);
    expect(claudeInputReady(screen(dashed, PTR, dashed))).toBe(false);
  });

  it('allows up to two wrapped input rows between the rules', () => {
    expect(claudeInputReady(screen(RULE, PTR + ' a long line that', 'wraps once', RULE))).toBe(true);
    expect(claudeInputReady(screen(RULE, PTR + ' a long line', 'wraps', 'twice', RULE))).toBe(true);
    expect(claudeInputReady(screen(RULE, PTR + ' a long line', 'wraps', 'three', 'times', RULE))).toBe(false);
  });

  it('scans only the last 12 non-empty rows, and blank rows do not count', () => {
    const footer = (n: number) => Array.from({ length: n }, (_, k) => `footer ${k}`);
    const box = [RULE, PTR + NB + 'Try x', RULE];
    expect(claudeInputReady(screen(...box, ...footer(8)))).toBe(true);
    expect(claudeInputReady(screen(...box, ...footer(10)))).toBe(false);
    const spaced = footer(8).flatMap((r) => [r, '', '   ']);
    expect(claudeInputReady(screen(...box, ...spaced))).toBe(true);
  });

  it('matches a resumed screen only when the box is below the history', () => {
    const history = ['Claude Code v2.1.325', PTR + ' earlier prompt', '\u25cf earlier answer', ''];
    expect(claudeInputReady(screen(...history, ...BOX_325))).toBe(true);
    expect(claudeInputReady(screen(...history))).toBe(false);
  });
});
