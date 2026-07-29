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

**Normalized args**:
The object form of a workflow invocation's args, parsed once at the top of
every workflow script; the runtime may deliver args as a JSON string, and a
string that does not parse to an object degrades to no-args with a logged
warning, never a thrown error.

**Terminal step write**:
The 'done'/'escalated' write that closes a step's 'started'. The test-author
and adr-reconcile 'done' writes are verified (one extra relay attempt, then
escalation), and refinement terminates test-author before any refreeze, so a
freeze can never complete over a dangling 'started'. The blocked-suite
'escalated' write is best-effort.

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

## Distillation

**Distillation**:
The pre-validation pass that grounds a spec to the codebase: the spec owns
the what; the repo is the sole authority on the how. Themis holds this
seat — opus class with no fable variant, so the fable↔opus mirror
invariant does not apply to it.
_Avoid_: cleanup, spec refactor

**Intent contract**:
The record, written before any repo contact, of what a spec rewrite must
preserve: business case, each AC's behavioral core, named constraints,
scope boundaries.

**Claim table**:
The sidecar mapping each auto-resolved spec claim to repo reality with
file:line evidence. Downstream validation spot-checks these instead of
re-deriving them.

**Intent decision**:
A spec divergence whose resolution changes intent. Never resolved by a
seat; escalated to the human with options and consequences.

## Reconciliation

**Reconciliation**:
The ship-phase pass, between winner checkout and the PR, that rewrites every
decision record the branch diff implements or contradicts into standalone
present-tense fact. Clio holds this seat — fresh-context by design (the
implementing agents never reconcile their own records), opus class with no
fable variant, so the fable↔opus mirror invariant does not apply to it.
Deviations between the diff and a prior recorded decision are named in the
record and the PR body, never absorbed; a project without a decision-record
directory skips the pass mechanically.

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

## Leading words

Compact concepts the definitions think with; use these exact words, never
synonyms.

**Frozen**:
The state of the acceptance suite after Clotho commits it at a SHA: no agent
may change it, and the verdict diff-checks it.
_Avoid_: locked, pinned, fixed

**Green**:
Passing the official verdict — every frozen-suite layer and gate exits 0.
_Avoid_: passing, successful, working

**Escape**:
A defect that surfaced downstream of the stage that should have caught it.
The harness's only honest quality signal.
_Avoid_: miss, leak, slip-through

**Kill rate**:
The fraction of adversary implementations a candidate suite fails. Measures
constraining power before any real implementation exists.

**Constraining power**:
What a test suite is for: how tightly it forces implementations toward the
spec. The opposite of coverage theater.
_Avoid_: coverage, thoroughness

**Coverage theater**:
Tests that run, look thorough, and constrain nothing.

**Route**:
One of Hecate's five classifications of a failed merge check, executed by the
workflow under the Kronos cap.
_Avoid_: category, bucket

## Canon formulas

Fixed sentences the agent definitions repeat verbatim; edit them here first,
then everywhere, never paraphrase in place.

- "Your final message is data for the script, not prose for a human."
- "You inform; the script decides."
- "No evidence, no finding."
- "A clean report is a valid report."
- "Judge in isolation; never against another candidate."
- "At most 5 LOWs."
- "When reporting, be extremely concise. Sacrifice grammar for the sake of
  concision."
