import { spawnSync } from 'node:child_process';
import { chmod, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateNativeBuildInput } from './win32-native-release-admission.mjs';

const repositoryRoot = new URL('..', import.meta.url);
await validateNativeBuildInput({
  repositoryRoot: fileURLToPath(repositoryRoot),
  mode: process.env.BAZFRAME_WIN32_NATIVE_PACK_MODE,
  releaseCommit: process.env.BAZFRAME_WIN32_NATIVE_RELEASE_COMMIT
});

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  ['./node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' }
);

if (result.status !== 0) {
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

for (const skill of ['bazframe', 'bazify']) {
  await cp(
    new URL(`../skills/${skill}`, import.meta.url),
    new URL(`../dist/skills/${skill}`, import.meta.url),
    { recursive: true }
  );
}
await chmod(new URL('../dist/cli.js', import.meta.url), 0o755);
