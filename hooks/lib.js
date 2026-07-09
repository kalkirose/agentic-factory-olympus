// Shared helpers for Olympus hooks. Zero dependencies; Node >= 18.
// Hooks receive a JSON payload on stdin and resolve run state from
// .olympus/state/ in the project the agent works in (payload.cwd).
'use strict';
const fs = require('fs');
const path = require('path');

function readStdin(cb) {
  let data = '';
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(data || '{}');
    } catch (e) {
      // Malformed payload: hooks are defense in depth, never the authority.
      // Fail open rather than blocking the agent on a parse error.
    }
    cb(payload);
  });
}

// Resolve the active run manifest for the project the agent is working in.
// Returns null when no run is active or state is unreadable (fail open;
// the workflow script's own verdict is the authority).
function loadManifest(cwd) {
  try {
    const activePath = path.join(cwd, '.olympus', 'state', 'active-run.json');
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    const manifestPath = path.isAbsolute(active.manifest)
      ? active.manifest
      : path.join(cwd, active.manifest);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.__path = manifestPath;
    return manifest;
  } catch (e) {
    return null;
  }
}

function normalize(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

// True when target (absolute or cwd-relative) is one of the frozen paths
// or sits under a frozen directory. Frozen entries may themselves be
// absolute (older manifests) — relativize both sides before comparing.
function isFrozenPath(target, frozenPaths, cwd) {
  if (!target || !Array.isArray(frozenPaths)) return false;
  const toRel = (p) =>
    normalize(path.isAbsolute(p) ? path.relative(cwd, p) : p);
  const rel = toRel(target);
  return frozenPaths.some((f) => {
    const fn = toRel(f);
    return rel === fn || rel.startsWith(fn + '/');
  });
}

// Best-effort audit line so hook firing is observable (and debuggable).
function trace(cwd, entry) {
  try {
    const p = path.join(cwd, '.olympus', 'state', 'hook-trace.log');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    // Tracing must never break the hook.
  }
}

module.exports = { readStdin, loadManifest, isFrozenPath, trace };
