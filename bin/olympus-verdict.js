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
const { run, git, gitLines, loadManifest, printAndExit, runWithFlakeRetry } = require('./olympus-exec-lib');

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

// Foreign-test flake guard (suite layers only — typecheck and gate failures
// name source defects, not test outcomes). A failing layer whose every named
// failing test lies outside the unit — not a frozen-suite path, untouched by
// the pass diff — earns ONE re-run before the verdict records it: such a
// failure cannot come from this pass's work, and a real regression elsewhere
// fails the re-run identically. A green re-run counts green and is flagged
// with (file, test, signature) per test, never silent; a second failure
// stands. Extraction reads failure-marker lines only (FAIL / ✘ ✖ × ✗ /
// numbered Playwright failures), so stack frames and module-load noise never
// qualify, and a tail with no extractable test file never fires the guard.
const ANSI = /\u001b\[[0-9;]*m/g;
const norm = (p) => String(p).replace(/\\/g, '/');
const frozenNorm = (frozen.paths || []).map(norm);
function failingTestsFrom(tailText) {
  const MARKER = /(?:\bFAIL\b|[✘✖×✗]|^\s*\d+\)\s)/;
  const ERRLINE = /^\s*(?:[A-Za-z][\w$]*)?Error\b/;
  const entries = [];
  const seen = new Set();
  for (const raw of String(tailText || '').split(/\r?\n/)) {
    const line = raw.replace(ANSI, '');
    if (!MARKER.test(line)) {
      // Error lines between markers carry the assertion text; the nearest
      // unsigned entry owns it.
      if (ERRLINE.test(line)) {
        const open = entries.filter((e) => !e.signature).pop();
        if (open) open.signature = line.trim().slice(0, 200);
      }
      continue;
    }
    for (const tok of line.match(/[^\s'"|]+/g) || []) {
      const t = norm(tok).replace(/[)\]"',;:.]+$/, '').replace(/^[(\["']+/, '');
      const m = t.match(/^(.+\.[A-Za-z][A-Za-z0-9]*)(?::\d+)*$/);
      if (!m || !m[1].includes('/') || m[1].includes('node_modules')) continue;
      const file = m[1];
      const segs = line
        .slice(line.indexOf(tok) + tok.length)
        .split(/\s+[>›]\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const test = segs.length ? segs[segs.length - 1] : '';
      const key = `${file}::${test}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ file, test, signature: '' });
      }
      break; // the first path token on a marker line names the test file
    }
  }
  return entries;
}
// Runners print paths relative to their package cwd while frozen paths and
// the diff are repo-relative, so membership is suffix-tolerant.
function samePath(a, b) {
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}
let passDiff = null; // computed on the first failing layer; false = unknowable
function passDiffList() {
  if (passDiff === null) {
    const d = gitLines(`diff --name-only ${frozen.sha} HEAD`, cwd);
    passDiff = d.ok ? d.lines.map(norm) : false;
  }
  return passDiff;
}
function isForeign(file) {
  const diffList = passDiffList();
  if (diffList === false) return false; // an unknowable diff never certifies foreignness
  return !frozenNorm.some((p) => samePath(file, p)) && !diffList.some((p) => samePath(file, p));
}
function foreignFlakeGuard(command, layerName, result) {
  if (result.ok) return result;
  const failing = failingTestsFrom(result.tail);
  if (!failing.length || !failing.every((t) => isForeign(t.file))) return result;
  const second = run(command, cwd);
  flakeFlags.push({ name: 'foreign-test-flake-retry', layer: layerName, recovered: second.ok, tests: failing });
  return second.ok ? second : result; // the original failure stands — its tail names the foreign tests
}

if (pass) {
  const layers = Array.isArray(manifest.commands.fullSuite)
    ? manifest.commands.fullSuite
    : [{ name: 'suite', command: manifest.commands.fullSuite }];
  for (const layer of layers) {
    if (!layer || !layer.command) continue;
    const r = runWithFlakeRetry(layer.command, cwd, signatures);
    if (r.retried) flakeFlags.push({ name: 'infra-flake-retry', layer: layer.name, signature: r.matchedSignature, recovered: r.result.ok });
    const result = foreignFlakeGuard(layer.command, layer.name || 'suite', r.result);
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
