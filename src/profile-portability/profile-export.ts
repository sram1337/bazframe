import { constants, type Dir } from 'node:fs';
import {
  lstat,
  open,
  opendir,
  readlink,
  realpath,
  type FileHandle
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  readPhysicalInstructionSnapshot,
  type PhysicalInstructionSnapshot
} from '../core/content.js';
import { BazframeError, errorCode } from '../core/errors.js';
import { boundedPathForDisplay } from '../core/safe-text.js';
import {
  captureManagedGitExportHealth,
  classifyManagedGitProviderOccupancy,
  type ManagedGitExportHealthSnapshot
} from '../providers/managed-git.js';
import {
  managedGitCheckoutsRoot,
  optionalManagedGitRecord,
  pathFreeManagedGitIdentityFromRecord,
  type ManagedGitRecordSnapshot,
  type ManagedGitResourceKind
} from '../providers/managed-git-record.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import {
  readProfileCollectionReferenceSnapshot,
  type ProfileSkillCollectionReferenceSnapshot
} from '../profiles/profile-skill-collection-reference.js';
import { profileDirectory } from '../profiles/profile-store.js';
import {
  loadFlatSkillIdentities,
  resolveGlobalSkillCollection,
  validateCapturedSkillComposition,
  type DerivedSkill,
  type FlatSkillIdentity
} from '../skill-collections/skill-collection-resolver.js';
import {
  readCollectionSnapshot,
  sameCollectionSnapshot,
  type SkillCollectionKind,
  type SkillCollectionRecordSnapshot
} from '../skill-collections/skill-collection-store.js';
import {
  readDefaultSkillRegistrationSnapshot,
  sameDefaultSkillRegistrationSnapshot,
  type DefaultSkillRegistrationSnapshot
} from '../skills/default-skill-catalog.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { withStateLock } from '../state/lock.js';
import {
  encodeProfileArtifact,
  type LocalMappingArtifactSource,
  type ProfileArtifact,
  type ProfileArtifactResource,
  type RemoteGitArtifactSource
} from './profile-artifact.js';
import {
  ProfileArtifactPublicationError,
  publishProfileArtifactDirectory,
  type ProfileArtifactPublicationOptions,
  type ProfileArtifactPublicationResult
} from './profile-artifact-publication.js';
import {
  PROFILE_PORTABILITY_PRODUCTION_LIMITS,
  profileArtifactLimitPolicy,
  type ProfileArtifactLimitPolicy
} from './profile-portability-policy.js';

export interface ProfileExportOptions {
  bazframeHome: string;
  profileId: string;
  outputDirectory: string;
  environment?: NodeJS.ProcessEnv;
}

export interface ProfileExportLimitPolicy extends ProfileArtifactLimitPolicy {
  maxProfileNamespaceEntries: number;
}

export type ProfileExportWarning =
  | { code: 'PROFILE_EXPORT_LOCAL_SKILLS_OMITTED'; skillIds: string[] }
  | { code: 'PROFILE_EXPORT_REVIEW_INSTRUCTIONS'; path: 'profile/AGENTS.md' };

export interface ProfileExportResult {
  action: 'published';
  exportedProfileId: string;
  outputPath: string;
  instructions: { path: 'profile/AGENTS.md'; sha256: string };
  skills: string[];
  omittedLocalSkills: string[];
  libraries: string[];
  packages: string[];
  resources: Array<
    | { kind: 'skill'; id: string; source: RemoteGitArtifactSource }
    | { kind: 'library'; id: string; source: RemoteGitArtifactSource | LocalMappingArtifactSource }
    | { kind: 'package'; id: string; source: RemoteGitArtifactSource | LocalMappingArtifactSource }
  >;
  warnings: ProfileExportWarning[];
}

export type ProfileExportCommitState = 'not-published' | 'published' | 'commit-ambiguous';

export class ProfileExportError extends BazframeError {
  readonly commitState: ProfileExportCommitState;
  readonly outputPath: string;

