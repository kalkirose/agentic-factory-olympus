export const meta = {
  name: 'atropos',
  description: 'Atropos (ship): Hebe opens the PR and watches checks; Hecate classifies failures into five routes; Kronos caps route executions at two, then mandatory escalation.',
  whenToUse: 'Final phase of an Olympus run. Requires a judged winner from Lachesis.',
  phases: [
    { title: 'Ship', detail: 'PR + merge-check watch' },
    { title: 'Triage', detail: 'Hecate routes failures; Kronos caps executions' },
  ],
}

const KRONOS_ROUTE_CAP = 2

const TALOS_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    output: { type: 'object', additionalProperties: true },
    exitCode: { type: 'number' },
    errorTail: { type: 'string' },
  },
  required: ['ok'],
}
// A relay that dies gets one fresh retry, then a soft failure the caller
// can escalate — a single crashed agent must never kill the whole run.
async function talos(scriptWithArgs, label, phaseName) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let r = null
    try {
      r = await agent(
        `Run the Olympus script: ${scriptWithArgs}\n` +
          `Put the script's JSON output (parsed) in the "output" field, its exit code in "exitCode", ` +
          `and set "ok" to whether the script itself reported ok:true. ` +
          `If the output was not JSON, put the raw tail in "errorTail" and set ok:false.`,
        { agentType: 'olympus:talos', schema: TALOS_SCHEMA, label: attempt === 1 ? label : `${label}-retry`, phase: phaseName, effort: 'xhigh' }
      )
    } catch (e) {
      r = null
    }
    if (r) return r
    if (attempt === 1) log(`relay returned nothing for: ${scriptWithArgs} — one fresh retry`)
  }
  return { ok: false, errorTail: `relay failed twice for: ${scriptWithArgs}` }
}
async function talosSoft(scriptWithArgs, label, phaseName) {
  const r = await talos(scriptWithArgs, label, phaseName)
  if (!r.ok) log(`non-fatal step failed: ${scriptWithArgs}`)
  return r
}
// Guarded seat dispatch: same one-retry-then-null contract for judgment
// seats. Callers decide what a null means (escalate, fall back, fail soft).
async function seat(prompt, opts) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let r = null
    try {
      r = await agent(prompt, attempt === 1 ? opts : { ...opts, label: `${opts.label}-retry` })
    } catch (e) {
      r = null
    }
    if (r) return r
    if (attempt === 1) log(`${opts.label}: seat returned nothing — one fresh retry`)
  }
  return null
}
// Integrity guard on the state relay: the script prints its key list; a
// relayed manifest missing declared keys is a relay failure to retry, never
// state truth (see docs/adr/0001).
async function getState(phaseName) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const st = await talos('olympus-state get', attempt === 1 ? 'talos:state' : 'talos:state-guard-retry', phaseName)
    if (!st.ok) return st
    const m = st.output && st.output.manifest
    const keys = st.output && st.output.keys
    if (m && Array.isArray(keys)) {
      const missing = keys.filter((k) => !(k in m))
      if (!missing.length) return st
      log(`state relay dropped keys: ${missing.join(', ')} — retrying the relay`)
    } else if (m) {
      return st
    }
  }
  return { ok: false, errorTail: 'state relay corrupt after retry (integrity guard: relayed manifest missing declared keys)' }
}
const MIN_STATE_VERSION = '0.2.0'
function versionLt(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0)
  }
  return false
}
const esc = (o) => JSON.stringify(JSON.stringify(o))
function escalate(seam, items, extra) {
  return { status: 'escalation', seam, escalations: items, ...(extra || {}) }
}

phase('Ship')
const ver = await talos('olympus-state version', 'talos:version', 'Ship')
const installedVersion = ver.ok && ver.output && ver.output.version
if (!installedVersion || versionLt(installedVersion, MIN_STATE_VERSION)) {
  return escalate('atropos:plugin', [
    `installed olympus plugin is stale (state version ${installedVersion || 'unknown'}, this workflow needs ≥ ${MIN_STATE_VERSION}) — reinstall the plugin, then re-run olympus:atropos`,
  ])
}
const rs = await talos('olympus-state resync', 'talos:resync', 'Ship')
if (rs.ok && rs.output && Array.isArray(rs.output.staleStarted) && rs.output.staleStarted.length) {
  log(
    `WARNING — steps still read "started" from a prior session: ${rs.output.staleStarted
      .map((s) => s.step)
      .join(', ')}. Their work may have completed without a terminal write (torn manifest); the resume re-runs them.`
  )
}
const state = await getState('Ship')
if (!state.ok) return escalate('atropos:state', [`no active run: ${state.errorTail || JSON.stringify(state.output)}`])
const manifest = state.output.manifest
if (!manifest.judge || !manifest.judge.winner) {
  return escalate('atropos:state', ['no judged winner — run olympus:lachesis first'])
}
const routeCount = (manifest.pr && manifest.pr.routeExecutions) || 0

