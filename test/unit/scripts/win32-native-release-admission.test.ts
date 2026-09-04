import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ZipFile } from 'yazl';
import { describe, expect, it } from 'vitest';
import { createTempDirectory } from '../../helpers/temp-directory.js';
// @ts-expect-error Repository scripts intentionally have no TypeScript declaration surface.
import { admitWin32NativeRelease } from '../../../scripts/win32-native-release-admission.mjs';

const commit = 'a'.repeat(40);
const version = '0.1.0-test.1';
const binary = Buffer.from('reviewed-win32-native-binary');
const binarySha256 = sha256(binary);

interface FixtureOptions {
  mutate?: (fixture: EvidenceFixture) => void;
  omit?: string;
  extra?: boolean;
  symlinkEntry?: string;
  duplicateEntry?: string;
}

interface EvidenceReceipt {
  schemaVersion: number;
  completion: string;
  releaseAdmission: string;
  environment: { node: string };
  observations: Record<string, string | boolean>;
  extra?: boolean;
}

interface AggregateEvidence {
  schemaVersion: number;
  sourceCommit: string;
  rust: string;
  msvcToolsVersion: string;
  binarySha256: string;
  windowsSupportClaim: boolean;
  sourceConformance: EvidenceReceipt;
  installedConformance: EvidenceReceipt;
}

interface EvidenceFixture {
  source: EvidenceReceipt;
  installed: EvidenceReceipt;
  aggregate: AggregateEvidence;
  rust: string;
  msvc: string;
  checksum: string;
}

