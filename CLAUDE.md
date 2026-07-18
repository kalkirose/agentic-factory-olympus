# Olympus repo rules

This repo is a public Claude Code plugin; nothing project- or
client-specific is ever committed (no store names, story IDs, tracker
references).

## Sync invariants

Judgment can't be hooked; keep these true by hand on every change:

- A fable-seat definition edit (cassandra, daedalus, minos, atlas,
  mnemosyne) is mirrored to its `-opus` variant in the same commit,
  preserving the variant's extra legwork injunctions (open-the-source,
  report-uncertain-findings) — those exist because the no-op boundary is
  model-relative.
- The README cast table lists exactly the agents in `agents/`.
- Agent definitions reuse the canon formulas and leading words from
  `CONTEXT.md` verbatim; a new shared sentence is added there first.
- Every definition ends with a `Done when …` completion criterion and the
  conciseness directive.
- Files are timeless (docs/adr/0004): no change narration anywhere;
  history lives in CHANGELOG.md, docs/adr/, and git.

## Mechanical gates

Enable once per clone: `git config core.hooksPath .githooks`. The
pre-commit gate then enforces: plugin-content change → version bump in
`.claude-plugin/plugin.json` + matching `CHANGELOG.md` entry, and a
residue denylist over staged lines (`OLYMPUS_ALLOW_RESIDUE=1` to override
deliberately).

## Rejected ideas

Rejected harness features get one file each under `.out-of-scope/`
(concept-named, with the reason and prior requests), created lazily on
first rejection. Check it before re-proposing anything.
