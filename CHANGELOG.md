# Changelog

## 0.7.2 — 2026-08-08

- clotho: the spec gate routes REVISIONs by class — cassandra sub-classifies every REVISION `mechanical` (the repository settles the correct resolution singly and clearly; no AC meaning, scope boundary, or trade-off at stake) or `intent` (default when the class is absent); mechanical findings are applied by a Themis fix dispatch (verify-then-apply, whole-spec-home sweep for the same wrong fact, spec-home commit `distill(<unit>): apply mechanical spec fixes`) and re-validated in place without consuming the 2-round human budget; two fix dispatches per invocation, then everything escalates rather than loop; a failed or partial dispatch escalates the leftovers explicitly, never drops them (found live 2026-08-08: two repo-settled findings — wrong framework event names, a CI provisioning line — escalated verbatim to a human who had already delegated exactly this class of correction)
- CONTEXT.md defines the mechanical finding; cassandra + cassandra-opus carry the sub-classification rule and the `Class:` line in the findings template (opus variant keeps its open-the-source injunction: a fact inferred but not read stays `intent`)

## 0.7.1 — 2026-08-05

- olympus-branch: `sweep` is two-phase — `--list` resolves the prefix to concrete branch names and deletes nothing; `--named <branch,origin/branch,...>` deletes exactly the named branches (keep/checked-out guards and the discarded-ref recovery contract, docs/adr/0005, unchanged); a destructive invocation that carries a bare prefix is refused. Pattern deletion hid the victims from the invocation record — flagged live by a security review of the PR-open sweep relay (2026-08-05)
- atropos: the PR-open sweep resolves its targets via `--list`, logs them, and invokes the destructive relay with `--named`, so the Talos transcript names every branch before it is deleted; an empty plan skips the destructive relay entirely

## 0.7.0 — 2026-08-05

- detached jobs (docs/adr/0006): the suite-running bins — olympus-redstate, olympus-verdict, olympus-adversary — gain a start/poll contract over shared plumbing (`bin/olympus-job-lib.js`); a full suite's wall time exceeds the ~600 s relay command cap, and the one-shot foreground shape produced twin orphaned suite runs that died at session teardown with empty output (found live twice, same unit, 2026-08). `start` spawns the run as a detached child that survives the invoker, writes handle/progress/result/log under `<runDir>/jobs/` (self-ignored via a generated .gitignore), and answers in seconds; a second start attaches to the live job instead of spawning a twin, refuses on an argsKey mismatch, and clears+respawns finished or dead jobs (dead pid without result → `staleCleared`). `status [--wait <seconds>]` blocks inside the bin (poll spacing — workflow scripts have no clock) and answers running+progress, a crash report with log tail, or the final JSON verbatim; results are never consumed by reading. Bare/`sweep` invocations stay synchronous for quick suites; state/branch/freeze bins keep their quick single-shot shape
- clotho: red-state and the adversary kill sweep run via start/poll (bounded 60 polls × 480 s window ≈ 8 h ceiling); escalation is reserved for unstartable/crashed jobs and an exhausted poll budget, never for "still running"; MIN_STATE_VERSION 0.7.0
- lachesis: the pass verdict runs via start/poll; an unusable final relay recovers with a cheap `status --wait 0` re-read of the persisted result file, never a suite re-run; MIN_STATE_VERSION 0.7.0
- talos: `start`/`status` job modes documented — a `running: true` status answer is the script's own JSON to relay verbatim, never a reason to wait for or hunt the detached job
- CONTEXT.md detached-job vocabulary (detached job, poll window); config README documents `runs/<unit>/jobs/`

## 0.6.8 — 2026-08-02

