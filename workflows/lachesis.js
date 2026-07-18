export const meta = {
  name: 'lachesis',
  description: 'Lachesis (build): the dev loop. Fresh passes against the frozen suite until 3 greens or 6 passes. Official verdict = deterministic Tier-1 gates + evidence-verified Fury findings; Minos picks the winner.',
  whenToUse: 'Second phase of an Olympus run. Requires a frozen suite from Clotho.',
  phases: [
    { title: 'Build loop', detail: 'fresh Hephaestus per pass; Tier-1 verdict + Furies + verification; Mentor between passes' },
    { title: 'Judge', detail: 'Minos scores green branches independently and picks' },
  ],
}

const GREENS_TARGET = 3
const MAX_PASSES = 6
const MAX_CONTINUATIONS_PER_PASS = 2

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
const esc = (o) => JSON.stringify(JSON.stringify(o))
function escalate(seam, items, extra) {
  return { status: 'escalation', seam, escalations: items, ...(extra || {}) }
}
// Cleanup steps are best-effort: a blocked branch delete must never kill a
// run that has already produced its result.
async function talosSoft(scriptWithArgs, label, phaseName) {
  try {
    return await talos(scriptWithArgs, label, phaseName)
  } catch (e) {
    log(`cleanup step failed (non-fatal): ${scriptWithArgs}`)
    return { ok: false }
  }
}

// ---- Fable-seat dispatch: Minos runs claude-fable-5 by definition; when
// that dispatch dies the -opus variant (same role, Opus-tuned prompt) takes
// the seat, logged and recorded. Config models.fableSeats: 'auto' (default)
// | 'opus' (variants directly) | 'fable' (never fall back).
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

// ------------------------------------------------------------------- Set up
phase('Build loop')
const ver = await talos('olympus-state version', 'talos:version', 'Build loop')
const installedVersion = ver.ok && ver.output && ver.output.version
if (!installedVersion || versionLt(installedVersion, MIN_STATE_VERSION)) {
  return escalate('lachesis:plugin', [
    `installed olympus plugin is stale (state version ${installedVersion || 'unknown'}, this workflow needs ≥ ${MIN_STATE_VERSION}) — reinstall the plugin, then re-run olympus:lachesis`,
  ])
}
const rs = await talos('olympus-state resync', 'talos:resync', 'Build loop')
if (rs.ok && rs.output && Array.isArray(rs.output.staleStarted) && rs.output.staleStarted.length) {
  log(
    `WARNING — steps still read "started" from a prior session: ${rs.output.staleStarted
      .map((s) => s.step)
      .join(', ')}. Their work may have completed without a terminal write (torn manifest); the resume re-runs them.`
  )
}
const state = await getState('Build loop')
if (!state.ok) return escalate('lachesis:state', [`no active run: ${state.errorTail || JSON.stringify(state.output)}`])
const manifest = state.output.manifest
fableSeatPref = (manifest.models && manifest.models.fableSeats) || 'auto'
const frozen = manifest.frozenTests
if (!frozen || !frozen.sha) return escalate('lachesis:state', ['no frozen suite — run olympus:clotho first'])

const unitId = manifest.unitId
const safeId = unitId.replace(/[^a-zA-Z0-9._-]/g, '-')
const baseBranch = (manifest.conventions.branchTemplate || 'olympus/{unit}').replace('{unit}', safeId)
const passes = Array.isArray(manifest.passes) ? manifest.passes.slice() : []
// Rehydrate full pass entries from the pass-details sidecar so a resumed
// run's Mentor and escalations see summaries and verdicts, not just the
// slim hot-path fields.
const sidecarDetails = await talosSoft('olympus-state sidecar get pass-details', 'talos:pass-detail-load', 'Build loop')
const detailByN = new Map(
  ((((sidecarDetails.ok && sidecarDetails.output && sidecarDetails.output.output) || {}).passes) || []).map((p) => [p.n, p])
)
for (let i = 0; i < passes.length; i++) passes[i] = { ...passes[i], ...(detailByN.get(passes[i].n) || {}) }
const sidecarLows = await talosSoft('olympus-state sidecar get low-findings', 'talos:lows', 'Build loop')
const lowFindingsLedger = (sidecarLows.ok && sidecarLows.output && sidecarLows.output.output && sidecarLows.output.output.lowFindings) || []
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
const FURY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'findings'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['HIGH', 'LOW'] },
          location: { type: 'string' },
          defect: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'location', 'defect', 'evidence'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['verdict', 'findings', 'summary'],
}
const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNVERIFIABLE'] },
          evidence: { type: 'string' },
        },
        required: ['index', 'verdict', 'evidence'],
      },
    },
  },
  required: ['results'],
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

