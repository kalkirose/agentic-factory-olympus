---
name: prometheus
description: Prometheus (init) — set up the Olympus harness in the current project. Use when the user asks to initialize/onboard Olympus in a repo. Scan-first - infers everything scanning can settle, asks only what it cannot, writes .olympus/config.json + hooks for one human review pass. Re-runs diff, never overwrite.
---

# Prometheus (init)

You bring the harness to a new project. The config you produce is the
interview record — one reviewable file the human signs off on. Scan first;
ask only what scanning cannot settle.

## Step 1 — scan

Read the repository (README, package manifests, CI workflows, existing
`.claude/` config, doc directories) and draft answers for every config
field:

- **Work queue** (`nextUnitQuery`): tracker integration, sprint file, epic
  list — where "the next unit of work" lives and how "next" is defined.
- **Commands**: per-layer test commands (`fullSuite`), typecheck, a
  targeted-run hint. Prefer what CI already runs — the config should
  mirror the project's own definition of green.
- **`commands.gates` — transcribe EVERY deterministic gate step from the
  CI workflows**, not a subset. A gate that runs in CI but not in the
  verdict is a guaranteed escape: the dev loop goes green locally and the
  PR fails remotely. Skip only gates that cannot run locally (deploy-bound
  steps), and say so in the config as a comment field.
- **`conventions.shipChecklist`**: pre-PR steps the project's DoD demands
  beyond code (spec-in-repo copies, changelog rules) — read the
  contributing/agent docs for these.
- **Conventions**: branch naming, PR target branch, PR title pattern —
  from contributing docs, git history, or CI triggers.
- **Doc paths**: conventions file (CLAUDE/AGENTS.md), ADRs, architecture,
  glossary, specs.
- **Behavioral surface** (when configured for the project type): how to
  boot the app and seed data for browser runs; viewports; design
  reference paths.
- **Thresholds**: context budget, loop caps — start from the example
  config's defaults unless the project's scale argues otherwise.
- **Infra-flake signatures**: start empty unless CI configs or docs name
  known flakes.

Mark every value you inferred with its evidence (file you read), and every
value you could not settle as OPEN.

## Step 2 — ask

Present the OPEN items as direct questions, one batch, each led by your
recommended answer and its one-line reason, so the user can accept it in
a word. Do not ask about anything you could infer; do not silently
default an OPEN item.

## Step 3 — materialize

1. Write `.olympus/config.json` (schema-versioned; see the plugin's
   `config/config.example.json` for the field reference).
2. Create `.olympus/hooks/` by copying the plugin's `hooks/*.js` (locate
   the installed plugin under `~/.claude/plugins/cache/*/olympus/*/hooks/`).
3. Register the hooks in the project's `.claude/settings.json` per the
   plugin's `hooks/README.md` template (merge — never clobber existing
   settings).
4. Show the human the full config with the inferred-evidence annotations
   and wait for their review. Apply their corrections.

## Re-runs

If `.olympus/config.json` already exists: produce a diff against your
fresh scan (fields whose evidence changed), never overwrite. State-bearing
files under `.olympus/state/` are never touched by init.

## Hard rules

- One review pass with the human is part of init — never skip it.
- Everything committed: config, hooks, settings changes ride the project's
  normal change process (branch/PR where the project demands it).
