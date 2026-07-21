import { promises as fsp } from 'fs';

export async function readNewLines(filePath: string, offset: number): Promise<{ lines: string[]; newOffset: number }> {
  const stat = await fsp.stat(filePath);
  if (stat.size <= offset) return { lines: [], newOffset: offset };

  const length = stat.size - offset;
  const fd = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await fd.read(buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { lines: [], newOffset: offset };
    const complete = text.slice(0, lastNewline);
    const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
    const lines = complete.split('\n');
    return { lines, newOffset };
  } finally {
    await fd.close();
  }
}
