#!/usr/bin/env node
// olympus-freeze: commit the authored acceptance suite and record the
// frozen coordinates in the manifest. From this SHA on, the dev loop's
// verdict diff-checks every listed path.
//
//   olympus-freeze --paths <comma-separated test paths and matrix path>
'use strict';
const { git, loadManifest, saveManifest, printAndExit } = require('./olympus-exec-lib');

const path = require('path');
const cwd = process.cwd();
const args = process.argv.slice(2);
const i = args.indexOf('--paths');
// Record repo-relative, forward-slash paths regardless of what the author
// agent returned — the verdict diff and the deny hook consume these.
const paths =
  i >= 0 && args[i + 1]
    ? args[i + 1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => (path.isAbsolute(p) ? path.relative(cwd, p) : p).replace(/\\/g, '/'))
    : [];
if (!paths.length) printAndExit({ ok: false, error: 'usage: olympus-freeze --paths <p1,p2,...>' }, 1);

let manifest, manifestPath;
try {
  ({ manifest, manifestPath } = loadManifest(cwd));
} catch (e) {
  printAndExit({ ok: false, error: `no active run state: ${e.message}` }, 1);
}

const quoted = paths.map((p) => `"${p}"`).join(' ');
const add = git(`add ${quoted}`, cwd);
if (!add.ok) printAndExit({ ok: false, error: `git add failed: ${add.tail}` }, 1);

// Commit only when the suite paths actually staged something (re-runs are no-ops).
const staged = git('diff --cached --name-only', cwd);
if (staged.tail.trim() !== '') {
  const commit = git(
    `commit -m "test: freeze acceptance suite for ${manifest.unitId} [olympus]"`,
    cwd
  );
  if (!commit.ok) printAndExit({ ok: false, error: `git commit failed: ${commit.tail}` }, 1);
}

const head = git('rev-parse HEAD', cwd);
if (!head.ok) printAndExit({ ok: false, error: `rev-parse failed: ${head.tail}` }, 1);
const sha = head.tail.trim();

manifest.frozenTests = { sha, paths, frozenAt: new Date().toISOString() };
saveManifest(manifest, manifestPath);
printAndExit({ ok: true, frozenTests: manifest.frozenTests });
