// src/state/noPayloadInStore.test.ts
//
// Mechanical enforcement of the Stage 14 "render, not store" rule -- see the
// "The privacy decision" section of
// docs/superpowers/specs/2026-08-05-comms-deck-stage14-design.md (binding):
// transcript message content read by electron/transcriptReader.ts must live
// only in the mounted Comms component's own useState. It must never enter
// AetherState, never enter persistence.ts's savePersisted whitelist, never
// be written to ~/.aether-os/, and never reach the collector's SQLite store.
//
// Written FIRST, before any Task 3 wiring, so this constraint is never
// retrofitted around code that already violates it -- see the task-3 brief's
// step ordering.
//
// Reuses the source-scan shape from src/shared/noApiCalls.test.ts: rather
// than trying to prove a negative about every conceivable future shape of a
// leak, it asserts the one concrete, checkable fact that would have to
// change first for a leak to become possible -- `DisplayMessage` (the type
// that names "a transcript message with its rendered text", defined in
// electron/transcriptReader.ts) is never referenced anywhere on the
// AetherState/persistence surface.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { initialState } from './initialState';
import { PERSISTENCE_EXCLUSIONS } from './persistence';
import type { AetherState } from './types';

const STATE_SURFACE_FILES = ['src/state/types.ts', 'src/state/initialState.ts', 'src/state/persistence.ts', 'src/state/reducer.ts'];

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(relPath), 'utf8');
}

describe('no transcript payload in the store', () => {
  it('DisplayMessage is never referenced by the AetherState/persistence/reducer surface', () => {
    for (const file of STATE_SURFACE_FILES) {
      const src = readSource(file);
      expect(src, `${file} must not reference DisplayMessage`).not.toMatch(/DisplayMessage/);
    }
  });

  it('AetherState has no key that plausibly holds transcript message content', () => {
    const suspicious = /transcript|displaymessage|chatlog/i;
    const keys = Object.keys(initialState) as (keyof AetherState)[];
    const offending = keys.filter((k) => suspicious.test(String(k)));
    expect(offending).toEqual([]);
  });

  it("persistence.ts's savePersisted slice literal never carries a transcript-shaped key", () => {
    const src = readSource('src/state/persistence.ts');
    const sliceMatch = src.match(/const slice: Partial<AetherState> = \{([\s\S]*?)\};/);
    expect(sliceMatch, 'savePersisted slice literal not found -- update this test if persistence.ts is restructured').toBeTruthy();
    const sliceBody = sliceMatch![1];
    expect(sliceBody).not.toMatch(/transcript|displayMessage|chatLog/i);
  });

  it('PERSISTENCE_EXCLUSIONS documents no transcript-message field (because none should ever exist on AetherState to exclude)', () => {
    // Belt-and-suspenders: even a future AetherState field merely listed in
    // PERSISTENCE_EXCLUSIONS (kept out of localStorage but still live in the
    // in-memory store) would violate the binding rule -- AetherState itself
    // must never hold transcript content, not just avoid persisting it.
    const offending = Object.keys(PERSISTENCE_EXCLUSIONS).filter((k) => /transcript|displaymessage|chatlog/i.test(k));
    expect(offending).toEqual([]);
  });
});