describe('Win32 native release admission', () => {
  it('normalizes the upload action raw digest before comparing REST metadata and ZIP bytes', async () => {
    const foundationWorkflow = await readFile('.github/workflows/win32-native-foundation.yml', 'utf8');
    const publishWorkflow = await readFile('.github/workflows/npm-publish.yml', 'utf8');
    expect(foundationWorkflow).toContain('Raw lowercase 64-hex SHA-256 output from actions/upload-artifact.');
    expect(publishWorkflow).toContain('[[ "$ARTIFACT_DIGEST_OUTPUT" =~ ^[a-f0-9]{64}$ ]]');
    expect(publishWorkflow).toContain('ARTIFACT_DIGEST="sha256:$ARTIFACT_DIGEST_OUTPUT"');
    expect(publishWorkflow).toContain('test "$ACTUAL_DIGEST" = "$ARTIFACT_DIGEST_OUTPUT"');
  });

  it('derives no-replace evidence from immediate before/after identity and security', async () => {
    const conformance = await readFile('scripts/test-win32-native-foundation.mjs', 'utf8');
    expect(conformance).toContain('const occupiedBefore = backend.inspectPath(privateRoot);');
    expect(conformance).toContain('const occupiedAfter = backend.inspectPath(privateRoot);');
    expect(conformance).toContain('privateDirectoryNoReplace: occupiedChildUnchanged');
    expect(conformance).not.toContain('privateDirectoryNoReplace: true');
  });

  it('admits only exact commit-bound evidence and emits an assembly-only record', async () => {
    const directory = await createTempDirectory();
    try {
      const root = directory.path('repository');
      await directory.write('repository/package.json', JSON.stringify({ name: 'bazframe', version }));
      const archive = await createEvidenceArchive(directory.path('evidence.zip'));
      const record = await admit(root, archive.path, archive.digest);

      expect(record).toMatchObject({
        sourceCommit: commit,
        packageVersion: version,
        target: 'win32-x64-msvc',
        binaryPath: 'artifacts/native/win32-x64-msvc/bazframe-win32.node',
        binarySha256,
        producer: {
          repository: 'sram1337/bazframe',
          repositoryId: '1334347295',
          workflow: '.github/workflows/win32-native-foundation.yml',
          runId: '33825410350',
          artifactId: '9919819006',
          artifactName: `bazframe-win32-native-foundation-${commit}`,
          archiveDigest: `sha256:${archive.digest}`
        },
        toolchain: { node: '22.19.0', rust: '1.88.0', msvcToolsVersion: '14.44.35207' },
        releaseAdmission: 'authorized-for-package-assembly',
        windowsSupportClaim: false
      });
      expect(await readFile(directory.path('repository', record.binaryPath))).toEqual(binary);
      expect(JSON.parse(await readFile(directory.path('repository', 'win32-native-release-admission.json'), 'utf8'))).toEqual(record);
    } finally {
      await directory.cleanup();
    }
  });

  it.each([
    ['wrong release commit', (fixture: EvidenceFixture) => { fixture.aggregate.sourceCommit = 'b'.repeat(40); }],
    ['wrong package version', (fixture: EvidenceFixture) => { fixture.source.observations.packageVersion = '0.1.0-wrong'; }],
    ['wrong Node version', (fixture: EvidenceFixture) => { fixture.installed.environment.node = '24.0.0'; }],
    ['wrong Rust toolchain', (fixture: EvidenceFixture) => { fixture.aggregate.rust = fixture.rust.replace('1.88.0', '1.89.0'); }],
    ['wrong MSVC toolchain', (fixture: EvidenceFixture) => { fixture.aggregate.msvcToolsVersion = '14.45.0'; }],
    ['old v3 evidence', (fixture: EvidenceFixture) => {
      fixture.source.schemaVersion = 3;
      fixture.installed.schemaVersion = 3;
      fixture.aggregate.schemaVersion = 3;
    }],
    ['failed completion', (fixture: EvidenceFixture) => { fixture.source.completion = 'failed'; }],
    ['changed release boundary', (fixture: EvidenceFixture) => { fixture.installed.releaseAdmission = 'authorized'; }],
    ['changed support boundary', (fixture: EvidenceFixture) => { fixture.aggregate.windowsSupportClaim = true; }],
    ['failed observation', (fixture: EvidenceFixture) => { fixture.source.observations.localFixedNtfs = false; }],
    ['failed private-directory observation', (fixture: EvidenceFixture) => {
      fixture.source.observations.privateDirectoryFirstVisibilityPrivate = false;
    }],
    ['failed private-file observation', (fixture: EvidenceFixture) => {
      fixture.source.observations.privateFileFirstVisibilityPrivate = false;
    }],
    ['failed directory-closure observation', (fixture: EvidenceFixture) => {
      fixture.source.observations.boundedDirectoryClosure = false;
    }],
    ['failed directory-publication observation', (fixture: EvidenceFixture) => {
      fixture.installed.observations.directoryPublicationRestartRecovery = false;
    }],
    ['failed bounded-materializer observation', (fixture: EvidenceFixture) => {
      fixture.installed.observations.directoryPublicationMaterializerBounded = false;
    }],
    ['nested/external receipt mismatch', (fixture: EvidenceFixture) => { fixture.aggregate.sourceConformance.observations.stableByteCount = '000000000000000e'; }],
    ['extra schema field', (fixture: EvidenceFixture) => { fixture.installed.extra = true; }],
    ['wrong checksum', (fixture: EvidenceFixture) => { fixture.checksum = `${'0'.repeat(64)}\r\n`; }],
    ['wrong aggregate digest', (fixture: EvidenceFixture) => { fixture.aggregate.binarySha256 = '0'.repeat(64); }],
    ['wrong source receipt digest', (fixture: EvidenceFixture) => { fixture.source.observations.binarySha256 = '0'.repeat(64); }],
    ['wrong installed receipt digest', (fixture: EvidenceFixture) => { fixture.installed.observations.binarySha256 = '0'.repeat(64); }]
  ])('rejects %s', async (_name, mutate) => {
    const directory = await createTempDirectory();
    try {
      await directory.write('repository/package.json', JSON.stringify({ name: 'bazframe', version }));
      const archive = await createEvidenceArchive(directory.path('evidence.zip'), { mutate });
      await expect(admit(directory.path('repository'), archive.path, archive.digest)).rejects.toThrow(/release admission failed/u);
    } finally {
      await directory.cleanup();
    }
  });

  it.each([
    ['missing inventory', { omit: 'native-msvc-version.txt' }],
    ['extra inventory', { extra: true }],
    ['duplicate inventory', { duplicateEntry: 'native-rust-version.txt' }],
    ['linked inventory', { symlinkEntry: 'native-rust-version.txt' }]
  ])('rejects %s', async (_name, options) => {
    const directory = await createTempDirectory();
    try {
      await directory.write('repository/package.json', JSON.stringify({ name: 'bazframe', version }));
      const archive = await createEvidenceArchive(directory.path('evidence.zip'), options);
      await expect(admit(directory.path('repository'), archive.path, archive.digest)).rejects.toThrow(/release admission failed/u);
    } finally {
      await directory.cleanup();
    }
  });

  it('rejects archive-digest drift and occupied outputs without replacing bytes', async () => {
    const directory = await createTempDirectory();
    try {
      const root = directory.path('repository');
      await directory.write('repository/package.json', JSON.stringify({ name: 'bazframe', version }));
      const archive = await createEvidenceArchive(directory.path('evidence.zip'));
      await expect(admit(root, archive.path, '0'.repeat(64))).rejects.toThrow(/archive digest/u);
      const destination = directory.path('repository', 'artifacts', 'native', 'win32-x64-msvc', 'bazframe-win32.node');
      await directory.write('repository/artifacts/native/win32-x64-msvc/bazframe-win32.node', 'occupied');
      await expect(admit(root, archive.path, archive.digest)).rejects.toThrow(/already occupied/u);
      expect(await readFile(destination, 'utf8')).toBe('occupied');
    } finally {
      await directory.cleanup();
    }
  });
});

