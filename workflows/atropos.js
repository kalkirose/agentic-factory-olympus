export const meta = {
  name: 'atropos',
  description: 'Atropos (ship): Hebe writes and opens the PR for the winning branch, watches the merge checks, escalates any failure.',
  whenToUse: 'Final phase of an Olympus run. Requires a judged winner from Lachesis.',
  phases: [{ title: 'Ship', detail: 'PR + merge-check watch' }],
}

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
async function talos(scriptWithArgs, label) {
  const r = await agent(
    `Run the Olympus script: ${scriptWithArgs}\n` +
      `Put the script's JSON output (parsed) in the "output" field, its exit code in "exitCode", ` +
      `and set "ok" to whether the script itself reported ok:true. ` +
      `If the output was not JSON, put the raw tail in "errorTail" and set ok:false.`,
    { agentType: 'talos', schema: TALOS_SCHEMA, label, phase: 'Ship', effort: 'low' }
  )
  if (!r) throw new Error(`talos relay returned nothing for: ${scriptWithArgs}`)
  return r
}
const esc = (o) => JSON.stringify(JSON.stringify(o))
function escalate(seam, items, extra) {
  return { status: 'escalation', seam, escalations: items, ...(extra || {}) }
}

phase('Ship')
const state = await talos('olympus-state get', 'talos:state')
if (!state.ok) return escalate('atropos:state', [`no active run: ${state.errorTail || JSON.stringify(state.output)}`])
const manifest = state.output.manifest
if (!manifest.judge || !manifest.judge.winner) {
  return escalate('atropos:state', ['no judged winner — run olympus:lachesis first'])
}

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

// Make sure the winner is checked out, then commit the accumulated run
// state onto it so the PR carries the manifest, learnings, and verdicts.
const co = await talos(`olympus-branch checkout --name "${manifest.judge.winner}"`, 'talos:checkout')
if (!co.ok) return escalate('atropos:state', [`could not check out winner: ${co.errorTail || JSON.stringify(co.output)}`])
await talos(`olympus-state commit "chore(olympus): run state for ${manifest.unitId}"`, 'talos:state-commit')

const flagged = (manifest.passes || []).flatMap((p) => p.flaggedDecisions || [])
const hebe = await agent(
  `Open the pull request for unit ${manifest.unitId}.\n` +
    `Winning branch: ${manifest.judge.winner}. Target branch: ${manifest.conventions.prTargetBranch || 'main'}.\n` +
    `Spec: "${manifest.spec.path}". Conventions: .olympus/config.json (conventions).\n` +
    `Run facts for the PR body: passes ${JSON.stringify((manifest.passes || []).map((p) => ({ n: p.n, outcome: p.outcome })))}; ` +
    `judge rationale: ${manifest.judge.rationale}; ` +
    `flagged decisions a human must see: ${flagged.length ? flagged.join('; ') : 'none'}.\n` +
    `Write the PR body per your definition, open the PR, watch every merge check to completion, report outcomes.`,
  { agentType: 'hebe', schema: HEBE_SCHEMA, label: 'hebe:pr', phase: 'Ship', effort: 'xhigh' }
)
if (!hebe) throw new Error('Hebe (pr) returned nothing')

await talos(`olympus-state merge ${esc({ pr: { url: hebe.url, checks: hebe.checks } })}`, 'talos:record-pr')

const failing = hebe.checks.filter((c) => c.status !== 'pass')
if (failing.length > 0 || hebe.needsHuman.length > 0) {
  await talos(`olympus-state step ship escalated ${esc({ url: hebe.url })}`, 'talos:step')
  return escalate(
    'atropos:checks',
    failing
      .map((c) => `${c.name}: ${c.status}${c.failureExcerpt ? ` — ${c.failureExcerpt}` : ''}`)
      .concat(hebe.needsHuman),
    { url: hebe.url, oneLiner: hebe.oneLiner, unit: manifest.unitId }
  )
}

await talos(`olympus-state step ship done ${esc({ url: hebe.url })}`, 'talos:step')

// The 3a protocol: the PR handoff is minimal — link, one line, human items.
return {
  status: 'done',
  seam: 'atropos',
  unit: manifest.unitId,
  url: hebe.url,
  oneLiner: hebe.oneLiner,
  humanDecisions: flagged,
  escalations: [],
}
