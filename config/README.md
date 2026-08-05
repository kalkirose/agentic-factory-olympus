# Per-project configuration

Each project the harness runs in carries an `.olympus/` directory:

```
.olympus/
  config.json          committed — the project's answers, one reviewable file
  state/               committed — run manifests, learnings, verdicts
    active-run.json    which run is live (absent between runs)
    last-run.json      the most recent closed run (unit, outcome, PR)
    runs/<unit>/       manifest.json, learnings.md, traceability.md, verdict-pass-N.json
      jobs/            transient detached-job files (handle, progress, result,
                       log per job); self-ignored via a generated .gitignore
```

Prometheus (`/olympus:prometheus`) writes this file during init; it can
also be hand-authored by copying `config.example.json`. Either way a human
reviews it before the first run.

The file is JSON: every mechanical consumer (the `bin/` scripts and hooks)
is a zero-dependency node script, and JSON needs no parser.

## Fields

| Field | Read by | Meaning |
|---|---|---|
| `nextUnitQuery` | Iris (scout) | Where the work queue lives and how "next" is defined. `kind` is free-form prose routing (`sprint-file`, `tracker`, …); `rule` is followed literally. |
| `readinessChecklist` | Iris (scout) | Project-specific prerequisites checked before a unit may start. |
| `commands.fullSuite` | red-state + verdict scripts, Hephaestus (dev) | The suite layers, run in order. Every layer must exit 0 for a green verdict. |
| `commands.typecheck` | verdict script, Hephaestus (dev) | Hard verdict gate. |
| `commands.targetedHint` | Hephaestus (dev) | How to run a narrow slice while iterating; advisory only. |
| `budget.maxTranscriptBytes` | budget-backstop hook | Per-pass context ceiling; a breach ends the pass as failed. |
| `infraFlakeSignatures` | verdict + red-state scripts | Regexes for known *infrastructure* failures (never test assertions). A failing layer whose output matches retries once; the retry is flagged in the verdict JSON, never silent. |
| `uiPathPatterns` | Lachesis (build) | Regexes over changed files; a match makes the interface gate agent run for that pass. |
| `testRalph` | Clotho (spec + tests) | Omit for a single authoring pass. With it: `passes` candidate suites on branches, `adversaryCount` Dolos wrong implementations measured via `killRateCommand` (`{tests}` substituted with the suite's files), a fact-anchored judge, then `refinementRounds` against surviving faults before the freeze. With `passes: 1`, one suite is authored and validated, then measured by the adversary sweep with survivor-driven refinement before the freeze. Per-run override: Workflow `args.testPasses`. |
| `devRalph` | Lachesis (build) | Dev-loop shape. The loop runs fresh implementation passes until `greensTarget` branches are green or `maxPasses` attempts are spent (a hard budget, independent of the target). Omit for 3 greens / 6 passes. A sole green candidate is adopted mechanically — the judge seat only dispatches when there are candidates to compare. With `greensTarget: 1` a failed verdict escalates at `lachesis:pass-verdict` instead of opening the next pass; re-entry with Workflow `args.passContinue: true` authorizes exactly one continuation. Per-run overrides: Workflow `args.greensTarget` / `args.maxPasses`. |
| `models.fableSeats` | Clotho + Lachesis seat dispatch | The judgment seats (cassandra, daedalus, minos) run the fable model class by definition; each has a `-opus` variant re-tuned for Opus 4.8. `auto` (default): try the Fable seat, fall back to the variant when the dispatch dies (model unavailable), recorded in learnings. `opus`: dispatch the variants directly (skip the failed attempt when Fable is known-out). `fable`: never fall back — a dead Fable dispatch fails the step. |
| `commands.gates` | verdict script | Additional deterministic Tier-1 gates `[{name, command}]` run after typecheck — prohibited patterns, token conformance, duplication, dependency rules, mutation. |
| `hooks.formatOnEditCommand` | format-on-edit hook | Run after every dev edit; `{file}` is replaced with the edited path. Omit to disable. |
| `conventions` | branch/freeze scripts, Hebe (pr) | Branch naming (`{unit}` substituted), PR target, title prefix. `shipChecklist`: project-specific steps Hebe completes before opening the PR (spec copies, changelog entries…). |
| `docPaths` | Cassandra (spec), Daedalus (tests), Hephaestus (dev) | Pointers, not dumps: agents retrieve these on demand. |

`olympus-state init` resolves this config into each run's manifest, so a
mid-run config edit never changes a running verdict.
