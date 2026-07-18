# Files are timeless; history lives in the changelog, ADRs, and git

LLM-assisted editing tends to leak change-narration into artifacts: comments
like "updated to", "no longer", "(added ...)", incident anecdotes, and other
text that only makes sense to a reader who knew the file's previous version.
Left in place, files become a recorded conversation instead of a clean
artifact, and the noise compounds with every edit.

Decided (2026-07-18): every file in this repo is written in the timeless
present — it states what is, never what changed or why a change was made
relative to a prior version. Reading a file must not reveal that it was ever
different. The designated history homes are `CHANGELOG.md` (one succinct
entry per version bump), `docs/adr/` (decisions and their trade-offs), and
git/PR history. Comments may state current constraints and invariants,
including their rationale; they may not narrate incidents or prior states.

Enforcement is mechanical: the pre-commit hook rejects commits that touch
`bin/`, `workflows/`, `agents/`, `hooks/`, or `skills/` without a
`plugin.json` version bump and a matching `CHANGELOG.md` entry, and blocks a
denylist of narration vocabulary in staged content outside `docs/adr/` and
`CHANGELOG.md`. A semantic sweep of the staged diff against this rule is part
of the commit ritual, since most residue is phrasing the denylist cannot
catch.
