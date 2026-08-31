import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_EFFECTIVE_INSTRUCTION_BYTES } from '../../../src/core/content.js';
import {
  readProfileArtifactDirectory,
  sameProfileArtifactDirectorySnapshot
} from '../../../src/profile-portability/profile-artifact-io.js';
import type {
  ProfileArtifact,
  ProfileArtifactLimitPolicy
} from '../../../src/profile-portability/profile-artifact.js';
import { snapshotFilesystem } from '../../helpers/filesystem-snapshot.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: TempDirectory[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

interface ArtifactFixture {
  root: string;
  profile: string;
  manifestPath: string;
  instructionPath: string;
  manifestBytes: Buffer;
  instructionBytes: Buffer;
  policy: ProfileArtifactLimitPolicy;
}

async function createFixture(
  directory: TempDirectory,
  name = 'portable-profile',
  instructionBytes: Uint8Array = Buffer.from('one\r\nmultibyte: é\n', 'utf8')
): Promise<ArtifactFixture> {
  const root = await directory.mkdir(name);
  const profile = await directory.mkdir(`${name}/profile`);
  const instructionPath = await directory.write(`${name}/profile/AGENTS.md`, instructionBytes);
  const artifact: ProfileArtifact = {
    schemaVersion: 1,
    kind: 'bazframe-profile-export',
    profile: {
      id: 'focused',
      instructions: {
        path: 'profile/AGENTS.md',
        sha256: createHash('sha256').update(instructionBytes).digest('hex')
      },
      skills: [],
      omittedLocalSkills: [],
      libraries: [],
      packages: []
    },
    resources: []
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const manifestPath = await directory.write(`${name}/bazframe-profile.json`, manifestBytes);
  return {
    root,
    profile,
    manifestPath,
    instructionPath,
    manifestBytes,
    instructionBytes: Buffer.from(instructionBytes),
    policy: {
      maxManifestBytes: manifestBytes.byteLength,
      maxProfileEntries: 0,
      maxResources: 0
    }
  };
}

async function temporaryDirectory(): Promise<TempDirectory> {
  const directory = await createTempDirectory('bazframe-profile-artifact-');
  temporaryDirectories.push(directory);
  return directory;
}

describe('physical profile artifact inspection', () => {
  it('retains exact canonical and instruction bytes and writes nothing', async () => {
    const directory = await temporaryDirectory();
    const fixture = await createFixture(directory);
    const before = await snapshotFilesystem(directory.root);

    const snapshot = await readProfileArtifactDirectory(fixture.root, fixture.policy);

    expect(snapshot.root.path).toBe(await realpath(fixture.root));
    expect(snapshot.root.device).toBeTypeOf('bigint');
    expect(snapshot.root.inode).toBeTypeOf('bigint');
    expect(snapshot.profileDirectory.path).toBe(await realpath(fixture.profile));
    expect(snapshot.manifestBytes).toEqual(Uint8Array.from(fixture.manifestBytes));
    expect(snapshot.instructions.bytes).toEqual(Uint8Array.from(fixture.instructionBytes));
    expect(snapshot.artifact.profile.instructions.sha256).toBe(snapshot.instructions.contentSha256);
    expect(await snapshotFilesystem(directory.root)).toEqual(before);
  });

  it('compares complete artifact bytes, paths, and physical identities', async () => {
    const directory = await temporaryDirectory();
    const fixture = await createFixture(directory, 'first');
    const same = await readProfileArtifactDirectory(fixture.root, fixture.policy);
    const reread = await readProfileArtifactDirectory(fixture.root, fixture.policy);
    expect(sameProfileArtifactDirectorySnapshot(same, reread)).toBe(true);

    const secondFixture = await createFixture(directory, 'second', Uint8Array.from(fixture.instructionBytes));
    const substituted = await readProfileArtifactDirectory(secondFixture.root, secondFixture.policy);
    expect(Buffer.from(substituted.manifestBytes)).toEqual(Buffer.from(same.manifestBytes));
    expect(Buffer.from(substituted.instructions.bytes)).toEqual(Buffer.from(same.instructions.bytes));
    expect(sameProfileArtifactDirectorySnapshot(same, substituted)).toBe(false);

    expect(sameProfileArtifactDirectorySnapshot(same, {
      ...same,
      manifestBytes: Uint8Array.from([...same.manifestBytes.slice(0, -1), 0x20])
    })).toBe(false);
    expect(sameProfileArtifactDirectorySnapshot(same, {
      ...same,
      root: { ...same.root, inode: same.root.inode + 1n }
    })).toBe(false);
    expect(sameProfileArtifactDirectorySnapshot(same, {
      ...same,
      profileDirectory: { ...same.profileDirectory, path: `${same.profileDirectory.path}-other` }
    })).toBe(false);
    expect(sameProfileArtifactDirectorySnapshot(same, {
      ...same,
      instructions: { ...same.instructions, path: `${same.instructions.path}-other` }
    })).toBe(false);
    expect(sameProfileArtifactDirectorySnapshot(same, {
      ...same,
      instructions: { ...same.instructions, inode: same.instructions.inode + 1n }
    })).toBe(false);
  });

  it('rejects noncanonical, invalid, and over-limit raw manifests', async () => {
    const noncanonicalDirectory = await temporaryDirectory();
    const noncanonical = await createFixture(noncanonicalDirectory);
    const compact = Buffer.from(JSON.stringify(JSON.parse(noncanonical.manifestBytes.toString('utf8'))), 'utf8');
    await writeFile(noncanonical.manifestPath, compact);
    await expect(readProfileArtifactDirectory(noncanonical.root, {
      ...noncanonical.policy,
      maxManifestBytes: noncanonical.manifestBytes.byteLength
    })).rejects.toThrow(/not canonical/u);

    const invalidDirectory = await temporaryDirectory();
    const invalid = await createFixture(invalidDirectory);
    await writeFile(invalid.manifestPath, '{');
    await expect(readProfileArtifactDirectory(invalid.root, invalid.policy))
      .rejects.toThrow(/valid JSON/u);

    const oversizedDirectory = await temporaryDirectory();
    const oversized = await createFixture(oversizedDirectory);
    await expect(readProfileArtifactDirectory(oversized.root, {
      ...oversized.policy,
      maxManifestBytes: oversized.manifestBytes.byteLength - 1
    })).rejects.toThrow(/byte limit/u);
    await expect(readProfileArtifactDirectory(oversized.root, {
      ...oversized.policy,
      maxManifestBytes: Number.POSITIVE_INFINITY
    })).rejects.toMatchObject({ code: 'PROFILE_ARTIFACT_INVALID' });
  });

  it('rejects digest mismatch, invalid instruction bytes, and oversized instructions', async () => {
    const digestDirectory = await temporaryDirectory();
    const digestFixture = await createFixture(digestDirectory);
    const manifest = JSON.parse(digestFixture.manifestBytes.toString('utf8')) as ProfileArtifact;
    manifest.profile.instructions.sha256 = '0'.repeat(64);
    const changedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(digestFixture.manifestPath, changedManifest);
    await expect(readProfileArtifactDirectory(digestFixture.root, {
      ...digestFixture.policy,
      maxManifestBytes: changedManifest.byteLength
    })).rejects.toThrow(/digest does not match/u);

    for (const invalidBytes of [Uint8Array.from([0xff]), Buffer.from('before\0after')]) {
      const invalidDirectory = await temporaryDirectory();
      const invalidFixture = await createFixture(
        invalidDirectory,
        'portable-profile',
        Buffer.from(invalidBytes)
      );
      await expect(readProfileArtifactDirectory(invalidFixture.root, invalidFixture.policy))
        .rejects.toThrow(/valid UTF-8|NUL/u);
    }

    const oversizedDirectory = await temporaryDirectory();
    const oversizedFixture = await createFixture(
      oversizedDirectory,
      'portable-profile',
      Buffer.alloc(MAX_EFFECTIVE_INSTRUCTION_BYTES + 1, 0x61)
    );
    await expect(readProfileArtifactDirectory(oversizedFixture.root, oversizedFixture.policy))
      .rejects.toThrow(new RegExp(`${MAX_EFFECTIVE_INSTRUCTION_BYTES}-byte instruction limit`, 'u'));
  });

  it('accepts instructions at the authoritative byte limit', async () => {
    const directory = await temporaryDirectory();
    const fixture = await createFixture(
      directory,
      'portable-profile',
      Buffer.alloc(MAX_EFFECTIVE_INSTRUCTION_BYTES, 0x61)
    );

    await expect(readProfileArtifactDirectory(fixture.root, fixture.policy))
      .resolves.toMatchObject({ instructions: { byteCount: MAX_EFFECTIVE_INSTRUCTION_BYTES } });
  });

  it('rejects missing, extra, and wrong-type artifact entries', async () => {
    const missingRootDirectory = await temporaryDirectory();
    const missingRoot = await createFixture(missingRootDirectory);
    await rm(missingRoot.manifestPath);
    await expect(readProfileArtifactDirectory(missingRoot.root, missingRoot.policy))
      .rejects.toThrow(/missing required entry/u);

    const missingInstructionDirectory = await temporaryDirectory();
    const missingInstruction = await createFixture(missingInstructionDirectory);
    await rm(missingInstruction.instructionPath);
    await expect(readProfileArtifactDirectory(missingInstruction.root, missingInstruction.policy))
      .rejects.toThrow(/missing required entry/u);

    const extraRootDirectory = await temporaryDirectory();
    const extraRoot = await createFixture(extraRootDirectory);
    await extraRootDirectory.write('portable-profile/extra', 'unexpected');
    await expect(readProfileArtifactDirectory(extraRoot.root, extraRoot.policy))
      .rejects.toThrow(/unexpected entry/u);

    const extraProfileDirectory = await temporaryDirectory();
    const extraProfile = await createFixture(extraProfileDirectory);
    await extraProfileDirectory.write('portable-profile/profile/extra', 'unexpected');
    await expect(readProfileArtifactDirectory(extraProfile.root, extraProfile.policy))
      .rejects.toThrow(/unexpected entry/u);

    const profileFileDirectory = await temporaryDirectory();
    const profileFile = await createFixture(profileFileDirectory);
    await rm(profileFile.profile, { recursive: true });
    await writeFile(profileFile.profile, 'not a directory');
    await expect(readProfileArtifactDirectory(profileFile.root, profileFile.policy))
      .rejects.toThrow(/physical directory/u);

    const manifestDirectory = await temporaryDirectory();
    const manifest = await createFixture(manifestDirectory);
    await rm(manifest.manifestPath);
    await mkdir(manifest.manifestPath);
    await expect(readProfileArtifactDirectory(manifest.root, manifest.policy))
      .rejects.toThrow(/physical regular file/u);
  });

  it.skipIf(process.platform === 'win32')('rejects linked artifact entries and roots', async () => {
    const rootDirectory = await temporaryDirectory();
    const rootFixture = await createFixture(rootDirectory, 'target');
    const linkedRoot = rootDirectory.path('linked-root');
    await symlink(rootFixture.root, linkedRoot);
    await expect(readProfileArtifactDirectory(linkedRoot, rootFixture.policy))
      .rejects.toThrow(/physical directory/u);

    const profileDirectory = await temporaryDirectory();
    const profileFixture = await createFixture(profileDirectory);
    await rename(profileFixture.profile, profileDirectory.path('saved-profile'));
    await symlink(profileDirectory.path('saved-profile'), profileFixture.profile);
    await expect(readProfileArtifactDirectory(profileFixture.root, profileFixture.policy))
      .rejects.toThrow(/physical directory/u);

    const manifestDirectory = await temporaryDirectory();
    const manifestFixture = await createFixture(manifestDirectory);
    await rename(manifestFixture.manifestPath, manifestDirectory.path('saved-manifest'));
    await symlink(manifestDirectory.path('saved-manifest'), manifestFixture.manifestPath);
    await expect(readProfileArtifactDirectory(manifestFixture.root, manifestFixture.policy))
      .rejects.toThrow(/physical regular file/u);

    const instructionDirectory = await temporaryDirectory();
    const instructionFixture = await createFixture(instructionDirectory);
    await rename(instructionFixture.instructionPath, instructionDirectory.path('saved-instructions'));
    await symlink(instructionDirectory.path('saved-instructions'), instructionFixture.instructionPath);
    await expect(readProfileArtifactDirectory(instructionFixture.root, instructionFixture.policy))
      .rejects.toThrow(/physical regular file/u);
  });

  it.skipIf(process.platform === 'win32')('rejects special manifest and instruction entries without hanging', async () => {
    const manifestDirectory = await temporaryDirectory();
    const manifestFixture = await createFixture(manifestDirectory);
    await rm(manifestFixture.manifestPath);
    await execFileAsync('mkfifo', [manifestFixture.manifestPath]);
    await expect(readProfileArtifactDirectory(manifestFixture.root, manifestFixture.policy))
      .rejects.toThrow(/physical regular file/u);

    const instructionDirectory = await temporaryDirectory();
    const instructionFixture = await createFixture(instructionDirectory);
    await rm(instructionFixture.instructionPath);
    await execFileAsync('mkfifo', [instructionFixture.instructionPath]);
    await expect(readProfileArtifactDirectory(instructionFixture.root, instructionFixture.policy))
      .rejects.toThrow(/physical regular file/u);
  }, 2_000);

  it('escapes control characters in artifact-derived instruction paths', async () => {
    const directory = await temporaryDirectory();
    const fixture = await createFixture(
      directory,
      'portable-\u001b[31m-profile',
      Buffer.from([0xff])
    );

    let failure: unknown;
    try {
      await readProfileArtifactDirectory(fixture.root, fixture.policy);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('portable-\\u001b[31m-profile');
    expect((failure as Error).message).not.toContain('\u001b');
  });

  it('rejects manifest replacement during its bounded read', async () => {
    const directory = await temporaryDirectory();
    const fixture = await createFixture(directory);
    const moved = directory.path('original-manifest');

    await expect(readProfileArtifactDirectory(fixture.root, fixture.policy, {
      afterManifestRead: async () => {
        await rename(fixture.manifestPath, moved);
        await writeFile(fixture.manifestPath, fixture.manifestBytes);
      }
    })).rejects.toThrow(/changed while being read/u);
  });

  it('rejects file and directory replacement before final validation', async () => {
    const instructionDirectory = await temporaryDirectory();
    const instruction = await createFixture(instructionDirectory);
    const movedInstruction = instructionDirectory.path('original-instructions');
    await expect(readProfileArtifactDirectory(instruction.root, instruction.policy, {
      beforeFinalIdentityCheck: async () => {
        await rename(instruction.instructionPath, movedInstruction);
        await writeFile(instruction.instructionPath, instruction.instructionBytes);
      }
    })).rejects.toThrow(/changed during inspection/u);

    const profileDirectory = await temporaryDirectory();
    const profile = await createFixture(profileDirectory);
    const movedProfile = profileDirectory.path('original-profile');
    await expect(readProfileArtifactDirectory(profile.root, profile.policy, {
      beforeFinalIdentityCheck: async () => {
        await rename(profile.profile, movedProfile);
        await mkdir(profile.profile);
        await writeFile(profile.instructionPath, profile.instructionBytes);
      }
    })).rejects.toThrow(/changed during inspection/u);

    const rootDirectory = await temporaryDirectory();
    const root = await createFixture(rootDirectory);
    const movedRoot = rootDirectory.path('original-artifact');
    await expect(readProfileArtifactDirectory(root.root, root.policy, {
      beforeFinalIdentityCheck: async () => {
        await rename(root.root, movedRoot);
        await mkdir(root.profile, { recursive: true });
        await writeFile(root.manifestPath, root.manifestBytes);
        await writeFile(root.instructionPath, root.instructionBytes);
      }
    })).rejects.toThrow(/changed during inspection/u);
  });

  it('surfaces cleanup failure after success and preserves primary validation errors', async () => {
    const closeFailure = () => {
      throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
    };

    const streamDirectory = await temporaryDirectory();
    const streamFixture = await createFixture(streamDirectory);
    await expect(readProfileArtifactDirectory(streamFixture.root, streamFixture.policy, {
      afterClose: (target) => target === 'directory-stream' ? closeFailure() : undefined
    })).rejects.toThrow(/directory stream could not be closed.*\(EIO\)/u);

    const handleDirectory = await temporaryDirectory();
    const handleFixture = await createFixture(handleDirectory);
    const canonicalRoot = await realpath(handleFixture.root);
    await expect(readProfileArtifactDirectory(handleFixture.root, handleFixture.policy, {
      afterClose: (target, path) => target === 'directory-handle' && path === canonicalRoot
        ? closeFailure()
        : undefined
    })).rejects.toThrow(/Could not close profile artifact directory handle.*\(EIO\)/u);

    const invalidDirectory = await temporaryDirectory();
    const invalidFixture = await createFixture(invalidDirectory);
    await rm(invalidFixture.manifestPath);
    await mkdir(invalidFixture.manifestPath);
    await expect(readProfileArtifactDirectory(invalidFixture.root, invalidFixture.policy, {
      afterClose: (target) => target === 'manifest' ? closeFailure() : undefined
    })).rejects.toThrow(/manifest must be a physical regular file/u);
  });

  it('copies the injected policy before asynchronous inspection', async () => {
    const directory = await temporaryDirectory();
    const fixture = await createFixture(directory);
    const mutablePolicy = { ...fixture.policy };

    await expect(readProfileArtifactDirectory(fixture.root, mutablePolicy, {
      afterManifestRead: () => {
        mutablePolicy.maxManifestBytes = 0;
        mutablePolicy.maxProfileEntries = Number.NaN;
        mutablePolicy.maxResources = Number.POSITIVE_INFINITY;
      }
    })).resolves.toMatchObject({ artifact: { profile: { id: 'focused' } } });
  });
});
