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
    { agentType: 'olympus:talos', schema: TALOS_SCHEMA, label, phase: phaseName, effort: 'low' }
  )
  if (!r) throw new Error(`talos relay returned nothing for: ${scriptWithArgs}`)
  return r
}
const esc = (o) => JSON.stringify(JSON.stringify(o)) // JSON arg, shell-quoted

function escalate(seam, items, extra) {
  return { status: 'escalation', seam, escalations: items, ...(extra || {}) }
}
// Cleanup steps are best-effort; they must never kill a run that already
// has its result.
async function talosSoft(scriptWithArgs, label, phaseName) {
  try {
    return await talos(scriptWithArgs, label, phaseName)
  } catch (e) {
    log(`cleanup step failed (non-fatal): ${scriptWithArgs}`)
    return { ok: false }
  }
}

// ---- Fable-seat dispatch: the judgment seats (cassandra, daedalus, minos)
// run claude-fable-5 by definition. When that dispatch dies (model
// unavailable, terminal API error) the -opus variant — same role, prompt
// re-tuned for Opus 4.8 — takes the seat, logged and recorded in learnings.
// Config models.fableSeats: 'auto' (default: try fable, fall back) |
// 'opus' (dispatch variants directly) | 'fable' (never fall back).
let fableSeatPref = 'auto'
async function seatAgent(seat, prompt, opts) {
  if (fableSeatPref !== 'opus') {
    const r = await agent(prompt, { ...opts, agentType: `olympus:${seat}` })
    if (r) return r
    if (fableSeatPref === 'fable') throw new Error(`${seat} (fable seat) returned nothing and fallback is disabled (models.fableSeats: 'fable')`)
    log(`${seat}: fable dispatch returned nothing — falling back to ${seat}-opus`)
    await talosSoft(
      `olympus-state learn ${esc(`Fable seat '${seat}' fell back to '${seat}-opus' (dispatch returned nothing — model unavailable or terminal error). Ledger comparisons for this run must account for the seat model change.`)}`,
      'talos:seat-fallback', opts.phase
    )
  }
  return agent(prompt, { ...opts, agentType: `olympus:${seat}-opus`, label: `${(opts && opts.label) || seat}-opus` })
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
  { agentType: 'olympus:iris', schema: IRIS_SCHEMA, label: 'iris:readiness', phase: 'Readiness', effort: 'xhigh' }
)
if (!iris) throw new Error('Iris (scout) returned nothing')
if (!iris.ready) {
  return escalate('clotho:readiness', iris.unmet, { unit: iris.unitId, title: iris.title })
}

const init = await talos(`olympus-state init "${iris.unitId}"`, 'talos:init', 'Readiness')
if (!init.ok) return escalate('clotho:state', [`state init failed: ${init.errorTail || JSON.stringify(init.output)}`])
const resumed = init.output.resumed === true
if (resumed) {
  log(`Resuming run for ${iris.unitId} at first incomplete step`)
  // A resumed manifest carries init-time config; refresh config-derived
  // fields so mid-run config edits reach the run (state is never touched).
  await talos('olympus-state resync', 'talos:resync', 'Readiness')
}
const refreshed = await talos('olympus-state get', 'talos:get', 'Readiness')
const manifest = refreshed.ok ? refreshed.output.manifest : init.output.manifest

const conv = manifest.conventions || {}
const baseBranch = (conv.branchTemplate || 'olympus/{unit}').replace('{unit}', iris.unitId.replace(/[^a-zA-Z0-9._-]/g, '-'))
const steps = manifest.steps || {}
fableSeatPref = (manifest.models && manifest.models.fableSeats) || 'auto'

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
  await talos('olympus-state step spec-validation started', 'talos:step', 'Spec')
  cassandra = await seatAgent('cassandra',
    `Validate the spec at "${iris.specPath}" for unit ${iris.unitId} (${iris.title}).\n` +
      `Doc pointers live in .olympus/config.json under docPaths — retrieve on demand.\n` +
      `Write your findings file to "${findingsPath}". Run all three checks from your definition.`,
    { schema: CASSANDRA_SCHEMA, label: 'cassandra:spec', phase: 'Spec', effort: 'xhigh' }
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

const DOLOS_SCHEMA = {
  type: 'object',
  properties: {
    implementations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          faultClass: { type: 'string' },
          clause: { type: 'string' },
          expectedKiller: { type: 'string' },
        },
        required: ['id', 'faultClass', 'clause', 'expectedKiller'],
      },
    },
  },
  required: ['implementations'],
}
const TEST_MINOS_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          total: { type: 'number' },
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