  constructor(commitState: ProfileExportCommitState, outputPath: string) {
    const state = commitState === 'published'
      ? 'The export output is published, but completion reporting failed.'
      : commitState === 'commit-ambiguous'
        ? 'The export publication state is ambiguous; inspect the requested output before retrying.'
        : 'The export output was not published.';
    super('PROFILE_EXPORT_FAILED', `${state} Output: ${boundedPathForDisplay(outputPath)}`);
    this.name = 'ProfileExportError';
    this.commitState = commitState;
    this.outputPath = outputPath;
  }
}

export interface ProfileExportDependencies {
  limitPolicy?: Partial<ProfileExportLimitPolicy>;
  publish?: (
    options: ProfileArtifactPublicationOptions
  ) => Promise<ProfileArtifactPublicationResult>;
  captureManagedGitHealth?: typeof captureManagedGitExportHealth;
  testHooks?: {
    afterCapture?: (captureNumber: 1 | 2 | 3) => void | Promise<void>;
  };
}

interface DirectoryIdentity { path: string; device: bigint; inode: bigint }
interface HeldDirectory extends DirectoryIdentity { handle: FileHandle }
interface ProfileSkillLinkSnapshot {
  id: string;
  path: string;
  device: bigint;
  inode: bigint;
  rawTarget: string;
  registration: DefaultSkillRegistrationSnapshot;
  managed?: ManagedGitExportHealthSnapshot;
  identity: FlatSkillIdentity;
}
interface CollectionCapture {
  kind: SkillCollectionKind;
  id: string;
  reference: ProfileSkillCollectionReferenceSnapshot;
  record: SkillCollectionRecordSnapshot;
  managed?: ManagedGitExportHealthSnapshot;
  children: DerivedSkill[];
}
interface SourceCapture {
  artifact: ProfileArtifact;
  instructions: PhysicalInstructionSnapshot;
  evidence: string;
}

const ROOT_ENTRIES = new Set(['AGENTS.md', 'skills', 'libraries', 'packages']);

export async function exportProfile(
  enteredOptions: ProfileExportOptions,
  enteredDependencies: ProfileExportDependencies = {}
): Promise<ProfileExportResult> {
  const options = copyOptions(enteredOptions);
  const dependencies = copyDependencies(enteredDependencies);
  assertSafeProfileId(options.profileId);
  validateOutput(options.outputDirectory);
  const home = await canonicalPhysicalHome(options.bazframeHome);
  const requestedOutput = resolve(options.outputDirectory);
  const lockPath = join(home, 'locks', 'state.lock');
  let published: ProfileArtifactPublicationResult | undefined;

  try {
    return await withStateLock(
      lockPath,
      { command: 'bazframe profile export', target: requestedOutput },
      async () => {
        const first = await captureSource(home, options.profileId, options.environment, dependencies);
        await dependencies.testHooks?.afterCapture?.(1);
        const second = await captureSource(home, options.profileId, options.environment, dependencies);
        requireSameCapture(first, second);
        await dependencies.testHooks?.afterCapture?.(2);

        published = await dependencies.publish({
          bazframeHome: home,
          outputDirectory: requestedOutput,
          artifact: first.artifact,
          instructionBytes: first.instructions.bytes,
          limitPolicy: artifactPolicy(dependencies.limitPolicy),
          beforeCommit: async () => {
            const finalCapture = await captureSource(home, options.profileId, options.environment, dependencies);
            requireSameCapture(first, finalCapture);
            await dependencies.testHooks?.afterCapture?.(3);
          }
        });

        return resultFromCapture(first, published);
      },
      { managedRoot: home }
    );
  } catch (error) {
    if (published !== undefined) {
      throw new ProfileExportError('published', published.outputPath);
    }
    if (error instanceof ProfileArtifactPublicationError) {
      throw new ProfileExportError(error.commitState, error.outputPath);
    }
    throw error;
  }
}

function copyOptions(options: ProfileExportOptions): Required<ProfileExportOptions> {
  if (options === null || typeof options !== 'object'
    || typeof options.bazframeHome !== 'string'
    || typeof options.profileId !== 'string'
    || typeof options.outputDirectory !== 'string') {
    throw new BazframeError('PROFILE_EXPORT_INVALID', 'Profile export requires explicit home, profile ID, and output directory strings.');
  }
  return {
    bazframeHome: options.bazframeHome,
    profileId: options.profileId,
    outputDirectory: options.outputDirectory,
    environment: { ...(options.environment ?? process.env) }
  };
}

