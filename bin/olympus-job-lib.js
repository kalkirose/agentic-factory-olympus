// Detached-job plumbing for the long-running bin scripts (red-state,
// verdict, adversary sweep). A full suite's wall time exceeds any single
// relay window, so the bin spawns the real work as a detached child that
// survives its invoker, and answers `start` and `status` within seconds.
// Poll spacing lives HERE (`status --wait` blocks inside the bin process):
// workflow scripts have no clock, and the relay agent never sleeps.
//
// Job files live under <runDir>/jobs/, self-ignored via a generated
// .gitignore (transient diagnostics; the audit record stays beside the
// manifest):
//   <name>.json           handle: pid, startedAt, argsKey
//   <name>-progress.json  written by the child before each unit of work
//   <name>-result.json    the final JSON, written atomically at child exit
//   <name>.log            the child's raw stdout/stderr
//
// Zero dependencies.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATUS_POLL_MS = 2000;
const CRASH_GRACE_MS = 3000;
const LOG_TAIL_LINES = 60;

// Synchronous sleep without busy-waiting: these bins are single-purpose
// processes, so blocking the thread is the point.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function jobPaths(runDir, name) {
  const dir = path.join(runDir, 'jobs');
  return {
    dir,
    handle: path.join(dir, `${name}.json`),
    progress: path.join(dir, `${name}-progress.json`),
    result: path.join(dir, `${name}-result.json`),
    log: path.join(dir, `${name}.log`),
  };
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Atomic write: a reader never sees a half-written file. rename() replaces
// an existing destination on every platform node supports.
function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// Liveness by signal 0. EPERM means the pid exists under another owner —
// alive. Pid reuse can in principle report a dead job as alive; the bounded
// poll budget in the workflows turns that into an escalation, never a hang.
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function logTail(p, lines = LOG_TAIL_LINES) {
  try {
    const arr = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    return arr.slice(Math.max(0, arr.length - lines)).join('\n');
  } catch (e) {
    return '';
  }
}

function clearJob(p) {
  for (const f of [p.handle, p.progress, p.result, p.log]) {
    try {
      fs.rmSync(f, { force: true });
    } catch (e) {
      /* a locked log never blocks a fresh start */
    }
  }
}

// Start, idempotent: a live job with the same argsKey returns its handle —
// never a twin (a relay retry of `start` must attach, not respawn). A
// finished or dead job is cleared and a fresh one spawned; a live job with
// a DIFFERENT argsKey refuses, because two suite runs would contend for the
// same worktree.
function startJob({ name, runDir, scriptPath, childArgs, argsKey, cwd }) {
  const p = jobPaths(runDir, name);
  fs.mkdirSync(p.dir, { recursive: true });
  const gi = path.join(p.dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  const handle = readJsonSafe(p.handle);
  let staleCleared = false;
  if (handle) {
    const finished = fs.existsSync(p.result);
    if (!finished && pidAlive(handle.pid)) {
      if (String(handle.argsKey || '') !== String(argsKey || '')) {
        return {
          ok: false,
          started: false,
          running: true,
          argsMismatch: true,
          job: name,
          handle,
          error: `a live ${name} job with different args holds the slot (pid ${handle.pid}, args "${handle.argsKey}") — poll it to completion or kill the pid, then start again`,
        };
      }
      return { ok: true, started: false, running: true, alreadyRunning: true, job: name, pid: handle.pid, startedAt: handle.startedAt };
    }
    staleCleared = !finished; // dead pid without a result: crashed or killed
    clearJob(p);
  }
  const fd = fs.openSync(p.log, 'a');
  const child = spawn(process.execPath, [scriptPath].concat(childArgs), {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  child.unref();
  const rec = {
    job: name,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    argsKey: String(argsKey || ''),
    log: path.relative(cwd, p.log),
    result: path.relative(cwd, p.result),
  };
  writeJsonAtomic(p.handle, rec);
  return {
    ok: true,
    started: true,
    running: true,
    job: name,
    pid: child.pid,
    startedAt: rec.startedAt,
    handlePath: path.relative(cwd, p.handle),
    ...(staleCleared ? { staleCleared: true } : {}),
  };
}

// Status: one check by default; with waitMs it blocks inside this process
// up to the deadline, answering early the moment the result lands. Answers
// are one of: the final JSON (running:false, merged at top level), a
// running report with progress, or a crash report (dead pid, no result).
// Reading the result never consumes it — a relay retry of `status` sees
// the same answer; only the next `start` clears the files.
function jobStatus({ name, runDir, waitMs }) {
  const p = jobPaths(runDir, name);
  const handle = readJsonSafe(p.handle);
  if (!handle) {
    return { ok: false, running: false, job: name, error: `no ${name} job under ${path.relative(process.cwd(), p.dir) || p.dir} — nothing started, or a later start cleared it` };
  }
  const deadline = Date.now() + Math.max(0, waitMs || 0);
  for (;;) {
    const result = readJsonSafe(p.result);
    if (result) {
      return { ok: result.ok !== false, running: false, job: name, startedAt: handle.startedAt, ...result };
    }
    if (!pidAlive(handle.pid)) {
      sleepMs(CRASH_GRACE_MS); // the result write may be mid-rename
      const late = readJsonSafe(p.result);
      if (late) return { ok: late.ok !== false, running: false, job: name, startedAt: handle.startedAt, ...late };
      return {
        ok: false,
        running: false,
        crashed: true,
        job: name,
        pid: handle.pid,
        startedAt: handle.startedAt,
        error: `${name} job (pid ${handle.pid}) died without writing results — killed or crashed; the next start clears it and runs fresh`,
        logTail: logTail(p.log),
      };
    }
    if (Date.now() >= deadline) {
      return {
        ok: true,
        running: true,
        job: name,
        pid: handle.pid,
        startedAt: handle.startedAt,
        progress: readJsonSafe(p.progress),
      };
    }
    sleepMs(STATUS_POLL_MS);
  }
}

// Child-side helpers: progress is best-effort, the result is load-bearing.
function writeProgress(runDir, name, obj) {
  try {
    writeJsonAtomic(jobPaths(runDir, name).progress, { ...obj, at: new Date().toISOString() });
  } catch (e) {
    /* progress loss never kills the job */
  }
}

function writeResult(runDir, name, obj) {
  writeJsonAtomic(jobPaths(runDir, name).result, { ...obj, finishedAt: new Date().toISOString() });
}

// Shared CLI fragment: `--wait <seconds>` for status modes.
function waitMsFrom(argv) {
  const i = argv.indexOf('--wait');
  const s = i >= 0 ? Number(argv[i + 1]) : 0;
  return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
}

module.exports = { startJob, jobStatus, writeProgress, writeResult, waitMsFrom };
