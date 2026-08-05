#!/usr/bin/env node
// olympus-redstate: run the configured suite layers expecting failure (the
// authored tests must be red against main before any implementation
// exists). Prints raw outcomes; Argus (validator) judges the reasons.
//
// A full suite's wall time exceeds any single relay window, so the run is
// a detached job (olympus-job-lib): `start` and `status` answer in
// seconds, and the suite keeps running whatever happens to the invoker.
//
//   olympus-redstate                 synchronous run (quick suites only)
//   olympus-redstate start           spawn the run as a detached job;
//                                    idempotent — a live job returns its
//                                    handle, never a twin
//   olympus-redstate status [--wait <seconds>]
//                                    running/progress, a crash report, or
//                                    the final results JSON once the job
//                                    exits; --wait blocks inside the bin
'use strict';
const path = require('path');
const { loadManifest, printAndExit, runWithFlakeRetry } = require('./olympus-exec-lib');
const { startJob, jobStatus, writeProgress, writeResult, waitMsFrom } = require('./olympus-job-lib');

const JOB = 'redstate';
const cwd = process.cwd();
const argv = process.argv.slice(2);
const mode = argv[0];

let manifest, manifestPath;
try {
  ({ manifest, manifestPath } = loadManifest(cwd));
} catch (e) {
  printAndExit({ ok: false, error: `no active run state: ${e.message}` }, 1);
}
const runDir = path.dirname(manifestPath);

function redstate(onLayer) {
  const layers = Array.isArray(manifest.commands.fullSuite)
    ? manifest.commands.fullSuite
    : [{ name: 'suite', command: manifest.commands.fullSuite }];

  const results = [];
  const signatures = manifest.infraFlakeSignatures || [];
  let i = 0;
  for (const layer of layers) {
    if (!layer || !layer.command) continue;
    i++;
    if (onLayer) onLayer(layer.name || 'suite', i, layers.length);
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

  return {
    ok: true,
    allRed: results.length > 0 && results.every((r) => r.red),
    results,
  };
}

if (mode === 'start') {
  const st = startJob({ name: JOB, runDir, scriptPath: __filename, childArgs: ['--detached-child'], argsKey: '', cwd });
  printAndExit(st, st.ok ? 0 : 1);
} else if (mode === 'status') {
  const st = jobStatus({ name: JOB, runDir, waitMs: waitMsFrom(argv) });
  printAndExit(st, st.ok ? 0 : 1);
} else if (mode === '--detached-child') {
  // Job body: same run as the synchronous mode, but the result lands in the
  // job's result file and any throw becomes a written failure — a crash
  // must read as a crash, never as running-forever.
  try {
    const out = redstate((name, n, total) => writeProgress(runDir, JOB, { current: name, layer: n, totalLayers: total }));
    writeResult(runDir, JOB, out);
    process.exit(0);
  } catch (e) {
    try {
      writeResult(runDir, JOB, { ok: false, error: String((e && e.message) || e) });
    } catch (e2) {
      /* nothing left to report to */
    }
    process.exit(1);
  }
} else if (mode) {
  printAndExit({ ok: false, error: `unknown mode: ${mode} — expected start, status, or no argument` }, 1);
} else {
  printAndExit(redstate());
}
