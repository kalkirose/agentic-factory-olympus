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
| `hooks.formatOnEditCommand` | format-on-edit hook | Run after every dev edit; `{file}` is replaced with the edited path. Omit to disable. |
| `conventions` | branch/freeze scripts, Hebe (pr) | Branch naming (`{unit}` substituted), PR target, title prefix. |
| `docPaths` | Cassandra (spec), Daedalus (tests), Hephaestus (dev) | Pointers, not dumps: agents retrieve these on demand. |

`olympus-state init` resolves this config into each run's manifest, so a
mid-run config edit never changes a running verdict.
