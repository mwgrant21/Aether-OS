const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createCommunicationQuitGate } = require('./gate.cjs');
const output = process.env.AETHER_TEST_OUTPUT;
app.setPath('userData', path.join(output, 'profile'));
const evidence = { verdict: 'Incomplete', cleanupStarts: 1, waits: 0, response: null };
let resolveCleanup;
const cleanup = new Promise(resolve => { resolveCleanup = resolve; });
let win;
const write = () => fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
const gate = createCommunicationQuitGate(async () => {
  evidence.waits++;
  return Promise.race([cleanup, new Promise(resolve => setTimeout(() => resolve({ ok: false, code: 'SHUTDOWN_TIMEOUT' }), 150))]);
}, () => app.quit(), async () => {
  evidence.heldWindowAlive = !win.isDestroyed();
  write();
  const { response } = await dialog.showMessageBox(win, { type: 'warning', title: 'Aether is waiting for cleanup',
    message: 'Cleanup is still unconfirmed.',
    detail: 'Aether has stopped accepting consultations and kept this window open. You can wait again on the existing cleanup operation or keep the app open.',
    buttons: ['Wait again', 'Keep open', 'Quit anyway…'], defaultId: 1, cancelId: 1 });
  evidence.response = response;
  evidence.afterDialogWindowAlive = !win.isDestroyed();
  write();
  if (response !== 1) throw new Error('Expected native Keep open action');
  setTimeout(() => { resolveCleanup({ ok: true }); app.quit(); }, 150);
  return 'stay';
});
app.on('before-quit', gate);
app.on('will-quit', () => {
  evidence.verdict = evidence.response === 1 && evidence.heldWindowAlive && evidence.afterDialogWindowAlive && evidence.waits === 2 ? 'Passed' : 'Failed';
  evidence.cleanQuit = true;
  write();
});
setTimeout(() => { evidence.error = 'Native dialog automation deadline exceeded'; write(); app.exit(1); }, 20000).unref();
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 600, height: 400, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('data:text/html,<h1>U9 native cleanup gate fixture</h1>');
  app.quit();
}).catch(error => { evidence.error = String(error); write(); app.exit(1); });
