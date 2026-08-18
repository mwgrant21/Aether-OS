import { describe, expect, it } from 'vitest';
import { createPlanUsageScraper } from './planUsageScraper';

describe('createPlanUsageScraper', () => {
  it('sets tier "max" and weekModel.pct once a per-model week line appears', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest(
      'Current session 46%used\nCurrent week (all models) 30%used\nCurrent week (Claude Opus 4) 52%used Resets 1:19am (America/Denver)\n',
    );
    expect(scraper.getSnapshot()).toEqual({ tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 1000 });
  });

  it('never sets a snapshot when only a non-model week line has been seen (Pro shape)', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest('Current session 46%used\nCurrent week (all models) 30%used Resets 1:19am (America/Denver)\n');
    expect(scraper.getSnapshot()).toBeNull();
  });

  it('never sets a snapshot when no usage pane text has been seen at all', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest('$ ls\nREADME.md  package.json\n');
    expect(scraper.getSnapshot()).toBeNull();
  });

  it('uses the LAST model-line match when the buffer contains a repainted (earlier + later) frame', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest('Current week (Claude Opus 4) 10%used');
    scraper.ingest('Current week (Claude Opus 4) 52%used Resets 1:19am (America/Denver)');
    expect(scraper.getSnapshot()?.weekModel).toEqual({ pct: 52 });
  });

  it('never throws on garbage/partial ANSI-laden input', () => {
    const scraper = createPlanUsageScraper();
    expect(() => scraper.ingest('\x1b[31m\x1b[unterminated garbage \x00\x01')).not.toThrow();
    expect(scraper.getSnapshot()).toBeNull();
  });

  it('hasSeenUsagePane() is false before any /usage-pane text is ingested, true once "Current session" appears (even without a model line)', () => {
    const scraper = createPlanUsageScraper();
    expect(scraper.hasSeenUsagePane()).toBe(false);
    scraper.ingest('Current session 12%used\n');
    expect(scraper.hasSeenUsagePane()).toBe(true);
  });

  it('does not bump capturedAtMs when re-ingesting the same pct value (quiescence signal)', () => {
    let now = 1000;
    const scraper = createPlanUsageScraper(() => now);
    scraper.ingest('Current week (Claude Opus 4) 52%used Resets 1:19am (America/Denver)');
    expect(scraper.getSnapshot()?.capturedAtMs).toBe(1000);

    now = 2000;
    scraper.ingest('Current week (Claude Opus 4) 52%used Resets 1:19am (America/Denver)');
    expect(scraper.getSnapshot()?.capturedAtMs).toBe(1000);

    now = 3000;
    scraper.ingest('Current week (Claude Opus 4) 61%used Resets 1:19am (America/Denver)');
    expect(scraper.getSnapshot()).toEqual({ tier: 'max', weekModel: { pct: 61 }, capturedAtMs: 3000 });
  });

  it('reset() clears the buffer, the snapshot, and hasSeenUsagePane()', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest('Current session 46%used\nCurrent week (Claude Opus 4) 52%used Resets 1:19am (America/Denver)\n');
    expect(scraper.getSnapshot()).not.toBeNull();
    expect(scraper.hasSeenUsagePane()).toBe(true);
    scraper.reset();
    expect(scraper.getSnapshot()).toBeNull();
    expect(scraper.hasSeenUsagePane()).toBe(false);
  });
});
