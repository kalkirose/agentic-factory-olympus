export const meta = {
  name: 'clotho',
  description: 'Clotho (spec + tests): readiness, distillation, spec validation, test authoring, red-state check, freeze',
  whenToUse: 'First phase of an Olympus run. Produces a validated spec and a frozen acceptance suite at a SHA.',
  phases: [
    { title: 'Readiness', detail: 'Iris: next unit + prerequisites' },
    { title: 'Distill', detail: 'Themis: ground the spec to the codebase; intent decisions escalate' },
    { title: 'Spec', detail: 'Cassandra: drift + intrinsic validation' },
    { title: 'Tests', detail: 'Daedalus authors, red-state runs, Argus validates' },
    { title: 'Freeze', detail: 'suite committed, SHA recorded' },
  ],
}

// ---- args normalization: the Workflow runtime can hand args through as a
// JSON string rather than an object. Normalize once; every later read goes
// through runArgs. A string that does not parse to an object degrades to
// no-args with a logged warning — it must never throw and kill the run. ----
let runArgs = args
if (typeof runArgs === 'string') {
  try {
    runArgs = JSON.parse(runArgs)
  } catch (e) {
    runArgs = null
  }
  if (runArgs === null || typeof runArgs !== 'object') {
    log('args arrived as a string that did not parse to an object — running with no args')
    runArgs = null
  }
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
          `Relay the output COMPLETE and VERBATIM — never truncate, summarize, or omit any field or key, whatever the size. ` +
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
const MIN_STATE_VERSION = '0.6.0'
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
// Terminal step writes are load-bearing: a lost 'done' leaves the manifest
// reading 'started' forever, so a resumed run redoes finished work and the
// step record lies to resync. One extra relay attempt beyond talos's own
// retry; the caller decides what a persistent failure means.
async function stepMust(scriptWithArgs, label, phaseName) {
  let r = await talos(scriptWithArgs, label, phaseName)
  if (!r.ok) {
    log(`terminal step write failed — one more relay attempt: ${scriptWithArgs}`)
    r = await talos(scriptWithArgs, `${label}-rewrite`, phaseName)
  }
  return r
}

// ---- Fable-seat dispatch: the judgment seats (cassandra, daedalus, minos)
// run the fable model class by definition. When that dispatch dies (model
// unavailable, terminal API error) the -opus variant — same role, prompt
// re-tuned for Opus 4.8 — takes the seat, logged and recorded in learnings.
// Config models.fableSeats: 'auto' (default: try fable, fall back) |
// 'opus' (dispatch variants directly) | 'fable' (never fall back).
let fableSeatPref = 'auto'
async function seatAgent(seatName, prompt, opts) {
  if (fableSeatPref !== 'opus') {
    const r = await seat(prompt, { ...opts, agentType: `olympus:${seatName}` })
    if (r) return r
    if (fableSeatPref === 'fable') throw new Error(`${seatName} (fable seat) returned nothing and fallback is disabled (models.fableSeats: 'fable')`)
    log(`${seatName}: fable dispatch returned nothing — falling back to ${seatName}-opus`)
    await talosSoft(
      `olympus-state learn ${esc(`Fable seat '${seatName}' fell back to '${seatName}-opus' (dispatch returned nothing — model unavailable or terminal error). Ledger comparisons for this run must account for the seat model change.`)} --status fact`,
      'talos:seat-fallback', opts.phase
    )
  }
  return seat(prompt, { ...opts, agentType: `olympus:${seatName}-opus`, label: `${(opts && opts.label) || seatName}-opus` })
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
      // State ≥ 0.6.1 always prints its key list (version-gated below); a
      // relayed manifest without one is a relay defect, never state truth.
      log('state relay dropped the keys list — retrying the relay')
    }
  }
  return { ok: false, errorTail: 'state relay corrupt after retry (integrity guard: relayed manifest missing declared keys)' }
}

