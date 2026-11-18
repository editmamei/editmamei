#!/usr/bin/env node
// Starts the Editmamei MCP server from the `editmamei` package this package
// depends on, with one editor's tools. scripts/build-wrappers.ts copies this
// file into each wrapper package and sets EDITOR for it.
//
// stdout is the MCP channel, so this file never writes to it: the server
// inherits stdin, stdout and stderr and talks to the client directly.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const EDITOR = 'photoshop';

const require = createRequire(import.meta.url);

let entry;
try {
  // `editmamei` has no exports map, so its files resolve by path.
  entry = require.resolve('editmamei/dist/index.js');
} catch (err) {
  process.stderr.write(
    `Could not find the editmamei package this launcher depends on: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
}

// A value the user set in their MCP config wins.
const env = { ...process.env };
if (!env.EDITMAMEI_EDITOR || !env.EDITMAMEI_EDITOR.trim()) env.EDITMAMEI_EDITOR = EDITOR;

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on('error', (err) => {
  process.stderr.write(`Could not start the Editmamei server: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
