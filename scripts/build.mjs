import { spawnSync } from 'node:child_process';
import { chmod, rm } from 'node:fs/promises';

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  ['./node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' }
);

if (result.status !== 0) {
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

await chmod(new URL('../dist/cli.js', import.meta.url), 0o755);