function copyDependencies(dependencies: ProfileExportDependencies): Required<Pick<ProfileExportDependencies, 'publish' | 'captureManagedGitHealth'>> & {
  limitPolicy: ProfileExportLimitPolicy;
  testHooks?: ProfileExportDependencies['testHooks'];
} {
  const lower = dependencies.limitPolicy ?? {};
  const allowedLimitKeys = new Set([
    'maxManifestBytes',
    'maxProfileEntries',
    'maxResources',
    'maxProfileNamespaceEntries'
  ]);
  for (const key of Object.keys(lower)) {
    if (!allowedLimitKeys.has(key)) {
      throw new BazframeError(
        'PROFILE_PORTABILITY_POLICY_INVALID',
        `Invalid profile portability limit policy: ${key} is unknown.`
      );
    }
  }
  const artifact = profileArtifactLimitPolicy({
    ...(lower.maxManifestBytes === undefined ? {} : { maxManifestBytes: lower.maxManifestBytes }),
    ...(lower.maxProfileEntries === undefined ? {} : { maxProfileEntries: lower.maxProfileEntries }),
    ...(lower.maxResources === undefined ? {} : { maxResources: lower.maxResources })
  });
  const namespace = lower.maxProfileNamespaceEntries
    ?? PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries;
  if (!Number.isSafeInteger(namespace) || namespace < 0
    || namespace > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries) {
    throw new BazframeError(
      'PROFILE_PORTABILITY_POLICY_INVALID',
      'Invalid profile portability limit policy: maxProfileNamespaceEntries may lower but must not raise the production limit.'
    );
  }
  return {
    limitPolicy: {
      ...artifact,
      maxProfileNamespaceEntries: namespace
    },
    publish: dependencies.publish ?? publishProfileArtifactDirectory,
    captureManagedGitHealth: dependencies.captureManagedGitHealth ?? captureManagedGitExportHealth,
    ...(dependencies.testHooks === undefined ? {} : { testHooks: dependencies.testHooks })
  };
}

function artifactPolicy(policy: ProfileExportLimitPolicy): ProfileArtifactLimitPolicy {
  return {
    maxManifestBytes: policy.maxManifestBytes,
    maxProfileEntries: policy.maxProfileEntries,
    maxResources: policy.maxResources
  };
}

function validateOutput(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new BazframeError('PROFILE_EXPORT_INVALID', 'Profile export requires an explicit output directory path without NUL bytes.');
  }
  const name = basename(path);
  if (name === '' || name === '.' || name === '..') {
    throw new BazframeError('PROFILE_EXPORT_INVALID', 'Profile export output must name a directory below an existing parent.');
  }
}

async function canonicalPhysicalHome(entered: string): Promise<string> {
  if (typeof entered !== 'string' || entered.length === 0 || entered.includes('\0') || !isAbsolute(entered)) {
    throw new BazframeError('PROFILE_EXPORT_INVALID_HOME', 'BAZFRAME_HOME must be a canonical absolute physical directory.');
  }
  const absolute = resolve(entered);
  try {
    const before = await lstat(absolute, { bigint: true });
    const canonical = await realpath(absolute);
    const after = await lstat(absolute, { bigint: true });
    if (canonical !== absolute || before.isSymbolicLink() || !before.isDirectory()
      || after.isSymbolicLink() || !after.isDirectory()
      || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('home is not a stable canonical physical directory');
    }
    return canonical;
  } catch (error) {
    throw new BazframeError(
      'PROFILE_EXPORT_INVALID_HOME',
      'BAZFRAME_HOME must be a canonical absolute physical directory.',
      { cause: error }
    );
  }
}