// ---------------------------------------------------------------- Readiness
phase('Readiness')
const ver = await talos('olympus-state version', 'talos:version', 'Readiness')
const installedVersion = ver.ok && ver.output && ver.output.version
if (!installedVersion || versionLt(installedVersion, MIN_STATE_VERSION)) {
  return escalate('clotho:plugin', [
    `installed olympus plugin is stale (state version ${installedVersion || 'unknown'}, this workflow needs ≥ ${MIN_STATE_VERSION}) — reinstall the plugin, then re-run olympus:clotho`,
  ])
}
const requestedUnit = runArgs && runArgs.unitId ? String(runArgs.unitId) : null

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
const iris = await seat(
  (requestedUnit
    ? `The unit of work to check is "${requestedUnit}". Do not pick a different one.\n`
    : `Find the next unit of work using the project's next-unit query in .olympus/config.json.\n`) +
    `Then run the full readiness check from your definition. Include the path to the unit's spec file as specPath.`,
  { agentType: 'olympus:iris', schema: IRIS_SCHEMA, label: 'iris:readiness', phase: 'Readiness', effort: 'xhigh' }
)
if (!iris) return escalate('clotho:seat', ['Iris (scout) returned nothing after a retry — re-run olympus:clotho to resume'])
if (!iris.ready) {
  // Re-entry deadlock guard: a launch that carries the human answers for an
  // open distill/spec escalation IS the resolution of that escalation. Iris
  // is blind to workflow args, so it reports the open escalation as unmet —
  // escalating here would bounce the answers forever. Defer readiness to the
  // step that consumes them; a genuine blocker still kills that step.
  if (runArgs && (runArgs.distillDecisions || runArgs.specSignoff)) {
    log(`readiness: ${iris.unmet.length} unmet item(s) deferred — this launch carries the human decisions for the open escalation`)
  } else {
    return escalate('clotho:readiness', iris.unmet, { unit: iris.unitId, title: iris.title })
  }
}

const init = await talos(`olympus-state init "${iris.unitId}"`, 'talos:init', 'Readiness')
if (!init.ok) return escalate('clotho:state', [`state init failed: ${init.errorTail || JSON.stringify(init.output)}`])
const resumed = init.output.resumed === true
if (resumed) {
  log(`Resuming run for ${iris.unitId} at first incomplete step`)
  // A resumed manifest carries init-time config; refresh config-derived
  // fields so mid-run config edits reach the run (state is never touched).
  const rs = await talos('olympus-state resync', 'talos:resync', 'Readiness')
  if (rs.ok && rs.output && Array.isArray(rs.output.staleStarted) && rs.output.staleStarted.length) {
    log(
      `WARNING — steps still read "started" from a prior session: ${rs.output.staleStarted
        .map((s) => s.step)
        .join(', ')}. Their work may have completed without a terminal write (torn manifest); the resume re-runs them.`
    )
  }
}
const refreshed = await getState('Readiness')
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

const runDir = `.olympus/state/runs/${iris.unitId.replace(/[^a-zA-Z0-9._-]/g, '-')}`

// ------------------------------------------------------------------ Distill
phase('Distill')
const THEMIS_SCHEMA = {
  type: 'object',
  properties: {
    claimsResolved: { type: 'number' },
    claimTablePath: { type: 'string' },
    intentContractPath: { type: 'string' },
    specCommit: { type: 'string' },
    summary: { type: 'string' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['id', 'question', 'options'],
      },
    },
  },
  required: ['claimsResolved', 'claimTablePath', 'intentContractPath', 'decisions', 'summary'],
}
// The decisions may arrive as a text blob or as a {D1: ..., D2: ...} object —
// both are faithful transports. String() on an object is neither: it hands
// Themis the literal "[object Object]" and silently discards the human's
// answers (found live on the first distill re-entry, 3-3-preview-deploys).
const rawDecisions = runArgs ? runArgs.distillDecisions : null
const distillDecisions =
  rawDecisions == null
    ? null
    : typeof rawDecisions === 'string'
      ? rawDecisions
      : Object.entries(rawDecisions)
          .map(([id, answer]) => `DECISION ${id}: ${typeof answer === 'string' ? answer : JSON.stringify(answer)}`)
          .join('\n\n')
