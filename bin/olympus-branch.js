#!/usr/bin/env node
// olympus-branch: deterministic branch plumbing for the dev loop.
//
//   olympus-branch create --name <branch> --from <sha>
//   olympus-branch delete --name <branch>
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
  printAndExit({ ok: false, error: `unknown command: ${cmd || '(none)'} — expected create|checkout|delete|current` }, 1);
}
