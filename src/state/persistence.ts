import type { AetherState } from './types';

const STORAGE_KEY = 'aetheros-v1';

export function loadPersisted(): Partial<AetherState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<AetherState>;
  } catch {
    return null;
  }
}

export function savePersisted(state: AetherState): void {
  try {
    const slice: Partial<AetherState> = {
      cfg: state.cfg,
      activeTab: state.activeTab,
      agents: state.agents,
      idleList: state.idleList,
      notifs: state.notifs,
      unread: state.unread,
      cmdHist: state.cmdHist,
      approvals: state.approvals,
      apprSeq: state.apprSeq,
      logs: state.logs,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch {
    // localStorage unavailable (private mode, quota) — persistence is best-effort
  }
}
