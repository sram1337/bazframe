import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

function canonicalJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

async function findPreparedRoot(childRoot) {
  let candidate = childRoot;
  for (;;) {
    try {
      await Promise.all([
        access(join(candidate, 'package.json')),
        access(join(candidate, 'package-lock.json')),
        access(join(candidate, 'node_modules', '.bin', 'tsx'))
      ]);
      return candidate;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error(`No prepared ancestor runtime for ${childRoot}`);
      candidate = parent;
    }
  }
}

async function execute(runtimePath, script, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [runtimePath, script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        npm_config_offline: 'true',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        ALL_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: ''
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        rejectRun(new Error(`Source-tree command failed: code=${code} signal=${signal}\n${stderr}`));
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

const [childRootArgument, scriptArgument] = process.argv.slice(2);
if (childRootArgument === undefined || scriptArgument === undefined) {
  throw new Error('Usage: source-tree-command.mjs <child-root> <child-relative-script>');
}
const startCwd = await realpath(process.cwd());
const childRoot = await realpath(resolve(childRootArgument));
const sourceRoot = await findPreparedRoot(childRoot);
const runtimePath = await realpath(join(sourceRoot, 'node_modules', '.bin', 'tsx'));
process.chdir(childRoot);
const executionCwd = await realpath(process.cwd());
const run = await execute(runtimePath, resolve(childRoot, scriptArgument), executionCwd);
const payloadText = run.stdout.trim();
const payload = JSON.parse(payloadText);
if (canonicalJson(payload) !== payloadText) throw new Error('Child output is not canonical JSON.');
process.stdout.write(`${canonicalJson({
  executionCwd,
  installAttempted: false,
  networkMode: 'offline-proxy-blocked',
  payload,
  runtimePath,
  sourceRoot: await realpath(sourceRoot),
  startCwd
})}\n`);