// Winner checked out; accumulated run state committed onto it so the PR
// carries the manifest, learnings, and verdicts.
const co = await talos(`olympus-branch checkout --name "${manifest.judge.winner}"`, 'talos:checkout', 'Ship')
if (!co.ok) return escalate('atropos:state', [`could not check out winner: ${co.errorTail || JSON.stringify(co.output)}`])
await talos(`olympus-state commit "chore(olympus): run state for ${manifest.unitId}"`, 'talos:state-commit', 'Ship')

const HEBE_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    oneLiner: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'pending'] },
          failureExcerpt: { type: 'string' },
        },
        required: ['name', 'status'],
      },
    },
    needsHuman: { type: 'array', items: { type: 'string' } },
  },
  required: ['url', 'oneLiner', 'checks', 'needsHuman'],
}

const flagged = (manifest.passes || []).flatMap((p) => p.flaggedDecisions || [])
// Advisory diagnostics live in sidecars, not the manifest (docs/adr/0001);
// a failed sidecar relay costs advisory notes, never the run.
const lowsRelay = await talosSoft('olympus-state sidecar get low-findings', 'talos:lows', 'Ship')
const furyNotes = (lowsRelay.ok && lowsRelay.output && lowsRelay.output.output && lowsRelay.output.output.lowFindings) || []
const detailRelay = await talosSoft('olympus-state sidecar get pass-details', 'talos:pass-details', 'Ship')
const passDetails = (detailRelay.ok && detailRelay.output && detailRelay.output.output && detailRelay.output.output.passes) || []
const existingPr = manifest.pr && manifest.pr.url

await talos('olympus-state step ship started', 'talos:step', 'Ship')
const hebe = await seat(
  (existingPr
    ? `The pull request for unit ${manifest.unitId} already exists: ${existingPr}. Re-run the previously failed merge checks where the platform allows it, then watch every check to completion.\n`
    : `Open the pull request for unit ${manifest.unitId}.\n`) +
    `Branch: ${manifest.judge.winner}. Target branch: ${manifest.conventions.prTargetBranch || 'main'}.\n` +
    `Spec: "${manifest.spec.path}". Conventions: .olympus/config.json (conventions).\n` +
    `Run facts for the PR body: passes ${JSON.stringify((manifest.passes || []).map((p) => ({ n: p.n, outcome: p.outcome })))}; ` +
    `judge rationale: ${manifest.judge.rationale}; ` +
    `flagged decisions a human must see: ${flagged.length ? flagged.join('; ') : 'none'}` +
    (furyNotes.length ? `; advisory gate notes (non-blocking): ${furyNotes.slice(0, 10).join('; ')}` : '') +
    (manifest.conventions.shipChecklist && manifest.conventions.shipChecklist.length
      ? `\nSHIP CHECKLIST (complete each item BEFORE opening the PR, committing on the branch where an item produces files): ${manifest.conventions.shipChecklist.join(' | ')}`
      : '') +
    `\nWrite the PR body per your definition, watch every merge check to completion, report outcomes.`,
  { agentType: 'olympus:hebe', schema: HEBE_SCHEMA, label: 'hebe:pr', phase: 'Ship', effort: 'xhigh' }
)
if (!hebe) return escalate('atropos:seat', ['Hebe (pr) returned nothing after a retry — re-run olympus:atropos to resume'])
await talos(`olympus-state merge ${esc({ pr: { url: hebe.url, checks: hebe.checks, routeExecutions: routeCount } })}`, 'talos:record-pr', 'Ship')

const failing = hebe.checks.filter((c) => c.status !== 'pass')
if (failing.length === 0 && hebe.needsHuman.length === 0) {
  await talos(`olympus-state step ship done ${esc({ url: hebe.url })}`, 'talos:step', 'Ship')
  return {
    status: 'done',
    seam: 'atropos',
    unit: manifest.unitId,
    url: hebe.url,
    oneLiner: hebe.oneLiner,
    humanDecisions: flagged,
    escalations: [],
  }
}

// ------------------------------------------------------------------- Triage
phase('Triage')
if (hebe.needsHuman.length > 0 && failing.length === 0) {
  return escalate('atropos:needs-human', hebe.needsHuman, { url: hebe.url, unit: manifest.unitId })
}

