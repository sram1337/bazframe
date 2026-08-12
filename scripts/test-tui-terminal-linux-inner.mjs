import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STARTUP_DEADLINE_MS = 8_000;
const DIRECT_APT_PACKAGES = [
  'ca-certificates',
  'git',
  'openssh-client',
  'openssh-server',
  'procps',
  'tmux',
  'util-linux'
];
const root = mkdtempSync(join(tmpdir(), 'bazframe-tui-linux-'));
let sshd;
try {
  process.stdout.write(`${JSON.stringify({
    environment: 'linux-container',
    baseImage: process.env.BAZFRAME_TUI_BASE_IMAGE ?? 'unknown',
    platform: process.platform,
    architecture: process.arch,
    packages: Object.fromEntries(DIRECT_APT_PACKAGES.map((name) => [name, packageVersion(name)])),
    tools: {
      node: process.version,
      npm: commandVersion('npm', ['--version']),
      git: commandVersion('git', ['--version']),
      ssh: commandVersion('ssh', ['-V']),
      sshd: commandVersion('/usr/sbin/sshd', ['-V']),
      ps: commandVersion('ps', ['--version']),
      tmux: commandVersion('tmux', ['-V']),
      script: commandVersion('script', ['--version']),
      dpkgQuery: commandVersion('dpkg-query', ['--version'])
    }
  })}\n`);

  run(process.execPath, ['./scripts/build.mjs']);
  run(process.execPath, ['./node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts', 'test/integration/tui-pty.test.ts']);
  run('npm', ['run', 'test:tui-terminal:local']);

  const hostKey = join(root, 'ssh_host_ed25519_key');
  const clientKey = join(root, 'client_ed25519');
  const authorizedKeys = join(root, 'authorized_keys');
  const knownHosts = join(root, 'known_hosts');
  mkdirSync('/run/sshd', { recursive: true });
  run('passwd', ['-d', 'root']);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  writeFileSync(authorizedKeys, readFileSync(`${clientKey}.pub`), { mode: 0o600 });
  sshd = spawn('/usr/sbin/sshd', [
    '-D', '-e', '-h', hostKey,
    '-o', 'PermitRootLogin=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'PubkeyAuthentication=yes',
    '-o', 'StrictModes=no',
    '-o', `AuthorizedKeysFile=${authorizedKeys}`
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let sshdError = '';
  sshd.stderr.setEncoding('utf8');
  sshd.stderr.on('data', (chunk) => { sshdError += chunk; });
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  let scanned = '';
  while (Date.now() < deadline && scanned.length === 0) {
    const scan = spawnSync('ssh-keyscan', ['-T', '1', '-t', 'ed25519', '127.0.0.1'], { encoding: 'utf8' });
    if (scan.status === 0) scanned = scan.stdout;
    if (sshd.exitCode !== null) throw new Error(`sshd exited during startup: ${sshdError}`);
  }
  if (scanned.length === 0) throw new Error(`sshd did not become ready within ${STARTUP_DEADLINE_MS}ms: ${sshdError}`);
  writeFileSync(knownHosts, scanned, { mode: 0o600 });

  run('ssh', [
    '-tt',
    '-i', clientKey,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'RequestTTY=force',
    'root@127.0.0.1',
    'cd /workspace && TERM=xterm-256color BAZFRAME_TUI_GRACEFUL_REPEATS=3 npm run test:tui-terminal:local'
  ]);
  process.stdout.write(`${JSON.stringify({ transport: 'linux-container-loopback-ssh-nested-tmux', passed: true, strictHostKeyChecking: true, ephemeralKeys: true })}\n`);
} finally {
  if (sshd !== undefined && sshd.exitCode === null) {
    sshd.kill('SIGTERM');
    const deadline = Date.now() + STARTUP_DEADLINE_MS;
    while (Date.now() < deadline && sshd.exitCode === null) {
      // The child-process exit event is delivered by the event loop after this script yields;
      // process termination at script exit is the final container boundary.
      break;
    }
    if (sshd.exitCode === null) sshd.kill('SIGKILL');
  }
  rmSync(root, { recursive: true, force: true });
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}
function packageVersion(name) {
  const result = spawnSync('dpkg-query', ['-W', '-f=${Version}', name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: '/workspace', stdio: 'inherit', env: { ...process.env, TERM: 'xterm-256color' } });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}
