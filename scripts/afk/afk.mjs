#!/usr/bin/env node
// The afk executable entry: the only file that reads the clock, the home dir and the real stdio (AFK Phase 1, T17).
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { isInteractive, main } from './cli.mjs';

const readLine = (question) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => resolve(''));
  rl.question(`${question}\n> `, (answer) => { resolve(answer); rl.close(); });
});

const code = await main(process.argv.slice(2), {
  homeDir: homedir(),
  nowMs: Date.now(),
  isTty: isInteractive(process.stdin, process.stdout),
  readLine,
  print: (s) => console.log(s),
  printErr: (s) => console.error(s),
  env: process.env,
});
process.exitCode = code;