const specSignoff = !!(runArgs && runArgs.specSignoff === true)
const specValidated = !!(steps['spec-validation'] && steps['spec-validation'].status === 'done')
let distillClaims = (steps['distill'] && steps['distill'].claimsResolved) || 0
// Distill runs only while spec validation is still open: a run resumed past
// that gate must never take a late spec rewrite under an authored or frozen
// suite. args.specSignoff re-runs Distill so a human-signed spec revision is
// re-grounded (fresh intent contract + claim table) before Cassandra
// re-validates.
if (!specValidated && (specSignoff || !steps['distill'] || steps['distill'].status !== 'done')) {
  await talos('olympus-state step distill started', 'talos:step', 'Distill')
  const themis = await seat(
    `Distill the spec at "${iris.specPath}" for unit ${iris.unitId} (${iris.title}) per your definition.\n` +
      `Write intent-contract.md and claim-table.md under "${runDir}".\n` +
      (distillDecisions ? `HUMAN DECISIONS for the open decision list — apply them, then complete the auto path:\n${distillDecisions}\n` : '') +
      `Doc pointers: .olympus/config.json under docPaths.`,
    { agentType: 'olympus:themis', schema: THEMIS_SCHEMA, label: 'themis:distill', phase: 'Distill', effort: 'xhigh' }
  )
  if (!themis) return escalate('clotho:seat', ['Themis (distill) returned nothing after a retry — re-run olympus:clotho to resume'])
  if (themis.decisions && themis.decisions.length) {
    await talos(`olympus-state step distill escalated ${esc({ decisions: themis.decisions.length })}`, 'talos:step', 'Distill')
    return escalate(
      'clotho:distill',
      themis.decisions.map((d) => `DECISION ${d.id}: ${d.question} — options: ${d.options}${d.context ? ` (${d.context})` : ''}`),
      {
        unit: iris.unitId,
        intentContract: themis.intentContractPath,
        claimTable: themis.claimTablePath,
        instruction: 'Collect the human answers, then re-run olympus:clotho with args.distillDecisions carrying them verbatim per DECISION id.',
      }
    )
  }
  await talos(`olympus-state step distill done ${esc({ claimsResolved: themis.claimsResolved, specCommit: themis.specCommit || '' })}`, 'talos:step', 'Distill')
  distillClaims = themis.claimsResolved
  log(`Distilled: ${themis.claimsResolved} claims auto-resolved, 0 decisions — proceeding`)
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
  const findingsPath = `${runDir}/spec-findings.md`
  // Round cap: the spec gate gets 2 automatic validation rounds per unit;
  // only a human-signed spec revision (args.specSignoff) resets the budget.
  const prevRounds = (steps['spec-validation'] && steps['spec-validation'].rounds) || 0
  let effectivePrev = prevRounds
  if (specSignoff) {
    effectivePrev = 0
    log('args.specSignoff: human-signed spec revision resets the round budget')
  }
  if (effectivePrev >= 2) {
    return escalate('clotho:spec', ['spec gate exhausted its 2 rounds for this unit — human-signed spec revision required; re-run with args.specSignoff true after sign-off'], { unit: iris.unitId, rounds: effectivePrev })
  }
  // A sign-off reset is persisted with the started write so a crash before
  // the verdict cannot resurrect the stored round count on the next resume.
  await talos(`olympus-state step spec-validation started${specSignoff ? ` ${esc({ rounds: 0 })}` : ''}`, 'talos:step', 'Spec')
  cassandra = await seatAgent('cassandra',
    `Validate the spec at "${iris.specPath}" for unit ${iris.unitId} (${iris.title}).\n` +
      `Doc pointers live in .olympus/config.json under docPaths — retrieve on demand.\n` +
      `Write your findings file to "${findingsPath}". Run all the checks from your definition.\n` +
      `Distillation artifacts under "${runDir}" (intent-contract.md, claim-table.md) if present: verify INTENT FIDELITY (the spec must preserve every contract item; drift is a REVISION); claims already verified in the claim table need only spot-checks.`,
    { schema: CASSANDRA_SCHEMA, label: 'cassandra:spec', phase: 'Spec', effort: 'xhigh' }
  )
  if (!cassandra) return escalate('clotho:seat', ['Cassandra (spec) returned nothing after retry and fallback — re-run olympus:clotho to resume'])
  const hard = cassandra.findings.filter((f) => f.severity === 'BLOCKER' || f.severity === 'REVISION')
  if (cassandra.verdict === 'blocked' || hard.length > 0) {
    const rounds = effectivePrev + 1
    await talos(`olympus-state step spec-validation escalated ${esc({ findingsPath: cassandra.findingsPath, rounds })}`, 'talos:step', 'Spec')
    const items = hard.map((f) => `${f.severity}: ${f.summary} (${f.evidence})`)
    if (rounds >= 2) items.unshift('SPEC GATE NOT CONVERGING: round 2 of 2 — no further automatic validation passes; revise the spec with human sign-off, then re-run with args.specSignoff true.')
    return escalate(
      'clotho:spec',
      items,
      { findingsPath: cassandra.findingsPath, unit: iris.unitId, rounds }
    )
  }
  await talos(`olympus-state step spec-validation done ${esc({ findingsPath: cassandra.findingsPath, notes: cassandra.findings.length })}`, 'talos:step', 'Spec')
}

