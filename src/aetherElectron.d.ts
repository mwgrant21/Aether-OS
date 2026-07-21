import type { RealUsageSnapshot } from './state/types';
import type { RealAgentDispatch } from './state/liveAgentsMath';

export {};

declare global {
  interface Window {
    aetherElectron?: {
      pty: {
        start: (opts: { cols: number; rows: number }) => Promise<void>;
        write: (input: string) => void;
        resize: (cols: number, rows: number) => void;
        onData: (callback: (data: string) => void) => () => void;
      };
      usage: {
        onSnapshot: (callback: (snapshot: RealUsageSnapshot) => void) => () => void;
      };
      agents: {
        onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => () => void;
      };
    };
  }
}
