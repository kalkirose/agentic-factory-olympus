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
  const r = git(`branch -D "${name}"`, cwd);
  if (!r.ok) printAndExit({ ok: false, error: r.tail }, 1);
  printAndExit({ ok: true, deleted: name });
} else if (cmd === 'checkout') {
  const name = argOf('--name');
  if (!name) printAndExit({ ok: false, error: 'usage: checkout --name <branch>' }, 1);
  const r = git(`checkout "${name}"`, cwd);
  if (!r.ok) printAndExit({ ok: false, error: r.tail }, 1);
  printAndExit({ ok: true, branch: name });
} else if (cmd === 'current') {
  const head = git('rev-parse --abbrev-ref HEAD', cwd);
  printAndExit({ ok: head.ok, branch: head.tail.trim() });
} else {
  printAndExit({ ok: false, error: `unknown command: ${cmd || '(none)'} — expected create|checkout|delete|current` }, 1);
}
