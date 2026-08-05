#!/usr/bin/env node
// olympus-branch: deterministic branch plumbing for the dev loop.
//
//   olympus-branch create --name <branch> --from <sha>
//   olympus-branch delete --name <branch>
//   olympus-branch sweep --prefix <p> [--keep <branch>] [--remote] --list
//   olympus-branch sweep --named <branch,origin/branch,...> [--keep <branch>]
//   olympus-branch current
'use strict';
const { git, printAndExit } = require('./olympus-exec-lib');

const cwd = process.cwd();
const [, , cmd, ...args] = process.argv;
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (cmd === 'create') {
  const name = argOf('--name');
  const from = argOf('--from');
  if (!name || !from) printAndExit({ ok: false, error: 'usage: create --name <branch> --from <sha>' }, 1);
  const r = git(`checkout -B "${name}" ${from}`, cwd);
  if (!r.ok) printAndExit({ ok: false, error: r.tail }, 1);
  printAndExit({ ok: true, branch: name, from });
} else if (cmd === 'delete') {
  const name = argOf('--name');
  if (!name) printAndExit({ ok: false, error: 'usage: delete --name <branch>' }, 1);
  const head = git('rev-parse --abbrev-ref HEAD', cwd);
  if (head.tail.trim() === name) {
    printAndExit({ ok: false, error: `refusing to delete the checked-out branch ${name}` }, 1);
  }
  // Every deletion leaves a discarded ref at the tip, so recovery is
  // deterministic (git branch <name> refs/olympus/discarded/<name>) and
  // never depends on reflog retention. See docs/adr/0005.
  const tip = git(`rev-parse "refs/heads/${name}"`, cwd);
  if (!tip.ok) printAndExit({ ok: false, error: `branch not found: ${name}` }, 1);
  const tag = git(`update-ref "refs/olympus/discarded/${name}" ${tip.tail.trim()}`, cwd);
  if (!tag.ok) printAndExit({ ok: false, error: `could not write discarded ref: ${tag.tail}` }, 1);
  const r = git(`branch -D "${name}"`, cwd);
  if (!r.ok) printAndExit({ ok: false, error: r.tail }, 1);
  printAndExit({ ok: true, deleted: name, discardedRef: `refs/olympus/discarded/${name}` });
} else if (cmd === 'sweep') {
  // Sweep is two-phase so the destructive invocation always names its
  // targets: --list resolves --prefix to concrete branch names and deletes
  // nothing; --named deletes exactly the named branches (origin/-prefixed
  // entries on the remote). A prefix without --list is refused — pattern
  // deletion hides the victims from the invocation record. Local tips are
  // preserved as discarded refs first (same recovery contract as delete,
  // docs/adr/0005). Failures accumulate as residual entries; the sweep
  // itself never dies on one branch, so the caller always learns what
  // survived and why.
  const prefix = argOf('--prefix');
  const named = argOf('--named');
  const keep = argOf('--keep');
  const remote = args.includes('--remote');
  const head = git('rev-parse --abbrev-ref HEAD', cwd).tail.trim();
  if (args.includes('--list')) {
    if (!prefix) printAndExit({ ok: false, error: 'usage: sweep --prefix <p> [--keep <branch>] [--remote] --list' }, 1);
    const planned = [];
    const residual = [];
    const locals = git(`for-each-ref --format=%(refname:short) "refs/heads/${prefix}*"`, cwd);
    for (const name of locals.ok ? locals.tail.trim().split(/\r?\n/).filter(Boolean) : []) {
      if (name === keep) continue;
      if (name === head) {
        residual.push(`local ${name} is checked out`);
        continue;
      }
      planned.push(name);
    }
    if (remote) {
      const ls = git(`ls-remote --heads origin "${prefix}*"`, cwd);
      if (!ls.ok) residual.push(`could not list remote branches: ${ls.tail.trim()}`);
      for (const line of ls.ok ? ls.tail.trim().split(/\r?\n/).filter(Boolean) : []) {
        const name = line.split(/\s+/)[1].replace('refs/heads/', '');
        if (name === keep) continue;
        planned.push(`origin/${name}`);
      }
    }
    printAndExit({ ok: true, planned, ...(residual.length ? { residual } : {}) });
  }
  if (!named || prefix) {
    printAndExit(
      {
        ok: false,
        error:
          'destructive sweep takes explicit names: first `sweep --prefix <p> [--keep <branch>] [--remote] --list`, then `sweep --named <branch,origin/branch,...> [--keep <branch>]`',
      },
      1
    );
  }
  const deleted = [];
  const residual = [];
  for (const entry of named.split(',').map((s) => s.trim()).filter(Boolean)) {
    const isRemote = entry.startsWith('origin/');
    const name = isRemote ? entry.slice('origin/'.length) : entry;
    if (name === keep) {
      residual.push(`${entry} is the kept branch`);
      continue;
    }
    if (isRemote) {
      const r = git(`push origin --delete "${name}"`, cwd);
      if (r.ok) deleted.push(`origin/${name}`);
      else residual.push(`origin/${name}: ${r.tail.trim()}`);
    } else {
      if (name === head) {
        residual.push(`local ${name} is checked out`);
        continue;
      }
      const tip = git(`rev-parse "refs/heads/${name}"`, cwd);
      if (tip.ok) git(`update-ref "refs/olympus/discarded/${name}" ${tip.tail.trim()}`, cwd);
      const r = git(`branch -D "${name}"`, cwd);
      if (r.ok) deleted.push(name);
      else residual.push(`local ${name}: ${r.tail.trim()}`);
    }
  }
  printAndExit({ ok: true, deleted, ...(residual.length ? { residual } : {}) });
} else if (cmd === 'checkout') {
  const name = argOf('--name');
  if (!name) printAndExit({ ok: false, error: 'usage: checkout --name <branch>' }, 1);
  const r = git(`checkout "${name}"`, cwd);
  if (!r.ok) printAndExit({ ok: false, error: r.tail }, 1);
  printAndExit({ ok: true, branch: name });
} else if (cmd === 'current') {
  const head = git('rev-parse --abbrev-ref HEAD', cwd);
  printAndExit({ ok: head.ok, branch: head.tail.trim() });
} else if (cmd === 'difffiles') {
  // Changed files vs a base SHA — feeds conditional gates (UI paths etc.).
  const from = argOf('--from');
  if (!from) printAndExit({ ok: false, error: 'usage: difffiles --from <sha>' }, 1);
  const r = git(`diff --name-only ${from} HEAD`, cwd);
  if (!r.ok) printAndExit({ ok: false, error: r.tail }, 1);
  printAndExit({ ok: true, files: r.tail.trim() ? r.tail.trim().split(/\r?\n/) : [] });
} else {
  printAndExit({ ok: false, error: `unknown command: ${cmd || '(none)'} — expected create|checkout|delete|sweep|current` }, 1);
}
