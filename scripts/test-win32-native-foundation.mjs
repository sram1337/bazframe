import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  link,
  mkdir,
  mkdtemp,
  open,
  lstat,
  readFile,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const packageRoot = resolve(argument('--package-root') ?? fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(argument('--output') ?? join(packageRoot, 'win32-native-evidence.json'));
const report = {
  schemaVersion: 6,
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
  const operationLockModule = await import(
    pathToFileURL(join(packageRoot, 'dist/state/win32-operation-lock.js')).href
  );
  const membershipModule = await import(
    pathToFileURL(join(packageRoot, 'dist/state/win32-skill-membership.js')).href
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
  const privateFileComponent = 'private-file.txt';
  const privateFilePath = join(privateRoot, privateFileComponent);
  const privateFileReceipt = backend.createPrivateFile(privateRoot, privateFileComponent);
  const privateFileBefore = privateDirectoryModule.admitWindowsPrivateFile(backend, privateFilePath);
  await expectCode(
    () => backend.createPrivateFile(privateRoot, privateFileComponent),
    'WINDOWS_NATIVE_DIRECTORY_OCCUPIED'
  );
  const privateFileAfter = privateDirectoryModule.admitWindowsPrivateFile(backend, privateFilePath);
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

  const membershipParentComponent = 'skill-memberships';
  const membershipParent = join(privateRoot, membershipParentComponent);
  privateDirectoryModule.createWindowsPrivateDirectory(
    backend,
    privateRoot,
    membershipParentComponent
  );
  const membershipTarget = join(outside, 'membership-target');
  await mkdir(membershipTarget);
  const membershipMarker = join(membershipTarget, 'marker.txt');
  await writeFile(membershipMarker, 'membership target\n');
  const membershipTargetBefore = backend.inspectPath(membershipTarget);
  const membershipOptions = (skillId, targetPath = membershipTarget, io = undefined) => ({
    backend,
    parentPath: membershipParent,
    skillId,
    targetPath,
    ...(io === undefined ? {} : { io })
  });
  const membershipCreated = await membershipModule.createWindowsSkillMembership(
    membershipOptions('direct-skill')
  );
  const membershipProof = membershipModule.inspectWindowsSkillMembership(
    membershipOptions('direct-skill')
  );
  const membershipPath = join(membershipParent, 'direct-skill');
  const membershipJunctionDirectTarget = membershipCreated.action === 'added'
    && membershipProof.link.object.reparseTag === 0xa0000003
    && membershipProof.link.normalizedTarget.toLowerCase()
      === membershipTargetBefore.canonicalPath.toLowerCase()
    && membershipProof.link.targetVolumeIdentity === membershipTargetBefore.object.volumeIdentity
    && membershipProof.link.targetFileId === membershipTargetBefore.object.fileId
    && await readFile(join(membershipPath, 'marker.txt'), 'utf8') === 'membership target\n';
  const membershipJunctionExactInspection = membershipProof.link.canonicalPath.toLowerCase()
    === `${backend.inspectPath(membershipParent).canonicalPath}\\direct-skill`.toLowerCase();
  const repeatedMembershipProof = membershipModule.inspectWindowsSkillMembership(
    membershipOptions('direct-skill')
  );
  const repeatedMembershipStable = repeatedMembershipProof.link.object.fileId
    === membershipProof.link.object.fileId
    && repeatedMembershipProof.target.object.fileId === membershipProof.target.object.fileId;
  let driftReads = 0;
  const driftingMembershipBackend = {
    ...backend,
    inspectMembershipLink(path) {
      const result = backend.inspectMembershipLink(path);
      if (++driftReads < 2) return result;
      return {
        ...result,
        security: {
          ...result.security,
          groupSid: result.security.groupSid === 'S-1-5-18'
            ? 'S-1-5-32-544'
            : 'S-1-5-18'
        }
      };
    }
  };
  const membershipDriftRefused = await expectCode(
    () => membershipModule.inspectWindowsSkillMembership({
      ...membershipOptions('direct-skill'),
      backend: driftingMembershipBackend
    }),
    'WINDOWS_SKILL_MEMBERSHIP_CHANGED'
  );
  const membershipJunctionImmediateRevalidation = repeatedMembershipStable
    && membershipDriftRefused;
  const membershipLinkSecurityBasics = membershipProof.link.security.daclPresent
    && !membershipProof.link.security.daclNull
    && (membershipProof.link.security.descriptorControl & 0x1000) !== 0
    && membershipProof.link.security.daclBytes.byteLength > 0
    && membershipProof.link.security.ownerSid === membershipProof.link.security.currentUserSid
    && membershipProof.link.security.currentUserSid
      === membershipProof.parent.security.currentUserSid;

  const occupiedMembershipFile = join(membershipParent, 'occupied-file');
  await writeFile(occupiedMembershipFile, 'occupied\n');
  await expectCode(
    () => membershipModule.createWindowsSkillMembership(membershipOptions('occupied-file')),
    'WINDOWS_NATIVE_MEMBERSHIP_LINK_INVALID'
  );
  const occupiedMembershipDirectory = join(membershipParent, 'occupied-directory');
  privateDirectoryModule.createWindowsPrivateDirectory(
    backend,
    membershipParent,
    'occupied-directory'
  );
  await expectCode(
    () => membershipModule.createWindowsSkillMembership(membershipOptions('occupied-directory')),
    'WINDOWS_NATIVE_MEMBERSHIP_LINK_INVALID'
  );
  const caseEquivalentMembership = join(membershipParent, 'Case-Skill');
  await writeFile(caseEquivalentMembership, 'case occupant\n');
  await expectCode(
    () => membershipModule.createWindowsSkillMembership(membershipOptions('case-skill')),
    'WINDOWS_NATIVE_MEMBERSHIP_LINK_INVALID'
  );
  backend.createPrivateJunction(membershipParent, 'existing-skill', membershipTarget);
  const exactExisting = await membershipModule.createWindowsSkillMembership(
    membershipOptions('existing-skill')
  );
  const otherMembershipTarget = join(outside, 'other-membership-target');
  await mkdir(otherMembershipTarget);
  await writeFile(join(otherMembershipTarget, 'other.txt'), 'other\n');
  backend.createPrivateJunction(membershipParent, 'wrong-target', otherMembershipTarget);
  await expectCode(
    () => membershipModule.createWindowsSkillMembership(membershipOptions('wrong-target')),
    'WINDOWS_SKILL_MEMBERSHIP_INVALID'
  );
  const racedMembershipPath = join(membershipParent, 'raced-skill');
  const racedCreationRefused = await expectCode(
    () => membershipModule.createWindowsSkillMembership(
      membershipOptions('raced-skill', membershipTarget, {
        async createJunction(selectedBackend, parentPath, skillId, targetPath) {
          await writeFile(join(parentPath, skillId), 'raced occupant\n');
          return selectedBackend.createPrivateJunction(parentPath, skillId, targetPath);
        }
      })
    ),
    'WINDOWS_SKILL_MEMBERSHIP_CREATE_AMBIGUOUS'
  );
  const beforeCreateRefused = await expectCode(
    () => membershipModule.createWindowsSkillMembership(
      membershipOptions('before-create-error', membershipTarget, {
        async createJunction() { throw new Error('injected before-effect creation failure'); }
      })
    ),
    'WINDOWS_SKILL_MEMBERSHIP_CREATE_FAILED'
  );
  const afterCreateResult = await membershipModule.createWindowsSkillMembership(
    membershipOptions('after-create-error', membershipTarget, {
      async createJunction(selectedBackend, parentPath, skillId, targetPath) {
        selectedBackend.createPrivateJunction(parentPath, skillId, targetPath);
        throw new Error('injected after-effect creation failure');
      }
    })
  );
  const membershipJunctionNoReplace = exactExisting.action === 'current'
    && racedCreationRefused
    && beforeCreateRefused
    && afterCreateResult.action === 'added'
    && await readFile(occupiedMembershipFile, 'utf8') === 'occupied\n'
    && (await lstat(occupiedMembershipDirectory)).isDirectory()
    && await readFile(caseEquivalentMembership, 'utf8') === 'case occupant\n'
    && await readFile(racedMembershipPath, 'utf8') === 'raced occupant\n'
    && !await pathExists(join(membershipParent, 'before-create-error'))
    && await readFile(join(membershipParent, 'after-create-error', 'marker.txt'), 'utf8')
      === 'membership target\n'
    && await readFile(join(otherMembershipTarget, 'other.txt'), 'utf8') === 'other\n'
    && await readFile(membershipMarker, 'utf8') === 'membership target\n';

  const chainedTarget = join(outside, 'chained-membership-target');
  await symlink(membershipTarget, chainedTarget, 'junction');
  await symlink(chainedTarget, join(membershipParent, 'chained-skill'), 'junction');
  const chainedMembershipRefused = await expectCode(
    () => backend.inspectMembershipLink(join(membershipParent, 'chained-skill')),
    'WINDOWS_NATIVE_MEMBERSHIP_TARGET_INVALID'
  );
  const directorySymlink = join(membershipParent, 'directory-symlink');
  await symlink(membershipTarget, directorySymlink, 'dir');
  const directorySymlinkRefused = await expectCode(
    () => backend.inspectMembershipLink(directorySymlink),
    'WINDOWS_NATIVE_MEMBERSHIP_LINK_INVALID'
  );
  const danglingTarget = join(outside, 'dangling-membership-target');
  const danglingMembership = join(membershipParent, 'dangling-skill');
  await mkdir(danglingTarget);
  await symlink(danglingTarget, danglingMembership, 'junction');
  await rmdir(danglingTarget);
  const danglingMembershipRefused = await expectCode(
    () => backend.inspectMembershipLink(danglingMembership),
    'WINDOWS_NATIVE_MEMBERSHIP_TARGET_INVALID'
  );
  const foreignAclMembership = join(membershipParent, 'foreign-acl-skill');
  backend.createPrivateJunction(membershipParent, 'foreign-acl-skill', membershipTarget);
  execFileSync('icacls.exe', [
    foreignAclMembership,
    '/L',
    '/inheritance:r',
    '/grant:r',
    '*S-1-1-0:(F)'
  ], { stdio: 'pipe' });
  const foreignAclRefused = await expectCode(
    () => membershipModule.inspectWindowsSkillMembership(
      membershipOptions('foreign-acl-skill')
    ),
    'WINDOWS_SKILL_MEMBERSHIP_LINK_SECURITY_INVALID'
  );
  const membershipTargetAfterForeignAcl = backend.inspectPath(membershipTarget);
  const membershipForeignReparseRefused = chainedMembershipRefused
    && directorySymlinkRefused
    && danglingMembershipRefused
    && await readFile(membershipMarker, 'utf8') === 'membership target\n';
  const membershipLinkSecurityAdmitted = membershipLinkSecurityBasics
    && foreignAclRefused
    && membershipTargetAfterForeignAcl.object.fileId === membershipTargetBefore.object.fileId
    && membershipTargetAfterForeignAcl.security.daclBytes.equals(
      membershipTargetBefore.security.daclBytes
    )
    && await readFile(membershipMarker, 'utf8') === 'membership target\n';

  const normalRemoval = await membershipModule.removeWindowsSkillMembership(
    membershipOptions('direct-skill')
  );
  await membershipModule.createWindowsSkillMembership(membershipOptions('before-error'));
  const beforeErrorRemoval = await membershipModule.removeWindowsSkillMembership(
    membershipOptions('before-error', membershipTarget, {
      async unlink() { throw new Error('injected before-effect unlink failure'); }
    })
  );
  await membershipModule.createWindowsSkillMembership(membershipOptions('after-error'));
  const afterErrorRemoval = await membershipModule.removeWindowsSkillMembership(
    membershipOptions('after-error', membershipTarget, {
      async unlink(path) {
        await unlink(path);
        throw new Error('injected after-effect unlink failure');
      }
    })
  );
  const membershipTargetAfter = backend.inspectPath(membershipTarget);
  const membershipLinkOnlyRemoval = normalRemoval.outcome === 'absent'
    && normalRemoval.effect === 'removed'
    && membershipTargetBefore.object.fileId === membershipTargetAfter.object.fileId
    && await readFile(membershipMarker, 'utf8') === 'membership target\n';
  const membershipRemovalReconciled = beforeErrorRemoval.outcome === 'present'
    && afterErrorRemoval.outcome === 'absent'
    && afterErrorRemoval.effect === 'removed';

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
  const createAndWritePrivateFile = async (parentPath, component, bytes) => {
    privateDirectoryModule.createWindowsPrivateFile(backend, parentPath, component);
    const handle = await open(join(parentPath, component), 'r+');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
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
      await createAndWritePrivateFile(destination, 'old.txt', 'old\n');
    }
    return { root, parent, journals, destinationName, destination };
  };
  const nativePublicationRename = async (source, destination) => {
    const parent = dirname(source);
    requireCondition(
      parent.toLowerCase() === dirname(destination).toLowerCase(),
      'native publication rename stays within one parent'
    );
    await backend.renameDirectoryNoReplace(parent, basename(source), basename(destination));
  };
  const commonPublicationOptions = (fixture, transactionId, observed = () => dependentStateSha256) => ({
    backend,
    parentPath: fixture.parent,
    journalRootPath: fixture.journals,
    destinationName: fixture.destinationName,
    dependentState: { expectedSha256: dependentStateSha256, observeSha256: observed },
    authority: authority(transactionId)
  });
  const materializePublicationCandidate = async (candidate) => {
    await candidate.createPrivateFile('new.txt', Buffer.from('new\n'));
  };

  const unawaitedFixture = await createPublicationFixture('unawaited');
  const unawaitedTransaction = transactionId();
  let retainedCandidateWriter;
  const unawaitedResult = await directoryPublicationModule.executeWindowsDirectoryPublication({
    ...commonPublicationOptions(unawaitedFixture, unawaitedTransaction),
    operation: { mode: 'fresh' },
    candidateLimits: { maxEntries: 1, maxPathBytes: 32, maxFileBytes: 4, maxAggregateBytes: 4 },
    materialize(candidate) {
      retainedCandidateWriter = candidate;
      void candidate.createPrivateFile('new.txt', Buffer.from('new\n'));
    }
  });
  await expectCode(
    () => retainedCandidateWriter.createPrivateFile('late.txt', Buffer.from('late\n')),
    'WINDOWS_DIRECTORY_PUBLICATION_AUTHORITY_INVALID'
  );
  const materializerDrained = unawaitedResult.action === 'committed'
    && await readFile(join(unawaitedFixture.destination, 'new.txt'), 'utf8') === 'new\n'
    && !await pathExists(join(unawaitedFixture.destination, 'late.txt'));

  const boundedCases = [
    ['entries', { maxEntries: 0, maxPathBytes: 32, maxFileBytes: 4, maxAggregateBytes: 4 }],
    ['path', { maxEntries: 1, maxPathBytes: 6, maxFileBytes: 4, maxAggregateBytes: 4 }],
    ['file', { maxEntries: 1, maxPathBytes: 32, maxFileBytes: 3, maxAggregateBytes: 4 }],
    ['aggregate', { maxEntries: 1, maxPathBytes: 32, maxFileBytes: 4, maxAggregateBytes: 3 }]
  ];
  let materializerBounded = true;
  for (const [label, limits] of boundedCases) {
    const boundedFixture = await createPublicationFixture(`bounded-materializer-${label}`);
    const boundedTransaction = transactionId();
    await expectCode(
      () => directoryPublicationModule.executeWindowsDirectoryPublication({
        ...commonPublicationOptions(boundedFixture, boundedTransaction),
        operation: { mode: 'fresh' },
        candidateLimits: limits,
        materialize(candidate) {
          void candidate.createPrivateFile('new.txt', Buffer.from('new\n'));
        }
      }),
      'WINDOWS_DIRECTORY_PUBLICATION_LIMIT_EXCEEDED'
    );
    materializerBounded &&= !await pathExists(join(
      boundedFixture.parent,
      `.bazframe-candidate-${boundedTransaction}`,
      'new.txt'
    ));
  }

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
        await nativePublicationRename(source, destination);
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
      await nativePublicationRename(source, destination);
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
        await nativePublicationRename(source, destination);
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

  const lockRootComponent = 'operation-locks';
  const lockRoot = join(privateRoot, lockRootComponent);
  privateDirectoryModule.createWindowsPrivateDirectory(backend, privateRoot, lockRootComponent);
  const lockOptions = (lockComponent) => ({
    backend,
    lockRootPath: lockRoot,
    lockComponent,
    details: { command: 'native-lock-evidence', target: 'evidence-state' }
  });
  let expiredLockAuthority;
  const firstLockRecovery = await operationLockModule.withWindowsOperationLock(
    lockOptions('state.lock'),
    async (held) => {
      held.assertHeld();
      expiredLockAuthority = held;
      return held.recovery;
    }
  );
  await expectCode(
    () => expiredLockAuthority.assertHeld(),
    'WINDOWS_OPERATION_LOCK_AUTHORITY_INVALID'
  );
  const lockDirectory = join(lockRoot, 'state.lock');
  const lockGuard = privateDirectoryModule.admitWindowsPrivateFile(
    backend,
    join(lockDirectory, 'guard')
  );
  const lockOwner = privateDirectoryModule.admitWindowsPrivateFile(
    backend,
    join(lockDirectory, 'owner')
  );

  const lockedPublicationFixture = await createPublicationFixture('operation-lock-authority');
  const lockedPublicationTransaction = transactionId();
  const lockedPublication = await operationLockModule.withWindowsOperationLock(
    lockOptions('publication.lock'),
    async (held) => directoryPublicationModule.executeWindowsDirectoryPublication({
      ...commonPublicationOptions(lockedPublicationFixture, lockedPublicationTransaction),
      authority: {
        transactionId: lockedPublicationTransaction,
        assertHeld: () => held.assertHeld()
      },
      operation: { mode: 'fresh' },
      materialize: materializePublicationCandidate
    })
  );

  const processProbe = backend.acquireFileLock(join(lockDirectory, 'guard'));
  requireCondition(processProbe.state === 'acquired', 'idle lock guard reacquired');
  const alteredCreationTime = `${processProbe.currentProcess.creationTime.slice(0, -1)}${
    processProbe.currentProcess.creationTime.endsWith('0') ? '1' : '0'
  }`;
  const reusedProcess = backend.inspectProcessInstance({
    pid: processProbe.currentProcess.pid,
    creationTime: alteredCreationTime
  });
  processProbe.capability.release();

  const lockChildScript = fileURLToPath(new URL('./test-win32-operation-lock-child.mjs', import.meta.url));
  const lockChildArgs = (lockComponent, mode) => [
    lockChildScript,
    '--package-root', packageRoot,
    '--lock-root', lockRoot,
    '--lock-component', lockComponent,
    '--mode', mode
  ];
  const holder = await spawnLockHolder(lockChildArgs('state.lock', 'hold'));
  try {
    await expectCode(
      () => operationLockModule.withWindowsOperationLock(
        lockOptions('state.lock'),
        async () => undefined
      ),
      'WINDOWS_OPERATION_LOCK_BUSY'
    );
  } finally {
    await terminateLockHolder(holder, 'lock holder');
  }
  const killedOwnerRecovery = await operationLockModule.withWindowsOperationLock(
    lockOptions('state.lock'),
    async (held) => held.recovery
  );

  const unannounced = spawnSync(process.execPath, lockChildArgs('interrupted.lock', 'crash-unannounced'), {
    encoding: 'utf8',
    shell: false
  });
  if (unannounced.status !== 86) {
    throw new Error(`Unannounced lock child failed: ${unannounced.status}; ${unannounced.stderr}`);
  }
  const unannouncedRecovery = await operationLockModule.withWindowsOperationLock(
    lockOptions('interrupted.lock'),
    async (held) => held.recovery
  );

  await operationLockModule.withWindowsOperationLock(
    lockOptions('malformed.lock'),
    async () => undefined
  );
  const malformedDirectory = join(lockRoot, 'malformed.lock');
  await writeFile(join(malformedDirectory, 'owner'), '{bad\n');
  const malformedHolder = await spawnLockHolder(lockChildArgs('malformed.lock', 'hold-native'));
  try {
    await expectCode(
      () => operationLockModule.withWindowsOperationLock(
        lockOptions('malformed.lock'),
        async () => undefined
      ),
      'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS'
    );
  } finally {
    await terminateLockHolder(malformedHolder, 'malformed lock holder');
  }
  const malformedRecovery = await operationLockModule.withWindowsOperationLock(
    lockOptions('malformed.lock'),
    async (held) => held.recovery
  );

  await operationLockModule.withWindowsOperationLock(
    lockOptions('binding-a.lock'),
    async () => undefined
  );
  await operationLockModule.withWindowsOperationLock(
    lockOptions('binding-b.lock'),
    async () => undefined
  );
  await writeFile(
    join(lockRoot, 'binding-b.lock', 'owner'),
    await readFile(join(lockRoot, 'binding-a.lock', 'owner'))
  );
  await expectCode(
    () => operationLockModule.withWindowsOperationLock(
      lockOptions('binding-b.lock'),
      async () => undefined
    ),
    'WINDOWS_OPERATION_LOCK_INVALID'
  );

  const releasedProbe = backend.acquireFileLock(join(lockDirectory, 'guard'));
  const operationLockReleased = releasedProbe.state === 'acquired';
  if (releasedProbe.state === 'acquired') releasedProbe.capability.release();

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
    membershipJunctionDirectTarget,
    membershipJunctionNoReplace,
    membershipJunctionExactInspection,
    membershipJunctionImmediateRevalidation,
    membershipLinkSecurityAdmitted,
    membershipForeignReparseRefused,
    membershipLinkOnlyRemoval,
    membershipRemovalReconciled,
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
    privateFileFirstVisibilityPrivate: sameRegularFileIdentityVolumeAndSecurity(
      privateFileReceipt.created,
      privateFileBefore
    )
      && privateFileReceipt.created.security.ownerSid
        === privateFileReceipt.created.security.currentUserSid
      && privateFileReceipt.created.security.daclPresent
      && !privateFileReceipt.created.security.daclNull
      && (privateFileReceipt.created.security.descriptorControl & 0x1000) !== 0
      && privateFileReceipt.created.object.size === '0000000000000000',
    privateFileNoReplace: sameRegularFileIdentityVolumeAndSecurity(
      privateFileBefore,
      privateFileAfter
    ),
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
    directoryPublicationMaterializerDrained: materializerDrained,
    directoryPublicationMaterializerBounded: materializerBounded,
    directoryPublicationReplacementBackupRetained: replacementResult.action === 'committed'
      && replacementResult.backupRetained,
    directoryPublicationAppendOnlyPrivateJournal: freshJournalClosure.closure.entries.length === 6,
    directoryPublicationRenameErrorPredicates: recoveredSharing.action === 'committed'
      && afterEffectResult.action === 'committed',
    directoryPublicationOccupiedRacePreserved: occupiedRacePreserved,
    directoryPublicationDependentDriftRetained: dependentResult.action === 'ambiguous',
    directoryPublicationCorruptJournalRefused: !renameAfterJournalDrift,
    directoryPublicationRestartRecovery: restartRecoveryPassed,
    operationLockPrivatePersistentNamespace: firstLockRecovery === 'none'
      && lockGuard.object.size === '0000000000000000'
      && lockOwner.object.numberOfLinks === '00000001'
      && lockGuard.security.ownerSid === lockGuard.security.currentUserSid
      && lockOwner.security.ownerSid === lockOwner.security.currentUserSid,
    operationLockAuthorityExpires: true,
    operationLockAuthorizesPublication: lockedPublication.action === 'committed'
      && await readFile(join(lockedPublicationFixture.destination, 'new.txt'), 'utf8') === 'new\n',
    operationLockContentionAnnounced: true,
    operationLockKilledOwnerRecovery: killedOwnerRecovery === 'dead-owner',
    operationLockInterruptedAnnouncementRecovery:
      unannouncedRecovery === 'incomplete-announcement',
    operationLockMalformedBusyRefused:
      malformedRecovery === 'incomplete-announcement',
    operationLockWrongBindingRefused: true,
    operationLockPidReuseDistinguished: reusedProcess.state === 'different',
    operationLockReleased: operationLockReleased
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

async function spawnLockHolder(args) {
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolveHolder, rejectHolder) => {
      const onData = () => {
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        try {
          const announcement = JSON.parse(stdout.slice(0, newline));
          requireCondition(announcement.state === 'held', 'lock child announced held state');
          cleanup();
          resolveHolder();
        } catch (error) {
          cleanup();
          rejectHolder(error);
        }
      };
      const onExit = (code) => {
        cleanup();
        rejectHolder(new Error(`Lock holder exited before acquisition: ${code}; ${stderr}`));
      };
      const cleanup = () => {
        child.stdout.off('data', onData);
        child.off('exit', onExit);
      };
      child.stdout.on('data', onData);
      child.on('exit', onExit);
      onData();
    });
  } catch (error) {
    try {
      await terminateLockHolder(child, 'unannounced lock holder');
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Lock-holder startup and cleanup failed',
        { cause: cleanupError }
      );
    }
    throw error;
  }
  return child;
}

