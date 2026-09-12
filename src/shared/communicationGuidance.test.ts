// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { communicationError } from './communicationLifecycle';
import type { CommunicationErrorCode } from './communicationTypes';

describe('approved communication error guidance', () => {
  it('matches every code in the v4 operator contract exactly', () => {
    const plan = readFileSync('docs/superpowers/plans/2026-09-11-visible-agent-communication-v4.md', 'utf8');
    const rows = [...plan.matchAll(/^\| ([A-Z_]+(?: \/ [A-Z_]+)*) \| (.+) \|$/gm)];
    expect(rows).toHaveLength(10);
    const codes = rows.flatMap(row => row[1].split(' / '));
    expect(new Set(codes).size).toBe(21);
    for (const row of rows) for (const code of row[1].split(' / '))
      expect(communicationError(code as CommunicationErrorCode).guidance).toBe(row[2]);
  });
});