async function captureSource(
  home: string,
  profileId: string,
  environment: NodeJS.ProcessEnv,
  dependencies: ReturnType<typeof copyDependencies>
): Promise<SourceCapture> {
  const rootPath = profileDirectory(home, profileId);
  let profilesDirectory: HeldDirectory | undefined;
  let root: HeldDirectory | undefined;
  let skillsDirectory: HeldDirectory | undefined;
  let librariesDirectory: HeldDirectory | undefined;
  let packagesDirectory: HeldDirectory | undefined;
  let operationError: unknown;
  let capture: SourceCapture | undefined;

  try {
    profilesDirectory = await holdPhysicalDirectory(join(home, 'profiles'), 'Profiles namespace');
    root = await holdPhysicalDirectory(rootPath, 'Profile root');
    const rootNames = await enumerateBounded(root, 4, 'profile root');
    if (!rootNames.includes('AGENTS.md') || !rootNames.includes('skills')
      || rootNames.some((name) => !ROOT_ENTRIES.has(name))) {
      throw invalidSource('profile root must contain exactly AGENTS.md, skills/, and optional libraries/ or packages/');
    }

    skillsDirectory = await holdPhysicalDirectory(join(rootPath, 'skills'), 'Profile skills namespace');
    librariesDirectory = await holdOptionalPhysicalDirectory(join(rootPath, 'libraries'), 'Profile libraries namespace');
    packagesDirectory = await holdOptionalPhysicalDirectory(join(rootPath, 'packages'), 'Profile packages namespace');

    const instructions = await readPhysicalInstructionSnapshot(
      join(rootPath, 'AGENTS.md'),
      `Profile ${JSON.stringify(profileId)} instructions`
    );
    const skillNames = await enumerateBounded(
      skillsDirectory,
      Math.min(
        dependencies.limitPolicy.maxProfileNamespaceEntries,
        dependencies.limitPolicy.maxProfileEntries
      ),
      'profile skills namespace'
    );
    const afterSkills = dependencies.limitPolicy.maxProfileEntries - skillNames.length;
    const libraryNames = librariesDirectory === undefined ? [] : await enumerateBounded(
      librariesDirectory,
      Math.min(dependencies.limitPolicy.maxProfileNamespaceEntries, afterSkills),
      'profile libraries namespace'
    );
    const afterLibraries = afterSkills - libraryNames.length;
    const packageNames = packagesDirectory === undefined ? [] : await enumerateBounded(
      packagesDirectory,
      Math.min(dependencies.limitPolicy.maxProfileNamespaceEntries, afterLibraries),
      'profile packages namespace'
    );

    const skillLinks: ProfileSkillLinkSnapshot[] = [];
    const resources: ProfileArtifactResource[] = [];
    const includedSkills: string[] = [];
    const omittedSkills: string[] = [];
    for (const id of skillNames) {
      if (!isSafeSkillId(id)) throw invalidSource('profile skills namespace contains an unsafe Skill ID');
      const link = await captureDirectSkill(home, skillsDirectory, id, environment, dependencies);
      skillLinks.push(link);
      if (link.managed === undefined) {
        omittedSkills.push(id);
      } else {
        includedSkills.push(id);
        resources.push(resourceFromManaged('skill', id, link.managed));
      }
      assertResourceLimit(resources.length, dependencies.limitPolicy.maxResources);
    }

    const flatSkills = loadFlatSkillIdentities(skillLinks.map((link) => link.registration.target));
    for (let index = 0; index < flatSkills.length; index += 1) {
      skillLinks[index]!.identity = flatSkills[index]!;
    }

    const libraries: CollectionCapture[] = [];
    for (const name of libraryNames) {
      const captured = await captureCollection(
        home,
        profileId,
        'library',
        name,
        environment,
        dependencies
      );
      libraries.push(captured.capture);
      resources.push(captured.resource);
      assertResourceLimit(resources.length, dependencies.limitPolicy.maxResources);
    }

    const packages: CollectionCapture[] = [];
    for (const name of packageNames) {
      const captured = await captureCollection(
        home,
        profileId,
        'package',
        name,
        environment,
        dependencies
      );
      packages.push(captured.capture);
      resources.push(captured.resource);
      assertResourceLimit(resources.length, dependencies.limitPolicy.maxResources);
    }

    const compositionDiagnostics = validateCapturedSkillComposition(
      flatSkills,
      [...libraries, ...packages].flatMap((collection) => collection.children)
    );
    if (compositionDiagnostics.length > 0) {
      throw new BazframeError(
        'PROFILE_EXPORT_COMPOSITION_INVALID',
        'Profile Skill composition contains direct or collection name collisions.'
      );
    }

    await revalidateSkillLinks(home, skillsDirectory, skillLinks);
    await assertDirectoryStable(skillsDirectory, 'Profile skills namespace');
    if (librariesDirectory !== undefined) await assertDirectoryStable(librariesDirectory, 'Profile libraries namespace');
    if (packagesDirectory !== undefined) await assertDirectoryStable(packagesDirectory, 'Profile packages namespace');
    await assertDirectoryStable(root, 'Profile root');
    await assertDirectoryStable(profilesDirectory, 'Profiles namespace');

    includedSkills.sort(compare);
    omittedSkills.sort(compare);
    libraries.sort((left, right) => compare(left.id, right.id));
    packages.sort((left, right) => compare(left.id, right.id));
    resources.sort((left, right) => compare(resourceOrderKey(left), resourceOrderKey(right)));
    const artifact: ProfileArtifact = {
      schemaVersion: 1,
      kind: 'bazframe-profile-export',
      profile: {
        id: profileId,
        instructions: { path: 'profile/AGENTS.md', sha256: instructions.contentSha256 },
        skills: includedSkills,
        omittedLocalSkills: omittedSkills,
        libraries: libraries.map((library) => library.id),
        packages: packages.map((item) => item.id)
      },
      resources
    };
    // Canonical validation also enforces the manifest and complete closure limits.
    encodeProfileArtifact(artifact, artifactPolicy(dependencies.limitPolicy));
    capture = {
      artifact,
      instructions,
      evidence: evidenceFor(
        profilesDirectory,
        root,
        skillsDirectory,
        librariesDirectory,
        packagesDirectory,
        instructions,
        skillLinks,
        libraries,
        packages
      )
    };
  } catch (error) {
    operationError = error;
  }

  operationError = await closeHeldDirectories(
    [packagesDirectory, librariesDirectory, skillsDirectory, root, profilesDirectory],
    operationError
  );
  if (operationError !== undefined) throw operationError;
  if (capture === undefined) throw invalidSource('profile capture did not complete');
  return capture;
}

