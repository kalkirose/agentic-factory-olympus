export const meta = {
  name: 'clotho',
  description: 'Clotho (spec + tests): readiness, spec validation, test authoring, red-state check, freeze',
  whenToUse: 'First phase of an Olympus run. Produces a validated spec and a frozen acceptance suite at a SHA.',
  phases: [
    { title: 'Readiness', detail: 'Iris: next unit + prerequisites' },
    { title: 'Spec', detail: 'Cassandra: drift + intrinsic validation' },
    { title: 'Tests', detail: 'Daedalus authors, red-state runs, Argus validates' },
    { title: 'Freeze', detail: 'suite committed, SHA recorded' },
  ],
}

// ---- talos relay: every mechanical step goes through one deterministic
// bin script; the relay agent returns its JSON verbatim. ----
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
const esc = (o) => JSON.stringify(JSON.stringify(o)) // JSON arg, shell-quoted

function escalate(seam, items, extra) {
  return { status: 'escalation', seam, escalations: items, ...(extra || {}) }
}

// ---------------------------------------------------------------- Readiness
phase('Readiness')
const requestedUnit = args && args.unitId ? String(args.unitId) : null

const IRIS_SCHEMA = {
  type: 'object',
  properties: {
    unitId: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    specPath: { type: 'string' },
    ready: { type: 'boolean' },
    unmet: { type: 'array', items: { type: 'string' } },
  },
  required: ['unitId', 'title', 'summary', 'ready', 'unmet'],
}
const iris = await agent(
  (requestedUnit
    ? `The unit of work to check is "${requestedUnit}". Do not pick a different one.\n`
    : `Find the next unit of work using the project's next-unit query in .olympus/config.json.\n`) +
    `Then run the full readiness check from your definition. Include the path to the unit's spec file as specPath.`,
  { agentType: 'iris', schema: IRIS_SCHEMA, label: 'iris:readiness', phase: 'Readiness', effort: 'xhigh' }
)
if (!iris) throw new Error('Iris (scout) returned nothing')
if (!iris.ready) {
  return escalate('clotho:readiness', iris.unmet, { unit: iris.unitId, title: iris.title })
}

const init = await talos(`olympus-state init "${iris.unitId}"`, 'talos:init', 'Readiness')
if (!init.ok) return escalate('clotho:state', [`state init failed: ${init.errorTail || JSON.stringify(init.output)}`])
const manifest = init.output.manifest
const resumed = init.output.resumed === true
if (resumed) log(`Resuming run for ${iris.unitId} at first incomplete step`)

const conv = manifest.conventions || {}
const baseBranch = (conv.branchTemplate || 'olympus/{unit}').replace('{unit}', iris.unitId.replace(/[^a-zA-Z0-9._-]/g, '-'))
const steps = manifest.steps || {}

if (!steps['branch'] || steps['branch'].status !== 'done') {
  const br = await talos(
    `olympus-branch create --name "${baseBranch}" --from ${conv.prTargetBranch || 'main'}`,
    'talos:branch', 'Readiness'
  )
  if (!br.ok) return escalate('clotho:state', [`branch create failed: ${br.errorTail || JSON.stringify(br.output)}`])
  await talos(`olympus-state step branch done ${esc({ branch: baseBranch })}`, 'talos:step', 'Readiness')
  await talos(`olympus-state merge ${esc({ spec: { path: iris.specPath || null } })}`, 'talos:merge', 'Readiness')
}

// --------------------------------------------------------------------- Spec
phase('Spec')
const CASSANDRA_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'blocked'] },
    findingsPath: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'REVISION', 'NOTE'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'summary', 'evidence'],
      },
    },
  },
  required: ['verdict', 'findings', 'findingsPath'],
}
let cassandra = null
if (!steps['spec-validation'] || steps['spec-validation'].status !== 'done') {
  const findingsPath = `.olympus/state/runs/${iris.unitId.replace(/[^a-zA-Z0-9._-]/g, '-')}/spec-findings.md`
  cassandra = await agent(
    `Validate the spec at "${iris.specPath}" for unit ${iris.unitId} (${iris.title}).\n` +
      `Doc pointers live in .olympus/config.json under docPaths — retrieve on demand.\n` +
      `Write your findings file to "${findingsPath}". Run all three checks from your definition.`,
    { agentType: 'cassandra', schema: CASSANDRA_SCHEMA, label: 'cassandra:spec', phase: 'Spec', effort: 'xhigh' }
  )
  if (!cassandra) throw new Error('Cassandra (spec) returned nothing')
  const hard = cassandra.findings.filter((f) => f.severity === 'BLOCKER' || f.severity === 'REVISION')
  if (cassandra.verdict === 'blocked' || hard.length > 0) {
    await talos(`olympus-state step spec-validation escalated ${esc({ findingsPath: cassandra.findingsPath })}`, 'talos:step', 'Spec')
    return escalate(
      'clotho:spec',
      hard.map((f) => `${f.severity}: ${f.summary} (${f.evidence})`),
      { findingsPath: cassandra.findingsPath, unit: iris.unitId }
    )
  }
  await talos(`olympus-state step spec-validation done ${esc({ findingsPath: cassandra.findingsPath, notes: cassandra.findings.length })}`, 'talos:step', 'Spec')
}

