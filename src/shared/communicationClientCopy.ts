import type { CommunicationBridgeSnapshot } from '../../electron/communicationBridge/mainIntegration';

/** Display conclusions only from positive evidence. Bridge readiness is not input readiness. */
export function communicationClientCopy(snapshot: CommunicationBridgeSnapshot | null) {
  if (!snapshot?.enabled || !snapshot.sessionStatus.sessionLabel) return null;
  const { client, prompt, connected } = snapshot.sessionStatus;
  if (client === 'exited') return { title: 'Client exited', detail: 'The connected Claude client has exited. Review its output in the terminal.' };
  if (client === 'failed') return { title: 'Client launch failed', detail: 'The connected Claude client could not be started or its launch failed. Check the terminal.' };
  if (connected && prompt === 'folder-trust') return { title: 'Action required: folder trust', detail: 'Review the folder-trust prompt in the terminal to continue.' };
  return { title: 'Client not ready — check terminal', detail: 'The client may be waiting for input, such as a folder-trust decision.' };
}
