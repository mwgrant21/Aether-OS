import { maskSecrets } from '../../src/shared/board/text';

const SUMMARY_CAP = 160;
const HINT_CAP = 80;

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/** One masked line "<tool>: <hint>", <= 160 chars. Never an absolute path, never the full input. */
export function summarizePermission(tool: string, input: unknown): string {
  let hint = '';
  if (typeof input === 'object' && input !== null) {
    const o = input as Record<string, unknown>;
    if (typeof o.command === 'string') hint = maskSecrets(o.command).slice(0, HINT_CAP); // mask first: a cap must not cut a secret
    else if (typeof o.file_path === 'string') hint = basename(o.file_path);
    else if (typeof o.path === 'string') hint = basename(o.path);
  }
  const line = (hint ? `${tool}: ${hint}` : `${tool}:`).replace(/\s+/g, ' ').trim();
  return maskSecrets(line).replace(/\s+/g, ' ').slice(0, SUMMARY_CAP);
}

export interface PermissionBookOpts {
  timeoutMs: number;
  onTimeout: (id: string) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (t: unknown) => void;
}

export interface PermissionBook {
  open(id: string): void;
  /** True exactly once per open id; false for unknown, answered or timed-out ids. */
  answer(id: string): boolean;
  /** Forget every open id without calling onTimeout (the session that asked is gone). */
  closeAll(): void;
  size(): number;
}

export function createPermissionBook(opts: PermissionBookOpts): PermissionBook {
  const setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const open = new Map<string, unknown>();
  return {
    open(id) {
      const prev = open.get(id);
      if (prev !== undefined) clearT(prev);
      const timer = setT(() => {
        if (open.get(id) !== timer) return;
        open.delete(id);
        opts.onTimeout(id);
      }, opts.timeoutMs);
      open.set(id, timer);
    },
    answer(id) {
      const timer = open.get(id);
      if (timer === undefined) return false;
      clearT(timer);
      open.delete(id);
      return true;
    },
    closeAll() {
      for (const t of open.values()) clearT(t);
      open.clear();
    },
    size() {
      return open.size;
    },
  };
}