// -------------------------------------------------------------------- Tests
phase('Tests')
const runDir = `.olympus/state/runs/${iris.unitId.replace(/[^a-zA-Z0-9._-]/g, '-')}`
const matrixPath = `${runDir}/traceability.md`
const DAEDALUS_SCHEMA = {
  type: 'object',
  properties: {
    testFiles: { type: 'array', items: { type: 'string' } },
    matrixPath: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' } },
  },
  required: ['testFiles', 'matrixPath', 'findings', 'deviations'],
}
const ARGUS_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'blocked'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'NOTE'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'summary', 'evidence'],
      },
    },
  },
  required: ['verdict', 'findings'],
}

let suite = steps['test-author'] && steps['test-author'].status === 'done' ? steps['test-author'].result : null
let frozen = manifest.frozenTests

if (!frozen) {
  let argusFindings = null
  for (let round = 1; round <= 2 && !frozen; round++) {
    if (!suite || argusFindings) {
      suite = await agent(
        `Author the acceptance suite for unit ${iris.unitId} from the validated spec at "${iris.specPath}".\n` +
          `Cassandra's findings file: "${(cassandra && cassandra.findingsPath) || (steps['spec-validation'] && steps['spec-validation'].findingsPath) || 'none'}" — read the NOTEs.\n` +
          `Test commands and conventions: .olympus/config.json (commands, docPaths.conventions).\n` +
          `Write the traceability matrix to "${matrixPath}".\n` +
          (argusFindings
            ? `REPAIR ROUND: the validator blocked the previous suite. Fix exactly these findings:\n${argusFindings}\n`
            : '') +
          `Work on the current branch (${baseBranch}). Do not commit; the freeze step commits.`,
        { agentType: 'daedalus', schema: DAEDALUS_SCHEMA, label: `daedalus:author-r${round}`, phase: 'Tests', effort: 'xhigh' }
      )
      if (!suite) throw new Error('Daedalus (tests) returned nothing')
    }

    const red = await talos('olympus-redstate', 'talos:redstate', 'Tests')
    if (!red.ok) return escalate('clotho:environment', [`red-state run failed to execute: ${red.errorTail || JSON.stringify(red.output)}`])

    const argus = await agent(
      `Validate the authored suite for unit ${iris.unitId}.\n` +
        `Spec: "${iris.specPath}". Matrix: "${suite.matrixPath}". Test files: ${suite.testFiles.join(', ')}.\n` +
        `Red-state run results (raw):\n${JSON.stringify(red.output.results || red.output)}\n` +
        `Run every check from your definition.`,
      { agentType: 'argus', schema: ARGUS_SCHEMA, label: `argus:validate-r${round}`, phase: 'Tests', effort: 'xhigh' }
    )
    if (!argus) throw new Error('Argus (validator) returned nothing')

    const blockers = argus.findings.filter((f) => f.severity === 'BLOCKER')
    if (argus.verdict === 'pass' && blockers.length === 0) {
      await talos(`olympus-state step test-author done ${esc({ files: suite.testFiles.length, matrix: suite.matrixPath })}`, 'talos:step', 'Tests')
      phase('Freeze')
      const freezePaths = suite.testFiles.concat([suite.matrixPath]).join(',')
      const fr = await talos(`olympus-freeze --paths "${freezePaths}"`, 'talos:freeze', 'Freeze')
      if (!fr.ok) return escalate('clotho:state', [`freeze failed: ${fr.errorTail || JSON.stringify(fr.output)}`])
      frozen = fr.output.frozenTests
      await talos(`olympus-state step freeze done ${esc({ sha: frozen.sha })}`, 'talos:step', 'Freeze')
    } else if (round === 2) {
      return escalate(
        'clotho:tests',
        blockers.map((f) => `BLOCKER: ${f.summary} (${f.evidence})`),
        { unit: iris.unitId, note: 'suite still blocked after one repair round' }
      )
    } else {
      argusFindings = blockers.map((f) => `- ${f.summary} (${f.evidence})`).join('\n')
      log(`Argus blocked the suite (${blockers.length} findings); one repair round`)
    }
  }
}

return {
  status: 'done',
  seam: 'clotho',
  unit: { id: iris.unitId, title: iris.title, summary: iris.summary },
  branch: baseBranch,
  frozen: { sha: frozen.sha, paths: frozen.paths },
  escalations: [],
}
