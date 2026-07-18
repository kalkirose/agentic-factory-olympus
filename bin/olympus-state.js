#!/usr/bin/env node
// olympus-state: deterministic run-state management. The only writer of
// .olympus/state/ besides the other Olympus bin scripts. Invoked by Talos
// (executor) on behalf of the Fates; prints JSON to stdout.
//
//   olympus-state init <unitId>      create manifest from .olympus/config.json,
//                                    point active-run.json at it (idempotent:
//                                    re-init of the same unit keeps the manifest)
//   olympus-state get                print the active manifest + its key list
//   olympus-state merge <json>       shallow-merge a JSON fragment into the
//                                    manifest (object values merge one level deep)
//   olympus-state step <name> <status> [<json>]   record a step outcome
//   olympus-state sidecar set <name> <json>       write a diagnostics sidecar
//   olympus-state sidecar get <name>              print a diagnostics sidecar
//   olympus-state learn <text> --status <s>       append a status-tagged
//                                    learnings entry (hypothesis|refuted|confirmed|fact)
//   olympus-state version            print the installed plugin version
//   olympus-state resync             refresh config-derived manifest fields;
//                                    reports steps stuck at "started" (staleStarted)
//   olympus-state commit [<msg>]     commit accumulated .olympus/ state
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

function saveAndPrint(manifest, manifestPath, extra) {
  writeJson(manifestPath, manifest);
  process.stdout.write(JSON.stringify({ ok: true, manifest, ...(extra || {}) }));
}

// The manifest reaches workflow scripts through an LLM relay; the key list
// lets the reader verify no top-level field was dropped in transit.
function keysOf(manifest) {
  return Object.keys(manifest);
}

function sidecarPath(manifestPath, name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '-');
  return path.join(path.dirname(manifestPath), 'sidecar', `${safe}.json`);
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
      uiPathPatterns: config.uiPathPatterns || [],
      testRalph: config.testRalph || null,
      models: config.models || null,
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
  process.stdout.write(
    JSON.stringify({ ok: true, resumed: manifest.steps && Object.keys(manifest.steps).length > 0, manifest, keys: keysOf(manifest) })
  );
} else if (cmd === 'get') {
  const { manifest } = loadActiveManifest();
  process.stdout.write(JSON.stringify({ ok: true, manifest, keys: keysOf(manifest) }));
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
} else if (cmd === 'sidecar') {
  // Diagnostics live beside the manifest, never inside it: the manifest is
  // hot-path-only because it travels through an LLM relay (see docs/adr/0001).
  const [sub, name, json] = args;
  const { manifestPath } = loadActiveManifest();
  if (sub === 'set') {
    if (!name || !json) die('usage: olympus-state sidecar set <name> <json>');
    let value;
    try {
      value = JSON.parse(json);
    } catch (e) {
      die(`sidecar value is not valid JSON: ${e.message}`);
    }
    const p = sidecarPath(manifestPath, name);
    writeJson(p, value);
    process.stdout.write(JSON.stringify({ ok: true, sidecar: name, bytes: fs.statSync(p).size }));
  } else if (sub === 'get') {
    if (!name) die('usage: olympus-state sidecar get <name>');
    const p = sidecarPath(manifestPath, name);
    if (!fs.existsSync(p)) die(`sidecar not found: ${name}`);
    process.stdout.write(JSON.stringify({ ok: true, sidecar: name, output: readJson(p) }));
  } else {
    die('usage: olympus-state sidecar set|get <name> [<json>]');
  }
} else if (cmd === 'resync') {
  // Refresh the manifest's config-derived fields from .olympus/config.json.
  // Run-state (frozenTests, passes, judge, pr, steps, learnings) is NEVER
  // touched — this exists because a config edit mid-run otherwise silently
  // diverges from the manifest snapshot taken at init.
  const configPath = path.join(cwd, '.olympus', 'config.json');
  if (!fs.existsSync(configPath)) die('.olympus/config.json not found');
  const config = readJson(configPath);
  const { manifest, manifestPath } = loadActiveManifest();
  const refreshed = [];
  for (const key of ['commands', 'budget', 'hooks', 'conventions', 'docPaths', 'infraFlakeSignatures', 'uiPathPatterns', 'testRalph', 'models']) {
    if (config[key] !== undefined && JSON.stringify(manifest[key]) !== JSON.stringify(config[key])) {
      manifest[key] = config[key];
      refreshed.push(key);
    }
  }
  writeJson(manifestPath, manifest);

  // Resync runs at workflow start, when no agent of this run is live
  // (runs are single-active). Any step still "started" is therefore
  // anomalous: either it is about to be legitimately re-run, or its work
  // finished and the terminal write was lost (a torn manifest). Report
  // them with the last telemetry event as evidence; the workflow logs
  // this so a human can verify completed work before it is redone.
  const staleStarted = [];
  const telePath = path.join(stateDir, 'telemetry.log');
  let lastTelemetry = null;
  if (fs.existsSync(telePath)) {
    const lines = fs.readFileSync(telePath, 'utf8').trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        lastTelemetry = { ts: e.ts, event: e.event, agent_type: e.agent_type };
        break;
      } catch (e) {
        // skip malformed tail lines
      }
    }
  }
  for (const [name, rec] of Object.entries(manifest.steps || {})) {
    if (rec.status === 'started') {
      staleStarted.push({ step: name, startedAt: rec.at, lastTelemetry });
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, refreshed, staleStarted }));
} else if (cmd === 'learn') {
  // Append a status-tagged entry to the run's learnings file. Statuses:
  //   hypothesis — a claim no deterministic signal has confirmed (agents
  //                may only ever record this)
  //   refuted    — the claim's fix failed the official verdict
  //   confirmed  — the claim's fix went green under the official verdict
  //   fact       — a mechanically-recorded event (CI excerpt, seat
  //                fallback), not a claim
  // Promotion to refuted/confirmed is the workflow script's act, keyed to
  // verdict outcomes — never the authoring agent's (see docs/adr/0002).
  const STATUSES = ['hypothesis', 'refuted', 'confirmed', 'fact'];
  const si = args.indexOf('--status');
  const status = si >= 0 ? args[si + 1] : null;
  const text = args.filter((a, i) => i !== si && i !== si + 1)[0];
  if (!text || !status) die(`usage: olympus-state learn "<entry text>" --status <${STATUSES.join('|')}>`);
  if (!STATUSES.includes(status)) die(`invalid status "${status}" — expected one of: ${STATUSES.join(', ')}`);
  const { manifest } = loadActiveManifest();
  const learningsPath = path.isAbsolute(manifest.learningsPath)
    ? manifest.learningsPath
    : path.join(cwd, manifest.learningsPath);
  fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
  const stamp = new Date().toISOString();
  fs.appendFileSync(learningsPath, `\n## ${stamp} [${status}] (harness-recorded)\n\n${text}\n`);
  process.stdout.write(JSON.stringify({ ok: true, appended: true, status, file: manifest.learningsPath }));
} else if (cmd === 'version') {
  // Reports the version of the installed plugin this script belongs to, so
  // workflows can refuse to run against a stale plugin cache.
  const pluginJson = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(pluginJson)) die('plugin.json not found relative to this script');
  const plugin = readJson(pluginJson);
  process.stdout.write(JSON.stringify({ ok: true, version: plugin.version, name: plugin.name }));
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
  die(`unknown command: ${cmd || '(none)'} — expected init|get|merge|step|sidecar|resync|learn|version|commit`);
}