const FURY_DIMENSIONS = [
  { key: 'spec', agentType: 'olympus:fury-spec' },
  { key: 'architecture', agentType: 'olympus:fury-architecture' },
  { key: 'minimality', agentType: 'olympus:fury-minimality' },
  { key: 'security', agentType: 'olympus:fury-security' },
  { key: 'operational', agentType: 'olympus:fury-operational' },
]

// Tier 2: the Furies in parallel, then the verification pass. Returns
// { confirmedHighs: [...], lows: [...] }. Only CONFIRMED HIGHs may block.
async function runFuries(n, branch, onlyKeys) {
  const diffFiles = await talos(`olympus-branch difffiles --from ${frozen.sha}`, `talos:difffiles-${n}`, 'Build loop')
  const files = (diffFiles.ok && diffFiles.output.files) || []
  const uiTouched = (manifest.uiPathPatterns || []).some((pat) => {
    try {
      const re = new RegExp(pat)
      return files.some((f) => re.test(f))
    } catch (e) {
      return false
    }
  })
  const dims = FURY_DIMENSIONS.filter((d) => !onlyKeys || onlyKeys.includes(d.key)).concat(
    uiTouched && (!onlyKeys || onlyKeys.includes('interface'))
      ? [{ key: 'interface', agentType: 'olympus:fury-interface' }]
      : []
  )
  const furyPrompt = (d) =>
    `Official gate review for unit ${unitId}, pass ${n}, branch ${branch}.\n` +
    `The diff: run \`git diff ${frozen.sha}..HEAD\` (you are on the branch). Changed files: ${files.join(', ') || '(none reported)'}.\n` +
    `Validated spec: "${manifest.spec.path}". Doc pointers: .olympus/config.json (docPaths).\n` +
    `Apply your definition's sweep and operating rules. Severity HIGH only where your definition allows it.`
  const results = await parallel(
    dims.map((d) => () =>
      seat(furyPrompt(d), { agentType: d.agentType, schema: FURY_SCHEMA, label: `fury:${d.key}-${n}`, phase: 'Build loop', effort: 'xhigh' }).then(
        (r) => r && { key: d.key, ...r }
      )
    )
  )
  const clean = results.filter(Boolean)
  const highs = clean.flatMap((r) => r.findings.filter((f) => f.severity === 'HIGH').map((f) => ({ ...f, fury: r.key })))
  const lows = clean.flatMap((r) => r.findings.filter((f) => f.severity === 'LOW').map((f) => `${r.key}: ${f.defect} (${f.location})`))

  if (!highs.length) return { confirmedHighs: [], lows, furiesRun: dims.map((d) => d.key) }

  const verifier = await seat(
    `Verify these HIGH gate findings for unit ${unitId} on branch ${branch} (diff base ${frozen.sha}).\n` +
      highs.map((f, i) => `[${i}] (${f.fury}) ${f.defect} — at ${f.location}; gate's evidence: ${f.evidence}`).join('\n') +
      `\nApply your definition: CONFIRMED / REFUTED / UNVERIFIABLE per finding, with settling evidence. Use the finding's [index].`,
    { agentType: 'olympus:fury-verifier', schema: VERIFIER_SCHEMA, label: `fury:verify-${n}`, phase: 'Build loop', effort: 'xhigh' }
  )
  const confirmed = verifier
    ? verifier.results.filter((r) => r.verdict === 'CONFIRMED').map((r) => ({ ...highs[r.index], verifierEvidence: r.evidence }))
    : highs // verifier glitch: fail safe toward keeping findings visible
  return { confirmedHighs: confirmed.filter(Boolean), lows, furiesRun: dims.map((d) => d.key) }
}

