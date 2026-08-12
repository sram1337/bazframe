import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

requireCommand('docker');
const suffix = `${process.pid}-${randomUUID()}`;
const image = `bazframe-tui-terminal:${suffix}`;
const container = `bazframe-tui-terminal-${suffix}`;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  cleanupDocker();
  process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
});
let primaryError;
try {
  run('docker', [
    'build',
    '--file', 'test/fixtures/tui-terminal/Dockerfile',
    '--tag', image,
    '.'
  ]);
  run('docker', ['run', '--name', container, '--rm', image]);
} catch (error) {
  primaryError = error;
} finally {
  cleanupDocker();
}
const containerExists = spawnSync('docker', ['container', 'inspect', container], { stdio: 'ignore' }).status === 0;
const imageExists = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
if (primaryError !== undefined) throw primaryError;
if (containerExists || imageExists) throw new Error(`Owned Docker resources survived cleanup: container=${containerExists}, image=${imageExists}`);

function cleanupDocker() {
  spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
  spawnSync('docker', ['image', 'rm', '--force', image], { stdio: 'ignore' });
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}
function requireCommand(command) {
  if (spawnSync('sh', ['-c', `command -v ${command} >/dev/null 2>&1`]).status !== 0) {
    throw new Error(`test:tui-terminal:linux requires ${command} on PATH.`);
  }
}