async function admit(repositoryRoot: string, archivePath: string, archiveDigest: string) {
  return admitWin32NativeRelease({
    repositoryRoot,
    archivePath,
    releaseCommit: commit,
    packageVersion: version,
    producerRepository: 'sram1337/bazframe',
    producerRepositoryId: '1334347295',
    producerRunId: '33825410350',
    artifactId: '9919819006',
    archiveDigest: `sha256:${archiveDigest}`
  });
}

async function createEvidenceArchive(path: string, options: FixtureOptions = {}) {
  const fixture = evidenceFixture();
  options.mutate?.(fixture);
  const values = new Map<string, Buffer>([
    ['artifacts/native/win32-x64-msvc/bazframe-win32.node', binary],
    ['native-binary.sha256', Buffer.from(fixture.checksum)],
    ['native-foundation-evidence.json', json(fixture.aggregate)],
    ['native-source-evidence.json', json(fixture.source)],
    ['native-installed-evidence.json', json(fixture.installed)],
    ['native-rust-version.txt', Buffer.from(fixture.rust)],
    ['native-msvc-version.txt', Buffer.from(fixture.msvc)]
  ]);
  if (options.omit) values.delete(options.omit);
  if (options.extra) values.set('unexpected.txt', Buffer.from('unexpected'));
  await writeZip(path, values, options.symlinkEntry, options.duplicateEntry);
  return { path, digest: sha256(await readFile(path)) };
}

function evidenceFixture(): EvidenceFixture {
  const source = receipt('source-tree');
  const installed = receipt('packed-install');
  const rust = 'rustc 1.88.0 (6b00bc388 2025-06-23)\r\nhost: x86_64-pc-windows-msvc\r\n';
  const msvc = 'Path=C:\\VS\\VC\\Tools\\MSVC\\14.44.35207\\bin\\HostX64\\x64\\cl.exe\r\n';
  const aggregate = {
    schemaVersion: 4,
    purpose: 'Bazframe-owned native foundation evidence only; not release admission or a Windows support claim.',
    completion: 'passed',
    sourceCommit: commit,
    runnerImage: 'win22',
    runnerImageVersion: 'test-image',
    node: 'v22.19.0',
    rust,
    msvcToolsVersion: '14.44.35207',
    msvc,
    binarySha256,
    sourceConformance: structuredClone(source),
    installedConformance: structuredClone(installed),
    releaseAdmission: 'not-authorized',
    windowsSupportClaim: false
  };
  return { source, installed, aggregate, rust, msvc, checksum: `${binarySha256}\r\n` };
}

