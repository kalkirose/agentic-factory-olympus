# Learnings claims are promoted mechanically, never self-declared

Dev-seat models (Opus-class) systematically over-claim: the first plausible
diagnosis gets recorded as "the root cause", the fix fails, and the false
record persists in `learnings.md` where every later pass loads it. Prompt-level
calibration ("be less confident") is weak; the harness already owns a
deterministic ground-truth signal — the Tier-1 verdict.

Decided (2026-07-18): every learnings entry carries a status. Entries are born
`hypothesis`; `olympus-state learn` requires the status flag and rejects
free-prose appends. A fourth status, `fact`, marks mechanically-recorded
events (CI excerpts, seat fallbacks) that are records rather than claims and
never need promotion. No agent may write `confirmed`. Promotion to `confirmed`
or demotion to `refuted` is performed by the workflow script, keyed to the
verdict outcome of the pass that applied the fix. Refuted entries stay in the
hot file as one-liners while their symptom is open (anti-retry value), and
move to the archive sidecar when the thread collapses to problem → solution on
confirmation. At run end nothing persists automatically: durable knowledge
graduates to an ADR, the conventions doc, or the eval ledgers, or it dies with
the run.

## Consequences

- A refuted-fix pattern recurring across units is visible only in archives,
  which only Mnemosyne reads. Cross-run anti-retry protection therefore
  depends on the eval loop actually running periodically.

## Fallback path

If mechanical promotion proves too rigid (legitimate confirmations arriving
outside verdict events), add an explicit human-confirmation path; the
born-as-hypothesis rule stays. Reversal cost: small — relax the flag
requirement in `olympus-state learn`.
