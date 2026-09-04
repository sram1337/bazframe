import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
// @ts-expect-error Repository scripts intentionally have no TypeScript declaration surface.
import { verifyWin32NativeReleaseTarball } from '../../../scripts/verify-win32-native-release-tarball.mjs';

const commit = 'a'.repeat(40);
const binary = Buffer.from('tarball-native-binary');
const digest = createHash('sha256').update(binary).digest('hex');
const member = 'package/artifacts/native/win32-x64-msvc/bazframe-win32.node';

describe('Win32 native release tarball verification', () => {
  it('accepts exactly one regular fixed-path binary with the admitted digest', async () => {
    const directory = await createTempDirectory();
    try {
      const tarball = await regularTarball(directory, member, binary);
      const admission = await admissionRecord(directory);
      await expect(verify(tarball, admission))
        .resolves.toMatchObject({ binarySha256: digest, windowsSupportClaim: false });
    } finally {
      await directory.cleanup();
    }
  });

  it.each([
    ['missing fixed member', 'package/artifacts/native/win32-x64-msvc/other.node', binary, false],
    ['wrong binary digest', member, Buffer.from('changed'), false],
    ['admission record leak', member, binary, true]
  ])('rejects %s', async (_name, archiveMember, contents, leakMarker) => {
    const directory = await createTempDirectory();
    try {
      const tarball = await regularTarball(directory, archiveMember, contents, leakMarker);
      const admission = await admissionRecord(directory);
      await expect(verify(tarball, admission))
        .rejects.toThrow(/tarball verification failed/u);
    } finally {
      await directory.cleanup();
    }
  });

  it('rejects duplicate native members', async () => {
    const directory = await createTempDirectory();
    try {
      await directory.write(`content/${member}`, binary);
      await directory.write('content/package/package.json', JSON.stringify({ name: 'bazframe', version: '0.1.0-test.1' }));
      const rawTar = directory.path('duplicate.tar');
      runTar(['-cf', rawTar, '-C', directory.path('content'), 'package/package.json', member, member]);
      const tarball = directory.path('duplicate.tgz');
      await writeFile(tarball, gzipSync(await readFile(rawTar)));
      const admission = await admissionRecord(directory);
      await expect(verify(tarball, admission))
        .rejects.toThrow(/only the one/u);
    } finally {
      await directory.cleanup();
    }
  });

  it('rejects an additional alternate native member', async () => {
    const directory = await createTempDirectory();
    try {
      const tarball = await regularTarball(directory, member, binary, false, 'package/alternate.node');
      const admission = await admissionRecord(directory);
      await expect(verify(tarball, admission)).rejects.toThrow(/only the one/u);
    } finally {
      await directory.cleanup();
    }
  });

  it('binds protected verification to trusted producer context', async () => {
    const directory = await createTempDirectory();
    try {
      const tarball = await regularTarball(directory, member, binary);
      const admission = await admissionRecord(directory);
      await expect(verify(tarball, admission, { producerRunId: '33825410351' })).rejects.toThrow(/producer run ID/u);
    } finally {
      await directory.cleanup();
    }
  });

  it('rejects a linked native member', async () => {
    const directory = await createTempDirectory();
    try {
      await directory.write('content/package/target.node', binary);
      await directory.write('content/package/package.json', JSON.stringify({ name: 'bazframe', version: '0.1.0-test.1' }));
      await directory.mkdir(dirname(`content/${member}`));
      await symlink('../../../target.node', directory.path(`content/${member}`));
      const tarball = directory.path('linked.tgz');
      runTar(['-czf', tarball, '-C', directory.path('content'), 'package/package.json', member]);
      const admission = await admissionRecord(directory);
      await expect(verify(tarball, admission))
        .rejects.toThrow(/regular file/u);
    } finally {
      await directory.cleanup();
    }
  });
});

async function regularTarball(
  directory: TempDirectory,
  archiveMember: string,
  contents: Buffer,
  leakMarker = false,
  alternateNative?: string
) {
  await directory.write(`content/${archiveMember}`, contents);
  await directory.write('content/package/package.json', JSON.stringify({ name: 'bazframe', version: '0.1.0-test.1' }));
  const entries = ['package/package.json', archiveMember];
  if (alternateNative) {
    await directory.write(`content/${alternateNative}`, Buffer.from('alternate-native'));
    entries.push(alternateNative);
  }
  if (leakMarker) {
    await directory.write('content/package/win32-native-release-admission.json', JSON.stringify(record()));
    entries.push('package/win32-native-release-admission.json');
  }
  const tarball = directory.path('package.tgz');
  runTar(['-czf', tarball, '-C', directory.path('content'), ...entries]);
  return tarball;
}

function verify(tarballPath: string, admissionPath: string, overrides: Record<string, string> = {}) {
  return verifyWin32NativeReleaseTarball({
    tarballPath,
    admissionPath,
    releaseCommit: commit,
    producerRepository: 'sram1337/bazframe',
    producerRepositoryId: '1334347295',
    producerRunId: '33825410350',
    ...overrides
  });
}

async function admissionRecord(directory: TempDirectory) {
  return directory.write('win32-native-release-admission.json', JSON.stringify(record()));
}

function record() {
  return {
    schemaVersion: 1,
    purpose: 'Authorizes only the evidenced Win32 binary for this package assembly; not a Windows support claim.',
    sourceCommit: commit,
    packageVersion: '0.1.0-test.1',
    target: 'win32-x64-msvc',
    binaryPath: 'artifacts/native/win32-x64-msvc/bazframe-win32.node',
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
    windowsSupportClaim: false
  };
}

function runTar(args: string[]) {
  const result = spawnSync('tar', args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
}
