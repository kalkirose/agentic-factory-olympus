export const meta = {
  name: 'lachesis',
  description: 'Lachesis (build): the dev loop. Fresh passes against the frozen suite until 3 greens or 6 passes; script-owned verdict; Minos picks the winner.',
  whenToUse: 'Second phase of an Olympus run. Requires a frozen suite from Clotho.',
  phases: [
    { title: 'Build loop', detail: 'fresh Hephaestus per pass; Mentor between passes; verdict per pass' },
    { title: 'Judge', detail: 'Minos scores green branches independently and picks' },
  ],
}

const GREENS_TARGET = 3
const MAX_PASSES = 6
const MAX_CONTINUATIONS_PER_PASS = 1

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
    { agentType: 'talos', schema: TALOS_SCHEMA, label, phase: phaseName, effort: 'low' }
  )
  if (!r) throw new Error(`talos relay returned nothing for: ${scriptWithArgs}`)
  return r
}
const esc = (o) => JSON.stringify(JSON.stringify(o))
function escalate(seam, items, extra) {
  return { status: 'escalation', seam, escalations: items, ...(extra || {}) }
}

// ------------------------------------------------------------------- Set up
phase('Build loop')
const state = await talos('olympus-state get', 'talos:state', 'Build loop')
if (!state.ok) return escalate('lachesis:state', [`no active run: ${state.errorTail || JSON.stringify(state.output)}`])
const manifest = state.output.manifest
const frozen = manifest.frozenTests
if (!frozen || !frozen.sha) return escalate('lachesis:state', ['no frozen suite — run olympus:clotho first'])

const unitId = manifest.unitId
const safeId = unitId.replace(/[^a-zA-Z0-9._-]/g, '-')
const baseBranch = (manifest.conventions.branchTemplate || 'olympus/{unit}').replace('{unit}', safeId)
const passes = Array.isArray(manifest.passes) ? manifest.passes.slice() : []
if (passes.length) log(`Resuming: ${passes.length} pass(es) recorded, ${passes.filter((p) => p.outcome === 'green').length} green`)

const HEPHAESTUS_SCHEMA = {
  type: 'object',
  properties: {
    reportedDone: { type: 'boolean' },
    summary: { type: 'string' },
    flaggedDecisions: { type: 'array', items: { type: 'string' } },
    stoppedForBudget: { type: 'boolean' },
  },
  required: ['reportedDone', 'summary', 'flaggedDecisions', 'stoppedForBudget'],
}
const MENTOR_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['continue', 'abort'] },
    route: { type: 'string', enum: ['none', 'spec-seam', 'environment'] },
    evidence: { type: 'array', items: { type: 'string' } },
    consolidated: { type: 'string' },
  },
  required: ['decision', 'route', 'evidence', 'consolidated'],
}

function contextPackage(passN) {
  return (
    `You are pass ${passN} of at most ${MAX_PASSES} for unit ${unitId}.\n` +
    `Validated spec: "${manifest.spec.path}".\n` +
    `Frozen suite: SHA ${frozen.sha}; paths: ${frozen.paths.join(', ')}.\n` +
    `Commands — layers: ${JSON.stringify(manifest.commands.fullSuite)}; typecheck: ${manifest.commands.typecheck || '(none)'}${manifest.commands.targetedHint ? `; targeted runs: ${manifest.commands.targetedHint}` : ''}.\n` +
    `Learnings file (read first, append your entry last): "${manifest.learningsPath}".\n` +
    `Project conventions doc: "${(manifest.docPaths && manifest.docPaths.conventions) || '(none listed)'}".\n` +
    `Design-doc pointers live in .olympus/config.json under docPaths — retrieve on demand, never preload.\n` +
    `Prior pass outcomes: ${passes.length ? passes.map((p) => `#${p.n}:${p.outcome}`).join(' ') : 'none'}.`
  )
}

async function runVerdict(n, branch) {
  const v = await talos(`olympus-verdict --pass ${n} --expect-branch "${branch}"`, `talos:verdict-${n}`, 'Build loop')
  if (!v.ok && !v.output) return { pass: false, checks: [], error: v.errorTail || 'verdict script failed to run' }
  return v.output
}

function failedChecksSummary(verdict) {
  return (verdict.checks || [])
    .filter((c) => !c.ok)
    .map((c) => `${c.name} (exit ${c.exitCode}):\n${c.tail}`)
    .join('\n---\n')
}

