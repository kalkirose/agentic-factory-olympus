#!/usr/bin/env node
// olympus-adversary: measure a candidate suite's kill rate against
// Dolos-authored wrong implementations. Deterministic overlay/run/restore;
// no LLM anywhere in this file.
//
//   olympus-adversary sweep --dir <adversaryRoot> --command "<test command>"
//
// <adversaryRoot> contains one subdirectory per wrong implementation, each
// mirroring repo-relative paths (e.g. adversary/w1/src/cart.ts). For each:
// overlay files onto the worktree, run the command, restore the worktree.
// killed = the command exited nonzero (at least one test failed).
'use strict';
const fs = require('fs');
const path = require('path');
const { run, git, printAndExit } = require('./olympus-exec-lib');

const cwd = process.cwd();
const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const cmd = process.argv[2];
const dir = argOf('--dir');
const testCommand = argOf('--command');
if (cmd !== 'sweep' || !dir || !testCommand) {
  printAndExit({ ok: false, error: 'usage: olympus-adversary sweep --dir <adversaryRoot> --command "<test command>"' }, 1);
}

// Refuse to run on a dirty tree (outside .olympus): restoration relies on
// git to be the ground truth for every file we overlay.
const status = git('status --porcelain -- . ":(exclude).olympus"', cwd);
if (status.tail.trim() !== '') {
  printAndExit({ ok: false, error: `worktree not clean; commit or stash first:\n${status.tail}` }, 1);
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
if (!implDirs.length) printAndExit({ ok: false, error: `no implementation directories under ${dir}` }, 1);

const results = [];
for (const impl of implDirs) {
  const implRoot = path.join(path.isAbsolute(dir) ? dir : path.join(cwd, dir), impl);
  const files = listFiles(implRoot);
  const targets = files.map((f) => path.relative(implRoot, f));

  // Overlay.
  const preExisting = [];
  for (let i = 0; i < files.length; i++) {
    const dest = path.join(cwd, targets[i]);
    if (fs.existsSync(dest)) preExisting.push(targets[i]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(files[i], dest);
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
printAndExit({
  ok: after.tail.trim() === '',
  restoreClean: after.tail.trim() === '',
  killRate: `${killedCount}/${results.length}`,
  survivors: results.filter((r) => !r.killed).map((r) => r.impl),
  results,
  ...(after.tail.trim() !== '' ? { error: `worktree not clean after restore:\n${after.tail}` } : {}),
});
