# Olympus Harness

The vocabulary of the Olympus development harness: the run-state model, the
learnings discipline, and the seat policy. Agent cast names live in README.md;
this file defines the operational concepts they share.

## Run state

**Manifest**:
The hot-path run state for one unit of work. Contains only what workflow
scripts read during a run; anything else lives in sidecar files.
_Avoid_: state file, run log

**Sidecar**:
A file in the run directory that holds diagnostics or history. Never loaded by
run agents.
_Avoid_: dump, scratch file

**Relay**:
The transcription of a bin script's JSON output through Talos into a workflow
script. A relay is a copy made by a model, so its fidelity must be checked, not
assumed.

**Integrity guard**:
The check that a relayed manifest contains every key the script declared. A
failed guard is a relay failure to retry or escalate, never state truth.

## Learnings

**Learnings**:
The per-run scratch record of what agents tried and found. Dies with the run;
nothing in it persists automatically.
_Avoid_: log, knowledge base

**Hypothesis**:
A recorded claim no deterministic signal has confirmed. Every learnings entry
is born as one, regardless of how confident its author was.
_Avoid_: root cause, solution, finding (until promoted)

**Confirmed**:
The status of a hypothesis whose fix went green under the official verdict.
Only the harness can assign it; no agent may write it.

**Refuted**:
The status of a hypothesis whose fix failed the official verdict. Stays
visible as a one-liner while its symptom is open, so later passes do not
retry it.

**Promotion**:
The mechanical act of marking a hypothesis confirmed or refuted, keyed to a
verdict event. Never performed by the agent that authored the hypothesis.

**Collapse**:
The rewrite of a solved thread down to problem and confirmed solution. Refuted
siblings move to the archive.

**Archive**:
The sidecar holding a run's full diagnostic history after collapse. Read only
by the eval loop (Mnemosyne), never by run agents.

**Graduation**:
The explicit move of run knowledge into a durable home (ADR, conventions doc,
eval ledger) at run end. The only way anything outlives a run.

## Branches

**Discarded ref**:
A ref under `refs/olympus/discarded/` written at a branch's tip before the
branch is deleted. Makes every harness deletion recoverable without reflog.

**Prune**:
The post-judge removal of all non-winner pass branches. The only moment the
harness deletes branches.
_Avoid_: cleanup (for branch deletion)

## Seats

**Seat**:
One agent role instance in a workflow, defined by agent type, model, and
effort.

**Tooling-only seat**:
A seat whose whole job is invoking tools and relaying results, with no
judgment. The only kind of seat allowed to run below Opus. Talos is the only
one today.

**Judgment seat**:
Any seat that interprets, decides, or writes prose that others consume. Always
Opus-class or above, never below xhigh effort.
