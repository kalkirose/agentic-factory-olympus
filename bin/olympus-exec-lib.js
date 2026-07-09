// Shared helpers for the Olympus bin scripts: command execution with
// captured tails, git plumbing, manifest access. Zero dependencies.
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TAIL_LINES = 60;

function tail(text, lines = TAIL_LINES) {
  if (!text) return '';
  const arr = text.split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - lines)).join('\n');
}

// Run a shell command; never throws. Returns { ok, exitCode, tail }.
function run(cmd, cwd, timeoutMs = 3600000) {
  try {
    const out = execSync(cmd, {
      cwd,
      stdio: 'pipe',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      shell: true,
    });
    return { ok: true, exitCode: 0, tail: tail(out.toString()) };
  } catch (e) {
    const out = [e.stdout && e.stdout.toString(), e.stderr && e.stderr.toString()]
      .filter(Boolean)
      .join('\n');
    return {
      ok: false,
      exitCode: typeof e.status === 'number' ? e.status : -1,
      tail: tail(out) || String(e.message),
    };
  }
}

function git(argsStr, cwd) {
  return run(`git ${argsStr}`, cwd);
}

function loadManifest(cwd) {
  const activePath = path.join(cwd, '.olympus', 'state', 'active-run.json');
  const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
  const manifestPath = path.isAbsolute(active.manifest)
    ? active.manifest
    : path.join(cwd, active.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { manifest, manifestPath };
}

function saveManifest(manifest, manifestPath) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function printAndExit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(code);
}

module.exports = { run, git, tail, loadManifest, saveManifest, printAndExit };
