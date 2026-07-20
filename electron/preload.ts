import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aetherElectron', {
  pty: {
    start: (opts: { cols: number; rows: number }) => ipcRenderer.invoke('pty:start', opts),
    write: (input: string) => ipcRenderer.send('pty:write', input),
    resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', { cols, rows }),
    onData: (callback: (data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
      ipcRenderer.on('pty:data', listener);
      // Returned so a caller CAN unsubscribe if it ever needs to -- Task 2's
      // PtyTerminal deliberately does not call this (the singleton's pty
      // connection is meant to live for the app's whole lifetime), but the
      // capability should exist rather than be silently impossible.
      return () => ipcRenderer.removeListener('pty:data', listener);
    },
  },
});
