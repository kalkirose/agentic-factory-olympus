#!/usr/bin/env node
// olympus-verdict: the official verdict for one dev pass. Deterministic —
// no LLM anywhere in this file, and its JSON lands on disk for audit.
//
//   olympus-verdict --pass <n> [--expect-branch <name>]
//
// Checks, in order (fail-fast is deliberate; later checks assume a sane tree):
//   1. worktree clean (the pass must be fully committed)
//   2. expected branch checked out (when --expect-branch given)
//   3. test integrity: no frozen test path differs from the frozen SHA
//   4. frozen suite green: every configured layer command exits 0
//   5. typecheck green
// Informational (never fails the verdict): lockfile changed vs. frozen SHA.
'use strict';
const fs = require('fs');
const path = require('path');
const { run, git, loadManifest, printAndExit, runWithFlakeRetry } = require('./olympus-exec-lib');

const cwd = process.cwd();
const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const passN = argOf('--pass');
const expectBranch = argOf('--expect-branch');

let manifest, manifestPath;
try {
  ({ manifest, manifestPath } = loadManifest(cwd));
} catch (e) {
  printAndExit({ ok: false, error: `no active run state: ${e.message}` }, 1);
}
const frozen = manifest.frozenTests;
if (!frozen || !frozen.sha) {
  printAndExit({ ok: false, error: 'manifest has no frozenTests — Clotho has not frozen a suite' }, 1);
}

const checks = [];
let pass = true;
function check(name, result, failDetail) {
  checks.push({ name, ok: result.ok, exitCode: result.exitCode, tail: result.ok ? '' : result.tail, ...(failDetail && !result.ok ? { detail: failDetail } : {}) });
  if (!result.ok) pass = false;
  return result.ok;
}

// 1. Worktree clean — excluding .olympus/, whose run-state files legitimately
// churn mid-run (they are committed at seam moments, not per mutation).
const status = git('status --porcelain -- . ":(exclude).olympus"', cwd);
check('worktree-clean', { ok: status.ok && status.tail.trim() === '', exitCode: status.exitCode, tail: status.tail }, 'uncommitted changes in the worktree');

// 2. Expected branch.
if (pass && expectBranch) {
  const head = git('rev-parse --abbrev-ref HEAD', cwd);
  const ok = head.ok && head.tail.trim() === expectBranch;
  check('on-expected-branch', { ok, exitCode: head.exitCode, tail: head.tail.trim() }, `expected ${expectBranch}`);
}

// 3. Test integrity vs. the frozen SHA. No agent involved, nothing to corrupt.
if (pass) {
  const pathArgs = (frozen.paths || []).map((p) => `"${p}"`).join(' ');
  const diff = git(`diff --name-only ${frozen.sha} HEAD -- ${pathArgs}`, cwd);
  const changed = diff.tail.trim();
  check('test-integrity', { ok: diff.ok && changed === '', exitCode: diff.exitCode, tail: changed }, 'frozen test paths differ from the frozen SHA');
}

// 4. Frozen suite, every configured layer. Failures matching a declared
// infra-flake signature retry once; every retry is flagged, never silent.
const flakeFlags = [];
const signatures = manifest.infraFlakeSignatures || [];
if (pass) {
  const layers = Array.isArray(manifest.commands.fullSuite)
    ? manifest.commands.fullSuite
    : [{ name: 'suite', command: manifest.commands.fullSuite }];
  for (const layer of layers) {
    if (!layer || !layer.command) continue;
    const { result, retried, matchedSignature } = runWithFlakeRetry(layer.command, cwd, signatures);
    if (retried) flakeFlags.push({ name: 'infra-flake-retry', layer: layer.name, signature: matchedSignature, recovered: result.ok });
    check(`suite:${layer.name || 'suite'}`, result);
    if (!result.ok) break; // fail fast; remaining layers would waste minutes
  }
}

// 5. Typecheck.
if (pass && manifest.commands.typecheck) {
  const { result, retried, matchedSignature } = runWithFlakeRetry(manifest.commands.typecheck, cwd, signatures);
  if (retried) flakeFlags.push({ name: 'infra-flake-retry', layer: 'typecheck', signature: matchedSignature, recovered: result.ok });
  check('typecheck', result);
}

// 6. Additional deterministic Tier-1 gates from config (commands.gates:
// [{name, command}] — prohibited patterns, token conformance, duplication,
// dependency rules, mutation… whatever the project declares).
if (pass && Array.isArray(manifest.commands.gates)) {
  for (const gate of manifest.commands.gates) {
    if (!gate || !gate.command) continue;
    const { result, retried, matchedSignature } = runWithFlakeRetry(gate.command, cwd, signatures);
    if (retried) flakeFlags.push({ name: 'infra-flake-retry', layer: gate.name, signature: matchedSignature, recovered: result.ok });
    check(`gate:${gate.name || 'gate'}`, result);
    if (!result.ok) break;
  }
}

// Informational: lockfile drift (no dependency gate is configured).
const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'poetry.lock'];
const lockDiff = git(`diff --name-only ${frozen.sha} HEAD -- ${lockfiles.join(' ')}`, cwd);
const lockChanged = lockDiff.tail.trim();

const verdict = {
  ok: true,
  pass,
  passNumber: passN ? Number(passN) : null,
  checks,
  flags: flakeFlags.concat(lockChanged ? [{ name: 'lockfile-changed', files: lockChanged.split(/\r?\n/) }] : []),
  at: new Date().toISOString(),
};

// Persist beside the manifest for audit, then print for the relay.
try {
  const file = path.join(path.dirname(manifestPath), `verdict-pass-${passN || 'x'}.json`);
  fs.writeFileSync(file, JSON.stringify(verdict, null, 2) + '\n');
} catch (e) {
  verdict.persistError = String(e.message);
}
printAndExit(verdict);
