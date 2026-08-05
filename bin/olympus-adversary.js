#!/usr/bin/env node
// olympus-adversary: measure a candidate suite's kill rate against
// Dolos-authored wrong implementations. Deterministic overlay/run/restore;
// no LLM anywhere in this file.
//
// The sweep runs the test command once per implementation, so its wall
// time can exceed a single relay window: it also runs as a detached job
// (olympus-job-lib) — `start` and `status` answer in seconds.
//
//   olympus-adversary sweep --dir <adversaryRoot> --command "<test command>"
//                                    synchronous sweep (quick suites only)
//   olympus-adversary start --dir <adversaryRoot> --command "<test command>"
//                                    spawn the sweep as a detached job;
//                                    idempotent — a live job with the same
//                                    args returns its handle, never a twin
//   olympus-adversary status [--wait <seconds>]
//                                    running/progress, a crash report, or
//                                    the final sweep JSON once the job
//                                    exits; --wait blocks inside the bin
//
// <adversaryRoot> contains one subdirectory per wrong implementation, each
// mirroring repo-relative paths (e.g. adversary/w1/src/cart.ts). For each:
// overlay files onto the worktree, run the command, restore the worktree.
// killed = the command exited nonzero (at least one test failed).
'use strict';
const fs = require('fs');
const path = require('path');
const { run, git, loadManifest, printAndExit } = require('./olympus-exec-lib');
const { startJob, jobStatus, writeProgress, writeResult, waitMsFrom } = require('./olympus-job-lib');

const JOB = 'adversary';
const cwd = process.cwd();
const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const cmd = args[0];
const dir = argOf('--dir');
const testCommand = argOf('--command');

function sweep(onImpl) {
  // Refuse to run on a dirty tree (outside .olympus): restoration relies on
  // git to be the ground truth for every file we overlay.
  const status = git('status --porcelain -- . ":(exclude).olympus"', cwd);
  if (status.tail.trim() !== '') {
    return { ok: false, error: `worktree not clean; commit or stash first:\n${status.tail}` };
  }

  function listFiles(root) {
    const out = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(p);
      }
    })(root);
    return out;
  }

  const implDirs = fs
    .readdirSync(path.isAbsolute(dir) ? dir : path.join(cwd, dir), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  if (!implDirs.length) return { ok: false, error: `no implementation directories under ${dir}` };

  const results = [];
  let i = 0;
  for (const impl of implDirs) {
    i++;
    if (onImpl) onImpl(impl, i, implDirs.length);
    const implRoot = path.join(path.isAbsolute(dir) ? dir : path.join(cwd, dir), impl);
    const files = listFiles(implRoot);
    const targets = files.map((f) => path.relative(implRoot, f));

    // Overlay.
    const preExisting = [];
    for (let j = 0; j < files.length; j++) {
      const dest = path.join(cwd, targets[j]);
      if (fs.existsSync(dest)) preExisting.push(targets[j]);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(files[j], dest);
    }

    // Measure.
    const r = run(testCommand, cwd);

    // Restore: tracked files via git, untracked overlays deleted.
    const quoted = targets.map((t) => `"${t.replace(/\\/g, '/')}"`).join(' ');
    git(`checkout -- ${quoted}`, cwd); // restores tracked; errors ignored for untracked
    for (const t of targets) {
      const dest = path.join(cwd, t);
      const tracked = git(`ls-files --error-unmatch "${t.replace(/\\/g, '/')}"`, cwd).ok;
      if (!tracked && fs.existsSync(dest)) fs.rmSync(dest);
    }

    results.push({ impl, files: targets, killed: !r.ok, exitCode: r.exitCode, tail: r.ok ? r.tail.slice(-800) : r.tail.slice(-400) });
  }

  // Verify restoration left the tree clean.
  const after = git('status --porcelain -- . ":(exclude).olympus"', cwd);
  const killedCount = results.filter((r) => r.killed).length;
  return {
    ok: after.tail.trim() === '',
    restoreClean: after.tail.trim() === '',
    killRate: `${killedCount}/${results.length}`,
    survivors: results.filter((r) => !r.killed).map((r) => r.impl),
    results,
    ...(after.tail.trim() !== '' ? { error: `worktree not clean after restore:\n${after.tail}` } : {}),
  };
}

function runDirOrDie() {
  try {
    const { manifestPath } = loadManifest(cwd);
    return path.dirname(manifestPath);
  } catch (e) {
    printAndExit({ ok: false, error: `no active run state: ${e.message}` }, 1);
  }
}

if (cmd === 'sweep') {
  if (!dir || !testCommand) {
    printAndExit({ ok: false, error: 'usage: olympus-adversary sweep --dir <adversaryRoot> --command "<test command>"' }, 1);
  }
  const out = sweep();
  printAndExit(out, out.ok ? 0 : 1);
} else if (cmd === 'start') {
  if (!dir || !testCommand) {
    printAndExit({ ok: false, error: 'usage: olympus-adversary start --dir <adversaryRoot> --command "<test command>"' }, 1);
  }
  const st = startJob({
    name: JOB,
    runDir: runDirOrDie(),
    scriptPath: __filename,
    childArgs: ['--detached-child', '--dir', dir, '--command', testCommand],
    argsKey: `dir=${dir};command=${testCommand}`,
    cwd,
  });
  printAndExit(st, st.ok ? 0 : 1);
} else if (cmd === 'status') {
  const st = jobStatus({ name: JOB, runDir: runDirOrDie(), waitMs: waitMsFrom(args) });
  printAndExit(st, st.ok ? 0 : 1);
} else if (cmd === '--detached-child') {
  // Job body: same sweep as the synchronous mode; the result lands in the
  // job's result file and any throw becomes a written failure — a crash
  // must read as a crash, never as running-forever.
  const runDir = runDirOrDie();
  try {
    const out = sweep((impl, n, total) => writeProgress(runDir, JOB, { current: impl, impl: n, totalImpls: total }));
    writeResult(runDir, JOB, out);
    process.exit(out.ok ? 0 : 1);
  } catch (e) {
    try {
      writeResult(runDir, JOB, { ok: false, error: String((e && e.message) || e) });
    } catch (e2) {
      /* nothing left to report to */
    }
    process.exit(1);
  }
} else {
  printAndExit({ ok: false, error: `unknown command: ${cmd || '(none)'} — expected sweep, start, or status` }, 1);
}
