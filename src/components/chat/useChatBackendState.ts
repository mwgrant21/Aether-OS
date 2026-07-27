import { useEffect, useState } from 'react';

/** Which backend is actually answering Chat messages right now.
 *  - `live`     — Electron main process confirmed a real ANTHROPIC_API_KEY.
 *  - `offline`  — Electron main process confirmed no key; replies fall back
 *                 to the local in-world responder.
 *  - `browser`  — no Electron bridge at all (`npm run dev`); real replies
 *                 work here too, via the Vite dev-server's `/api/chat` proxy.
 *                 This is NOT the same as `offline` — collapsing it into
 *                 "offline" is exactly the bug this hook exists to avoid. */
export type ChatBackendState = 'live' | 'offline' | 'browser';

/** Feature-detects the Electron IPC bridge the same way `TopBar.tsx`'s `WindowControls` does,
 *  then asks the main process (never the renderer's own env) whether a real API key is set.
 *  Returns null until resolved. Shared by `ChatBackendCard.tsx` (Settings) and `ChatView.tsx`
 *  (the chat header chip) so the two surfaces can never disagree on which of these three
 *  states is currently true. */
export function useChatBackendState(): ChatBackendState | null {
  const [state, setState] = useState<ChatBackendState | null>(null);

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.aetherElectron : undefined;
    if (!bridge) {
      setState('browser');
      return;
    }
    let cancelled = false;
    bridge.chat.hasKey().then((hasKey) => {
      if (!cancelled) setState(hasKey ? 'live' : 'offline');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