function receipt(kind: 'source-tree' | 'packed-install') {
  return {
    schemaVersion: 4,
    purpose: 'Bazframe-owned native Windows foundation evidence only; not a Windows support claim.',
    environment: { platform: 'win32', arch: 'x64', node: '22.19.0' },
    packageRootKind: kind,
    completion: 'passed',
    releaseAdmission: 'not-authorized',
    windowsSupportClaim: false,
    observations: {
      binarySha256,
      packageVersion: version,
      stableByteCount: '000000000000000d',
      exactIdentityWidths: true,
      rootAndFileShareVolume: true,
      stableReadKeptIdentity: true,
      localFixedNtfs: true,
      uncAndDeviceNamespacesRefused: true,
      substitutedDriveRefused: true,
      finalReparseRefused: true,
      ancestorReparseRefused: true,
      boundedStableReads: true,
      junctionTargetPreserved: true,
      privateDirectoryFirstVisibilityPrivate: true,
      privateDirectoryOwnerCurrentUser: true,
      privateDirectoryDaclPresentNonNullProtected: true,
      privateDirectoryTrustedFullControl: true,
      privateDirectoryNoReplace: true,
      privateDirectoryParentStable: true,
      privateDirectoryUnicodeName: true,
      privateDirectoryInvalidNameRefusedBeforeMutation: true,
      privateDirectoryReparseParentRefused: true,
      privateDirectoryDirectChildLocalNtfs: true,
      privateFileFirstVisibilityPrivate: true,
      privateFileNoReplace: true,
      stableDirectoryEnumerationEmptyAndBounded: true,
      stableDirectoryEnumerationDeterministic: true,
      stableDirectoryEnumerationMultiBufferComplete: true,
      stableDirectoryEnumerationKeptIdentity: true,
      directoryEnumerationIdentityReconciled: true,
      directoryReparseObservedAsLeaf: true,
      boundedDirectoryClosure: true,
      directoryClosureLimitsRefused: true,
      directoryClosureHardLinkRefused: true,
      directoryClosureForeignFileAclRefused: true,
      directoryClosureDriftRefused: true,
      directoryClosureReparseRefusedTargetPreserved: true,
      directoryPublicationFreshNoReplace: true,
      directoryPublicationMaterializerDrained: true,
      directoryPublicationMaterializerBounded: true,
      directoryPublicationReplacementBackupRetained: true,
      directoryPublicationAppendOnlyPrivateJournal: true,
      directoryPublicationRenameErrorPredicates: true,
      directoryPublicationOccupiedRacePreserved: true,
      directoryPublicationDependentDriftRetained: true,
      directoryPublicationCorruptJournalRefused: true,
      directoryPublicationRestartRecovery: true
    },
    failures: []
  };
}

async function writeZip(path: string, values: Map<string, Buffer>, symlinkEntry?: string, duplicateEntry?: string) {
  const writer = new ZipFile();
  const chunks: Buffer[] = [];
  const completed = new Promise<void>((resolve, reject) => {
    writer.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    writer.outputStream.on('error', reject);
    writer.outputStream.on('end', resolve);
  });
  for (const [name, value] of values) {
    writer.addBuffer(value, name, { mode: name === symlinkEntry ? 0o120777 : 0o100644 });
  }
  if (duplicateEntry) writer.addBuffer(values.get(duplicateEntry)!, duplicateEntry, { mode: 0o100644 });
  writer.end();
  await completed;
  await writeFile(path, Buffer.concat(chunks));
}

function json(value: unknown) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
