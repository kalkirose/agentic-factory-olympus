# Long bin runs are detached jobs with a start/poll contract

Suite-running bin scripts (red-state, verdict, adversary sweep) execute
every configured layer sequentially in one process and print JSON only at
exit. The relay agent's command runtime caps a single foreground command at
~600 s, while a project's full suite can take hours. A live run (2026-08)
hit this twice in the same shape: the relay backgrounded the run, gave up
at the cap, the workflow's fresh retry started a SECOND concurrent suite
run, both orphans contended for the worktree for hours, and both died at
session teardown with empty output — escalated as "still running … no
output", which is a relay-protocol violation, not an outcome.

Decided (2026-08-05): every bin whose wall time can plausibly exceed one
relay window runs its work as a **detached job** (shared plumbing in
`bin/olympus-job-lib.js`):

- `start` spawns the run as a detached child (survives the invoker and the
  session), writes a handle (pid, startedAt, argsKey) plus per-layer
  progress and a final result file under `<runDir>/jobs/` (self-ignored
  via a generated `.gitignore`), and answers within seconds.
- `start` is idempotent: a live job with the same argsKey answers with its
  handle — never a twin (the retry-spawned twin is exactly the observed
  failure). A live job with a different argsKey refuses (two suite runs
  would contend for one worktree). A finished or dead job is cleared and
  respawned; a dead pid without a result reports `staleCleared`.
- `status [--wait <seconds>]` answers running (with progress), a crash
  report (pid dead, no result, log tail attached), or the final JSON once
  the result file lands. The wait blocks inside the bin — poll spacing
  lives there because workflow scripts have no clock and the relay agent
  never sleeps. Reading a result never consumes it; only the next `start`
  clears the files.
- Workflows call `start`, then poll `status --wait <window>` a bounded
  number of times (window below the relay's command cap, budget sized to
  hours of wall time). Escalation is reserved for genuine failure —
  unstartable job, crashed job, exhausted poll budget — never for "still
  running".

Applied to `olympus-redstate`, `olympus-verdict`, and `olympus-adversary`
(the sweep runs the test command once per wrong implementation). The
remaining bins (state, branch, freeze) are quick git/fs operations and
keep their synchronous single-shot shape, as do the three bins' own
synchronous modes for quick suites.

## Considered options

- **Raise the relay timeout**: rejected — the cap belongs to the relay
  agent's runtime, not to this repo, and any fixed cap loses to a
  sufficiently long suite.
- **Let the relay agent background the run and babysit it**: rejected —
  that converts a tooling-only seat into a judge of process liveness, and
  a dead relay agent still orphans the run. The observed incident is this
  option happening by accident.
- **Sleep between polls in the workflow script**: impossible — the
  workflow runtime exposes no clock and no timer; blocking inside the
  polled bin is the only deterministic spacing available.

## Fallback path

If detached children prove unreliable on some platform (spawn semantics,
pid-liveness false positives), the contract degrades gracefully: the
synchronous modes remain, and a per-project config flag could route quick
suites through them. Pid reuse misreading a dead job as alive is bounded
by the poll budget, which turns it into an escalation rather than a hang.
