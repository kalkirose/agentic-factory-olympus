# Changelog

## 0.2.0 — 2026-07-18

- olympus-state: `version` command; `learn` requires `--status` (hypothesis | refuted | confirmed | fact); `sidecar set/get` for diagnostics; `get`/`init` print the manifest key list; `resync` reports steps stuck at "started" (torn-manifest evidence)
- olympus-freeze: `reanchor` moves the frozen SHA when every frozen path is byte-identical between old SHA and target
- olympus-branch: `delete` writes `refs/olympus/discarded/<name>` before deleting — every deletion is recoverable without reflog
- workflows: relay and seat dispatches retry once then escalate cleanly (a crashed agent no longer kills the run); state reads carry an integrity guard against relay-dropped keys; a plugin-version probe escalates on a stale cache; Talos runs at xhigh effort on claude-sonnet-5; failed pass branches survive to the post-judge prune; learnings promotion lines are keyed to the verdict; pass details and LOW-findings ledger move to sidecars
- pre-commit gate (`.githooks/`): plugin changes require a version bump + changelog entry; staged lines are scanned for change-narration residue
- docs: CONTEXT.md glossary; ADRs 0001–0005; residue purge across README, config, hooks, workflows