// Author one suite on the current branch; validate; return the candidate
// record or an escalation-shaped error. One Argus repair round included.
async function authorAndValidate(passLabel, extraPrompt) {
  let suite = null
  let argusFindings = null
  for (let round = 1; round <= 2; round++) {
    await talos('olympus-state step test-author started', 'talos:step', 'Tests')
    suite = await seatAgent('daedalus',
      `Author the acceptance suite for unit ${iris.unitId} from the validated spec at "${iris.specPath}".\n` +
        `Cassandra's findings file: "${(cassandra && cassandra.findingsPath) || (steps['spec-validation'] && steps['spec-validation'].findingsPath) || 'none'}" — read the NOTEs.\n` +
        `Test commands and conventions: .olympus/config.json (commands, docPaths.conventions).\n` +
        `Write the traceability matrix to "${matrixPath}".\n` +
        (extraPrompt || '') +
        (argusFindings ? `REPAIR ROUND: the validator blocked the previous suite. Fix exactly these findings:\n${argusFindings}\n` : '') +
        `Append a distilled learnings entry to "${manifest.learningsPath}" when you are done (test-authoring discipline: what constrained well, what was hard to express, spec gaps).\n` +
        `Do not commit; the harness owns commits.`,
      { schema: DAEDALUS_SCHEMA, label: `daedalus:${passLabel}-r${round}`, phase: 'Tests', effort: 'xhigh' }
    )
    if (!suite) throw new Error('Daedalus (tests) returned nothing')

    const red = await talos('olympus-redstate', 'talos:redstate', 'Tests')
    if (!red.ok) return { error: escalate('clotho:environment', [`red-state run failed to execute: ${red.errorTail || JSON.stringify(red.output)}`]) }

    const argus = await agent(
      `Validate the authored suite for unit ${iris.unitId}.\n` +
        `Spec: "${iris.specPath}". Matrix: "${suite.matrixPath}". Test files: ${suite.testFiles.join(', ')}.\n` +
        `Red-state run results (raw):\n${JSON.stringify(red.output.results || red.output)}\n` +
        `Run every check from your definition.`,
      { agentType: 'olympus:argus', schema: ARGUS_SCHEMA, label: `argus:${passLabel}-r${round}`, phase: 'Tests', effort: 'xhigh' }
    )
    if (!argus) throw new Error('Argus (validator) returned nothing')
    const blockers = argus.findings.filter((f) => f.severity === 'BLOCKER')
    if (argus.verdict === 'pass' && blockers.length === 0) {
      await talos(`olympus-state step test-author done ${esc({ files: suite.testFiles.length, matrix: suite.matrixPath })}`, 'talos:step', 'Tests')
      return { suite, notes: argus.findings.filter((f) => f.severity === 'NOTE').length }
    }
    if (round === 2) {
      return {
        error: escalate('clotho:tests', blockers.map((f) => `BLOCKER: ${f.summary} (${f.evidence})`), {
          unit: iris.unitId,
          note: 'suite still blocked after one repair round',
        }),
      }
    }
    argusFindings = blockers.map((f) => `- ${f.summary} (${f.evidence})`).join('\n')
    log(`Argus blocked the suite (${blockers.length} findings); one repair round`)
  }
  return { error: escalate('clotho:tests', ['unreachable'], {}) }
}

async function killSweep(suite, label) {
  if (!tr.adversaryCount || !tr.killRateCommand) return null
  const cmd = tr.killRateCommand.split('{tests}').join(suite.testFiles.map((f) => `"${f}"`).join(' '))
  const sweep = await talos(`olympus-adversary sweep --dir "${adversaryDir}" --command ${esc(cmd)}`, `talos:sweep-${label}`, 'Tests')
  if (!sweep.ok) {
    log(`kill sweep failed for ${label}: ${sweep.errorTail || JSON.stringify(sweep.output)}`)
    return null
  }
  return sweep.output
}

