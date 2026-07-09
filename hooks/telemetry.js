// Lifecycle telemetry (the Nyx ledger): SubagentStart / SubagentStop /
// PostToolUseFailure append one line each to .olympus/state/telemetry.log.
// Nobody self-reports; liveness questions are answered by reading the
// ledger's last-event age against per-agent-type thresholds — never by
// letting something run until a timeout expires.
'use strict';
const fs = require('fs');
const path = require('path');
const { readStdin } = require('./lib');

readStdin((p) => {
  try {
    const cwd = p.cwd || process.cwd();
    const line = {
      ts: new Date().toISOString(),
      event: p.hook_event_name,
      agent_type: p.agent_type || 'main',
      agent_id: p.agent_id || null,
    };
    if (p.hook_event_name === 'PostToolUseFailure') {
      line.tool = p.tool_name;
    }
    if (p.hook_event_name === 'SubagentStop' && p.agent_transcript_path) {
      try {
        line.transcript_bytes = fs.statSync(p.agent_transcript_path).size;
      } catch (e) {
        // size is best-effort
      }
    }
    const file = path.join(cwd, '.olympus', 'state', 'telemetry.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch (e) {
    // Telemetry must never break a tool call.
  }
  process.exit(0);
});
