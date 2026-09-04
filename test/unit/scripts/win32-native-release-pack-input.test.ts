import { createHash } from 'node:crypto';
import { symlink, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createTempDirectory } from '../../helpers/temp-directory.js';
// @ts-expect-error Repository scripts intentionally have no TypeScript declaration surface.
import { validateNativeBuildInput, WIN32_NATIVE_ADMISSION_PATH, WIN32_NATIVE_BINARY_PATH } from '../../../scripts/win32-native-release-admission.mjs';

const commit = 'a'.repeat(40);
const version = '0.1.0-test.1';
const binary = Buffer.from('admitted-native-binary');
const digest = createHash('sha256').update(binary).digest('hex');

describe('Win32 native build input', () => {
  it('preserves ordinary and foundation-evidence mode behavior', async () => {
    const directory = await createTempDirectory();
    try {
      const root = await repository(directory);
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: undefined })).resolves.toBeNull();
      await directory.write(WIN32_NATIVE_BINARY_PATH, binary);
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: undefined })).rejects.toThrow(/unadmitted/u);
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: 'foundation-evidence' })).resolves.toBeNull();
      await directory.write(WIN32_NATIVE_ADMISSION_PATH, JSON.stringify(record()));
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: 'foundation-evidence' })).rejects.toThrow(/requires only/u);
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: 'unknown' })).rejects.toThrow(/unknown Windows native pack mode/u);
    } finally {
      await directory.cleanup();
    }
  });

  it('requires both release inputs and rejects orphan or linked inputs', async () => {
    const directory = await createTempDirectory();
    try {
      const root = await repository(directory);
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: 'release-admission', releaseCommit: commit })).rejects.toThrow(/requires the physical/u);
      await directory.write(WIN32_NATIVE_ADMISSION_PATH, JSON.stringify(record()));
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: undefined })).rejects.toThrow(/unadmitted/u);
      await directory.write('target.bin', binary);
      await directory.mkdir('artifacts/native/win32-x64-msvc');
      await symlink(directory.path('target.bin'), directory.path(WIN32_NATIVE_BINARY_PATH));
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: 'release-admission', releaseCommit: commit })).rejects.toThrow(/physical regular file/u);
    } finally {
      await directory.cleanup();
    }
  });

  it.each([
    ['malformed record', () => '{'],
    ['wrong commit', () => JSON.stringify(record({ sourceCommit: 'b'.repeat(40) }))],
    ['wrong version', () => JSON.stringify(record({ packageVersion: '0.1.0-wrong' }))],
    ['wrong target', () => JSON.stringify(record({ target: 'win32-arm64-msvc' }))],
    ['wrong digest', () => JSON.stringify(record({ binarySha256: '0'.repeat(64) }))],
    ['opened support boundary', () => JSON.stringify(record({ windowsSupportClaim: true }))],
    ['extra field', () => JSON.stringify({ ...record(), extra: true })]
  ])('rejects %s', async (_name, recordText) => {
    const directory = await createTempDirectory();
    try {
      const root = await repository(directory);
      await directory.write(WIN32_NATIVE_BINARY_PATH, binary);
      await directory.write(WIN32_NATIVE_ADMISSION_PATH, recordText());
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: 'release-admission', releaseCommit: commit })).rejects.toThrow();
    } finally {
      await directory.cleanup();
    }
  });

  it('accepts exact admitted bytes and rejects post-admission drift', async () => {
    const directory = await createTempDirectory();
    try {
      const root = await repository(directory);
      await directory.write(WIN32_NATIVE_BINARY_PATH, binary);
      await directory.write(WIN32_NATIVE_ADMISSION_PATH, JSON.stringify(record()));
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: 'release-admission', releaseCommit: commit })).resolves.toMatchObject({ binarySha256: digest });
      await writeFile(directory.path(WIN32_NATIVE_BINARY_PATH), 'changed');
      await expect(validateNativeBuildInput({ repositoryRoot: root, mode: 'release-admission', releaseCommit: commit })).rejects.toThrow(/drifted/u);
    } finally {
      await directory.cleanup();
    }
  });
});

async function repository(directory: Awaited<ReturnType<typeof createTempDirectory>>) {
  await directory.write('package.json', JSON.stringify({ name: 'bazframe', version }));
  return directory.root;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    purpose: 'Authorizes only the evidenced Win32 binary for this package assembly; not a Windows support claim.',
    sourceCommit: commit,
    packageVersion: version,
    target: 'win32-x64-msvc',
    binaryPath: WIN32_NATIVE_BINARY_PATH,
    binarySha256: digest,
    producer: {
      repository: 'sram1337/bazframe',
      repositoryId: '1334347295',
      workflow: '.github/workflows/win32-native-foundation.yml',
      runId: '33825410350',
      artifactId: '9919819006',
      artifactName: `bazframe-win32-native-foundation-${commit}`,
      archiveDigest: `sha256:${'c'.repeat(64)}`
    },
    toolchain: { node: '22.19.0', rust: '1.88.0', msvcToolsVersion: '14.44.35207' },
    releaseAdmission: 'authorized-for-package-assembly',
    windowsSupportClaim: false,
    ...overrides
  };
}