async function terminateLockHolder(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const accepted = child.kill('SIGKILL');
  if (!accepted && child.exitCode === null && child.signalCode === null) {
    throw new Error(`${label} did not accept termination`);
  }
  await exited;
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

function publicationIo(renameOperation) {
  return {
    async writeExistingFile(path, bytes) {
      const handle = await open(path, 'r+');
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
    if (error !== null && typeof error === 'object' && error.code === expected) return true;
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

function sameRegularFileIdentityVolumeAndSecurity(before, after) {
  return before.canonicalPath.toLowerCase() === after.canonicalPath.toLowerCase()
    && before.kind === 'regular-file'
    && after.kind === 'regular-file'
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
    && before.object.size === after.object.size
    && before.object.allocationSize === after.object.allocationSize
    && before.object.numberOfLinks === after.object.numberOfLinks
    && before.object.creationTime === after.object.creationTime
    && before.object.lastWriteTime === after.object.lastWriteTime
    && before.object.changeTime === after.object.changeTime
    && before.object.attributes === after.object.attributes
    && before.object.reparseTag === null
    && after.object.reparseTag === null
    && before.object.deletePending === false
    && after.object.deletePending === false
    && before.object.directory === false
    && after.object.directory === false
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

function safeError(error, depth = 0) {
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
  const cause = depth < 4 && error instanceof Error && error.cause !== undefined
    ? safeError(error.cause, depth + 1)
    : undefined;
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    code: error !== null && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : null,
    message,
    ...(cause === undefined ? {} : { cause })
  };
}
