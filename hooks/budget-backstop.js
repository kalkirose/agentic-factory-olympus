// PostToolUse hook on the dev agent (Hephaestus): the context-budget
// backstop (structural prevention is primary; agents never self-estimate).
// Measures the agent's own transcript file — located from agent_id +
// transcript_path in the payload — against the per-run byte threshold in
// the manifest. Past the threshold it tells the agent to stop, record
// learnings, and exit, and drops a breach marker the workflow script
// routes into the failed-pass path.
'use strict';
const fs = require('fs');
const path = require('path');
const { readStdin, loadManifest } = require('./lib');

function findAgentTranscript(sessionTranscript, agentId) {
  try {
    const sessionDir = sessionTranscript.replace(/\.jsonl$/, '');
    const hits = fs
      .readdirSync(sessionDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(`agent-${agentId}.jsonl`));
    return hits.length ? path.join(sessionDir, hits[0]) : null;
  } catch (e) {
    return null;
  }
}

readStdin((p) => {
  if (!p.agent_id || !p.transcript_path) process.exit(0);
  // Project-level hook: fires for every agent's tool calls. The budget
  // governs only the harness's dev agent; everyone else passes through.
  if (p.agent_type !== 'olympus:hephaestus') process.exit(0);
  const cwd = p.cwd || process.cwd();
  const manifest = loadManifest(cwd);
  const limit = manifest && manifest.budget && manifest.budget.maxTranscriptBytes;
  if (!limit) process.exit(0);

  const transcript = findAgentTranscript(p.transcript_path, p.agent_id);
  if (!transcript) process.exit(0);

  let size = 0;
  try {
    size = fs.statSync(transcript).size;
  } catch (e) {
    process.exit(0);
  }
  if (size < limit) process.exit(0);

  try {
    const marker = path.join(
      path.dirname(manifest.__path),
      `budget-breach-${p.agent_id}.json`
    );
    fs.writeFileSync(
      marker,
      JSON.stringify({ agentId: p.agent_id, bytes: size, limit, at: new Date().toISOString() })
    );
  } catch (e) {
    // Marker is best-effort; the feedback below still fires.
  }
  process.stderr.write(
    `Context budget reached (${size} of ${limit} bytes). Stop now: append ` +
      'your learnings entry, report your state honestly, and exit. A budget ' +
      'breach is a failed pass; the next pass inherits your learnings.'
  );
  process.exit(2);
});
