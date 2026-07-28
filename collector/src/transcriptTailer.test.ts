import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readNewLines } from './transcriptTailer.js';

function tempFile(initialContent = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-tailer-'));
  const filePath = join(dir, 'session.jsonl');
  writeFileSync(filePath, initialContent, 'utf8');
  return filePath;
}

describe('readNewLines', () => {
  it('reads all complete lines from offset 0 on first read', async () => {
    const filePath = tempFile('line1\nline2\n');
    const { lines, newOffset } = await readNewLines(filePath, 0);
    expect(lines).toEqual(['line1', 'line2']);
    expect(newOffset).toBe(Buffer.byteLength('line1\nline2\n'));
  });

  it('reads only new lines when called again with the previous offset', async () => {
    const filePath = tempFile('line1\n');
    const first = await readNewLines(filePath, 0);
    appendFileSync(filePath, 'line2\n', 'utf8');
    const second = await readNewLines(filePath, first.newOffset);
    expect(second.lines).toEqual(['line2']);
  });

  it('does not return a trailing incomplete line still being written', async () => {
    const filePath = tempFile('line1\npartial-no-newline-yet');
    const { lines, newOffset } = await readNewLines(filePath, 0);
    expect(lines).toEqual(['line1']);
    expect(newOffset).toBe(Buffer.byteLength('line1\n'));
  });

  it('returns no lines and unchanged offset when nothing new has been written', async () => {
    const filePath = tempFile('line1\n');
    const first = await readNewLines(filePath, 0);
    const second = await readNewLines(filePath, first.newOffset);
    expect(second).toEqual({ lines: [], newOffset: first.newOffset });
  });

  it('returns no lines when offset already equals or exceeds the file size', async () => {
    const filePath = tempFile('short');
    const result = await readNewLines(filePath, 1000);
    expect(result).toEqual({ lines: [], newOffset: 1000 });
  });
});
