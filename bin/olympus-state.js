#!/usr/bin/env node
// olympus-state: deterministic run-state management. The only writer of
// .olympus/state/ besides the other Olympus bin scripts. Invoked by Talos
// (executor) on behalf of the Fates; prints JSON to stdout.
//
//   olympus-state init <unitId>      create manifest from .olympus/config.json,
//                                    point active-run.json at it (idempotent:
//                                    re-init of the same unit keeps the manifest)
//   olympus-state get                print the active manifest
//   olympus-state merge <json>       shallow-merge a JSON fragment into the
//                                    manifest (object values merge one level deep)
//   olympus-state step <name> <status> [<json>]   record a step outcome
'use strict';
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const stateDir = path.join(cwd, '.olympus', 'state');
const activePath = path.join(stateDir, 'active-run.json');

function die(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function loadActiveManifest() {
  if (!fs.existsSync(activePath)) die('no active run (.olympus/state/active-run.json missing)');
  const active = readJson(activePath);
  const manifestPath = path.isAbsolute(active.manifest)
    ? active.manifest
    : path.join(cwd, active.manifest);
  if (!fs.existsSync(manifestPath)) die(`active-run points at missing manifest: ${active.manifest}`);
  return { manifest: readJson(manifestPath), manifestPath };
}

function saveAndPrint(manifest, manifestPath) {
  writeJson(manifestPath, manifest);
  process.stdout.write(JSON.stringify({ ok: true, manifest }));
}

const [, , cmd, ...args] = process.argv;

if (cmd === 'init') {
  const unitId = args[0];
  if (!unitId) die('usage: olympus-state init <unitId>');
  const configPath = path.join(cwd, '.olympus', 'config.json');
  if (!fs.existsSync(configPath)) die('.olympus/config.json not found in this project');
  const config = readJson(configPath);
  const safeId = unitId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const relManifest = path.join('.olympus', 'state', 'runs', safeId, 'manifest.json');
  const manifestPath = path.join(cwd, relManifest);

  let manifest;
  if (fs.existsSync(manifestPath)) {
    manifest = readJson(manifestPath); // re-entrancy: resume, never overwrite
  } else {
    manifest = {
      schemaVersion: 1,
      unitId,
      createdAt: new Date().toISOString(),
      phase: 'clotho',
      steps: {},
      spec: { path: null, findingsPath: null },
      commands: config.commands || {},
      budget: config.budget || {},
      hooks: config.hooks || {},
      conventions: config.conventions || {},
      docPaths: config.docPaths || {},
      infraFlakeSignatures: config.infraFlakeSignatures || [],
      learningsPath: path
        .join('.olympus', 'state', 'runs', safeId, 'learnings.md')
        .replace(/\\/g, '/'),
      frozenTests: null,
      passes: [],
      judge: null,
      pr: null,
    };
    writeJson(manifestPath, manifest);
  }
  writeJson(activePath, { unitId, manifest: relManifest.replace(/\\/g, '/') });
  process.stdout.write(JSON.stringify({ ok: true, resumed: manifest.steps && Object.keys(manifest.steps).length > 0, manifest }));
} else if (cmd === 'get') {
  const { manifest } = loadActiveManifest();
  process.stdout.write(JSON.stringify({ ok: true, manifest }));
} else if (cmd === 'merge') {
  if (!args[0]) die('usage: olympus-state merge <json>');
  let fragment;
  try {
    fragment = JSON.parse(args[0]);
  } catch (e) {
    die(`merge fragment is not valid JSON: ${e.message}`);
  }
  const { manifest, manifestPath } = loadActiveManifest();
  for (const [k, v] of Object.entries(fragment)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && manifest[k] && typeof manifest[k] === 'object' && !Array.isArray(manifest[k])) {
      Object.assign(manifest[k], v);
    } else {
      manifest[k] = v;
    }
  }
  saveAndPrint(manifest, manifestPath);
} else if (cmd === 'step') {
  const [name, status, extra] = args;
  if (!name || !status) die('usage: olympus-state step <name> <status> [<json>]');
  const { manifest, manifestPath } = loadActiveManifest();
  let detail = {};
  if (extra) {
    try {
      detail = JSON.parse(extra);
    } catch (e) {
      die(`step detail is not valid JSON: ${e.message}`);
    }
  }
  const at = new Date().toISOString();
  const rec = { status, at, ...detail };
  // A "started" -> terminal transition preserves the start and yields a
  // duration, so run timing is auditable per step.
  const existing = manifest.steps[name];
  if (existing && status !== 'started') {
    const startedAt = existing.status === 'started' ? existing.at : existing.startedAt;
    if (startedAt) {
      rec.startedAt = startedAt;
      const d = Date.parse(at) - Date.parse(startedAt);
      if (!Number.isNaN(d) && d >= 0) rec.durationMs = d;
    }
  }
  manifest.steps[name] = rec;
  saveAndPrint(manifest, manifestPath);
} else if (cmd === 'commit') {
  // Commit accumulated .olympus/ state at a seam moment (freeze, pre-PR).
  const { execSync } = require('child_process');
  const msg = args[0] || 'chore(olympus): run state';
  try {
    execSync('git add .olympus', { cwd, stdio: 'pipe' });
    const staged = execSync('git diff --cached --name-only', { cwd, stdio: 'pipe' }).toString().trim();
    if (staged === '') {
      process.stdout.write(JSON.stringify({ ok: true, committed: false, note: 'no state changes to commit' }));
    } else {
      execSync(`git commit -m "${msg.replace(/"/g, "'")}"`, { cwd, stdio: 'pipe' });
      process.stdout.write(JSON.stringify({ ok: true, committed: true, files: staged.split(/\r?\n/) }));
    }
  } catch (e) {
    die(`state commit failed: ${e.message}`);
  }
} else {
  die(`unknown command: ${cmd || '(none)'} — expected init|get|merge|step|commit`);
}
