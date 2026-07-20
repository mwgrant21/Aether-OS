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
    };
  }
}
