#!/usr/bin/env node
// olympus-redstate: run the configured suite layers expecting failure (the
// authored tests must be red against main before any implementation
// exists). Prints raw outcomes; Argus (validator) judges the reasons.
//
//   olympus-redstate
'use strict';
const { loadManifest, printAndExit, runWithFlakeRetry } = require('./olympus-exec-lib');

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
const signatures = manifest.infraFlakeSignatures || [];
for (const layer of layers) {
  if (!layer || !layer.command) continue;
  // An infra flake here would masquerade as "red for the wrong reason" and
  // mislead the validator — retry declared signatures once, flagged.
  const { result, retried, matchedSignature } = runWithFlakeRetry(layer.command, cwd, signatures);
  results.push({
    name: layer.name || 'suite',
    command: layer.command,
    exitCode: result.exitCode,
    red: !result.ok, // red (failing) is the EXPECTED state here
    tail: result.tail,
    ...(retried ? { infraFlakeRetry: { signature: matchedSignature, recovered: result.ok } } : {}),
  });
}

printAndExit({
  ok: true,
  allRed: results.length > 0 && results.every((r) => r.red),
  results,
});