let frozen = manifest.frozenTests
const tr = manifest.testRalph || { passes: 1, adversaryCount: 0, refinementRounds: 0 }
const adversaryDir = `${runDir}/adversary`

if (!frozen) {
  // Adversary set: generated once, reused across every candidate suite.
  if (tr.adversaryCount > 0 && !(steps['adversary'] && steps['adversary'].status === 'done')) {
    const dolos = await agent(
      `Write ${tr.adversaryCount} plausible WRONG implementations for unit ${iris.unitId}.\n` +
        `Spec (your only oracle): "${iris.specPath}". Write each implementation under "${adversaryDir}/<id>/" ` +
        `mirroring repo-relative paths (e.g. ${adversaryDir}/w1/src/module.ts). Follow your definition: one deliberate ` +
        `spec-violating fault each, diverse fault classes, otherwise complete and plausible.`,
      { agentType: 'olympus:dolos', schema: DOLOS_SCHEMA, label: 'dolos:adversary', phase: 'Tests', effort: 'xhigh' }
    )
    if (!dolos) throw new Error('Dolos (adversary) returned nothing')
    await talos(`olympus-state step adversary done ${esc({ count: dolos.implementations.length, manifest: dolos.implementations })}`, 'talos:step', 'Tests')
  }

  if (tr.passes <= 1) {
    // Single-pass shape (the Phase-A skeleton, still config-reachable).
    const r = await authorAndValidate('author', `Work on the current branch (${baseBranch}).\n`)
    if (r.error) return r.error
    const sweep = await killSweep(r.suite, 'single')
    if (sweep) await talos(`olympus-state merge ${esc({ testKillRate: { killRate: sweep.killRate, survivors: sweep.survivors } })}`, 'talos:kill-record', 'Tests')
    phase('Freeze')
    const fr = await talos(`olympus-freeze --paths "${r.suite.testFiles.concat([r.suite.matrixPath]).join(',')}"`, 'talos:freeze', 'Freeze')
    if (!fr.ok) return escalate('clotho:state', [`freeze failed: ${fr.errorTail || JSON.stringify(fr.output)}`])
    frozen = fr.output.frozenTests
    await talos(`olympus-state step freeze done ${esc({ sha: frozen.sha })}`, 'talos:step', 'Freeze')
  } else {
    // Test tournament: P candidate suites on branches, judged, refined, frozen.
    const candidates = []
    for (let t = 1; t <= tr.passes; t++) {
      const tBranch = `${baseBranch}-tests-${t}`
      const br = await talos(`olympus-branch create --name "${tBranch}" --from "${baseBranch}"`, `talos:tbranch-${t}`, 'Tests')
      if (!br.ok) return escalate('clotho:state', [`test branch create failed: ${br.errorTail || JSON.stringify(br.output)}`])
      const r = await authorAndValidate(`t${t}`, `You are test pass ${t} of ${tr.passes}. Read the learnings file first — prior passes' entries steer you.\nWork on the current branch (${tBranch}).\n`)
      if (r.error) return r.error
      // Candidate suites are committed on their branch so the sweep and the
      // judge see a fixed artifact (adversary sweep requires a clean tree).
      await talos(`olympus-freeze --paths "${r.suite.testFiles.concat([r.suite.matrixPath]).join(',')}"`, `talos:tcommit-${t}`, 'Tests')
      const sweep = await killSweep(r.suite, `t${t}`)
      candidates.push({
        branch: tBranch,
        suite: r.suite,
        argusNotes: r.notes,
        killRate: sweep ? sweep.killRate : 'unmeasured',
        survivors: sweep ? sweep.survivors : [],
      })
      log(`Test pass ${t}: ${r.suite.testFiles.length} files, kill rate ${sweep ? sweep.killRate : 'unmeasured'}`)
    }

    const judge = await seatAgent('minos',
      `Judge the candidate TEST SUITES for unit ${iris.unitId} — individual, fact-anchored scoring; never side-by-side. ` +
        `Spec: "${iris.specPath}".\n` +
        `Candidates (score strictly one at a time, in this order):\n` +
        candidates.map((c) => `- ${c.branch}: files ${c.suite.testFiles.join(', ')}; matrix ${c.suite.matrixPath}; adversary kill rate ${c.killRate} (survivors: ${c.survivors.join(', ') || 'none'}); validator notes ${c.argusNotes}`).join('\n') +
        `\nRubric (fact-anchored, per your isolation protocol): traceability completeness both directions (count gaps from the matrix); ` +
        `adversary kill rate (given above — higher is better); compound-condition depth; smell absence; red-state validity. ` +
        `Do NOT score line coverage or executability. Read each branch in isolation (git diff ${'`'}${baseBranch}${'`'}..<branch>). Tie goes to the later pass.`,
      { schema: TEST_MINOS_SCHEMA, label: 'minos:test-judge', phase: 'Tests', effort: 'xhigh' }
    )
    if (!judge || !candidates.some((c) => c.branch === judge.winner)) {
      return escalate('clotho:test-judge', ['test judge failed to return a valid pick'], { candidates: candidates.map((c) => c.branch) })
    }
    const winner = candidates.find((c) => c.branch === judge.winner)
    log(`Test judge picked ${winner.branch}: ${judge.rationale.slice(0, 160)}`)

    // The story branch adopts the winning suite; losing branches vanish.
    const adopt = await talos(`olympus-branch create --name "${baseBranch}" --from "${winner.branch}"`, 'talos:adopt', 'Tests')
    if (!adopt.ok) return escalate('clotho:state', [`could not adopt winning suite: ${adopt.errorTail || JSON.stringify(adopt.output)}`])
    for (const c of candidates) {
      if (c.branch !== winner.branch) await talosSoft(`olympus-branch delete --name "${c.branch}"`, 'talos:tprune', 'Tests')
    }
    await talosSoft(`olympus-branch delete --name "${winner.branch}"`, 'talos:tprune-winner', 'Tests')

    // Bounded refinement against exactly the wrong implementations the
    // winner failed to kill, then freeze.
    let survivors = winner.survivors
    let suite = winner.suite
    for (let round = 1; round <= (tr.refinementRounds || 0) && survivors.length; round++) {
      log(`Refinement round ${round}: strengthening against survivors ${survivors.join(', ')}`)
      const refined = await seatAgent('daedalus',
        `REFINEMENT ROUND ${round} for the winning suite of unit ${iris.unitId} (files: ${suite.testFiles.join(', ')}).\n` +
          `These adversary implementations under "${adversaryDir}" SURVIVED the suite: ${survivors.join(', ')}. ` +
          `Read each survivor's fault (their manifest entries are in the run manifest step "adversary"), and strengthen the suite ` +
          `to kill exactly those faults — from the SPEC's language, not from the wrong code's shape. Update the matrix. ` +
          `Spec: "${iris.specPath}". Do not weaken or remove existing tests. Do not commit.`,
        { schema: DAEDALUS_SCHEMA, label: `daedalus:refine-${round}`, phase: 'Tests', effort: 'xhigh' }
      )
      if (!refined) break
      suite = refined
      await talos(`olympus-freeze --paths "${suite.testFiles.concat([suite.matrixPath]).join(',')}"`, `talos:refreeze-${round}`, 'Tests')
      const sweep = await killSweep(suite, `refine-${round}`)
      survivors = sweep ? sweep.survivors : []
      await talos(`olympus-state merge ${esc({ testKillRate: { killRate: sweep ? sweep.killRate : 'unmeasured', survivors } })}`, 'talos:kill-record', 'Tests')
    }

    phase('Freeze')
    const fr = await talos(`olympus-freeze --paths "${suite.testFiles.concat([suite.matrixPath]).join(',')}"`, 'talos:freeze', 'Freeze')
    if (!fr.ok) return escalate('clotho:state', [`freeze failed: ${fr.errorTail || JSON.stringify(fr.output)}`])
    frozen = fr.output.frozenTests
    await talos(
      `olympus-state merge ${esc({ testJudge: { winner: judge.winner, rationale: judge.rationale, scores: judge.scores } })}`,
      'talos:test-judge-record', 'Freeze'
    )
    await talos(`olympus-state step freeze done ${esc({ sha: frozen.sha, survivorsAtFreeze: survivors })}`, 'talos:step', 'Freeze')
    if (survivors.length) log(`Frozen with ${survivors.length} surviving adversary implementation(s) — recorded for the eval ledger`)
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
