import { describe, it, expect } from 'vitest';
import {
  MANAGED_BEGIN,
  MANAGED_END,
  HEADING,
  GUIDANCE_BY_ID,
  guidanceFor,
  upsertGuidance,
  isGuidanceApplied,
} from './optimizeActions';

const KNOWN_ID = 'opus-on-trivial-turns';
const KNOWN_GUIDANCE = GUIDANCE_BY_ID[KNOWN_ID];
const OTHER_ID = 'uncapped-bash-output';
const OTHER_GUIDANCE = GUIDANCE_BY_ID[OTHER_ID];

describe('optimizeActions', () => {
  it('constants have the exact spec values', () => {
    expect(MANAGED_BEGIN).toBe('<!-- token-tracker:begin -->');
    expect(MANAGED_END).toBe('<!-- token-tracker:end -->');
    expect(HEADING).toBe('## Token Tracker suggestions');
  });

  it('GUIDANCE_BY_ID has the three exact strings', () => {
    expect(GUIDANCE_BY_ID['opus-on-trivial-turns']).toBe(
      'Prefer Sonnet for short/trivial turns; reserve Opus for complex reasoning.',
    );
    expect(GUIDANCE_BY_ID['unpinned-config-re-reads']).toBe(
      'Pin frequently re-read files into context instead of re-reading them each turn.',
    );
    expect(GUIDANCE_BY_ID['uncapped-bash-output']).toBe(
      'Cap large command output (pipe through head/tail or Select-Object -First).',
    );
  });

  it('guidanceFor returns the string for a known id and null for unknown', () => {
    expect(guidanceFor(KNOWN_ID)).toBe(KNOWN_GUIDANCE);
    expect(guidanceFor('no-such-id')).toBeNull();
    expect(guidanceFor(undefined)).toBeNull();
  });

  it('empty content -> creates a block with heading + bullet, added:true', () => {
    const { content, added } = upsertGuidance('', KNOWN_ID);
    expect(added).toBe(true);
    expect(content.includes(MANAGED_BEGIN)).toBe(true);
    expect(content.includes(HEADING)).toBe(true);
    expect(content.includes(`- ${KNOWN_GUIDANCE}`)).toBe(true);
    expect(content.includes(MANAGED_END)).toBe(true);
    expect(content.indexOf(MANAGED_BEGIN) < content.indexOf(`- ${KNOWN_GUIDANCE}`)).toBe(true);
    expect(content.indexOf(`- ${KNOWN_GUIDANCE}`) < content.indexOf(MANAGED_END)).toBe(true);
  });

  it('content without a block -> appends the block and preserves original content', () => {
    const original = '# My Project\n\nSome existing notes.\n';
    const { content, added } = upsertGuidance(original, KNOWN_ID);
    expect(added).toBe(true);
    expect(content.startsWith(original)).toBe(true);
    expect(content.includes(MANAGED_BEGIN)).toBe(true);
    expect(content.includes(`- ${KNOWN_GUIDANCE}`)).toBe(true);
    expect(content.includes(MANAGED_END)).toBe(true);
  });

  it('content WITH a block missing this line -> inserts the bullet before MANAGED_END, added:true', () => {
    const original = [
      '# My Project',
      '',
      MANAGED_BEGIN,
      HEADING,
      `- ${OTHER_GUIDANCE}`,
      MANAGED_END,
      '',
      'Trailing user content.',
      '',
    ].join('\n');

    const { content, added } = upsertGuidance(original, KNOWN_ID);
    expect(added).toBe(true);
    expect(content.includes(`- ${OTHER_GUIDANCE}`)).toBe(true);
    expect(content.includes(`- ${KNOWN_GUIDANCE}`)).toBe(true);
    expect(content.indexOf(`- ${KNOWN_GUIDANCE}`) < content.indexOf(MANAGED_END)).toBe(true);
    expect(content.startsWith('# My Project')).toBe(true);
    expect(content.includes('Trailing user content.')).toBe(true);
  });

  it('idempotency: re-applying the same id -> added:false and content unchanged', () => {
    const first = upsertGuidance('', KNOWN_ID);
    const second = upsertGuidance(first.content, KNOWN_ID);
    expect(second.added).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('unknown id -> added:false and content unchanged', () => {
    const original = '# Whatever\n';
    const { content, added } = upsertGuidance(original, 'not-a-real-id');
    expect(added).toBe(false);
    expect(content).toBe(original);
  });

  it('isGuidanceApplied: true only when the bullet is inside the managed block', () => {
    expect(isGuidanceApplied('', KNOWN_ID)).toBe(false);
    expect(isGuidanceApplied('# Notes\nUnrelated content.\n', KNOWN_ID)).toBe(false);

    const { content } = upsertGuidance('# My Project\n', KNOWN_ID);
    expect(isGuidanceApplied(content, KNOWN_ID)).toBe(true);
    expect(isGuidanceApplied(content, OTHER_ID)).toBe(false);

    expect(isGuidanceApplied(content, 'no-such-id')).toBe(false);
  });

  it('isGuidanceApplied: bullet text OUTSIDE the managed block does not count', () => {
    const outside = `# My Project\n- ${KNOWN_GUIDANCE}\n`;
    expect(isGuidanceApplied(outside, KNOWN_ID)).toBe(false);
  });

  it('a different finding into an existing block -> both bullets present', () => {
    const step1 = upsertGuidance('', KNOWN_ID);
    const step2 = upsertGuidance(step1.content, OTHER_ID);
    expect(step2.added).toBe(true);
    expect(step2.content.includes(`- ${KNOWN_GUIDANCE}`)).toBe(true);
    expect(step2.content.includes(`- ${OTHER_GUIDANCE}`)).toBe(true);
    expect(step2.content.split(MANAGED_BEGIN).length - 1).toBe(1);
    expect(step2.content.split(MANAGED_END).length - 1).toBe(1);
  });
});
