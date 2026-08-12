import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Issue #22: the app went fully white while the main process stayed healthy,
// and the decisive evidence was lost when the window closed. The instrumentation
// added for it cannot be exercised in a unit test -- these are Electron
// lifecycle events on a real window, GPU process, and OS session, which is
// exactly the category this repo does not fake (see CLAUDE.md's testing
// philosophy).
//
// What IS worth pinning is that the handlers remain wired. They are pure
// diagnostics: nothing depends on them, nothing fails without them, and no
// other test would notice their removal. That makes them unusually easy to
// delete during an unrelated cleanup -- and their absence would only be
// discovered the next time a white screen happened and again produced nothing.
// This is a source-level assertion for the same reason noApiCalls.test.ts is.
const mainSrc = readFileSync(join(__dirname, 'main.ts'), 'utf8');

describe('issue #22 white-screen diagnostics stay wired', () => {
  it("subscribes to the signals render-process-gone cannot see", () => {
    // A renderer that is alive but painting nothing never fires
    // render-process-gone. These are the events that CAN observe it.
    expect(mainSrc).toMatch(/win\.on\('unresponsive'/);
    expect(mainSrc).toMatch(/app\.on\('child-process-gone'/);
  });

  it('records session lock/unlock, the reported trigger', () => {
    // The hypothesis is that a Windows session lock tears down the GPU
    // context. Without these timestamps the next occurrence is undecidable in
    // exactly the way the first one was.
    expect(mainSrc).toMatch(/powerMonitor\.on\(evt/);
    expect(mainSrc).toMatch(/'lock-screen'/);
    expect(mainSrc).toMatch(/'unlock-screen'/);
  });

  it('tags diagnostic output so it is greppable in a dev session log', () => {
    // The first investigation had to read the whole dev-process output. A
    // stable prefix makes the next one a single grep.
    const diagLines = mainSrc.match(/\[diag\]/g) ?? [];
    expect(diagLines.length).toBeGreaterThanOrEqual(5);
  });

  it('timestamps every diagnostic line', () => {
    // "The last logged event was a full page reload at 10:38:32" was the single
    // most useful fact in the original report. Correlating a white screen with
    // a lock or a GPU death needs times on both sides, not just one.
    const diagLogs = mainSrc.match(/console\.error\([^;]*\[diag\][^;]*\)/gs) ?? [];
    expect(diagLogs.length).toBeGreaterThanOrEqual(5);
    for (const line of diagLogs) {
      expect(line).toMatch(/new Date\(\)\.toISOString\(\)/);
    }
  });
});

describe('issue #22 dev-server watch scope', () => {
  const viteCfg = readFileSync(join(__dirname, '..', 'electron.vite.config.ts'), 'utf8');

  it('excludes build output from the dev-server watcher', () => {
    // dist/ and out/ are gitignored build output. Watched, a build running
    // while a dev window is open reloads the running app for a file nobody
    // edited - the shape of the unexplained 10:38:32 reload in the report.
    expect(viteCfg).toMatch(/watch:\s*\{/);
    expect(viteCfg).toMatch(/\*\*\/dist\/\*\*/);
    expect(viteCfg).toMatch(/\*\*\/out\/\*\*/);
  });
});
