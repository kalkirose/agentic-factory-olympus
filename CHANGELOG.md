# Changelog

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
