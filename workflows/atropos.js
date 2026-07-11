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
async function talos(scriptWithArgs, label, phaseName) {
  const r = await agent(
    `Run the Olympus script: ${scriptWithArgs}\n` +
      `Put the script's JSON output (parsed) in the "output" field, its exit code in "exitCode", ` +
      `and set "ok" to whether the script itself reported ok:true. ` +
      `If the output was not JSON, put the raw tail in "errorTail" and set ok:false.`,
    { agentType: 'olympus:talos', schema: TALOS_SCHEMA, label, phase: phaseName || 'Ship', effort: 'low' }
  )
  if (!r) throw new Error(`talos relay returned nothing for: ${scriptWithArgs}`)
  return r
}
const esc = (o) => JSON.stringify(JSON.stringify(o))
function escalate(seam, items, extra) {
  return { status: 'escalation', seam, escalations: items, ...(extra || {}) }
}

phase('Ship')
await talos('olympus-state resync', 'talos:resync')
const state = await talos('olympus-state get', 'talos:state')
if (!state.ok) return escalate('atropos:state', [`no active run: ${state.errorTail || JSON.stringify(state.output)}`])
const manifest = state.output.manifest
if (!manifest.judge || !manifest.judge.winner) {
  return escalate('atropos:state', ['no judged winner — run olympus:lachesis first'])
}
const routeCount = (manifest.pr && manifest.pr.routeExecutions) || 0

// Winner checked out; accumulated run state committed onto it so the PR
// carries the manifest, learnings, and verdicts.
const co = await talos(`olympus-branch checkout --name "${manifest.judge.winner}"`, 'talos:checkout')
if (!co.ok) return escalate('atropos:state', [`could not check out winner: ${co.errorTail || JSON.stringify(co.output)}`])
await talos(`olympus-state commit "chore(olympus): run state for ${manifest.unitId}"`, 'talos:state-commit')

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
const furyNotes = (manifest.furies && manifest.furies.lowFindings) || []
const existingPr = manifest.pr && manifest.pr.url

await talos('olympus-state step ship started', 'talos:step')
const hebe = await agent(
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
if (!hebe) throw new Error('Hebe (pr) returned nothing')
await talos(`olympus-state merge ${esc({ pr: { url: hebe.url, checks: hebe.checks, routeExecutions: routeCount } })}`, 'talos:record-pr')

const failing = hebe.checks.filter((c) => c.status !== 'pass')
if (failing.length === 0 && hebe.needsHuman.length === 0) {
  await talos(`olympus-state step ship done ${esc({ url: hebe.url })}`, 'talos:step')
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
const hecate = await agent(
  `Classify the failed merge checks for the PR ${hebe.url} (unit ${manifest.unitId}).\n` +
    `Failed checks: ${JSON.stringify(failing)}.\n` +
    `Local verdict already proved: ${JSON.stringify(((manifest.passes || []).find((p) => p.branch === manifest.judge.winner) || {}).verdict || {})}.\n` +
    `Follow the five-route protocol in your definition; evidence excerpts are mandatory.`,
  { agentType: 'olympus:hecate', schema: HECATE_SCHEMA, label: 'hecate:triage', phase: 'Triage', effort: 'xhigh' }
)
if (!hecate) throw new Error('Hecate (triage) returned nothing')
await talos(`olympus-state merge ${esc({ pr: { url: hebe.url, checks: hebe.checks, routeExecutions: routeCount, triage: hecate.classifications } })}`, 'talos:record-triage')

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
    await talos(`olympus-state learn ${esc(entry)}`, 'talos:learn', 'Triage')
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
