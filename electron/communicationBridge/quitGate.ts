/** Defer Electron quit until cleanup is proven. A bounded failed attempt leaves
 * the app alive to retain ownership and report its cleanup failure. */
export function createCommunicationQuitGate(dispose: () => Promise<{ ok: boolean }>, quit: () => void) {
  let confirmed = false, pending = false;
  return (event: { preventDefault(): void }): boolean => {
    if (confirmed) return true;
    event.preventDefault();
    if (!pending) {
      pending = true;
      void Promise.resolve().then(dispose).then(result => {
        if (result.ok) { confirmed = true; quit(); }
      }, () => { /* Unconfirmed cleanup never authorizes quitting. */ }).finally(() => { pending = false; });
    }
    return false;
  };
}
