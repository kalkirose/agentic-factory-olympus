# No seat below xhigh effort; sub-Opus models only for tooling-only seats

The single `effort: 'low'` seat in the harness (Talos, in all three workflows)
sat exactly on the relay-truncation path that wedged a live run (2026-07) —
with an Opus model, so effort rather than model tier is the suspect variable.

Decided (2026-07-18): every seat runs at `xhigh` effort or above. Judgment
seats (anything that interprets, decides, or writes prose others consume) are
Opus-class or above. Sub-Opus models are permitted only for tooling-only seats
— invoke and relay, no judgment. Talos, the only tooling-only seat, is the
`sonnet` class at `xhigh`: it runs dozens of times per run, and relay fidelity
is protected by ADR-0001's slim manifest and integrity guard rather than by
model size.

Each seat's frontmatter declares a model *class* — `opus`, `fable`, or
`sonnet` — never a pinned model ID. The alias resolves to the newest model of
that class at dispatch time, so a class release reaches every seat of that
class without a plugin edit. A pinned ID does the reverse: it strands the seat
on a stale model until someone hand-edits each definition and cuts a release.
The Fable judgment seats keep their `-opus` fallback variants; `models.fableSeats`
selects between the Fable seat and its variant (see config README).

## Fallback path

If the `sonnet` Talos shows relay errors the integrity guard catches
repeatedly, move the seat to the `opus` class at xhigh; one `model:` line in
the seat's agent-definition frontmatter (`agents/talos.md`). Reversal cost:
trivial.
