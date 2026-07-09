// PreToolUse hook on the dev agent (Hephaestus): denies Edit/Write/
// NotebookEdit against frozen test paths, with the reason fed back to the
// agent. Defense in depth only — the workflow's frozen-SHA diff check
// remains the authoritative verdict. Fails open when no run state exists.
'use strict';
const { readStdin, loadManifest, isFrozenPath, trace } = require('./lib');

readStdin((p) => {
  const cwd = p.cwd || process.cwd();
  const manifest = loadManifest(cwd);
  const frozen = manifest && manifest.frozenTests && manifest.frozenTests.paths;
  const input = p.tool_input || {};
  const target = input.file_path || input.notebook_path;
  const deny = Boolean(frozen && isFrozenPath(target, frozen, cwd));
  trace(cwd, { hook: 'deny-frozen-tests', tool: p.tool_name, agent: p.agent_type || 'main', target, frozenLoaded: Boolean(frozen), decision: deny ? 'deny' : 'allow' });

  if (deny) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'The acceptance tests are frozen: fix the code, not the test. ' +
            'If you believe this test is wrong, say so in your report and ' +
            'your learnings entry; the spec seam owns that call.',
        },
      })
    );
  }
  process.exit(0);
});
