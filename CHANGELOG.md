# Changelog

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
