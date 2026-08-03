import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  ['./node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' }
);

process.exit(typeof result.status === 'number' ? result.status : 1);
