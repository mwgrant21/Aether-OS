import { contextBridge, ipcRenderer } from 'electron';
import type { RealUsageSnapshot } from '../src/state/types';
import type { RealAgentDispatch } from '../src/state/liveAgentsMath';
import type { AttachmentInfo } from '../src/components/files/attachmentsMath';

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
  agents: {
    onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, dispatches: RealAgentDispatch[]) => callback(dispatches);
      ipcRenderer.on('agents:snapshot', listener);
      return () => ipcRenderer.removeListener('agents:snapshot', listener);
    },
  },
  attachments: {
    list: (): Promise<AttachmentInfo[]> => ipcRenderer.invoke('attachments:list'),
    add: (): Promise<string[]> => ipcRenderer.invoke('attachments:add'),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('attachments:remove', name),
    thumbnail: (name: string): Promise<string | null> => ipcRenderer.invoke('attachments:thumbnail', name),
    open: (name: string): Promise<void> => ipcRenderer.invoke('attachments:open', name),
  },
});
