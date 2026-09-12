/** Defer Electron quit until cleanup is proven. A bounded failed attempt leaves
 * the app alive to retain ownership and report its cleanup failure. */
export function createCommunicationQuitGate(dispose: () => Promise<{ ok: boolean; code?: string }>, quit: () => void,
  onHeld: (code: string) => Promise<'retry' | 'stay' | 'force'> = async () => 'stay') {
  let authorized = false, pending = false;
  return (event: { preventDefault(): void }): boolean => {
    if (authorized) return true;
    event.preventDefault();
    if (!pending) {
      pending = true;
      void (async () => {
        do {
          const result = await Promise.resolve().then(dispose).catch(() => ({ ok: false, code: 'CLEANUP_FAILED' }));
          if (result.ok) { authorized = true; quit(); return; }
          const choice = await onHeld(result.code ?? 'CLEANUP_FAILED');
          // Force is explicit operator authorization, never evidence of cleanup.
          if (choice === 'force') { authorized = true; quit(); return; }
          if (choice !== 'retry') return;
        } while (true);
      })().catch(() => { /* A failed dialog keeps the app open. */ }).finally(() => { pending = false; });
    }
    return false;
  };
}
