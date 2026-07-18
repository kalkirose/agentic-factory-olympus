# Branch deletion is tag-then-delete, and only ever post-judge

A dev loop produces up to six candidate branches per unit; unpruned they
clutter the repo, but a deleted branch can carry hours of near-complete work,
and git reflog — the only recovery net for a bare `branch -D` — expires and
can be gc'd. A live run (2026-07) lost two candidate branches this way during
a crash and recovered them only because the reflog still held their tips.

Decided (2026-07-18): `olympus-branch delete` writes
`refs/olympus/discarded/<branch>` at the branch tip before deleting, making
every harness deletion deterministically recoverable
(`git branch <name> refs/olympus/discarded/<name>`), independent of reflog
state. Deletion happens at exactly one moment per run — the post-judge prune,
which removes all non-winner pass branches once a judge pick exists and is
best-effort (a blocked delete never kills the run). The build loop never
deletes mid-run: failed pass branches survive to the judge seam, so error and
crash paths contain no destructive operations at all. Discarded refs have no
retention policy; they are a few bytes each and stay until someone chooses to
clear them.

## Considered options

- **A recovery agent restoring deleted branches from reflog**: rejected —
  prevention (never delete unrecoverably, never delete early) removes the
  failure class a recovery seat would exist to repair.

## Fallback path

If keeping failed branches through a run causes real friction (branch-name
collisions, tooling noise), reintroduce mid-loop pruning — but only as
tag-then-delete. Reversal cost: one line per workflow.
