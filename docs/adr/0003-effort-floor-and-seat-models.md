# No seat below xhigh effort; sub-Opus models only for tooling-only seats

The single `effort: 'low'` seat in the harness (Talos, in all three workflows)
sat exactly on the relay-truncation path that wedged a live run (2026-07) —
with an Opus model, so effort rather than model tier is the suspect variable.

Decided (2026-07-18): every seat runs at `xhigh` effort or above. Judgment
seats (anything that interprets, decides, or writes prose others consume) are
Opus-class or above. Sub-Opus models are permitted only for tooling-only seats
— invoke and relay, no judgment. Talos, the only tooling-only seat, moves to
`claude-sonnet-5` at `xhigh`: it runs dozens of times per run, and relay
fidelity is protected by ADR-0001's slim manifest and integrity guard rather
than by model size.

## Fallback path

If Sonnet-Talos shows relay errors the integrity guard catches repeatedly,
move the seat back to Opus at xhigh; one-line change per workflow. Reversal
cost: trivial.