// -------------------------------------------------------------------- Tests
phase('Tests')
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
    // A completed authoring survives a torn manifest via the authoredSuite
    // record: reuse skips only the Daedalus dispatch — red-state and Argus
    // still gate the reused suite.
    const recorded = manifest.authoredSuite
    if (round === 1 && !argusFindings && recorded && recorded.label === passLabel && Array.isArray(recorded.files) && recorded.files.length) {
      suite = { testFiles: recorded.files, matrixPath: recorded.matrixPath, findings: [], deviations: [] }
      log(`Reusing authored suite from the manifest for ${passLabel} (${recorded.files.length} files) — Daedalus dispatch skipped; red-state + Argus still gate it`)
    } else {
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
      if (!suite) return { error: escalate('clotho:seat', ['Daedalus (tests) returned nothing after retry and fallback — re-run olympus:clotho to resume']) }
      await talos(`olympus-state merge ${esc({ authoredSuite: { files: suite.testFiles, matrixPath: suite.matrixPath, label: passLabel } })}`, 'talos:authored-record', 'Tests')
    }

    let red = await talos('olympus-redstate', 'talos:redstate', 'Tests')
    if (!red.ok) {
      log('red-state run failed to execute — one fresh relay retry')
      red = await talos('olympus-redstate', 'talos:redstate-retry', 'Tests')
    }
    if (!red.ok) return { error: escalate('clotho:environment', [`red-state run failed to execute: ${red.errorTail || JSON.stringify(red.output)}`]) }

    const argus = await seat(
      `Validate the authored suite for unit ${iris.unitId}.\n` +
        `Spec: "${iris.specPath}". Matrix: "${suite.matrixPath}". Test files: ${suite.testFiles.join(', ')}.\n` +
        `Red-state run results (raw):\n${JSON.stringify(red.output.results || red.output)}\n` +
        `Run every check from your definition.`,
      { agentType: 'olympus:argus', schema: ARGUS_SCHEMA, label: `argus:${passLabel}-r${round}`, phase: 'Tests', effort: 'xhigh' }
    )
    if (!argus) return { error: escalate('clotho:seat', ['Argus (validator) returned nothing after a retry — re-run olympus:clotho to resume']) }
    const blockers = argus.findings.filter((f) => f.severity === 'BLOCKER')
    if (argus.verdict === 'pass' && blockers.length === 0) {
      // The done write is verified: freezing over a dangling 'started' would
      // make the resume protocol treat finished authoring as torn.
      const done = await stepMust(`olympus-state step test-author done ${esc({ files: suite.testFiles.length, matrix: suite.matrixPath })}`, 'talos:step-author-done', 'Tests')
      if (!done.ok) {
        return {
          error: escalate('clotho:state', [
            `test-author done write failed twice: ${done.errorTail || JSON.stringify(done.output)} — the manifest still reads 'started'; the authored suite is recorded (authoredSuite), so re-running olympus:clotho reuses it`,
          ]),
        }
      }
      return { suite, notes: argus.findings.filter((f) => f.severity === 'NOTE').length }
    }
    if (round === 2) {
      await talosSoft(`olympus-state step test-author escalated ${esc({ blockers: blockers.length })}`, 'talos:step', 'Tests')
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
const trBase = manifest.testRalph || { passes: 1, adversaryCount: 0, refinementRounds: 0 }
const num = (v, d) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d)
// Per-invocation override: a single run can take a different suite count
// (e.g. one authored suite) without editing tracked config.
const tr = runArgs && runArgs.testPasses != null ? { ...trBase, passes: Math.max(1, num(runArgs.testPasses, trBase.passes)) } : trBase
if (runArgs && runArgs.testPasses != null) log(`Test-loop override from args: passes=${tr.passes}`)
const adversaryDir = `${runDir}/adversary`

