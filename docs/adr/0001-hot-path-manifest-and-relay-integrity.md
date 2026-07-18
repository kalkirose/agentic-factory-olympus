# Manifest carries only the hot path; relays are verified

Run state reaches workflow scripts through Talos, an LLM that transcribes
`olympus-state get` output into a structured tool call. Transcription fidelity
degrades with payload size: at ~29.5 KB the model silently dropped
`frozenTests`, which a live run (2026-07) misread as "no frozen suite" (proven
by direct test — trimming the manifest to 6.6 KB unblocked the run). Manifest
size is therefore a correctness constraint, not a style preference.

Decided (2026-07-18): the manifest holds only fields workflow scripts read on
the hot path. Diagnostics — Fury low-findings, pass summaries, abort evidence —
move to sidecar files in the run directory. `olympus-state get` additionally
prints the manifest's key list; a workflow receiving a relay missing declared
keys treats it as a relay failure (retry once, then escalate "relay corrupt"),
never as state truth.

## Considered options

- **Targeted field reads** (`get --fields frozenTests,...`): rejected as the
  primary fix. Shrinks payloads but leaves the transcription mechanism trusted
  and unverified, so any future bloat silently reintroduces the bug.

## Fallback path

If sidecar splitting proves too coarse (a workflow turns out to need a
diagnostic field mid-run), add targeted field reads on top; the integrity
guard stays regardless. Reversal cost: small — merge sidecars back and drop
the guard check.
