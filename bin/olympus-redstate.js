#!/usr/bin/env node
// olympus-redstate: run the configured suite layers expecting failure (the
// authored tests must be red against main before any implementation
// exists). Prints raw outcomes; Argus (validator) judges the reasons.
//
//   olympus-redstate
'use strict';
const { run, loadManifest, printAndExit } = require('./olympus-exec-lib');

const cwd = process.cwd();
let manifest;
try {
  ({ manifest } = loadManifest(cwd));
} catch (e) {
  printAndExit({ ok: false, error: `no active run state: ${e.message}` }, 1);
}

const layers = Array.isArray(manifest.commands.fullSuite)
  ? manifest.commands.fullSuite
  : [{ name: 'suite', command: manifest.commands.fullSuite }];

const results = [];
for (const layer of layers) {
  if (!layer || !layer.command) continue;
  const r = run(layer.command, cwd);
  results.push({
    name: layer.name || 'suite',
    command: layer.command,
    exitCode: r.exitCode,
    red: !r.ok, // red (failing) is the EXPECTED state here
    tail: r.tail,
  });
}

printAndExit({
  ok: true,
  allRed: results.length > 0 && results.every((r) => r.red),
  results,
});