// Survivor-driven strengthening, shared by both suite shapes: each round
// sends the surviving adversary faults back to the test author, re-freezes,
// re-sweeps, and records the new kill rate. A clean sweep ends it early.
// The test-author 'started'/'done' pair wraps the Daedalus dispatch alone,
// and the verified 'done' lands BEFORE the refreeze: olympus-freeze writes
// manifest.frozenTests unconditionally, so an interim-SHA write must never
// precede the step's termination — a crash between them would leave a
// frozen-looking manifest over a dangling 'started'. The authoredSuite
// record tracks the refined files so a resume reuses them, never a stale set.
async function refineAgainstSurvivors(suite, survivors, passLabel) {
  for (let round = 1; round <= (tr.refinementRounds || 0) && survivors.length; round++) {
    log(`Refinement round ${round}: strengthening against survivors ${survivors.join(', ')}`)
    await talos('olympus-state step test-author started', 'talos:step', 'Tests')
    const refined = await seatAgent('daedalus',
      `REFINEMENT ROUND ${round} for the suite of unit ${iris.unitId} (files: ${suite.testFiles.join(', ')}).\n` +
        `These adversary implementations under "${adversaryDir}" SURVIVED the suite: ${survivors.join(', ')}. ` +
        `Read each survivor's fault (their manifest entries are in the run manifest step "adversary"), and strengthen the suite ` +
        `to kill exactly those faults — from the SPEC's language, not from the wrong code's shape. Update the matrix. ` +
        `Spec: "${iris.specPath}". Do not weaken or remove existing tests. Do not commit.`,
      { schema: DAEDALUS_SCHEMA, label: `daedalus:refine-${round}`, phase: 'Tests', effort: 'xhigh' }
    )
    if (refined) {
      suite = refined
      await talos(`olympus-state merge ${esc({ authoredSuite: { files: suite.testFiles, matrixPath: suite.matrixPath, label: passLabel } })}`, `talos:authored-record-${round}`, 'Tests')
    }
    const done = await stepMust(`olympus-state step test-author done ${esc({ files: suite.testFiles.length, matrix: suite.matrixPath })}`, `talos:step-refine-done-${round}`, 'Tests')
    if (!done.ok) {
      return {
        suite,
        survivors,
        error: escalate('clotho:state', [
          `test-author done write failed twice after refinement round ${round}: ${done.errorTail || JSON.stringify(done.output)} — re-run olympus:clotho to resume`,
        ]),
      }
    }
    if (!refined) break
    await talos(`olympus-freeze --paths "${suite.testFiles.concat([suite.matrixPath]).join(',')}"`, `talos:refreeze-${round}`, 'Tests')
    const sweep = await killSweep(suite, `refine-${round}`)
    survivors = sweep ? sweep.survivors : []
    await talos(`olympus-state merge ${esc({ testKillRate: { killRate: sweep ? sweep.killRate : 'unmeasured', survivors } })}`, 'talos:kill-record', 'Tests')
  }
  return { suite, survivors }
}

