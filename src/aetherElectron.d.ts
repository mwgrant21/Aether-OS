import type { RealUsageSnapshot } from './state/types';
import type { RealAgentDispatch, CompletedDispatchUsage } from './state/liveAgentsMath';
import type { AttachmentInfo } from './components/files/attachmentsMath';

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
        onCompleted: (callback: (completed: CompletedDispatchUsage[]) => void) => () => void;
      };
      attachments: {
        list: () => Promise<AttachmentInfo[]>;
        add: () => Promise<string[]>;
        remove: (name: string) => Promise<void>;
        thumbnail: (name: string) => Promise<string | null>;
        open: (name: string) => Promise<void>;
      };
    };
  }
}
