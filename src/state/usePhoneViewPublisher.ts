// Renderer side of the phone view bridge (privacy section 17). Each phone view that is derived in the renderer
// registers a pure builder in PHONE_VIEW_PUBLISHERS (each consuming task adds its own). The publisher builds
// each view's payload from the store state, sends it to main only when it changed (structural compare) and at most
// once per second per view. Main ignores it unless phone control is on, holds only the latest value in memory, and
// re-validates it.
import { useEffect, useRef } from 'react';
import { useAetherStore } from './store';
import type { AetherState } from './types';
import type { ViewId } from '../shared/remote/types';
import { phoneDashPayload } from '../components/dashboard/phoneDashPayload';
import { hasDesktopApp } from '../components/dashboard/readinessMath';

export type PhoneViewBuilder = (state: AetherState) => Record<string, unknown> | null;
export type PhoneViewRegistry = Partial<Record<ViewId, PhoneViewBuilder>>;

export const PHONE_VIEW_PUBLISHERS: PhoneViewRegistry = {
  dash: (state) => phoneDashPayload(state, hasDesktopApp(), Date.now()),
};
export const PUBLISH_MIN_GAP_MS = 1000;

export interface PhoneViewPublisher {
  update(state: AetherState): void;
  dispose(): void;
}

export function createPhoneViewPublisher(
  registry: PhoneViewRegistry,
  publish: (v: ViewId, payload: Record<string, unknown>) => void,
  opts: { now?: () => number; minGapMs?: number } = {},
): PhoneViewPublisher {
  const now = opts.now ?? Date.now;
  const gap = opts.minGapMs ?? PUBLISH_MIN_GAP_MS;
  const lastJson = new Map<ViewId, string>();
  const lastAt = new Map<ViewId, number>();
  const timers = new Map<ViewId, ReturnType<typeof setTimeout>>();
  let latest: AetherState | null = null;

  const run = (v: ViewId): void => {
    const build = registry[v];
    if (!build || !latest) return;
    let payload: Record<string, unknown> | null;
    try { payload = build(latest); } catch { return; }
    if (!payload) return;
    const json = JSON.stringify(payload);
    if (json === lastJson.get(v)) return;
    lastJson.set(v, json);
    lastAt.set(v, now());
    try { publish(v, payload); } catch { /* the bridge is best effort */ }
  };

  return {
    update(state) {
      latest = state;
      for (const v of Object.keys(registry) as ViewId[]) {
        if (timers.has(v)) continue; // a send is scheduled and will use the newest state
        const wait = (lastAt.get(v) ?? Number.NEGATIVE_INFINITY) + gap - now();
        if (wait <= 0) run(v);
        else timers.set(v, setTimeout(() => { timers.delete(v); run(v); }, wait));
      }
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      latest = null;
    },
  };
}

export function usePhoneViewPublisher(registry: PhoneViewRegistry = PHONE_VIEW_PUBLISHERS): void {
  const { state } = useAetherStore();
  const pub = useRef<PhoneViewPublisher | null>(null);
  useEffect(() => {
    const bridge = window.aetherElectron?.phoneView;
    if (!bridge) return;
    pub.current = createPhoneViewPublisher(registry, (v, p) => bridge.publish(v, p));
    return () => { pub.current?.dispose(); pub.current = null; };
  }, [registry]);
  useEffect(() => { pub.current?.update(state); }, [state]);
}
