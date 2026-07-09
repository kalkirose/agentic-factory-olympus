# Olympus

A development harness for Claude Code, packaged as a plugin. Three
deterministic workflows take one unit of work (a story, an epic, a task)
from specification to a reviewed pull request:

1. **Clotho** (spec + tests) — validates the spec against reality, authors
   an acceptance-test suite, and freezes it at a git SHA.
2. **Lachesis** (build) — runs fresh-context dev passes against the frozen
   suite until enough candidates are green, then a judge picks the winner.
   The workflow script, not any agent, owns the verdict: the frozen suite
   runs by command, a diff check proves the tests are untouched, and gate
   agents see only the diff.
3. **Atropos** (ship) — writes the PR and watches the merge checks.

Handoffs between workflows are files, not conversations: a validated spec,
a frozen test SHA, a learnings file, a branch, a PR. Agents exist only at
judgment points; everything mechanical is script or hook. Each pass's dev
agent starts with clean context — it inherits distilled learnings from
prior passes, never their code.

## Status

Phase B in build. The skeleton (Phase A) is validated end-to-end; the
organs are authored: the six Furies (official LLM gate agents) with a
verification pass, the config-gated test tournament (adversary kill
rates, suite judge, bounded refinement), triage routes with a
route-execution cap, and the lifecycle telemetry ledger. Deterministic
Tier-1 gates extend per project via `commands.gates`.

## Install

```
claude plugin marketplace add kalkirose/agentic-factory-olympus
claude plugin install olympus@olympus
```

Then, in the target project, create `.olympus/config.yaml` (see
`config/config.example.yaml`; a guided init lands in Phase B). Projects pin
a plugin version — upgrades are explicit, never silent.

## Layout

| Path | Contents |
|---|---|
| `agents/` | Agent definitions (system prompts + model pins) |
| `workflows/` | The three Fates, as named workflows (`olympus:clotho`, …) |
| `hooks/` | Mechanical enforcement scripts (frozen-test write denial, format/lint, context-budget backstop) |
| `bin/` | Deterministic run mechanics: state, verdict, freeze, red-state, branch plumbing — no LLM anywhere in them |
| `skills/` | `hermes` — the conversational entry point |
| `config/` | Config field reference + a generic example |

## The cast

Every agent has a Greek name and a one-word hint, used consistently in
prompts, manifests, and reports.

| Name | Hint | Job |
|---|---|---|
| Hermes | orchestrator | talks to you, launches workflows, surfaces escalations; loads no project context |
| Iris | scout | next unit of work; readiness check |
| Cassandra | spec | drift + intrinsic spec validation before any tests exist |
| Daedalus | tests | authors the acceptance suite from the validated spec |
| Argus | validator | coverage matrix + red-state check on the suite |
| Hephaestus | dev | one fresh implementation pass to green, within budget |
| Mentor | between-pass | reads learnings; continue or abort with a route |
| Minos | judge | picks the winner among green branches |
| Hebe | pr | writes a clean PR, watches the merge checks |
| Talos | executor | invokes the deterministic `bin/` scripts and relays their JSON verbatim; judges nothing |
| Dolos | adversary | writes plausible wrong implementations so a suite's kill rate is measurable pre-implementation |
| The Furies | gates | six official diff-only gate agents (spec, architecture, minimality, security, operational, interface) + a verification pass; only confirmed HIGH findings block |
| Hecate | triage | classifies failed PR checks into five evidence-carrying routes |
| Mnemosyne | eval | out-of-band eval review: escape attribution, proposals needing sign-off |
| Prometheus | init | scan-first project onboarding (`/olympus:prometheus`) |
| Atlas | arch review | out-of-band whole-repo drift/erosion review; proposals, never blocks |

Roles carried by mechanism rather than an agent: Nyx (liveness) is the
telemetry ledger + duration records; Kronos (time governance) is the loop
caps, the budget backstop, and the triage route cap; the Cyclopes
(advisory checks) are the dev agent's own test/gate runs mid-pass.