// frozenTests alone does not prove the Freeze phase completed: candidate
// commits and refinement refreezes record interim SHAs through
// olympus-freeze. The freeze step's done record is the authority — until it
// exists, a resume re-enters the Tests/Freeze block (the authoredSuite
// reuse and the adversary done record keep that cheap).
const freezeComplete = !!frozen && !!(steps['freeze'] && steps['freeze'].status === 'done')
if (!freezeComplete) {
  // Adversary set: generated once, reused across every candidate suite.
  if (tr.adversaryCount > 0 && !(steps['adversary'] && steps['adversary'].status === 'done')) {
    const dolos = await seat(
      `Write ${tr.adversaryCount} plausible WRONG implementations for unit ${iris.unitId}.\n` +
        `Spec (your only oracle): "${iris.specPath}". Write each implementation under "${adversaryDir}/<id>/" ` +
        `mirroring repo-relative paths (e.g. ${adversaryDir}/w1/src/module.ts). Follow your definition: one deliberate ` +
        `spec-violating fault each, diverse fault classes, otherwise complete and plausible.`,
      { agentType: 'olympus:dolos', schema: DOLOS_SCHEMA, label: 'dolos:adversary', phase: 'Tests', effort: 'xhigh' }
    )
    if (!dolos) return escalate('clotho:seat', ['Dolos (adversary) returned nothing after a retry — re-run olympus:clotho to resume'])
    await talos(`olympus-state step adversary done ${esc({ count: dolos.implementations.length, manifest: dolos.implementations })}`, 'talos:step', 'Tests')
  }

  if (tr.passes <= 1) {
    // Single-suite shape (config-reachable alternative to the tournament).
    // Quality bar: Argus validation, then the adversary sweep with
    // survivor-driven refinement — measured blind spots are closed before
    // the freeze, not just recorded.
    const r = await authorAndValidate('author', `Work on the current branch (${baseBranch}).\n`)
    if (r.error) return r.error
    let suite = r.suite
    let sweep = await killSweep(suite, 'single')
    let survivors = sweep ? sweep.survivors : []
    if (sweep) await talos(`olympus-state merge ${esc({ testKillRate: { killRate: sweep.killRate, survivors } })}`, 'talos:kill-record', 'Tests')
    if (survivors.length) {
      const refined = await refineAgainstSurvivors(suite, survivors, 'author')
      if (refined.error) return refined.error
      suite = refined.suite
      survivors = refined.survivors
    }
    phase('Freeze')
    const fr = await talos(`olympus-freeze --paths "${suite.testFiles.concat([suite.matrixPath]).join(',')}"`, 'talos:freeze', 'Freeze')
    if (!fr.ok) return escalate('clotho:state', [`freeze failed: ${fr.errorTail || JSON.stringify(fr.output)}`])
    frozen = fr.output.frozenTests
    // Verified write: the resume gate reads this record as proof the Freeze
    // phase completed; losing it would send a later re-run back through the
    // whole Tests/Freeze block.
    const fd = await stepMust(`olympus-state step freeze done ${esc({ sha: frozen.sha, survivorsAtFreeze: survivors })}`, 'talos:step-freeze-done', 'Freeze')
    if (!fd.ok) {
      return escalate('clotho:state', [
        `freeze done write failed twice: ${fd.errorTail || JSON.stringify(fd.output)} — the suite is committed at ${frozen.sha} but the manifest does not record the freeze as complete; re-run olympus:clotho to record it`,
      ])
    }
    if (survivors.length) log(`Frozen with ${survivors.length} surviving adversary implementation(s) — recorded for the eval ledger`)
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
        label: `t${t}`,
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
    let suite = winner.suite
    let survivors = winner.survivors
    if (survivors.length) {
      const refined = await refineAgainstSurvivors(suite, survivors, winner.label)
      if (refined.error) return refined.error
      suite = refined.suite
      survivors = refined.survivors
    }

    phase('Freeze')
    const fr = await talos(`olympus-freeze --paths "${suite.testFiles.concat([suite.matrixPath]).join(',')}"`, 'talos:freeze', 'Freeze')
    if (!fr.ok) return escalate('clotho:state', [`freeze failed: ${fr.errorTail || JSON.stringify(fr.output)}`])
    frozen = fr.output.frozenTests
    await talos(
      `olympus-state merge ${esc({ testJudge: { winner: judge.winner, rationale: judge.rationale, scores: judge.scores } })}`,
      'talos:test-judge-record', 'Freeze'
    )
    // Verified write: the resume gate reads this record as proof the Freeze
    // phase completed; losing it would send a later re-run back through the
    // whole tournament.
    const fd = await stepMust(`olympus-state step freeze done ${esc({ sha: frozen.sha, survivorsAtFreeze: survivors })}`, 'talos:step-freeze-done', 'Freeze')
    if (!fd.ok) {
      return escalate('clotho:state', [
        `freeze done write failed twice: ${fd.errorTail || JSON.stringify(fd.output)} — the suite is committed at ${frozen.sha} but the manifest does not record the freeze as complete; re-run olympus:clotho to record it`,
      ])
    }
    if (survivors.length) log(`Frozen with ${survivors.length} surviving adversary implementation(s) — recorded for the eval ledger`)
  }
}

return {
  status: 'done',
  seam: 'clotho',
  unit: { id: iris.unitId, title: iris.title, summary: iris.summary },
  branch: baseBranch,
  distill: { claimsResolved: distillClaims },
  frozen: { sha: frozen.sha, paths: frozen.paths },
  escalations: [],
}