async function captureDirectSkill(
  home: string,
  directory: HeldDirectory,
  id: string,
  environment: NodeJS.ProcessEnv,
  dependencies: ReturnType<typeof copyDependencies>
): Promise<ProfileSkillLinkSnapshot> {
  const path = join(directory.path, id);
  const raw = await physicalLink(path);
  if (!isAbsolute(raw.target)) throw invalidSource(`profile Skill ${JSON.stringify(id)} must use an absolute direct link`);
  const registration = await readDefaultSkillRegistrationSnapshot(home, id);
  if (raw.target !== registration.target) {
    throw invalidSource(`profile Skill ${JSON.stringify(id)} does not exactly match its same-ID added Skill`);
  }

  const provenance = await optionalProvenance(home, 'skill', id);
  let managed: ManagedGitExportHealthSnapshot | undefined;
  if (provenance !== undefined) {
    if (provenance.record.root !== registration.target) {
      throw invalidSource(`same-ID remote Git provenance collides with Skill ${JSON.stringify(id)}`);
    }
    managed = await dependencies.captureManagedGitHealth(home, 'skill', id, environment);
  } else if (isWithin(managedGitCheckoutsRoot(home), registration.target)) {
    throw invalidSource(`Bazframe-managed checkout Skill ${JSON.stringify(id)} has no matching remote Git provenance`);
  }

  return {
    id,
    path,
    device: raw.device,
    inode: raw.inode,
    rawTarget: raw.target,
    registration,
    ...(managed === undefined ? {} : { managed }),
    identity: { name: '', definitionPath: '' }
  };
}