const HECATE_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          check: { type: 'string' },
          route: { type: 'string', enum: ['ack-able', 'flake', 'dev-defect', 'spec-defect', 'unknown'] },
          excerpt: { type: 'string' },
          rationale: { type: 'string' },
          escapeAttribution: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['check', 'route', 'excerpt', 'rationale'],
      },
    },
  },
  required: ['classifications'],
}
const hecate = await seat(
  `Classify the failed merge checks for the PR ${hebe.url} (unit ${manifest.unitId}).\n` +
    `Failed checks: ${JSON.stringify(failing)}.\n` +
    `Local verdict already proved: ${JSON.stringify((passDetails.find((p) => p.branch === manifest.judge.winner) || {}).verdict || {})}.\n` +
    `Follow the five-route protocol in your definition; evidence excerpts are mandatory.`,
  { agentType: 'olympus:hecate', schema: HECATE_SCHEMA, label: 'hecate:triage', phase: 'Triage', effort: 'xhigh' }
)
if (!hecate) return escalate('atropos:seat', ['Hecate (triage) returned nothing after a retry — re-run olympus:atropos to resume'], { url: hebe.url })
await talos(`olympus-state merge ${esc({ pr: { url: hebe.url, checks: hebe.checks, routeExecutions: routeCount, triage: hecate.classifications } })}`, 'talos:record-triage', 'Triage')

const routes = hecate.classifications
const needsHumanNow = routes.filter((c) => c.route === 'ack-able' || c.route === 'spec-defect' || c.route === 'unknown')
const devDefects = routes.filter((c) => c.route === 'dev-defect')
const flakes = routes.filter((c) => c.route === 'flake')

// Kronos: at the cap, every remaining route escalates — no ping-pong.
if (routeCount >= KRONOS_ROUTE_CAP && (devDefects.length || flakes.length)) {
  return escalate(
    'atropos:kronos-cap',
    routes.map((c) => `${c.check}: ${c.route} — ${c.rationale}`),
    { url: hebe.url, unit: manifest.unitId, note: `route-execution cap (${KRONOS_ROUTE_CAP}) reached; human decision required` }
  )
}

// Human-owned routes always escalate immediately, whatever else is queued.
if (needsHumanNow.length) {
  return escalate(
    'atropos:triage',
    needsHumanNow.map((c) => `${c.check} [${c.route}]: ${c.rationale}${c.recommendation ? ` — recommendation: ${c.recommendation}` : ''}`),
    { url: hebe.url, unit: manifest.unitId, alsoQueued: devDefects.concat(flakes).map((c) => `${c.check}: ${c.route}`) }
  )
}

// Dev defects: record the failure as a learnings entry + escape attribution,
// then hand the seam to Hermes to re-run Lachesis (a route execution).
if (devDefects.length) {
  for (const d of devDefects) {
    const entry = `CI check '${d.check}' failed after a green local verdict (dev defect). Excerpt: ${d.excerpt}. ${d.escapeAttribution ? `Escape attribution: ${d.escapeAttribution}.` : ''} The next pass must address this.`
    await talos(`olympus-state learn ${esc(entry)} --status fact`, 'talos:learn', 'Triage')
  }
  await talos(`olympus-state merge ${esc({ pr: { url: hebe.url, checks: hebe.checks, routeExecutions: routeCount + 1, triage: hecate.classifications } })}`, 'talos:kronos', 'Triage')
  return {
    status: 'route',
    seam: 'atropos:dev-defect',
    route: 'lachesis',
    unit: manifest.unitId,
    url: hebe.url,
    details: devDefects.map((c) => `${c.check}: ${c.rationale}`),
    instruction: 'Re-run olympus:lachesis (failures recorded in learnings), then olympus:atropos.',
  }
}

// Pure flakes: one more Hebe round re-running them is a route execution.
if (flakes.length) {
  await talos(`olympus-state merge ${esc({ pr: { url: hebe.url, checks: hebe.checks, routeExecutions: routeCount + 1, triage: hecate.classifications } })}`, 'talos:kronos', 'Triage')
  return {
    status: 'route',
    seam: 'atropos:flake',
    route: 'atropos',
    unit: manifest.unitId,
    url: hebe.url,
    details: flakes.map((c) => `${c.check}: ${c.rationale}`),
    instruction: 'Re-run olympus:atropos — Hebe re-runs the flake-classified checks; a repeat failure must reclassify.',
  }
}

return escalate('atropos:triage', ['triage produced no executable route'], { url: hebe.url, unit: manifest.unitId })
