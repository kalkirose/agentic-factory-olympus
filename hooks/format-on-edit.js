// PostToolUse hook on the dev agent (Hephaestus): after every Edit/Write,
// runs the project's format/lint-on-edit command (from the run manifest,
// which Lachesis resolves out of .olympus/config.yaml). Deterministic
// instant feedback that keeps trivial issues out of agent token budgets.
// Exit 2 feeds the tool's output back to the agent; missing config = no-op.
'use strict';
const { execSync } = require('child_process');
const { readStdin, loadManifest } = require('./lib');

const LIMIT = 4000;

readStdin((p) => {
  const cwd = p.cwd || process.cwd();
  const manifest = loadManifest(cwd);
  const template =
    manifest && manifest.hooks && manifest.hooks.formatOnEditCommand;
  const input = p.tool_input || {};
  const target = input.file_path || input.notebook_path;
  if (!template || !target) process.exit(0);

  const cmd = template.includes('{file}')
    ? template.replaceAll('{file}', JSON.stringify(target))
    : `${template} ${JSON.stringify(target)}`;
  try {
    execSync(cmd, { cwd, stdio: 'pipe', timeout: 100000 });
    process.exit(0);
  } catch (e) {
    const out = [
      e.stdout && e.stdout.toString(),
      e.stderr && e.stderr.toString(),
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, LIMIT);
    process.stderr.write(
      `format/lint failed for ${target} (fix before moving on):\n${out}`
    );
    process.exit(2);
  }
});
