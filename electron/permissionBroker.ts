// Observe-only registry of pending permission prompts. main.ts calls open()
// when a prompt is shown and close() when it is answered; the registry never
// resolves anything itself and holds entries in memory only, until closed.
import type { PermissionRisk } from '../src/shared/permissionRisk';
import {
  PROMPT_SUMMARY_CAP,
  type PromptCloseReason,
  type PromptInfo,
  type PromptReadPort,
  type PromptTap,
} from '../src/shared/remote/types';

export function summarizePermission(toolName: string, toolInput: unknown): string {
  const input = typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  let text = '';
  if (toolName === 'Bash') text = str('command');
  else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read' || toolName === 'NotebookEdit') {
    text = str('file_path') || str('notebook_path');
  }
  if (!text) {
    const keys = Object.keys(input);
    text = keys.length > 0 ? `${toolName} (${keys.join(', ')})` : toolName;
  }
  return text.length > PROMPT_SUMMARY_CAP ? text.slice(0, PROMPT_SUMMARY_CAP) : text;
}

export interface PermissionBrokerOptions {
  now: () => number;
  timeoutMs: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface PermissionBroker {
  open(p: { id: string; toolName: string; toolInput: unknown; risk: PermissionRisk }): void;
  close(id: string, reason: PromptCloseReason): boolean;
  readPort(): PromptReadPort;
}

interface Pending { info: Omit<PromptInfo, 'ttlMs'>; expiresAt: number; timer: unknown }

export function createPermissionBroker(opts: PermissionBrokerOptions): PermissionBroker {
  const setT = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Map<string, Pending>();
  const taps = new Set<PromptTap>();

  const fanOut = (fn: (t: PromptTap) => void): void => {
    for (const t of [...taps]) {
      try { fn(t); } catch { /* a throwing tap must not break the others */ }
    }
  };

  const close = (id: string, reason: PromptCloseReason): boolean => {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    try { clearT(p.timer); } catch { /* ignore */ }
    fanOut((t) => t.closed({ id, reason }));
    return true;
  };

  return {
    open({ id, toolName, toolInput, risk }) {
      if (pending.has(id)) return;
      const info = { id, tool: toolName, risk, summary: summarizePermission(toolName, toolInput) };
      const timer = setT(() => { close(id, 'timeout'); }, opts.timeoutMs);
      (timer as { unref?: () => void } | null)?.unref?.();
      pending.set(id, { info, expiresAt: opts.now() + opts.timeoutMs, timer });
      fanOut((t) => t.opened({ ...info, ttlMs: opts.timeoutMs }));
    },
    close,
    readPort() {
      return {
        attach(tap) {
          taps.add(tap);
          for (const p of [...pending.values()]) {
            try { tap.opened({ ...p.info, ttlMs: Math.max(0, p.expiresAt - opts.now()) }); } catch { /* isolate */ }
          }
          return { detach() { taps.delete(tap); } };
        },
      };
    },
  };
}
