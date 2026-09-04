import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  open,
  lstat,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const packageRoot = resolve(argument('--package-root') ?? fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(argument('--output') ?? join(packageRoot, 'win32-native-evidence.json'));
const report = {
  schemaVersion: 4,
  purpose: 'Bazframe-owned native Windows foundation evidence only; not a Windows support claim.',
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node
  },
  packageRootKind: packageRoot.includes('node_modules') ? 'packed-install' : 'source-tree',
  completion: 'failed',
  releaseAdmission: 'not-authorized',
  windowsSupportClaim: false,
  observations: {},
  failures: []
};

let testRoot;
let privateRoot;
let outside;
let temporaryParent;
let substDrive;
try {
  requireCondition(process.platform === 'win32' && process.arch === 'x64', 'requires win32/x64');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const nativeModule = await import(pathToFileURL(join(packageRoot, 'dist/core/win32-native.js')).href);
  const privateDirectoryModule = await import(
    pathToFileURL(join(packageRoot, 'dist/state/win32-private-directory.js')).href
  );
  const directoryClosureModule = await import(
    pathToFileURL(join(packageRoot, 'dist/state/win32-directory-closure.js')).href
  );
  const directoryPublicationModule = await import(
    pathToFileURL(join(packageRoot, 'dist/state/win32-directory-publication.js')).href
  );
  const backend = nativeModule.loadBazframeWin32Native();
  const nativePath = join(
    packageRoot,
    'artifacts/native/win32-x64-msvc/bazframe-win32.node'
  );
  const nativeBytes = await readFile(nativePath);

  temporaryParent = resolve(process.env.BAZFRAME_WIN32_NATIVE_TEST_PARENT ?? tmpdir());
  const testRootComponent = `bazframe-native-foundation-${randomUUID()}`;
  testRoot = join(temporaryParent, testRootComponent);
  const bootstrapReceipt = backend.createPrivateDirectory(temporaryParent, testRootComponent);
  const rootInspection = privateDirectoryModule.admitWindowsPrivateDirectory(backend, testRoot);
  const privateComponent = 'private-数据';
  privateRoot = join(testRoot, privateComponent);
  const privateInspection = privateDirectoryModule.createWindowsPrivateDirectory(
    backend,
    testRoot,
    privateComponent
  );
  const parentAfterPrivateCreation = backend.inspectPath(testRoot);
  const occupiedBefore = backend.inspectPath(privateRoot);
  await expectCode(
    () => privateDirectoryModule.createWindowsPrivateDirectory(backend, testRoot, privateComponent),
    'WINDOWS_PRIVATE_DIRECTORY_OCCUPIED'
  );
  const occupiedAfter = backend.inspectPath(privateRoot);
  const occupiedChildUnchanged = sameDirectoryIdentityVolumeAndSecurity(
    occupiedBefore,
    occupiedAfter
  );
  const invalidComponent = 'invalid:name';
  let invalidCreationInvoked = false;
  const invalidGuardBackend = {
    ...backend,
    createPrivateDirectory(parentPath, finalComponent) {
      invalidCreationInvoked = true;
      return backend.createPrivateDirectory(parentPath, finalComponent);
    }
  };
  await expectCode(
    () => privateDirectoryModule.createWindowsPrivateDirectory(
      invalidGuardBackend,
      testRoot,
      invalidComponent
    ),
    'WINDOWS_PRIVATE_DIRECTORY_NAME_INVALID'
  );
  requireCondition(!invalidCreationInvoked, 'invalid component refused before native mutation');

  outside = await mkdtemp(join(temporaryParent, 'bazframe-native-outside-'));
  const file = join(testRoot, 'stable.txt');
  const empty = join(testRoot, 'empty.txt');
  await writeFile(file, 'stable bytes\n');
  await writeFile(empty, '');

  const fileInspection = backend.inspectPath(file);
  requireCondition(rootInspection.kind === 'directory', 'root inspection kind');
  requireCondition(fileInspection.kind === 'regular-file', 'file inspection kind');
  requireCondition(
    rootInspection.volume.identity === fileInspection.volume.identity,
    'root and file volume identity'
  );
  requireCondition(rootInspection.volume.filesystemName === 'NTFS', 'filesystem admission');
  requireCondition(rootInspection.volume.driveType === 'fixed', 'fixed-drive admission');
  requireCondition(rootInspection.volume.remoteDevice === false, 'remote-device refusal');

  const stable = await backend.readStableFile(file, Buffer.byteLength('stable bytes\n'));
  requireCondition(stable.bytes.toString('utf8') === 'stable bytes\n', 'stable bytes');
  const emptyReceipt = await backend.readStableFile(empty, 0);
  requireCondition(emptyReceipt.bytes.byteLength === 0, 'empty stable bytes');

  await expectCode(
    () => backend.readStableFile(file, 1),
    'WINDOWS_NATIVE_READ_LIMIT_EXCEEDED'
  );
  await expectCode(
    () => backend.inspectPath('\\\\localhost\\bazframe-nonexistent\\state'),
    'WINDOWS_NATIVE_TARGET_UNSUPPORTED'
  );
  await expectCode(
    () => backend.inspectPath('\\\\?\\C:\\bazframe-nonexistent'),
    'WINDOWS_NATIVE_TARGET_UNSUPPORTED'
  );

  substDrive = unusedDriveLetter();
  execFileSync('subst.exe', [substDrive, testRoot], { stdio: 'pipe' });
  await expectCode(
    () => backend.inspectPath(`${substDrive}\\stable.txt`),
    'WINDOWS_NATIVE_VOLUME_NOT_FIXED'
  );

  await writeFile(join(outside, 'child.txt'), 'outside\n');
  const junction = join(testRoot, 'outside-junction');
  await symlink(outside, junction, 'junction');
  await expectCode(() => backend.inspectPath(junction), 'WINDOWS_NATIVE_REPARSE_REFUSED');
  await expectCode(
    () => backend.inspectPath(join(junction, 'child.txt')),
    'WINDOWS_NATIVE_REPARSE_REFUSED'
  );
  await expectCode(
    () => privateDirectoryModule.createWindowsPrivateDirectory(backend, junction, 'child'),
    'WINDOWS_NATIVE_REPARSE_REFUSED'
  );
  await unlink(junction);
  requireCondition(await readFile(join(outside, 'child.txt'), 'utf8') === 'outside\n', 'junction target preserved');

  const closureComponent = 'closure-root';
  const closureRoot = join(privateRoot, closureComponent);
  privateDirectoryModule.createWindowsPrivateDirectory(backend, privateRoot, closureComponent);
  privateDirectoryModule.createWindowsPrivateDirectory(backend, closureRoot, 'nested-数据');
  privateDirectoryModule.createWindowsPrivateDirectory(backend, closureRoot, 'empty');
  const closureFiles = [
    [join(closureRoot, 'zeta.txt'), 'zeta\n'],
    [join(closureRoot, 'alpha.txt'), 'alpha\n'],
    [join(closureRoot, 'nested-数据', 'value.txt'), 'nested\n']
  ];
  for (const [path, bytes] of closureFiles) {
    await writeFile(path, bytes);
    makePrivateTestFile(path, rootInspection.security.currentUserSid);
  }

  const enumeration = await backend.enumerateStableDirectory(closureRoot, 4);
  const enumerationNames = enumeration.entries.map((entry) => entry.name);
  requireCondition(
    JSON.stringify(enumerationNames) === JSON.stringify([...enumerationNames].sort()),
    'stable directory enumeration order'
  );
  requireCondition(enumeration.entries.length === 4, 'stable directory exact bound');
  await expectCode(
    () => backend.enumerateStableDirectory(closureRoot, 3),
    'WINDOWS_NATIVE_ENUMERATION_LIMIT_EXCEEDED'
  );
  const secondEnumeration = await backend.enumerateStableDirectory(closureRoot, 4);
  const emptyEnumeration = await backend.enumerateStableDirectory(join(closureRoot, 'empty'), 0);
  requireCondition(emptyEnumeration.entries.length === 0, 'empty stable directory enumeration');

  const manyComponent = 'enumeration-many';
  const manyRoot = join(privateRoot, manyComponent);
  privateDirectoryModule.createWindowsPrivateDirectory(backend, privateRoot, manyComponent);
  const manyNames = Array.from(
    { length: 400 },
    (_, index) => `entry-${String(index).padStart(3, '0')}-${'x'.repeat(75)}`
  );
  requireCondition(
    manyNames.reduce((bytes, name) => bytes + Buffer.byteLength(name, 'utf16le'), 0) > 64 * 1024,
    'multi-buffer directory fixture exceeds one native buffer in names alone'
  );
  for (const name of manyNames) await writeFile(join(manyRoot, name), '');
  const manyFirst = await backend.enumerateStableDirectory(manyRoot, manyNames.length);
  const manySecond = await backend.enumerateStableDirectory(manyRoot, manyNames.length);
  requireCondition(
    JSON.stringify(manyFirst.entries) === JSON.stringify(manySecond.entries)
      && JSON.stringify(manyFirst.entries.map((entry) => entry.name))
        === JSON.stringify([...manyNames].sort()),
    'multi-buffer directory enumeration is complete and deterministic'
  );
  await expectCode(
    () => backend.enumerateStableDirectory(manyRoot, manyNames.length - 1),
    'WINDOWS_NATIVE_ENUMERATION_LIMIT_EXCEEDED'
  );

  const closure = await directoryClosureModule.captureWindowsDirectoryClosure(
    backend,
    closureRoot,
    { maxEntries: 6, maxDepth: 2, maxPathBytes: 256, maxFileBytes: 32, maxAggregateBytes: 64 }
  );
  const repeatedClosure = await directoryClosureModule.captureWindowsDirectoryClosure(
    backend,
    closureRoot,
    { maxEntries: 6, maxDepth: 2, maxPathBytes: 256, maxFileBytes: 32, maxAggregateBytes: 64 }
  );
  const listedIdentities = new Map(enumeration.entries.map((entry) => [entry.name, entry.fileId]));
  const closureTopLevel = closure.closure.entries.filter((entry) => !entry.path.includes('/'));
  const closureIdentityReconciled = closureTopLevel.every(
    (entry) => listedIdentities.get(entry.path) === entry.fileId
  );
  await expectCode(
    () => directoryClosureModule.captureWindowsDirectoryClosure(
      backend,
      closureRoot,
      { maxEntries: 7, maxDepth: 2, maxPathBytes: 256, maxFileBytes: 32, maxAggregateBytes: 64 },
      { beforeSecondPass: () => writeFile(join(closureRoot, 'drift.txt'), 'drift\n') }
    ),
    'WINDOWS_DIRECTORY_CLOSURE_CHANGED'
  );
  await unlink(join(closureRoot, 'drift.txt'));

  for (const lowerLimits of [
    { maxEntries: 4 },
    { maxDepth: 0 },
    { maxPathBytes: 4 },
    { maxFileBytes: 5 },
    { maxAggregateBytes: 10 }
  ]) {
    await expectCode(
      () => directoryClosureModule.captureWindowsDirectoryClosure(
        backend,
        closureRoot,
        lowerLimits
      ),
      'WINDOWS_DIRECTORY_CLOSURE_LIMIT_EXCEEDED'
    );
  }

  const hardLinkAlias = join(outside, 'closure-hard-link');
  await link(join(closureRoot, 'alpha.txt'), hardLinkAlias);
  await expectCode(
    () => directoryClosureModule.captureWindowsDirectoryClosure(backend, closureRoot),
    'WINDOWS_DIRECTORY_CLOSURE_INVALID'
  );
  await unlink(hardLinkAlias);

  const broadAclComponent = 'broad-file-acl';
  const broadAclRoot = join(privateRoot, broadAclComponent);
  privateDirectoryModule.createWindowsPrivateDirectory(backend, privateRoot, broadAclComponent);
  const broadAclFile = join(broadAclRoot, 'secret.txt');
  await writeFile(broadAclFile, 'secret\n');
  makePrivateTestFile(broadAclFile, rootInspection.security.currentUserSid);
  execFileSync('icacls.exe', [broadAclFile, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe' });
  await expectCode(
    () => directoryClosureModule.captureWindowsDirectoryClosure(backend, broadAclRoot),
    'WINDOWS_DIRECTORY_CLOSURE_INVALID'
  );

  const closureJunction = join(closureRoot, 'outside-junction');
  await symlink(outside, closureJunction, 'junction');
  const reparseEnumeration = await backend.enumerateStableDirectory(closureRoot, 5);
  const reparseEntry = reparseEnumeration.entries.find((entry) => entry.name === 'outside-junction');
  requireCondition(reparseEntry?.reparseTag !== null, 'directory reparse observed as leaf');
  await expectCode(
    () => directoryClosureModule.captureWindowsDirectoryClosure(
      backend,
      closureRoot,
      { maxEntries: 7, maxDepth: 2, maxPathBytes: 256, maxFileBytes: 32, maxAggregateBytes: 64 }
    ),
    'WINDOWS_DIRECTORY_CLOSURE_INVALID'
  );
  await unlink(closureJunction);
  requireCondition(
    await readFile(join(outside, 'child.txt'), 'utf8') === 'outside\n',
    'enumerated reparse target preserved'
  );

  const dependentStateSha256 = createHash('sha256')
    .update('publication-dependent-state:none')
    .digest('hex');
  const authority = (transactionId) => ({ transactionId, assertHeld() {} });
  const createPublicationFixture = async (label, withOld = false) => {
    const component = `publication-${label}`;
    const root = join(privateRoot, component);
    privateDirectoryModule.createWindowsPrivateDirectory(backend, privateRoot, component);
    const parent = join(root, 'parent');
    const journals = join(root, 'journals');
    privateDirectoryModule.createWindowsPrivateDirectory(backend, root, 'parent');
    privateDirectoryModule.createWindowsPrivateDirectory(backend, root, 'journals');
    const destinationName = 'profile';
    const destination = join(parent, destinationName);
    if (withOld) {
      privateDirectoryModule.createWindowsPrivateDirectory(backend, parent, destinationName);
      await writePrivateInheritedFile(join(destination, 'old.txt'), 'old\n');
    }
    return { root, parent, journals, destinationName, destination };
  };
  const commonPublicationOptions = (fixture, transactionId, observed = () => dependentStateSha256) => ({
    backend,
    parentPath: fixture.parent,
    journalRootPath: fixture.journals,
    destinationName: fixture.destinationName,
    dependentState: { expectedSha256: dependentStateSha256, observeSha256: observed },
    authority: authority(transactionId)
  });
  const materializePublicationCandidate = async (candidatePath) => {
    await writePrivateInheritedFile(join(candidatePath, 'new.txt'), 'new\n');
  };

  const freshFixture = await createPublicationFixture('fresh');
  const freshTransaction = transactionId();
  const freshResult = await directoryPublicationModule.executeWindowsDirectoryPublication({
    ...commonPublicationOptions(freshFixture, freshTransaction),
    operation: { mode: 'fresh' },
    materialize: materializePublicationCandidate
  });
  requireCondition(freshResult.action === 'committed' && !freshResult.backupRetained, 'fresh publication committed');
  requireCondition(await readFile(join(freshFixture.destination, 'new.txt'), 'utf8') === 'new\n', 'fresh publication bytes');
  const freshJournalClosure = await directoryClosureModule.captureWindowsDirectoryClosure(
    backend,
    join(freshFixture.journals, freshTransaction),
    { maxEntries: 8, maxDepth: 0, maxPathBytes: 32, maxFileBytes: 1024 * 1024, maxAggregateBytes: 8 * 1024 * 1024 }
  );
  requireCondition(
    freshJournalClosure.closure.entries.length === 6
      && freshJournalClosure.closure.entries.every((entry) => entry.kind === 'file'),
    'publication journal closure is private and append-only'
  );

  const replacementFixture = await createPublicationFixture('replacement', true);
  const replacementTransaction = transactionId();
  const expectedOld = await directoryClosureModule.captureWindowsDirectoryClosure(
    backend,
    replacementFixture.destination
  );
  const replacementResult = await directoryPublicationModule.executeWindowsDirectoryPublication({
    ...commonPublicationOptions(replacementFixture, replacementTransaction),
    operation: {
      mode: 'replacement',
      expectedOld: {
        rootIdentity: expectedOld.rootIdentity,
        closureSha256: expectedOld.closureSha256
      },
      overwriteAuthorization: 'explicit-overwrite'
    },
    materialize: materializePublicationCandidate
  });
  const replacementBackup = join(
    replacementFixture.parent,
    `.bazframe-backup-${replacementTransaction}`
  );
  const retainedOld = await directoryClosureModule.captureWindowsDirectoryClosure(backend, replacementBackup);
  requireCondition(
    replacementResult.action === 'committed' && replacementResult.backupRetained
      && retainedOld.rootIdentity === expectedOld.rootIdentity
      && retainedOld.closureSha256 === expectedOld.closureSha256
      && await readFile(join(replacementFixture.destination, 'new.txt'), 'utf8') === 'new\n',
    'replacement publication retained exact private backup'
  );

  const sharingFixture = await createPublicationFixture('sharing');
  const sharingTransaction = transactionId();
  let sharingFailures = 1;
  await expectCode(
    () => directoryPublicationModule.executeWindowsDirectoryPublication({
      ...commonPublicationOptions(sharingFixture, sharingTransaction),
      operation: { mode: 'fresh' },
      materialize: materializePublicationCandidate,
      io: publicationIo(async (source, destination) => {
        if (sharingFailures > 0) {
          sharingFailures -= 1;
          throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
        }
        await rename(source, destination);
      })
    }),
    'WINDOWS_DIRECTORY_PUBLICATION_RETRY_REQUIRED'
  );
  const recoveredSharing = await directoryPublicationModule.recoverWindowsDirectoryPublication({
    ...commonPublicationOptions(sharingFixture, sharingTransaction),
    transactionId: sharingTransaction
  });
  requireCondition(recoveredSharing.action === 'committed', 'no-effect sharing failure recovered');

  const afterEffectFixture = await createPublicationFixture('after-effect', true);
  const afterEffectTransaction = transactionId();
  const afterEffectOld = await directoryClosureModule.captureWindowsDirectoryClosure(
    backend,
    afterEffectFixture.destination
  );
  const afterEffectResult = await directoryPublicationModule.executeWindowsDirectoryPublication({
    ...commonPublicationOptions(afterEffectFixture, afterEffectTransaction),
    operation: {
      mode: 'replacement',
      expectedOld: {
        rootIdentity: afterEffectOld.rootIdentity,
        closureSha256: afterEffectOld.closureSha256
      },
      overwriteAuthorization: 'explicit-overwrite'
    },
    materialize: materializePublicationCandidate,
    io: publicationIo(async (source, destination) => {
      await rename(source, destination);
      throw Object.assign(new Error('reported error after effect'), { code: 'EIO' });
    })
  });
  requireCondition(afterEffectResult.action === 'committed', 'after-effect rename error reconciled');

  let occupiedRacePreserved = true;
  for (const kind of ['file', 'empty-directory', 'nonempty-directory', 'case-directory', 'symlink', 'junction']) {
    const fixture = await createPublicationFixture(`race-${kind}`);
    const transaction = transactionId();
    let occupiedPath = fixture.destination;
    let beforeInspection;
    let beforeReparseTag;
    let beforeReparseFileId;
    const raceResult = await directoryPublicationModule.executeWindowsDirectoryPublication({
      ...commonPublicationOptions(fixture, transaction),
      operation: { mode: 'fresh' },
      materialize: materializePublicationCandidate,
      io: publicationIo(async (source, destination) => {
        if (kind === 'file') {
          await writePrivateInheritedFile(destination, 'occupied\n');
          beforeInspection = backend.inspectPath(destination);
        } else if (kind === 'symlink' || kind === 'junction') {
          await symlink(outside, destination, kind === 'symlink' ? 'dir' : 'junction');
          const occupied = await backend.enumerateStableDirectory(fixture.parent, 3);
          const reparse = occupied.entries.find(
            (entry) => entry.name.toLowerCase() === fixture.destinationName
          );
          beforeReparseTag = reparse?.reparseTag;
          beforeReparseFileId = reparse?.fileId;
        } else {
          const component = kind === 'case-directory' ? 'PROFILE' : fixture.destinationName;
          occupiedPath = join(fixture.parent, component);
          privateDirectoryModule.createWindowsPrivateDirectory(backend, fixture.parent, component);
          if (kind === 'nonempty-directory') {
            await writePrivateInheritedFile(join(occupiedPath, 'occupied.txt'), 'occupied\n');
          }
          beforeInspection = backend.inspectPath(occupiedPath);
        }
        await rename(source, destination);
      })
    });
    occupiedRacePreserved &&= raceResult.action === 'ambiguous';
    if (kind === 'symlink' || kind === 'junction') {
      const occupied = await backend.enumerateStableDirectory(fixture.parent, 3);
      const afterReparse = occupied.entries.find(
        (entry) => entry.name.toLowerCase() === fixture.destinationName
      );
      const afterReparseTag = afterReparse?.reparseTag;
      occupiedRacePreserved &&= (await lstat(fixture.destination)).isSymbolicLink()
        && beforeReparseTag !== null && beforeReparseTag !== undefined
        && beforeReparseTag === afterReparseTag
        && beforeReparseFileId !== undefined
        && beforeReparseFileId === afterReparse?.fileId
        && beforeReparseTag === (kind === 'symlink' ? 0xa000000c : 0xa0000003)
        && await readFile(join(outside, 'child.txt'), 'utf8') === 'outside\n';
    } else {
      const afterInspection = backend.inspectPath(occupiedPath);
      occupiedRacePreserved &&= beforeInspection.object.fileId === afterInspection.object.fileId;
      if (kind === 'file') {
        occupiedRacePreserved &&= await readFile(occupiedPath, 'utf8') === 'occupied\n';
      }
    }
  }
  requireCondition(occupiedRacePreserved, 'occupied race destinations preserved');

  const dependentFixture = await createPublicationFixture('dependent-drift', true);
  const dependentTransaction = transactionId();
  const dependentOld = await directoryClosureModule.captureWindowsDirectoryClosure(
    backend,
    dependentFixture.destination
  );
  let observedDependent = dependentStateSha256;
  const dependentResult = await directoryPublicationModule.executeWindowsDirectoryPublication({
    ...commonPublicationOptions(dependentFixture, dependentTransaction, () => observedDependent),
    operation: {
      mode: 'replacement',
      expectedOld: {
        rootIdentity: dependentOld.rootIdentity,
        closureSha256: dependentOld.closureSha256
      },
      overwriteAuthorization: 'explicit-overwrite'
    },
    materialize: materializePublicationCandidate,
    hooks: {
      afterPhase(phase) {
        if (phase === 'CANDIDATE_RENAME_INTENT') {
          observedDependent = createHash('sha256').update('changed-dependent-state').digest('hex');
        }
      }
    }
  });
  requireCondition(
    dependentResult.action === 'ambiguous'
      && !await pathExists(dependentFixture.destination)
      && await readFile(join(
        dependentFixture.parent,
        `.bazframe-candidate-${dependentTransaction}`,
        'new.txt'
      ), 'utf8') === 'new\n'
      && (await lstat(join(dependentFixture.parent, `.bazframe-backup-${dependentTransaction}`))).isDirectory(),
    'dependent-state drift before publication retained private transaction state'
  );

  const journalDriftFixture = await createPublicationFixture('journal-drift');
  const journalDriftTransaction = transactionId();
  await expectCode(
    () => directoryPublicationModule.executeWindowsDirectoryPublication({
      ...commonPublicationOptions(journalDriftFixture, journalDriftTransaction),
      operation: { mode: 'fresh' },
      materialize: materializePublicationCandidate,
      io: publicationIo(async () => {
        throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
      })
    }),
    'WINDOWS_DIRECTORY_PUBLICATION_RETRY_REQUIRED'
  );
  const journalDriftDirectory = join(journalDriftFixture.journals, journalDriftTransaction);
  const journalEntries = await backend.enumerateStableDirectory(journalDriftDirectory, 8);
  const lastJournal = journalEntries.entries.at(-1).name;
  await writeFile(join(journalDriftDirectory, lastJournal), '{"broken":true}\n');
  let renameAfterJournalDrift = false;
  await expectCode(
    () => directoryPublicationModule.recoverWindowsDirectoryPublication({
      ...commonPublicationOptions(journalDriftFixture, journalDriftTransaction),
      transactionId: journalDriftTransaction,
      io: publicationIo(async () => { renameAfterJournalDrift = true; })
    }),
    'WINDOWS_DIRECTORY_PUBLICATION_JOURNAL_INVALID'
  );
  requireCondition(!renameAfterJournalDrift, 'corrupt journal refused before recovery rename');

  const crashCases = [
    ...[
      'PLANNED', 'CANDIDATE_READY', 'OLD_RENAME_INTENT', 'OLD_RENAME_PROVEN',
      'CANDIDATE_RENAME_INTENT', 'CANDIDATE_RENAME_PROVEN',
      'DEPENDENT_STATE_PROVEN', 'COMMITTED'
    ].map((phase) => ({ publicationMode: 'replacement', phase })),
    ...[
      'PLANNED', 'CANDIDATE_READY', 'CANDIDATE_RENAME_INTENT',
      'CANDIDATE_RENAME_PROVEN', 'DEPENDENT_STATE_PROVEN', 'COMMITTED'
    ].map((phase) => ({ publicationMode: 'fresh', phase })),
    { publicationMode: 'replacement', point: 'after-old-rename' },
    { publicationMode: 'replacement', point: 'after-candidate-rename' },
    { publicationMode: 'fresh', point: 'after-candidate-rename' }
  ];
  const childScript = fileURLToPath(new URL('./test-win32-directory-publication-child.mjs', import.meta.url));
  let restartRecoveryPassed = true;
  for (const crashCase of crashCases) {
    const label = crashCase.phase ?? crashCase.point;
    const fixture = await createPublicationFixture(
      `crash-${crashCase.publicationMode}-${label.toLowerCase()}`,
      crashCase.publicationMode === 'replacement'
    );
    const transaction = transactionId();
    const commonArgs = [
      childScript,
      '--package-root', packageRoot,
      '--parent', fixture.parent,
      '--journal-root', fixture.journals,
      '--destination', fixture.destinationName,
      '--transaction', transaction,
      '--publication-mode', crashCase.publicationMode
    ];
    const crashArgs = crashCase.phase === undefined
      ? ['--crash-point', crashCase.point]
      : ['--crash-phase', crashCase.phase];
    const stopped = spawnSync(process.execPath, [
      ...commonArgs,
      '--mode', 'start',
      ...crashArgs
    ], { encoding: 'utf8', shell: false });
    if (stopped.status !== 86) {
      throw new Error(`Publication crash child failed at ${label}: ${stopped.status}; ${stopped.stderr}`);
    }
    const recovered = spawnSync(process.execPath, [
      ...commonArgs,
      '--mode', 'recover'
    ], { encoding: 'utf8', shell: false });
    if (recovered.status !== 0) {
      throw new Error(`Publication recovery child failed at ${label}: ${recovered.status}; ${recovered.stderr}`);
    }
    const value = JSON.parse(recovered.stdout);
    const expectedAction = crashCase.phase === 'PLANNED' || crashCase.phase === 'CANDIDATE_READY'
      ? 'aborted'
      : crashCase.phase === 'COMMITTED' ? 'terminal' : 'committed';
    restartRecoveryPassed &&= value.action === expectedAction;
  }
  requireCondition(restartRecoveryPassed, 'fresh/replacement clean-process phase and post-rename recovery matrix');

  report.observations = {
    binarySha256: createHash('sha256').update(nativeBytes).digest('hex'),
    packageVersion: manifest.version,
    stableByteCount: stable.byteCount,
    exactIdentityWidths: /^[0-9a-f]{16}$/u.test(rootInspection.volume.identity)
      && /^[0-9a-f]{32}$/u.test(rootInspection.object.fileId)
      && /^[0-9a-f]{32}$/u.test(stable.before.fileId),
    rootAndFileShareVolume: rootInspection.volume.identity === fileInspection.volume.identity,
    stableReadKeptIdentity: stable.before.volumeIdentity === stable.after.volumeIdentity
      && stable.before.fileId === stable.after.fileId,
    localFixedNtfs: true,
    uncAndDeviceNamespacesRefused: true,
    substitutedDriveRefused: true,
    finalReparseRefused: true,
    ancestorReparseRefused: true,
    boundedStableReads: true,
    junctionTargetPreserved: true,
    privateDirectoryFirstVisibilityPrivate: bootstrapReceipt.created.object.fileId
      === rootInspection.object.fileId
      && bootstrapReceipt.created.security.ownerSid
        === bootstrapReceipt.created.security.currentUserSid
      && bootstrapReceipt.created.security.daclPresent
      && !bootstrapReceipt.created.security.daclNull
      && (bootstrapReceipt.created.security.descriptorControl & 0x1000) !== 0
      && bootstrapReceipt.created.security.daclBytes.equals(rootInspection.security.daclBytes),
    privateDirectoryOwnerCurrentUser: rootInspection.security.ownerSid
      === rootInspection.security.currentUserSid,
    privateDirectoryDaclPresentNonNullProtected: rootInspection.security.daclPresent
      && !rootInspection.security.daclNull
      && (rootInspection.security.descriptorControl & 0x1000) !== 0,
    privateDirectoryTrustedFullControl: true,
    privateDirectoryNoReplace: occupiedChildUnchanged,
    privateDirectoryParentStable: bootstrapReceipt.parentBefore.object.fileId
      === bootstrapReceipt.parentAfter.object.fileId
      && bootstrapReceipt.parentBefore.volume.identity
        === bootstrapReceipt.parentAfter.volume.identity
      && rootInspection.object.fileId === parentAfterPrivateCreation.object.fileId
      && rootInspection.volume.identity === parentAfterPrivateCreation.volume.identity
      && rootInspection.security.daclBytes.equals(parentAfterPrivateCreation.security.daclBytes),
    privateDirectoryUnicodeName: privateInspection.canonicalPath.toLowerCase()
      === `${rootInspection.canonicalPath}\\${privateComponent}`.toLowerCase(),
    privateDirectoryInvalidNameRefusedBeforeMutation: !invalidCreationInvoked,
    privateDirectoryReparseParentRefused: true,
    privateDirectoryDirectChildLocalNtfs: privateInspection.volume.identity
      === rootInspection.volume.identity
      && privateInspection.volume.filesystemName === 'NTFS',
    stableDirectoryEnumerationEmptyAndBounded: emptyEnumeration.entries.length === 0
      && enumeration.entries.length === 4,
    stableDirectoryEnumerationDeterministic: JSON.stringify(enumeration.entries)
      === JSON.stringify(secondEnumeration.entries),
    stableDirectoryEnumerationMultiBufferComplete: manyFirst.entries.length === manyNames.length
      && JSON.stringify(manyFirst.entries) === JSON.stringify(manySecond.entries),
    stableDirectoryEnumerationKeptIdentity: enumeration.directoryBefore.object.fileId
      === enumeration.directoryAfter.object.fileId,
    directoryEnumerationIdentityReconciled: closureIdentityReconciled,
    directoryReparseObservedAsLeaf: reparseEntry?.reparseTag !== null,
    boundedDirectoryClosure: closure.closure.entries.length === 5
      && closure.closure.entries.some((entry) => entry.path === 'nested-数据/value.txt')
      && /^[0-9a-f]{64}$/u.test(closure.closureSha256)
      && JSON.stringify(closure) === JSON.stringify(repeatedClosure),
    directoryClosureLimitsRefused: true,
    directoryClosureHardLinkRefused: true,
    directoryClosureForeignFileAclRefused: true,
    directoryClosureDriftRefused: true,
    directoryClosureReparseRefusedTargetPreserved: true,
    directoryPublicationFreshNoReplace: freshResult.action === 'committed'
      && !freshResult.backupRetained,
    directoryPublicationReplacementBackupRetained: replacementResult.action === 'committed'
      && replacementResult.backupRetained,
    directoryPublicationAppendOnlyPrivateJournal: freshJournalClosure.closure.entries.length === 6,
    directoryPublicationRenameErrorPredicates: recoveredSharing.action === 'committed'
      && afterEffectResult.action === 'committed',
    directoryPublicationOccupiedRacePreserved: occupiedRacePreserved,
    directoryPublicationDependentDriftRetained: dependentResult.action === 'ambiguous',
    directoryPublicationCorruptJournalRefused: !renameAfterJournalDrift,
    directoryPublicationRestartRecovery: restartRecoveryPassed
  };
  for (const [name, value] of Object.entries(report.observations)) {
    if (typeof value === 'boolean') requireCondition(value, name);
  }
  report.completion = 'passed';
} catch (error) {
  report.failures.push(safeError(error));
  process.exitCode = 1;
} finally {
  if (substDrive !== undefined) {
    try { execFileSync('subst.exe', [substDrive, '/D'], { stdio: 'pipe' }); }
    catch (error) {
      report.failures.push({ stage: 'subst-cleanup', ...safeError(error) });
      report.completion = 'failed';
      process.exitCode = 1;
    }
  }
  await Promise.all([testRoot, outside].filter(Boolean).map(async (path) => {
    try { await rm(path, { recursive: true, force: true }); }
    catch (error) {
      report.failures.push({ stage: 'cleanup', ...safeError(error) });
      report.completion = 'failed';
      process.exitCode = 1;
    }
  }));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Bazframe native Windows foundation: ${report.completion}`);
  console.log(`Evidence: ${outputPath}`);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writePrivateInheritedFile(path, bytes) {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function publicationIo(renameOperation = rename) {
  return {
    async appendFileExclusive(path, bytes) {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename: renameOperation
  };
}

function transactionId() {
  return randomUUID().replaceAll('-', '');
}

function makePrivateTestFile(path, currentUserSid) {
  execFileSync('icacls.exe', [path, '/inheritance:r'], { stdio: 'pipe' });
  execFileSync('icacls.exe', [path, '/grant:r', `*${currentUserSid}:(F)`], { stdio: 'pipe' });
  execFileSync(
    'icacls.exe',
    [path, '/grant', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'],
    { stdio: 'pipe' }
  );
  execFileSync('icacls.exe', [path, '/setowner', `*${currentUserSid}`], { stdio: 'pipe' });
}

function unusedDriveLetter() {
  for (let code = 'Z'.charCodeAt(0); code >= 'D'.charCodeAt(0); code -= 1) {
    const drive = `${String.fromCharCode(code)}:`;
    try {
      execFileSync('cmd.exe', ['/d', '/s', '/c', `if exist ${drive}\\ exit /b 1`], { stdio: 'pipe' });
      return drive;
    } catch {
      // Occupied drive; continue toward D:.
    }
  }
  throw new Error('No unused drive letter is available for substituted-drive conformance.');
}

function argument(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function expectCode(operation, expected) {
  try {
    await operation();
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === expected) return;
    throw new Error(
      `Expected ${expected}, received ${safeError(error).code ?? safeError(error).message}`,
      { cause: error }
    );
  }
  throw new Error(`Expected ${expected}, but the operation succeeded`);
}

function requireCondition(condition, name) {
  if (!condition) throw new Error(`Native conformance failed: ${name}`);
}

function sameDirectoryIdentityVolumeAndSecurity(before, after) {
  return before.canonicalPath.toLowerCase() === after.canonicalPath.toLowerCase()
    && before.kind === 'directory'
    && after.kind === 'directory'
    && before.ancestryReparseFree === true
    && after.ancestryReparseFree === true
    && before.volume.identity === after.volume.identity
    && before.volume.filesystemName === after.volume.filesystemName
    && before.volume.driveType === after.volume.driveType
    && before.volume.canonicalVolumeGuidPath.toLowerCase()
      === after.volume.canonicalVolumeGuidPath.toLowerCase()
    && before.volume.remoteDevice === after.volume.remoteDevice
    && before.object.volumeIdentity === after.object.volumeIdentity
    && before.object.fileId === after.object.fileId
    && before.object.reparseTag === null
    && after.object.reparseTag === null
    && before.object.deletePending === false
    && after.object.deletePending === false
    && before.object.directory === true
    && after.object.directory === true
    && before.security.descriptorControl === after.security.descriptorControl
    && before.security.daclPresent === after.security.daclPresent
    && before.security.daclNull === after.security.daclNull
    && before.security.daclDefaulted === after.security.daclDefaulted
    && before.security.daclBytes.equals(after.security.daclBytes)
    && before.security.ownerSid === after.security.ownerSid
    && before.security.ownerDefaulted === after.security.ownerDefaulted
    && before.security.groupSid === after.security.groupSid
    && before.security.groupDefaulted === after.security.groupDefaulted
    && before.security.currentUserSid === after.security.currentUserSid;
}

function replaceCaseInsensitive(value, search, replacement) {
  const foldedValue = value.toLowerCase();
  const foldedSearch = search.toLowerCase();
  let cursor = 0;
  let result = '';
  while (true) {
    const index = foldedValue.indexOf(foldedSearch, cursor);
    if (index === -1) return result + value.slice(cursor);
    result += value.slice(cursor, index) + replacement;
    cursor = index + search.length;
  }
}

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/S-[0-9]+(?:-[0-9]+)+/giu, '[sid]');
  for (const [path, label] of [
    [privateRoot, '[private-root]'],
    [testRoot, '[test-root]'],
    [outside, '[outside-root]'],
    [packageRoot, '[package-root]'],
    [temporaryParent, '[temporary-root]']
  ]) {
    if (typeof path === 'string' && path.length > 0) message = replaceCaseInsensitive(message, path, label);
  }
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    code: error !== null && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : null,
    message
  };
}