- olympus-verdict: foreign-test flake guard — a failing suite layer whose every named failing test lies outside the unit (not a frozen-suite path, untouched by the pass diff) is re-run ONCE before the verdict records it; a green re-run counts green, flagged `foreign-test-flake-retry` with (file, test, signature) per test, and a second failure stands (found live on pass 1 of 3-4-checkout-shipping-vat: two browser-mode component tests from another unit, untouched by the pass diff and green in the dev's own run minutes earlier, burned a multi-hour fresh pass on a false fail); extraction reads failure-marker lines only, and a tail with no extractable test file never fires the guard
- lachesis: recovered foreign flakes are harvested from every verdict round into the manifest pass record (`flakes`) and the learnings ledger as harness-recorded facts
- lachesis: single-green escalation seam — with `greensTarget: 1` a verdict failure that survives the flake guard escalates at `lachesis:pass-verdict` (failing checks verbatim, Mentor's consolidated learnings summary when available, resume instruction) instead of auto-continuing into a fresh pass; re-entry with `args.passContinue: true` (normalized like the other args) authorizes exactly one continuation into the next pass; targets above 1 keep the Mentor auto-continue unchanged, and Mentor's learnings consolidation runs in both modes; MIN_STATE_VERSION 0.6.8
- hermes documents the `lachesis:pass-verdict` seam and the `passContinue` re-entry; config README documents the single-green loop shape

## 0.6.7 — 2026-08-01

- all three Fates: `getState` no longer accepts a relayed manifest that arrives without its `keys` list — that is the exact truncation signature (found live twice: the atropos "no judged winner" false escalation and a lachesis crash on `manifest.conventions` after the state relay returned 3.5KB of a 15KB manifest); keyless relays retry once, then fail as relay corruption, never as state truth

## 0.6.6 — 2026-07-31

- lachesis: `runVerdict` no longer crashes the build loop when the Talos relay answers ok:true with no `output` (the relay schema requires only `ok`; found live on pass 1 of 3-3-preview-deploys) — no usable output after one fresh retry degrades to a failed round, never a crash
- all three Fates: the Talos relay prompt now demands the script output COMPLETE and VERBATIM — never truncated, summarized, or field-dropped — closing the relay-fidelity class that produced both the atropos manifest truncation and the lachesis empty verdict

## 0.6.5 — 2026-07-31

- clotho: `args.distillDecisions` passed as an object no longer degrades to the literal `"[object Object]"` in the Themis prompt (silently discarding the human's answers — found live on the second distill re-entry, 3-3-preview-deploys); an object is serialized per DECISION id, a string passes through verbatim

## 0.6.4 — 2026-07-31

- clotho: re-entry deadlock fixed — a launch carrying `args.distillDecisions`/`args.specSignoff` no longer escalates at readiness when Iris (blind to workflow args) reports the open distill/spec escalation itself as unmet; the readiness verdict is deferred to the step that consumes the answers (found live on the first distill re-entry, 3-3-preview-deploys)

## 0.6.3 — 2026-07-31

- olympus-branch: new `sweep --prefix <p> [--keep <branch>] [--remote]` — deletes every branch under the prefix except `--keep` and the checked-out branch, local and (with `--remote`) origin; local tips preserved as discarded refs (docs/adr/0005); per-branch failures accumulate as `residual`, never kill the sweep
- olympus-state: `close` always reports unit branch/stash hygiene (branches surviving under the manifest's branch template, stash entries) alongside the tracked-state warnings; `close --sweep` additionally deletes the surviving branches and re-checks, so the report describes what actually survives — post-merge only (sweeping earlier deletes the open PR's head branch)
- olympus-state: `init` refuses to start a new unit while the previous unit's branches survive (mechanical backstop for a skipped close-out; the error names the branches and the fix); `--force` overrides; torn last-run/manifest never blocks
- atropos: PR-open sweep — after Hebe records the PR, the base branch and losing pass branches are deleted local+remote via `olympus-branch sweep --keep <winner>` (non-fatal); the freeze commit and losing diffs stay reachable through the winner's history and discarded refs
- atropos: every merge-adjacent exit (done seam, needs-human escalation) carries an `afterMerge` instruction naming the close-out — the merge is human-owned and asynchronous, so the seam payload is the only artifact that survives into that moment; meta.whenToUse warns that direct invocation skips Hermes; MIN_STATE_VERSION 0.6.3
- hermes: close-out step 1 is now `olympus-state close <unitId> --sweep`; step 3 verifies the close output's `hygiene` array is empty instead of re-deriving branch state by hand

## 0.6.2 — 2026-07-30

- olympus-state: `init` and `resync` write `.olympus/state/.gitignore` when missing (anchored patterns for telemetry.log, hook-trace.log, active-run.json — the append-on-every-command logs and the transient lock never enter git; runs/** and last-run.json stay tracked as the audit record); an existing file is never overwritten, and any fs failure degrades to a no-op
- olympus-state: `close` returns a non-fatal `hygiene` warning array when any of the three ignored files is still git-tracked (`git ls-files`) — gitignore cannot take effect until `git rm --cached` lands
- hermes: mandatory post-merge close-out seam — `olympus-state close <unitId>` via Talos (the only surface for `hygiene` warnings), state delta landed on a `chore/olympus-<unit>-closeout` non-story PR cut from the freshly-pulled protected branch (never direct to it), story/pass branches confirmed deleted local and remote, stash clean; the unit is not done until the sweep is clean

## 0.6.1 — 2026-07-29

- workflows: args from the Workflow runtime can arrive as a JSON string — each Fate normalizes args once at the top (a string that does not parse to an object degrades to no-args with a logged warning) and every later read goes through the normalized value; a stringified `specSignoff`/`distillDecisions`/loop-override no longer silently no-ops
- clotho: the test-author step can no longer freeze over a dangling 'started' — the Argus-pass 'done' write is verified (one extra relay attempt, then a `clotho:state` escalation), the blocked round-2 exit records 'escalated' (best-effort write), each refinement round wraps only the Daedalus dispatch in 'started'/verified-'done' and terminates it before the refreeze, and the Tests/Freeze block skips on resume only when the freeze step is done — interim refreeze/candidate SHAs in `frozenTests` no longer read as a completed freeze; both `freeze done` writes are verified the same way
- known limitation: tournament re-entry after a mid-refinement or post-freeze-commit crash re-authors over a baseBranch already carrying the crashed attempt's committed suite, so stale committed test files can linger outside the final frozen set (pre-existing in kind; the freeze-step resume gate slightly broadens the window)
- clio: new seat (opus class, single variant) — fresh-context reconciliation of decision records against the shipped branch diff; atropos dispatches it as the re-entrant `adr-reconcile` step between winner checkout and the PR (no `docPaths.adrs` in the manifest → step recorded done with reviewed 0; Clio's deviations feed Hebe's PR-body prompt; a Clio failure after retry escalates instead of shipping; the adr-reconcile 'done' write is verified like test-author's); atropos MIN_STATE_VERSION 0.6.1
- CONTEXT.md reconciliation vocabulary (normalized args, terminal step write, reconciliation); README cast table lists Clio

## 0.6.0 — 2026-07-28

- themis: distillation seat (opus class, single variant) — grounds the spec to the codebase before Cassandra: intent contract written before any repo contact, four-register sentence classification, repo-answerable claims auto-resolved into a claim table, intent decisions escalated to the human; the only seat allowed to edit a spec
- clotho: Distill phase between Readiness and Spec — a Themis decision list escalates at `clotho:distill` and re-enters via `args.distillDecisions`; Distill runs only while spec validation is open (a run resumed past that gate never takes a late spec rewrite); spec-validation capped at 2 rounds per unit, `args.specSignoff` resets the budget (persisted with the started write) and re-runs Distill so the human-signed revision is re-grounded; the done seam returns `distill.claimsResolved`; the authored suite is recorded in the manifest before red-state so a torn-manifest resume reuses it (red-state + Argus still gate the reuse); red-state relay gets one fresh retry before `clotho:environment`; MIN_STATE_VERSION 0.6.0
- talos: scripts run in the foreground to exit — a "still running" report is a protocol violation, never an outcome; long scripts take the maximum command timeout (600000 ms), not a background dispatch
- cassandra (+opus): single-pass exhaustiveness (layered discovery across rounds is a seat failure); enforcement mechanisms verified from their source with cited lines, never from their name; every REVISION proposal names the mechanical check proving the edit closes it; intent-fidelity check against the distillation artifacts
- hermes: documents the `clotho:distill` and spec-round seams; every escalation waits for the human decision — prior acceptance never covers new findings, and no spec edits without an explicit per-batch human instruction; escalation and seam reports carry cumulative agent token spend when available
- CONTEXT.md distillation vocabulary (intent contract, claim table, intent decision); README cast table lists Themis

## 0.5.0 — 2026-07-27

- lachesis: dev-loop shape is config/args-driven — `devRalph: { greensTarget, maxPasses }` (defaults 3/6), per-run `args.greensTarget`/`args.maxPasses`; `maxPasses` is a hard attempt budget; a sole green candidate skips the Minos seat and records the judge pick mechanically (pass-level Tier-1 + Fury gates remain the quality bar); MIN_STATE_VERSION 0.5.0
- clotho: per-run `args.testPasses` overrides `testRalph.passes`; the single-suite shape runs the survivor-driven refinement rounds before freeze (shared helper with the tournament path)
- olympus-state: `init` copies `devRalph` into the manifest; `resync` refreshes it
- agents: every seat declares its model class (opus / fable / sonnet) instead of a pinned ID — seats track the newest model of their class (docs/adr/0003)
- config example + README document `devRalph` and the per-run overrides; hermes documents passing them through workflow args

## 0.4.0 — 2026-07-26

- olympus-state: `close [<unitId>] [--outcome shipped|abandoned|superseded]` stamps terminal state (`phase: done`, `outcome`, `closedAt`) into the run manifest and, for the active run, records `last-run.json` and deletes `active-run.json`; `list` prints every run with phase/outcome/active flag; `get` with no active run reports `lastCompleted`; `init <newUnit>` closes an unclosed prior active run as `superseded` and reports it in its output
- atropos: the done seam closes the run via `close --outcome shipped` (non-fatal relay); MIN_STATE_VERSION 0.4.0
- hermes: on-demand status answers from `lastCompleted` when no run is active
- config README: state layout documents `last-run.json`

## 0.3.0 — 2026-07-18

- agent definitions: descriptions cut to one line each (dispatch is by type; long descriptions were pure context load); every definition ends with a `Done when …` completion criterion and the conciseness directive
- self-interrupt tripwires at each seat's known temptation (Hephaestus: test-editing; Minos: cross-candidate comparison; Mentor: single-pass aborts; Cassandra: gap-filling)
- fenced artifact templates: Daedalus traceability matrix, Hephaestus learnings entry (status-tagged claims), Hebe PR body, Cassandra findings entries
- Argus smell screen and a new fury-architecture Fowler baseline each carry per-defect tells; Mentor gains collapse/archive duties over solved learnings threads plus a worked merge example; Mentor and Hecate cross-check asserted root causes against verdict history
- Prometheus presents OPEN items recommendation-first
- CONTEXT.md: leading words and canon formulas as the single source of truth; CLAUDE.md: sync invariants (fable↔opus mirroring, cast table, canon reuse) and the `.out-of-scope/` convention

## 0.2.0 — 2026-07-18

- olympus-state: `version` command; `learn` requires `--status` (hypothesis | refuted | confirmed | fact); `sidecar set/get` for diagnostics; `get`/`init` print the manifest key list; `resync` reports steps stuck at "started" (torn-manifest evidence)
- olympus-freeze: `reanchor` moves the frozen SHA when every frozen path is byte-identical between old SHA and target
- olympus-branch: `delete` writes `refs/olympus/discarded/<name>` before deleting — every deletion is recoverable without reflog
- workflows: relay and seat dispatches retry once then escalate cleanly (a crashed agent no longer kills the run); state reads carry an integrity guard against relay-dropped keys; a plugin-version probe escalates on a stale cache; Talos runs at xhigh effort on claude-sonnet-5; failed pass branches survive to the post-judge prune; learnings promotion lines are keyed to the verdict; pass details and LOW-findings ledger move to sidecars
- pre-commit gate (`.githooks/`): plugin changes require a version bump + changelog entry; staged lines are scanned for change-narration residue
- docs: CONTEXT.md glossary; ADRs 0001–0005; residue purge and stale config-path fixes across README, config, hooks, agents, workflows