// -------------------------------------------------------------- The Q4 loop
let greens = passes.filter((p) => p.outcome === 'green').length
while (greens < GREENS_TARGET && passes.length < MAX_PASSES) {
  const n = passes.length + 1
  const branch = `${baseBranch}-pass-${n}`

  const br = await talos(`olympus-branch create --name "${branch}" --from ${frozen.sha}`, `talos:branch-${n}`, 'Build loop')
  if (!br.ok) return escalate('lachesis:state', [`branch create failed for pass ${n}: ${br.errorTail || JSON.stringify(br.output)}`])

  let dev = await agent(contextPackage(n), {
    agentType: 'hephaestus',
    schema: HEPHAESTUS_SCHEMA,
    label: `hephaestus:pass-${n}`,
    phase: 'Build loop',
    effort: 'max',
  })
  if (!dev) {
    log(`Pass ${n}: spawn glitch (empty return); re-dispatching once`)
    dev = await agent(contextPackage(n), {
      agentType: 'hephaestus',
      schema: HEPHAESTUS_SCHEMA,
      label: `hephaestus:pass-${n}-retry`,
      phase: 'Build loop',
      effort: 'max',
    })
  }

  let outcome = 'failed'
  let verdict = null
  if (dev) {
    verdict = await runVerdict(n, branch)
    let continuations = 0
    while (!verdict.pass && !dev.stoppedForBudget && continuations < MAX_CONTINUATIONS_PER_PASS) {
      continuations++
      const findings = failedChecksSummary(verdict)
      log(`Pass ${n}: verdict failed; handing findings back (continuation ${continuations})`)
      dev = await agent(
        contextPackage(n) +
          `\n\nCONTINUATION OF PASS ${n}: the official verdict failed on branch ${branch}. ` +
          `Your prior commits are on the branch; fix exactly what these findings name, re-run, commit, report.\n` +
          `Findings:\n${findings}`,
        { agentType: 'hephaestus', schema: HEPHAESTUS_SCHEMA, label: `hephaestus:pass-${n}-cont`, phase: 'Build loop', effort: 'max' }
      )
      if (!dev) break
      verdict = await runVerdict(n, branch)
    }
    if (verdict.pass) outcome = 'green'
    else if (dev && dev.stoppedForBudget) outcome = 'budget'
  } else {
    outcome = 'spawn-glitch'
  }

  const entry = {
    n,
    outcome,
    branch,
    summary: dev ? dev.summary : 'agent returned nothing twice',
    flaggedDecisions: dev ? dev.flaggedDecisions : [],
    verdict: verdict ? { pass: verdict.pass, failed: (verdict.checks || []).filter((c) => !c.ok).map((c) => c.name), flags: verdict.flags || [] } : null,
  }
  passes.push(entry)
  if (outcome === 'green') greens++
  else {
    // Losing/failed branches are deleted at the end; failed ones now (4b: only greens persist).
    await talos(`olympus-branch create --name "${baseBranch}" --from ${frozen.sha}`, `talos:park-${n}`, 'Build loop')
    await talos(`olympus-branch delete --name "${branch}"`, `talos:cleanup-${n}`, 'Build loop')
  }
  await talos(`olympus-state merge ${esc({ passes })}`, `talos:record-${n}`, 'Build loop')
  log(`Pass ${n}: ${outcome} (${greens}/${GREENS_TARGET} green, ${passes.length}/${MAX_PASSES} passes)`)

  if (greens < GREENS_TARGET && passes.length < MAX_PASSES) {
    const mentor = await agent(
      `Between-pass check for unit ${unitId}. Learnings file: "${manifest.learningsPath}". ` +
        `Run state: ${JSON.stringify(passes.map((p) => ({ n: p.n, outcome: p.outcome, failed: p.verdict && p.verdict.failed })))}.\n` +
        `Make the continue/abort call and consolidate the learnings file per your definition.`,
      { agentType: 'mentor', schema: MENTOR_SCHEMA, label: `mentor:after-${n}`, phase: 'Build loop', effort: 'xhigh' }
    )
    if (mentor && mentor.decision === 'abort') {
      await talos(`olympus-state step build-loop aborted ${esc({ route: mentor.route, evidence: mentor.evidence })}`, 'talos:abort', 'Build loop')
      return escalate(`lachesis:${mentor.route}`, mentor.evidence, { unit: unitId, passesRun: passes.length, greens })
    }
  }
}

if (greens === 0) {
  await talos(`olympus-state step build-loop failed ${esc({ passesRun: passes.length })}`, 'talos:fail', 'Build loop')
  return escalate('lachesis:no-green', passes.map((p) => `pass ${p.n}: ${p.outcome} — ${p.summary}`), { unit: unitId })
}

// -------------------------------------------------------------------- Judge
phase('Judge')
const greenBranches = passes.filter((p) => p.outcome === 'green').map((p) => p.branch)
const MINOS_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          total: { type: 'number' },
          dims: { type: 'object', additionalProperties: true },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['branch', 'total', 'evidence'],
      },
    },
    winner: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['scores', 'winner', 'rationale'],
}
const minos = await agent(
  `Judge the green candidates for unit ${unitId}. Spec: "${manifest.spec.path}". ` +
    `Frozen base SHA: ${frozen.sha}. Candidates (in pass order — score strictly one at a time, in this order): ${greenBranches.join(', ')}.\n` +
    `Read each candidate's diff with: git diff ${frozen.sha}..<branch>. Follow the isolation protocol and rubric in your definition. ` +
    `Tie goes to the later pass.`,
  { agentType: 'minos', schema: MINOS_SCHEMA, label: 'minos:judge', phase: 'Judge', effort: 'xhigh' }
)
if (!minos || !greenBranches.includes(minos.winner)) {
  return escalate('lachesis:judge', ['Minos (judge) failed to return a valid pick'], { candidates: greenBranches })
}

// Check the winner out first: HEAD may sit on a losing branch, and the
// delete script refuses to remove the checked-out branch.
const co = await talos(`olympus-branch checkout --name "${minos.winner}"`, 'talos:checkout-winner', 'Judge')
if (!co.ok) return escalate('lachesis:state', [`could not check out winner: ${co.errorTail || JSON.stringify(co.output)}`])
for (const b of greenBranches) {
  if (b !== minos.winner) await talos(`olympus-branch delete --name "${b}"`, 'talos:prune', 'Judge')
}
await talos(
  `olympus-state merge ${esc({ judge: { winner: minos.winner, scores: minos.scores, rationale: minos.rationale }, phase: 'atropos' })}`,
  'talos:judge-record', 'Judge'
)

return {
  status: 'done',
  seam: 'lachesis',
  unit: unitId,
  greens,
  passesRun: passes.length,
  winner: minos.winner,
  judgeRationale: minos.rationale,
  flaggedDecisions: passes.flatMap((p) => p.flaggedDecisions || []),
  escalations: [],
}