// -------------------------------------------------------------- The Q4 loop
let greens = passes.filter((p) => p.outcome === 'green').length
while (greens < GREENS_TARGET && passes.length < MAX_PASSES) {
  const n = passes.length + 1
  const branch = `${baseBranch}-pass-${n}`

  const br = await talos(`olympus-branch create --name "${branch}" --from ${frozen.sha}`, `talos:branch-${n}`, 'Build loop')
  if (!br.ok) return escalate('lachesis:state', [`branch create failed for pass ${n}: ${br.errorTail || JSON.stringify(br.output)}`])
  await talos(`olympus-state step pass-${n} started`, `talos:step-${n}`, 'Build loop')

  let dev = await seat(contextPackage(n), {
    agentType: 'olympus:hephaestus',
    schema: HEPHAESTUS_SCHEMA,
    label: `hephaestus:pass-${n}`,
    phase: 'Build loop',
    effort: 'max',
  })

  let outcome = 'failed'
  let verdict = null
  let fury = null
  if (dev) {
    let continuations = 0
    verdict = await runVerdict(n, branch)
    while (continuations <= MAX_CONTINUATIONS_PER_PASS) {
      if (!verdict.pass) {
        if (dev.stoppedForBudget || continuations === MAX_CONTINUATIONS_PER_PASS) break
        continuations++
        log(`Pass ${n}: Tier-1 verdict failed; findings back to the dev (continuation ${continuations})`)
        dev = await seat(
          contextPackage(n) +
            `\n\nCONTINUATION OF PASS ${n}: the official verdict failed on branch ${branch}. ` +
            `Your prior commits are on the branch; fix exactly what these findings name, re-run, commit, report.\nFindings:\n${failedChecksSummary(verdict)}`,
          { agentType: 'olympus:hephaestus', schema: HEPHAESTUS_SCHEMA, label: `hephaestus:pass-${n}-cont${continuations}`, phase: 'Build loop', effort: 'max' }
        )
        if (!dev) break
        verdict = await runVerdict(n, branch)
        continue
      }
      // Tier 1 green — Tier 2 (only re-run the dimensions that blocked last round).
      const rerunKeys = fury ? fury.confirmedHighs.map((f) => f.fury) : null
      fury = await runFuries(n, branch, rerunKeys && rerunKeys.length ? Array.from(new Set(rerunKeys)) : null)
      if (!fury.confirmedHighs.length) {
        outcome = 'green'
        break
      }
      if (dev.stoppedForBudget || continuations === MAX_CONTINUATIONS_PER_PASS) break
      continuations++
      log(`Pass ${n}: ${fury.confirmedHighs.length} verified gate finding(s); back to the dev (continuation ${continuations})`)
      dev = await seat(
        contextPackage(n) +
          `\n\nCONTINUATION OF PASS ${n}: the official gate agents found verified defects on branch ${branch}. ` +
          `Fix exactly these, re-run your advisory checks, commit, report.\n` +
          fury.confirmedHighs.map((f) => `- (${f.fury}) ${f.defect} — at ${f.location}. Evidence: ${f.verifierEvidence || f.evidence}`).join('\n'),
        { agentType: 'olympus:hephaestus', schema: HEPHAESTUS_SCHEMA, label: `hephaestus:pass-${n}-cont${continuations}`, phase: 'Build loop', effort: 'max' }
      )
      if (!dev) break
      verdict = await runVerdict(n, branch)
    }
    if (outcome !== 'green' && dev && dev.stoppedForBudget) outcome = 'budget'
  } else {
    outcome = 'spawn-glitch'
  }

  if (fury && fury.lows.length) {
    for (const l of fury.lows) if (!lowFindingsLedger.includes(l)) lowFindingsLedger.push(l)
  }

  const entry = {
    n,
    outcome,
    branch,
    summary: dev ? dev.summary : 'agent returned nothing twice',
    flaggedDecisions: dev ? dev.flaggedDecisions : [],
    verdict: verdict ? { pass: verdict.pass, failed: (verdict.checks || []).filter((c) => !c.ok).map((c) => c.name), flags: verdict.flags || [] } : null,
    furies: fury ? { run: fury.furiesRun, unresolvedHighs: outcome === 'green' ? 0 : fury.confirmedHighs.length } : null,
  }
  passes.push(entry)
  if (outcome === 'green') greens++
  else {
    // Failed pass branches survive to the judge seam; deletion happens only
    // in the post-judge prune (docs/adr/0005). Parking the base keeps it
    // in existence for the next pass.
    await talosSoft(`olympus-branch create --name "${baseBranch}" --from ${frozen.sha}`, `talos:park-${n}`, 'Build loop')
  }
  // Manifest carries the hot path only; full pass details and the LOW-
  // findings ledger live in sidecars (docs/adr/0001).
  const passesSlim = passes.map((p) => ({ n: p.n, outcome: p.outcome, branch: p.branch, flaggedDecisions: p.flaggedDecisions }))
  await talos(`olympus-state merge ${esc({ passes: passesSlim })}`, `talos:record-${n}`, 'Build loop')
  await talosSoft(`olympus-state sidecar set pass-details ${esc({ passes })}`, `talos:record-detail-${n}`, 'Build loop')
  await talosSoft(`olympus-state sidecar set low-findings ${esc({ lowFindings: lowFindingsLedger.slice(0, 40) })}`, `talos:record-lows-${n}`, 'Build loop')
  await talos(`olympus-state step pass-${n} ${outcome} ${esc({ branch })}`, `talos:step-${n}-end`, 'Build loop')
  // Status promotion is the script's act, keyed to the verdict — the
  // authoring agent's claims stay hypotheses until this line settles them
  // (docs/adr/0002).
  if (outcome === 'green') {
    await talosSoft(`olympus-state learn ${esc(`Pass ${n} went green on ${branch} — this pass's recorded approach is a verdict-confirmed solution path.`)} --status confirmed`, `talos:promote-${n}`, 'Build loop')
  } else if (verdict && !verdict.pass) {
    const failedNames = (verdict.checks || []).filter((c) => !c.ok).map((c) => c.name).join(', ')
    await talosSoft(`olympus-state learn ${esc(`Pass ${n} did not go green (${outcome}; failing: ${failedNames || 'n/a'}) — fix hypotheses recorded this pass are refuted by the verdict.`)} --status refuted`, `talos:promote-${n}`, 'Build loop')
  }
  log(`Pass ${n}: ${outcome} (${greens}/${GREENS_TARGET} green, ${passes.length}/${MAX_PASSES} passes)`)

  if (greens < GREENS_TARGET && passes.length < MAX_PASSES) {
    const mentor = await seat(
      `Between-pass check for unit ${unitId}. Learnings file: "${manifest.learningsPath}". ` +
        `Run state: ${JSON.stringify(passes.map((p) => ({ n: p.n, outcome: p.outcome, failed: p.verdict && p.verdict.failed })))}.\n` +
        `Make the continue/abort call and consolidate the learnings file per your definition.`,
      { agentType: 'olympus:mentor', schema: MENTOR_SCHEMA, label: `mentor:after-${n}`, phase: 'Build loop', effort: 'xhigh' }
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
await talos('olympus-state step judge started', 'talos:step-judge', 'Judge')
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
const minos = await seatAgent('minos',
  `Judge the green candidates for unit ${unitId}. Spec: "${manifest.spec.path}". ` +
    `Frozen base SHA: ${frozen.sha}. Candidates (in pass order — score strictly one at a time, in this order): ${greenBranches.join(', ')}.\n` +
    `Read each candidate's diff with: git diff ${frozen.sha}..<branch>. Follow the isolation protocol and rubric in your definition. ` +
    `Tie goes to the later pass.`,
  { schema: MINOS_SCHEMA, label: 'minos:judge', phase: 'Judge', effort: 'xhigh' }
)
if (!minos || !greenBranches.includes(minos.winner)) {
  return escalate('lachesis:judge', ['Minos (judge) failed to return a valid pick'], { candidates: greenBranches })
}

const co = await talos(`olympus-branch checkout --name "${minos.winner}"`, 'talos:checkout-winner', 'Judge')
if (!co.ok) return escalate('lachesis:state', [`could not check out winner: ${co.errorTail || JSON.stringify(co.output)}`])
// The post-judge prune: the one moment branches are deleted, and every
// delete leaves a discarded ref (docs/adr/0005). All non-winner pass
// branches go, failed passes included.
for (const b of passes.map((p) => p.branch)) {
  if (b !== minos.winner) await talosSoft(`olympus-branch delete --name "${b}"`, 'talos:prune', 'Judge')
}
await talos(
  `olympus-state merge ${esc({ judge: { winner: minos.winner, scores: minos.scores, rationale: minos.rationale }, phase: 'atropos' })}`,
  'talos:judge-record', 'Judge'
)
await talos(`olympus-state step judge done ${esc({ winner: minos.winner })}`, 'talos:step-judge-end', 'Judge')

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
