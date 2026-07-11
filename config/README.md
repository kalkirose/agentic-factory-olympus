# Per-project configuration

Each project the harness runs in carries an `.olympus/` directory:

```
.olympus/
  config.json          committed — the project's answers, one reviewable file
  state/               committed — run manifests, learnings, verdicts
    active-run.json    which run is live
    runs/<unit>/       manifest.json, learnings.md, traceability.md, verdict-pass-N.json
```

Copy `config.example.json` to `.olympus/config.json` in the project and
fill it in. A guided init (Prometheus) lands in Phase B; until then this
file is hand-authored and human-reviewed.

Format note: the design doc named this file `config.yaml`. Phase A ships it
as JSON because every mechanical consumer (the `bin/` scripts and hooks) is
a zero-dependency node script and JSON needs no parser. Revisit when
Prometheus writes the file.

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
| `testRalph` | Clotho (spec + tests) | Omit for a single authoring pass. With it: `passes` candidate suites on branches, `adversaryCount` Dolos wrong implementations measured via `killRateCommand` (`{tests}` substituted with the suite's files), a fact-anchored judge, then `refinementRounds` against surviving faults before the freeze. |
| `models.fableSeats` | Clotho + Lachesis seat dispatch | The judgment seats (cassandra, daedalus, minos) run `claude-fable-5` by definition; each has a `-opus` variant re-tuned for Opus 4.8. `auto` (default): try the Fable seat, fall back to the variant when the dispatch dies (model unavailable), recorded in learnings. `opus`: dispatch the variants directly (skip the failed attempt when Fable is known-out). `fable`: never fall back — a dead Fable dispatch fails the step. |
| `commands.gates` | verdict script | Additional deterministic Tier-1 gates `[{name, command}]` run after typecheck — prohibited patterns, token conformance, duplication, dependency rules, mutation. |
| `hooks.formatOnEditCommand` | format-on-edit hook | Run after every dev edit; `{file}` is replaced with the edited path. Omit to disable. |
| `conventions` | branch/freeze scripts, Hebe (pr) | Branch naming (`{unit}` substituted), PR target, title prefix. `shipChecklist`: project-specific steps Hebe completes before opening the PR (spec copies, changelog entries…). |
| `docPaths` | Cassandra (spec), Daedalus (tests), Hephaestus (dev) | Pointers, not dumps: agents retrieve these on demand. |

`olympus-state init` resolves this config into each run's manifest, so a
mid-run config edit never changes a running verdict.
