import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, migrate } from './schema.js';
import { scanTranscriptsOnce } from './transcriptScan.js';

/**
 * Node half of the cross-collector parity harness.
 * See test-fixtures/collector-parity/README.md for why this exists.
 * The Go half is collector-go/internal/transcript/parity_test.go; neither
 * runs the other, they agree by both asserting expected.json.
 */
const fixtureRoot = fileURLToPath(new URL('../../test-fixtures/collector-parity/', import.meta.url));
const expected = JSON.parse(readFileSync(join(fixtureRoot, 'expected.json'), 'utf8'));

describe('cross-collector parity', () => {
  it('produces exactly the golden figures for the shared corpus', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'aether-parity-node-')), 'p.db'));
    migrate(db);

    scanTranscriptsOnce(db, join(fixtureRoot, 'corpus'), 1000, new Map());

    const usage = db
      .prepare(
        `SELECT COUNT(*) AS rows,
                SUM(input_tokens) AS input,
                SUM(output_tokens) AS output,
                SUM(cache_creation_input_tokens) AS cacheCreation,
                SUM(cache_read_input_tokens) AS cacheRead
         FROM usage_events`,
      )
      .get() as Record<string, number>;

    expect(usage.rows).toBe(expected.usageEvents);
    expect({
      input: usage.input,
      output: usage.output,
      cacheCreation: usage.cacheCreation,
      cacheRead: usage.cacheRead,
    }).toEqual(expected.usageTokenTotals);

    const toolCalls = db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number };
    expect(toolCalls.n).toBe(expected.toolCalls);

    // The load-bearing assertion: both collectors write to the same database,
    // so a file keyed two different ways is scanned twice and double counted.
    // The golden stores forward slashes; normalise this platform's separator.
    const files = (db.prepare('SELECT file_path FROM transcript_files ORDER BY file_path').all() as { file_path: string }[])
      .map((r) => r.file_path.split(sep).join('/'))
      .sort();
    expect(files).toEqual([...expected.transcriptFiles].sort());

    // Schema shape. The two collectors migrate the same database, so their
    // schemas must not drift -- issue #31, where Go sat on version 4 while
    // Node was on 7 and stamped a newer database back down.
    const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string };
    expect(Number(version.value)).toBe(expected.schemaVersion);

    for (const [table, cols] of Object.entries(expected.columns as Record<string, string[]>)) {
      const actual = (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[])
        .map((r) => r.name)
        .sort();
      expect(actual).toEqual([...cols].sort());
    }

    db.close();
  });
});