async function optionalProvenance(
  home: string,
  kind: ManagedGitResourceKind,
  id: string
): Promise<ManagedGitRecordSnapshot | undefined> {
  try {
    await lstat(join(home, 'providers', 'git', 'records', kind, `${id}.json`));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  return optionalManagedGitRecord(home, kind, id);
}

async function captureCollection(
  home: string,
  profileId: string,
  kind: SkillCollectionKind,
  name: string,
  environment: NodeJS.ProcessEnv,
  dependencies: ReturnType<typeof copyDependencies>
): Promise<{ capture: CollectionCapture; resource: ProfileArtifactResource }> {
  const id = referenceId(name);
  const reference = await readProfileCollectionReferenceSnapshot(
    home,
    profileId,
    { kind, id },
    { maxBytes: dependencies.limitPolicy.maxManifestBytes }
  );
  const record = await readCollectionSnapshot(
    home,
    { kind, id },
    { maxBytes: dependencies.limitPolicy.maxManifestBytes }
  );
  const provenance = await optionalProvenance(home, kind, id);
  let managed: ManagedGitExportHealthSnapshot | undefined;
  let resource: ProfileArtifactResource;
  if (provenance === undefined) {
    if (isWithin(managedGitCheckoutsRoot(home), record.record.root)
      || await classifyManagedGitProviderOccupancy(home, kind, id) !== 'absent') {
      throw invalidSource(`${kind} ${JSON.stringify(id)} has managed Git checkout or provider state without matching provenance`);
    }
    resource = kind === 'library'
      ? { kind: 'library', id, source: { type: 'localMapping' } }
      : { kind: 'package', id, source: { type: 'localMapping' } };
  } else {
    if (provenance.record.root !== record.record.root) {
      throw invalidSource(`remote Git provenance does not match ${kind} ${JSON.stringify(id)}`);
    }
    managed = await dependencies.captureManagedGitHealth(home, kind, id, environment);
    if (managed.collectionSnapshot === undefined
      || !sameCollectionSnapshot(record, managed.collectionSnapshot)) {
      throw changedSource();
    }
    resource = resourceFromManaged(kind, id, managed);
  }
  const children = await resolveGlobalSkillCollection(home, record.record);
  return {
    capture: { kind, id, reference, record, ...(managed === undefined ? {} : { managed }), children },
    resource
  };
}

function referenceId(name: string): string {
  if (!name.endsWith('.json')) throw invalidSource('profile reference namespace contains an unknown entry');
  const id = name.slice(0, -5);
  if (!isSafeSkillId(id)) throw invalidSource('profile reference namespace contains an unsafe ID');
  return id;
}

function resourceFromManaged(
  kind: ManagedGitResourceKind,
  id: string,
  managed: ManagedGitExportHealthSnapshot
): ProfileArtifactResource {
  const source: RemoteGitArtifactSource = {
    type: 'remoteGit',
    ...pathFreeManagedGitIdentityFromRecord(managed.recordSnapshot.record)
  };
  if (kind === 'skill') return { kind: 'skill', id, source };
  return kind === 'library'
    ? { kind: 'library', id, source }
    : { kind: 'package', id, source };
}

function resourceOrderKey(resource: ProfileArtifactResource): string {
  const kindOrder = resource.kind === 'skill' ? '0' : resource.kind === 'library' ? '1' : '2';
  return `${kindOrder}:${resource.id}`;
}

function assertResourceLimit(count: number, maximum: number): void {
  if (count > maximum) throw invalidSource(`resources exceed the ${maximum}-resource limit`);
}

async function holdPhysicalDirectory(path: string, label: string): Promise<HeldDirectory> {
  let handle: FileHandle | undefined;
  try {
    const expected = await lstat(path, { bigint: true });
    if (expected.isSymbolicLink() || !expected.isDirectory()) throw new Error('not a physical directory');
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error('directory identity changed while opening');
    }
    return { path, device: expected.dev, inode: expected.ino, handle };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw new BazframeError('PROFILE_EXPORT_SOURCE_INVALID', `${label} must be a stable physical directory.`, { cause: error });
  }
}

async function holdOptionalPhysicalDirectory(path: string, label: string): Promise<HeldDirectory | undefined> {
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  return holdPhysicalDirectory(path, label);
}

