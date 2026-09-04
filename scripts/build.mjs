import { spawnSync } from 'node:child_process';
import { chmod, cp, lstat, rm } from 'node:fs/promises';

const nativeArtifact = new URL(
  '../artifacts/native/win32-x64-msvc/bazframe-win32.node',
  import.meta.url
);
const nativePackMode = process.env.BAZFRAME_WIN32_NATIVE_PACK_MODE;
let nativeArtifactPresent = false;
try {
  const metadata = await lstat(nativeArtifact);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('The Bazframe Windows native pack input must be one physical regular file.');
  }
  nativeArtifactPresent = true;
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
if (nativeArtifactPresent && nativePackMode !== 'foundation-evidence') {
  throw new Error(
    'Refusing an unadmitted Windows native pack input. Remove the ignored binary or use the foundation evidence workflow.'
  );
}
if (!nativeArtifactPresent && nativePackMode !== undefined) {
  throw new Error('The requested Windows native foundation pack input is missing.');
}

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
