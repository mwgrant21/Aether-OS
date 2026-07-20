import { contextBridge, ipcRenderer } from 'electron';
import type { RealUsageSnapshot } from '../src/state/types';

contextBridge.exposeInMainWorld('aetherElectron', {
  pty: {
    start: (opts: { cols: number; rows: number }) => ipcRenderer.invoke('pty:start', opts),
    write: (input: string) => ipcRenderer.send('pty:write', input),
    resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', { cols, rows }),
    onData: (callback: (data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
      ipcRenderer.on('pty:data', listener);
      return () => ipcRenderer.removeListener('pty:data', listener);
    },
  },
  usage: {
    onSnapshot: (callback: (snapshot: RealUsageSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: RealUsageSnapshot) => callback(snapshot);
      ipcRenderer.on('usage:snapshot', listener);
      return () => ipcRenderer.removeListener('usage:snapshot', listener);
    },
  },
});