async function enumerateBounded(
  directory: HeldDirectory,
  maximum: number,
  label: string
): Promise<string[]> {
  await assertDirectoryStable(directory, label);
  const names: string[] = [];
  let stream: Dir | undefined;
  let operationError: unknown;
  try {
    stream = await opendir(directory.path);
    while (true) {
      const entry = await stream.read();
      if (entry === null) break;
      if (names.length === maximum) {
        throw invalidSource(`${label} exceeds the ${maximum}-entry limit`);
      }
      names.push(entry.name);
    }
  } catch (error) {
    operationError = error;
  }
  if (stream !== undefined) {
    try { await stream.close(); }
    catch (error) { operationError ??= error; }
  }
  if (operationError !== undefined) throw operationError;
  await assertDirectoryStable(directory, label);
  return names.sort(compare);
}

async function assertDirectoryStable(directory: HeldDirectory, label: string): Promise<void> {
  const [opened, current] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directory.path, { bigint: true })
  ]);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || opened.dev !== directory.device || opened.ino !== directory.inode
    || current.dev !== directory.device || current.ino !== directory.inode) {
    throw invalidSource(`${label} changed during capture`);
  }
}

async function physicalLink(path: string): Promise<{ target: string; device: bigint; inode: bigint }> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isSymbolicLink()) throw new Error('not a symbolic link');
    return { target: await readlink(path), device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    throw new BazframeError(
      'PROFILE_EXPORT_SOURCE_INVALID',
      'Every direct profile Skill must be a safe-ID absolute direct symbolic link.',
      { cause: error }
    );
  }
}

async function revalidateSkillLinks(
  home: string,
  directory: HeldDirectory,
  links: readonly ProfileSkillLinkSnapshot[]
): Promise<void> {
  for (const link of links) {
    const current = await physicalLink(link.path);
    const registration = await readDefaultSkillRegistrationSnapshot(home, link.id);
    if (current.device !== link.device || current.inode !== link.inode || current.target !== link.rawTarget
      || !sameDefaultSkillRegistrationSnapshot(link.registration, registration)) {
      throw changedSource();
    }
  }
}

async function closeHeldDirectories(
  directories: readonly (HeldDirectory | undefined)[],
  primary: unknown
): Promise<unknown> {
  let failure = primary;
  for (const directory of directories) {
    if (directory === undefined) continue;
    try { await directory.handle.close(); }
    catch (error) { failure ??= error; }
  }
  return failure;
}

function evidenceFor(
  profilesDirectory: HeldDirectory,
  root: HeldDirectory,
  skills: HeldDirectory,
  librariesDirectory: HeldDirectory | undefined,
  packagesDirectory: HeldDirectory | undefined,
  instructions: PhysicalInstructionSnapshot,
  links: readonly ProfileSkillLinkSnapshot[],
  libraries: readonly CollectionCapture[],
  packages: readonly CollectionCapture[]
): string {
  return JSON.stringify({
    profilesDirectory: directoryEvidence(profilesDirectory),
    root: directoryEvidence(root),
    skillsDirectory: directoryEvidence(skills),
    librariesDirectory: librariesDirectory === undefined ? 'absent' : directoryEvidence(librariesDirectory),
    packagesDirectory: packagesDirectory === undefined ? 'absent' : directoryEvidence(packagesDirectory),
    instructions: {
      device: String(instructions.device), inode: String(instructions.inode),
      byteCount: instructions.byteCount, digest: instructions.contentSha256,
      bytes: Buffer.from(instructions.bytes).toString('base64')
    },
    links: links.map((link) => ({
      id: link.id, device: String(link.device), inode: String(link.inode), rawTarget: link.rawTarget,
      registration: registrationEvidence(link.registration),
      identity: link.identity,
      managed: link.managed === undefined ? null : managedEvidence(link.managed)
    })),
    libraries: libraries.map(collectionCaptureEvidence),
    packages: packages.map(collectionCaptureEvidence)
  });
}

