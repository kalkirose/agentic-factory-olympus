#!/usr/bin/env node
// Repo pre-commit gate (enable once per clone: git config core.hooksPath .githooks)
//
// 1. Any commit touching plugin content (bin/, workflows/, agents/, hooks/,
//    skills/) must bump .claude-plugin/plugin.json's version and add a
//    CHANGELOG.md entry for that version in the same commit.
// 2. Staged added lines must be free of change-narration residue — files are
//    timeless; history lives in CHANGELOG.md, docs/adr/, and git
//    (docs/adr/0004). Override for a deliberate exception:
//    OLYMPUS_ALLOW_RESIDUE=1 git commit ...
'use strict';
const { execSync } = require('child_process');

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 }).toString();
  } catch (e) {
    return null;
  }
}

const staged = (sh('git diff --cached --name-only') || '').trim().split(/\r?\n/).filter(Boolean);
if (!staged.length) process.exit(0);

const failures = [];

// ---- 1. version + changelog discipline -----------------------------------
const PLUGIN_DIRS = ['bin/', 'workflows/', 'agents/', 'hooks/', 'skills/'];
const pluginTouched = staged.some((f) => PLUGIN_DIRS.some((d) => f.startsWith(d)));
if (pluginTouched) {
  const stagedPlugin = sh('git show :.claude-plugin/plugin.json');
  const headPlugin = sh('git show HEAD:.claude-plugin/plugin.json');
  const versionOf = (s) => {
    try {
      return JSON.parse(s).version;
    } catch (e) {
      return null;
    }
  };
  const newVersion = stagedPlugin ? versionOf(stagedPlugin) : null;
  const oldVersion = headPlugin ? versionOf(headPlugin) : null;
  if (!newVersion || newVersion === oldVersion) {
    failures.push(
      `plugin content changed (${staged.filter((f) => PLUGIN_DIRS.some((d) => f.startsWith(d))).join(', ')}) but .claude-plugin/plugin.json version is ${newVersion || 'unreadable'} (HEAD: ${oldVersion || 'none'}) — bump the version in this commit`
    );
  } else {
    const stagedChangelog = sh('git show :CHANGELOG.md');
    if (!stagedChangelog || !stagedChangelog.includes(`## ${newVersion}`)) {
      failures.push(`version bumped to ${newVersion} but CHANGELOG.md has no "## ${newVersion}" entry staged in this commit`);
    }
  }
}

// ---- 2. residue denylist --------------------------------------------------
if (process.env.OLYMPUS_ALLOW_RESIDUE !== '1') {
  const RESIDUE = [
    /\bpreviously\b/i,
    /\bno longer\b/i,
    /\bUPDATED\b/,
    /\bNEW:/,
    /\bchanged from\b/i,
    /\breplaces the old\b/i,
    /\bas discussed\b/i,
    /\bper the user\b/i,
    /\blearned the hard way\b/i,
    /\bformerly\b/i,
    /\brenamed from\b/i,
  ];
  const diff = sh("git diff --cached -U0 -- . ':(exclude)docs/adr' ':(exclude)CHANGELOG.md' ':(exclude).out-of-scope' ':(exclude).githooks'") || '';
  let file = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    const hit = RESIDUE.find((re) => re.test(added));
    if (hit) failures.push(`residue in ${file}: "${added.trim().slice(0, 100)}" (matched ${hit}) — files are timeless (docs/adr/0004); OLYMPUS_ALLOW_RESIDUE=1 to override deliberately`);
  }
}

if (failures.length) {
  process.stderr.write('pre-commit blocked:\n' + failures.map((f) => `  - ${f}`).join('\n') + '\n');
  process.exit(1);
}
process.exit(0);