function directoryEvidence(directory: DirectoryIdentity): object {
  return { path: directory.path, device: String(directory.device), inode: String(directory.inode) };
}
function registrationEvidence(value: DefaultSkillRegistrationSnapshot): object {
  return {
    id: value.id, registrationPath: value.registrationPath, target: value.target,
    catalogDevice: String(value.catalogDevice), catalogInode: String(value.catalogInode),
    registrationDevice: String(value.registrationDevice), registrationInode: String(value.registrationInode),
    targetDevice: String(value.targetDevice), targetInode: String(value.targetInode)
  };
}
function referenceEvidence(value: ProfileSkillCollectionReferenceSnapshot): object {
  return {
    reference: value.reference, path: value.path, device: String(value.device),
    inode: String(value.inode), contentSha256: value.contentSha256
  };
}
function collectionEvidence(value: SkillCollectionRecordSnapshot): object {
  return {
    record: value.record, path: value.path, device: String(value.device),
    inode: String(value.inode), contentSha256: value.contentSha256
  };
}
function collectionCaptureEvidence(collection: CollectionCapture): object {
  return {
    kind: collection.kind,
    id: collection.id,
    reference: referenceEvidence(collection.reference),
    record: collectionEvidence(collection.record),
    managed: collection.managed === undefined ? null : managedEvidence(collection.managed),
    children: collection.children.map((child) => ({
      name: child.name,
      baseDir: child.baseDir,
      definitionPath: child.definitionPath,
      collectionKind: child.collectionKind,
      collectionId: child.collectionId,
      collectionRoot: child.collectionRoot,
      relativePath: child.relativePath
    }))
  };
}
function managedEvidence(value: ManagedGitExportHealthSnapshot): object {
  return {
    record: {
      record: value.recordSnapshot.record,
      path: value.recordSnapshot.path,
      device: String(value.recordSnapshot.device),
      inode: String(value.recordSnapshot.inode),
      contentSha256: value.recordSnapshot.contentSha256
    },
    root: { path: value.root.path, device: String(value.root.device), inode: String(value.root.inode) },
    resourceIdentity: value.resourceIdentity
  };
}

function requireSameCapture(left: SourceCapture, right: SourceCapture): void {
  if (left.evidence !== right.evidence
    || JSON.stringify(left.artifact) !== JSON.stringify(right.artifact)
    || !Buffer.from(left.instructions.bytes).equals(Buffer.from(right.instructions.bytes))) {
    throw changedSource();
  }
}

function resultFromCapture(
  capture: SourceCapture,
  publication: ProfileArtifactPublicationResult
): ProfileExportResult {
  const artifact = capture.artifact;
  const omitted = [...artifact.profile.omittedLocalSkills];
  const warnings: ProfileExportWarning[] = [];
  if (omitted.length > 0) warnings.push({ code: 'PROFILE_EXPORT_LOCAL_SKILLS_OMITTED', skillIds: omitted });
  warnings.push({ code: 'PROFILE_EXPORT_REVIEW_INSTRUCTIONS', path: 'profile/AGENTS.md' });
  return {
    action: 'published',
    exportedProfileId: artifact.profile.id,
    outputPath: publication.outputPath,
    instructions: { ...artifact.profile.instructions },
    skills: [...artifact.profile.skills],
    omittedLocalSkills: omitted,
    libraries: [...artifact.profile.libraries],
    packages: [...artifact.profile.packages],
    resources: artifact.resources.map((resource) => {
      if (resource.kind === 'skill' && resource.source.type === 'remoteGit') {
        return { kind: 'skill' as const, id: resource.id, source: { ...resource.source } };
      }
      if (resource.kind === 'library') {
        return { kind: 'library' as const, id: resource.id, source: { ...resource.source } };
      }
      if (resource.kind === 'package') {
        return { kind: 'package' as const, id: resource.id, source: { ...resource.source } };
      }
      throw invalidSource('captured artifact contains an unsupported resource');
    }),
    warnings
  };
}

function invalidSource(detail: string): BazframeError {
  return new BazframeError('PROFILE_EXPORT_SOURCE_INVALID', `Profile cannot be exported: ${detail}.`);
}
function changedSource(): BazframeError {
  return new BazframeError('PROFILE_EXPORT_SOURCE_CHANGED', 'Profile export source changed during capture or publication revalidation.');
}
function isWithin(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === ''
    || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
