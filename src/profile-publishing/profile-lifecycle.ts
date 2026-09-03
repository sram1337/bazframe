import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import type { AuthorizePackageBuild } from '../profile-portability/profile-import-package-build.js';
import { assertSafeProfileId } from '../profiles/profile-id.js';
import { readActiveProfile, readOptionalActiveProfileSnapshot } from '../profiles/profile-store.js';
import {
  assertBlobBytes,
  capturedProfileContentBaselineSha256,
  decodeCapturedProfileObject,
  encodeCapturedProfile,
  profileLocalResourceInstanceId,
  type CapturedProfileV1,
  type CapturedResource,
  type Sha256
} from './captured-profile.js';
import { readOptionalManagedProfileState } from './managed-profile-state.js';
import {
  materializeCapturedProfile,
  type CapturedBlobSource,
  type RemoteMaterializationResult
} from './profile-materialization.js';
import type { OperationMutationAuthority } from './profile-operation-lock.js';
import { capturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { executeProfileCandidateSwap, type CandidateSwapOperation } from './profile-transaction.js';
import {
  assertPhysicalProfileExpectation,
  capturePhysicalProfileExpectation,
  physicalProfileLocalSkillNames,
  type PhysicalProfileExpectation
} from './physical-profile-closure.js';
import { captureCatalogResource, captureProfile, isExcludedCapturedResourcePath, type ProfileCaptureSnapshot } from './profile-capture.js';
import { readProfileSystemView } from './profile-view.js';
import { defaultProfileZipPath, readProfileZip, writeProfileZip, type ProfileZipSnapshot } from './profile-zip.js';
import { parseProfileGithubSource, type CanonicalProfileGithubSource } from './profile-github.js';
import type { ManagedProfileStateV1, PublicationState } from './publication-state.js';
import { createProductionProfileLifecycleRemoteAdapter } from './profile-remote-materializer.js';
import { noProfileLifecycleMutationEffects, type ProfileLifecycleMutationEffects } from './profile-lifecycle-effects.js';
import { copyPhysicalProfileLocalExcludedToCandidate } from './profile-publication.js';
export {
  publishManagedProfile,
  publishSidecarCandidate,
  type ProfilePublicationAdapter,
  type PublishManagedProfileOptions,
  type PublishManagedProfileResult
} from './profile-publication.js';

export interface GitProfileSnapshot extends ProfileZipSnapshot {
  source: CanonicalProfileGithubSource;
  commit: string;
  latestCommit: string;
  visibility: 'private' | 'public';
}

export interface GitProfileVersion {
  commit: string;
}

/** Read-only transport boundary. Implementations resolve only refs/heads/main. */
export interface ProfileLifecycleGitAdapter {
  inspect(source: CanonicalProfileGithubSource, revision?: string): Promise<GitProfileSnapshot>;
  list(source: CanonicalProfileGithubSource): Promise<readonly GitProfileVersion[]>;
}

export type ProfilePackageBuildAuthorization =
  | { mode: 'preauthorized' }
  | { mode: 'interactive'; authorize: AuthorizePackageBuild }
  | { mode: 'decline' };

export interface RemoteResourceMaterializationContext {
  home: string;
  authority: OperationMutationAuthority;
  transactionId: string;
  packageBuildAuthorization: ProfilePackageBuildAuthorization;
}

/** Exact-revision acquisition boundary; package implementations retain report/consent/revalidation. */
export interface ProfileLifecycleRemoteAdapter {
  materialize(resource: CapturedResource, context: RemoteResourceMaterializationContext): Promise<RemoteMaterializationResult>;
}

export interface ProfileLifecycleDependencies {
  git?: ProfileLifecycleGitAdapter;
  remote?: ProfileLifecycleRemoteAdapter;
  capture?: typeof captureProfile;
  captureCatalog?: typeof captureCatalogResource;
  readZip?: typeof readProfileZip;
  writeZip?: typeof writeProfileZip;
}

export interface ExportProfileOptions {
  home: string;
  profileName?: string;
  outputPath?: string;
  overwrite?: boolean;
  bundleRemote?: boolean;
  cwd?: string;
}

export interface ExportProfileResult {
  profileName: string;
  outputPath: string;
  captureSha256: Sha256;
  capturedProfile: CapturedProfileV1;
  bytes: number;
  overwritten: boolean;
  complete: boolean;
  preview: ProfileCaptureSnapshot['preview'];
}

export async function exportManagedProfile(options: ExportProfileOptions, dependencies: ProfileLifecycleDependencies = {}): Promise<ExportProfileResult> {
  const profileName = options.profileName ?? await readActiveProfile(options.home);
  assertSafeProfileId(profileName);
  const captured = await (dependencies.capture ?? captureProfile)({
    bazframeHome: options.home,
    profileId: profileName,
    bundleRemote: options.bundleRemote === true
  });
  const outputPath = options.outputPath ?? defaultProfileZipPath(profileName, options.cwd ?? process.cwd());
  const written = await (dependencies.writeZip ?? writeProfileZip)(outputPath, captured.profile, captured.blobs, { overwrite: options.overwrite === true });
  return {
    profileName,
    outputPath: written.path,
    captureSha256: sha256(captured.manifestBytes),
    capturedProfile: structuredClone(captured.profile),
    bytes: written.bytes,
    overwritten: written.overwritten,
    complete: captured.complete,
    preview: captured.preview.map((entry) => ({ ...entry }))
  };
}

export type ProfileImportSource =
  | { kind: 'zip'; path: string }
  | { kind: 'git'; value: string; revision?: string };

export interface ProfileImportInspection {
  sourceKind: 'zip' | 'git';
  requestedName: string;
  canonicalOrigin: string | null;
  commit: string | null;
  latestCommit: string | null;
  collision: boolean;
  safeSuffix: string | null;
  existingLinkedProfile: string | null;
  completeCapture: boolean;
  /** Inspection itself never writes Bazframe state, cache, locks, profiles, or repositories. */
  mutationPerformed: false;
}

interface InspectedImport {
  report: ProfileImportInspection;
  snapshot: ProfileZipSnapshot | GitProfileSnapshot;
}

export async function inspectProfileImport(
  home: string,
  source: ProfileImportSource,
  dependencies: ProfileLifecycleDependencies = {}
): Promise<ProfileImportInspection> {
  return (await inspectImportSnapshot(home, source, dependencies)).report;
}

export type ProfileImportCollisionChoice = 'safe-suffix' | 'overwrite' | 'cancel';

export interface ImportProfileOptions {
  home: string;
  source: ProfileImportSource;
  profileName?: string;
  yes?: boolean;
  overwrite?: boolean;
  authorizePackageBuild?: AuthorizePackageBuild;
  chooseCollision?: (inspection: ProfileImportInspection) => ProfileImportCollisionChoice | Promise<ProfileImportCollisionChoice>;
}

export interface ImportProfileResult {
  action: 'imported' | 'overwritten' | 'already-linked';
  profileName: string;
  active: boolean;
  incomplete: boolean;
  missingResourceIds: Sha256[];
  publication: PublicationState | null;
  inspection: ProfileImportInspection;
  effects: ProfileLifecycleMutationEffects;
}

export async function importManagedProfile(options: ImportProfileOptions, dependencies: ProfileLifecycleDependencies = {}): Promise<ImportProfileResult> {
  const inspected = await inspectImportSnapshot(options.home, options.source, dependencies);
  if (inspected.report.existingLinkedProfile !== null) {
    return idempotentLinkedImportResult(options.home, inspected.report.existingLinkedProfile, inspected.report);
  }
  const desiredName = options.profileName ?? inspected.report.requestedName;
  assertSafeProfileId(desiredName);
  const desiredReport = desiredName === inspected.report.requestedName ? inspected.report : {
    ...inspected.report,
    collision: await profileExists(options.home, desiredName),
    safeSuffix: await profileExists(options.home, desiredName) ? await firstFreeSuffix(options.home, desiredName) : null
  };
  const selection = await selectImportDestination(desiredReport, options, desiredName);
  const localized = localizeSnapshot(inspected.snapshot, selection.profileName);
  const publication = gitPublication(inspected.snapshot, localized.profile);
  const operation: CandidateSwapOperation = selection.overwrite ? 'overwrite' : 'fresh-import';
  const overwriteBaseline = selection.overwrite ? await captureOptionalManagedBaseline(options.home, selection.profileName) : undefined;
  const previous = overwriteBaseline?.state;
  let missingResourceIds: Sha256[] = [];
  let materializationEffects = { cacheWritten: false, buildExecuted: false };
  const swapped = await executeProfileCandidateSwap({
    home: options.home,
    profileName: selection.profileName,
    operation,
    ...(overwriteBaseline === undefined ? {} : { expectedOld: overwriteBaseline.expectation }),
    ...(selection.overwrite ? {} : { freshImportMustRemainInactive: true }),
    ...(publication === null ? {} : { beforePublication: () => assertOriginUnlinked(options.home, publication.origin) }),
    materialize: async (candidateDirectory, context) => {
      const materialized = await materializeWithPackageOrdering({
        home: options.home,
        candidateDirectory,
        captured: localized.profile,
        blobs: localized.blobs,
        // Import overwrite creates a new logical import and must not inherit the
        // replaced profile's imported-instance IDs or retained bindings.
        previousState: selection.overwrite ? undefined : previous,
        publication,
        allowIncomplete: !selection.overwrite,
        packageBuildAuthorization: packageAuthorization(options.yes === true, options.authorizePackageBuild),
        preserveCapturedResourceBindings: false,
        dependencies,
        context
      });
      missingResourceIds = materialized.missingResourceIds;
      materializationEffects = { ...materialized.effects };
      return { state: materialized.state };
    }
  });
  return {
    action: selection.overwrite ? 'overwritten' : 'imported',
    profileName: selection.profileName,
    active: swapped.active,
    incomplete: missingResourceIds.length > 0,
    missingResourceIds: [...missingResourceIds],
    publication,
    inspection: inspected.report,
    effects: {
      ...noProfileLifecycleMutationEffects(),
      localStateWritten: true,
      profilePublished: true,
      cacheWritten: materializationEffects.cacheWritten,
      lockAcquired: true,
      buildExecuted: materializationEffects.buildExecuted
    }
  };
}

export interface UpdateProfileOptions {
  home: string;
  profileName?: string;
  overwrite?: boolean;
  yes?: boolean;
  authorizePackageBuild?: AuthorizePackageBuild;
}

export interface UpdateProfileResult {
  action: 'current' | 'updated';
  profileName: string;
  commit: string;
  latestCommit: string;
}

export async function updateManagedProfile(options: UpdateProfileOptions, dependencies: ProfileLifecycleDependencies = {}): Promise<UpdateProfileResult> {
  const profileName = options.profileName ?? await readActiveProfile(options.home);
  const baseline = await captureLinkedBaseline(options.home, profileName, options.overwrite === true, dependencies);
  const previous = baseline.state;
  const source = sourceFromPublication(previous.publication!);
  const snapshot = await requiredGit(dependencies).inspect(source);
  validateTransportSnapshot(snapshot);
  if (snapshot.commit !== snapshot.latestCommit) throw invalid('latest Git inspection did not return refs/heads/main tip');
  const hasMissing = previous.importedResources.some((resource) => resource.source.kind === 'missingRemoteGit');
  if (!hasMissing
    && previous.publication!.installedCommit === snapshot.commit
    && previous.publication!.latestSeenCommit === snapshot.latestCommit
    && previous.publication!.visibility === snapshot.visibility) {
    await assertPhysicalProfileExpectation(options.home, profileName, baseline.expectation);
    return { action: 'current', profileName, commit: snapshot.commit, latestCommit: snapshot.latestCommit };
  }
  await applyLinkedVersion(options.home, profileName, previous, baseline.expectation, snapshot, 'update', dependencies, options);
  return { action: 'updated', profileName, commit: snapshot.commit, latestCommit: snapshot.latestCommit };
}

export interface ProfileVersionView {
  commit: string;
  current: boolean;
  latest: boolean;
}

export async function listManagedProfileVersions(
  home: string,
  profileName: string | undefined,
  dependencies: ProfileLifecycleDependencies = {}
): Promise<ProfileVersionView[]> {
  const selected = profileName ?? await readActiveProfile(home);
  const state = await requiredLinkedState(home, selected);
  const versions = await requiredGit(dependencies).list(sourceFromPublication(state.publication!));
  if (versions.length === 0) throw invalid('linked repository has no refs/heads/main versions');
  const seen = new Set<string>();
  const result = versions.map((version, index) => {
    assertCommit(version.commit);
    if (seen.has(version.commit)) throw invalid('version adapter returned duplicate commits');
    seen.add(version.commit);
    return { commit: version.commit, current: version.commit === state.publication!.installedCommit, latest: index === 0 };
  });
  if (result.filter((version) => version.current).length !== 1) throw invalid('installed commit is not reachable from refs/heads/main');
  return result;
}

export interface UseManagedProfileVersionOptions extends UpdateProfileOptions {
  revision: string;
}

export async function useManagedProfileVersion(
  options: UseManagedProfileVersionOptions,
  dependencies: ProfileLifecycleDependencies = {}
): Promise<UpdateProfileResult> {
  const profileName = options.profileName ?? await readActiveProfile(options.home);
  const baseline = await captureLinkedBaseline(options.home, profileName, options.overwrite === true, dependencies, false);
  const previous = baseline.state;
  assertRevisionSelector(options.revision);
  const snapshot = await requiredGit(dependencies).inspect(sourceFromPublication(previous.publication!), options.revision);
  validateTransportSnapshot(snapshot);
  if (snapshot.commit === previous.publication!.installedCommit
    && snapshot.latestCommit === previous.publication!.latestSeenCommit
    && snapshot.visibility === previous.publication!.visibility) {
    await assertPhysicalProfileExpectation(options.home, profileName, baseline.expectation);
    return { action: 'current', profileName, commit: snapshot.commit, latestCommit: snapshot.latestCommit };
  }
  if (baseline.diverged && options.overwrite !== true) throw new BazframeError('PROFILE_LOCAL_DIVERGENCE', 'Profile has local changes; use --overwrite to discard them.');
  await applyLinkedVersion(options.home, profileName, previous, baseline.expectation, snapshot, 'version-use', dependencies, options);
  return { action: 'updated', profileName, commit: snapshot.commit, latestCommit: snapshot.latestCommit };
}

async function inspectImportSnapshot(home: string, source: ProfileImportSource, dependencies: ProfileLifecycleDependencies): Promise<InspectedImport> {
  let snapshot: ProfileZipSnapshot | GitProfileSnapshot;
  let origin: string | null = null;
  let commit: string | null = null;
  let latestCommit: string | null = null;
  if (source.kind === 'zip') snapshot = await (dependencies.readZip ?? readProfileZip)(source.path);
  else {
    const parsed = parseProfileGithubSource(source.value);
    if (source.revision !== undefined) assertRevisionSelector(source.revision);
    const gitSnapshot = await requiredGit(dependencies).inspect(parsed, source.revision);
    if (gitSnapshot.source.origin !== parsed.origin) throw invalid('Git adapter returned a different canonical origin');
    snapshot = gitSnapshot;
    origin = parsed.origin;
    commit = gitSnapshot.commit;
    latestCommit = gitSnapshot.latestCommit;
    if (source.revision === undefined && commit !== latestCommit) throw invalid('default Git import did not return refs/heads/main tip');
  }
  validateTransportSnapshot(snapshot);
  const requestedName = snapshot.profile.profile.name;
  assertSafeProfileId(requestedName);
  let existingProfiles: Awaited<ReturnType<typeof readProfileSystemView>>['profiles'] = [];
  try {
    await lstat(home);
    existingProfiles = (await readProfileSystemView(home)).profiles;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const originOwners = origin === null ? [] : existingProfiles.filter((profile) => profile.publication?.origin === origin);
  if (originOwners.length > 1) throw invalid('canonical GitHub origin is linked by more than one profile');
  const existingLinkedProfile = originOwners[0]?.name ?? null;
  const collision = await profileExists(home, requestedName);
  const safeSuffix = collision ? await firstFreeSuffix(home, requestedName) : null;
  return {
    snapshot,
    report: {
      sourceKind: source.kind,
      requestedName,
      canonicalOrigin: origin,
      commit,
      latestCommit,
      collision,
      safeSuffix,
      existingLinkedProfile,
      completeCapture: !snapshot.profile.resources.some((resource) => resource.payload.kind === 'remoteGit'),
      mutationPerformed: false
    }
  };
}

async function selectImportDestination(report: ProfileImportInspection, options: ImportProfileOptions, desiredName = report.requestedName): Promise<{ profileName: string; overwrite: boolean }> {
  if (!report.collision) return { profileName: desiredName, overwrite: false };
  if (options.overwrite === true) return { profileName: desiredName, overwrite: true };
  if (options.yes === true) return { profileName: report.safeSuffix!, overwrite: false };
  const choice = await options.chooseCollision?.(report);
  if (choice === 'safe-suffix') return { profileName: report.safeSuffix!, overwrite: false };
  if (choice === 'overwrite') return { profileName: desiredName, overwrite: true };
  if (choice === 'cancel') throw new BazframeError('PROFILE_IMPORT_CANCELLED', 'Profile import was cancelled.');
  throw new BazframeError('PROFILE_IMPORT_COLLISION_DECISION_REQUIRED', 'Profile import destination exists; choose a safe suffix, overwrite, or cancel.');
}

async function applyLinkedVersion(
  home: string,
  profileName: string,
  previous: ManagedProfileStateV1,
  expectedOld: PhysicalProfileExpectation,
  snapshot: GitProfileSnapshot,
  operation: 'update' | 'version-use',
  dependencies: ProfileLifecycleDependencies,
  authorization: Pick<UpdateProfileOptions, 'yes' | 'overwrite' | 'authorizePackageBuild'>
): Promise<void> {
  if (snapshot.source.origin !== previous.publication!.origin) throw invalid('Git adapter returned a different linked origin');
  const localized = localizeSnapshot(snapshot, profileName);
  const publication: PublicationState = {
    ...previous.publication!,
    installedCommit: snapshot.commit,
    latestSeenCommit: snapshot.latestCommit,
    baselineCaptureSha256: capturedProfileContentBaselineSha256(localized.profile, capturedProfileLimitPolicy()),
    visibility: snapshot.visibility
  };
  const incomingIds = new Set(localized.profile.resources.map((resource) => resource.id));
  for (const name of physicalProfileLocalSkillNames(expectedOld.closure)) {
    const binding = previous.capturedResourceIds.find((candidate) => candidate.identityKind === 'profileLocal' && candidate.instanceId === profileLocalResourceInstanceId(previous.profileInstanceId, name));
    if (binding !== undefined && !incomingIds.has(binding.capturedResourceId)
      && expectedOld.closure.entries.some((entry) => entry.kind === 'file' && entry.path.startsWith(`skills/${name}/`) && isExcludedCapturedResourcePath(entry.path.slice(`skills/${name}/`.length)))
      && authorization.overwrite !== true) {
      throw new BazframeError('PROFILE_LOCAL_DIVERGENCE', `Profile-local Skill ${JSON.stringify(name)} contains source-only files that removal would discard; use --overwrite to discard them.`);
    }
  }
  let revalidateOrdinary = async (): Promise<void> => undefined;
  await executeProfileCandidateSwap({
    home,
    profileName,
    operation,
    expectedOld,
    beforePublication: async () => {
      await assertSingleOriginOwner(home, publication.origin, profileName);
      await revalidateOrdinary();
    },
    materialize: async (candidateDirectory, context) => {
      if (authorization.overwrite !== true) {
        const retainedLocalNames = new Set(localized.profile.resources
          .filter((resource) => previous.capturedResourceIds.some((binding) => binding.capturedResourceId === resource.id && binding.identityKind === 'profileLocal'))
          .map((resource) => resource.key.name));
        await copyPhysicalProfileLocalExcludedToCandidate(home, profileName, expectedOld, candidateDirectory, retainedLocalNames);
      }
      const materialized = await materializeWithPackageOrdering({
        home,
        candidateDirectory,
        captured: localized.profile,
        blobs: localized.blobs,
        previousState: previous,
        publication,
        allowIncomplete: false,
        packageBuildAuthorization: packageAuthorization(authorization.yes === true, authorization.authorizePackageBuild),
        preserveCapturedResourceBindings: true,
        dependencies,
        context
      });
      revalidateOrdinary = materialized.revalidateOrdinary;
      return { state: materialized.state };
    }
  });
}

async function materializeWithPackageOrdering(options: {
  home: string;
  candidateDirectory: string;
  captured: CapturedProfileV1;
  blobs: readonly CapturedBlobSource[];
  previousState?: ManagedProfileStateV1;
  publication: PublicationState | null;
  allowIncomplete: boolean;
  packageBuildAuthorization: ProfilePackageBuildAuthorization;
  preserveCapturedResourceBindings: boolean;
  dependencies: ProfileLifecycleDependencies;
  context: { authority: OperationMutationAuthority; transactionId: string; beginPackageEffects(ids?: readonly string[]): Promise<void> };
}) {
  const packageIds = options.captured.resources.filter((resource) => resource.key.kind === 'package' && resource.payload.kind === 'remoteGit').map((resource) => resource.id);
  let packagesBegun = false;
  const remote = options.dependencies.remote ?? createProductionProfileLifecycleRemoteAdapter();
  return materializeCapturedProfile({
    home: options.home,
    candidateDirectory: options.candidateDirectory,
    authority: options.context.authority,
    captured: options.captured,
    blobs: options.blobs,
    ...(options.previousState === undefined ? {} : { previousState: options.previousState }),
    publication: options.publication,
    allowIncomplete: options.allowIncomplete,
    preserveCapturedResourceBindings: options.preserveCapturedResourceBindings,
    captureOrdinary: async (resource) => (options.dependencies.captureCatalog ?? captureCatalogResource)({
      bazframeHome: options.home,
      kind: resource.key.kind,
      name: resource.key.name,
      capturedResourceId: resource.id,
      bundleRemote: resource.payload.kind === 'bundled'
    }),
    materializeRemote: async (resource) => {
      if (resource.key.kind === 'package' && !packagesBegun) {
        packagesBegun = true;
        await options.context.beginPackageEffects(packageIds);
      }
      return remote.materialize(resource, {
        home: options.home,
        authority: options.context.authority,
        transactionId: options.context.transactionId,
        packageBuildAuthorization: options.packageBuildAuthorization
      });
    }
  });
}

interface ManagedProfileBaseline {
  expectation: PhysicalProfileExpectation;
  state: ManagedProfileStateV1 | undefined;
}

async function captureOptionalManagedBaseline(home: string, profileName: string): Promise<ManagedProfileBaseline> {
  const expectation = await capturePhysicalProfileExpectation(home, profileName);
  const snapshot = await readOptionalManagedProfileState(home, profileName);
  if ((snapshot?.sha256 ?? null) !== expectation.sidecarSha256) throw changed(profileName);
  await assertPhysicalProfileExpectation(home, profileName, expectation);
  return { expectation, state: snapshot?.state };
}

async function captureLinkedBaseline(
  home: string,
  profileName: string,
  overwrite: boolean,
  dependencies: ProfileLifecycleDependencies,
  enforceDivergence = true
): Promise<{ expectation: PhysicalProfileExpectation; state: ManagedProfileStateV1; diverged: boolean }> {
  const expectation = await capturePhysicalProfileExpectation(home, profileName);
  const snapshot = await readOptionalManagedProfileState(home, profileName);
  if (snapshot === undefined || snapshot.state.publication === null) throw new BazframeError('PROFILE_NOT_PUBLISHED', `Profile ${JSON.stringify(profileName)} is not linked to GitHub.`);
  if (snapshot.sha256 !== expectation.sidecarSha256) throw changed(profileName);
  const captured = await (dependencies.capture ?? captureProfile)({ bazframeHome: home, profileId: profileName, bundleRemote: false });
  await assertPhysicalProfileExpectation(home, profileName, expectation);
  const diverged = capturedProfileContentBaselineSha256(captured.profile, capturedProfileLimitPolicy()) !== snapshot.state.publication.baselineCaptureSha256;
  if (diverged && !overwrite && enforceDivergence) throw new BazframeError('PROFILE_LOCAL_DIVERGENCE', 'Profile has local changes; use --overwrite to discard them.');
  return { expectation, state: snapshot.state, diverged };
}

function localizeSnapshot(snapshot: ProfileZipSnapshot | GitProfileSnapshot, profileName: string): ProfileZipSnapshot {
  const policy = capturedProfileLimitPolicy();
  const profile = decodeCapturedProfileObject({
    ...snapshot.profile,
    profile: { ...snapshot.profile.profile, name: profileName }
  }, policy);
  return {
    profile,
    manifestBytes: Buffer.from(encodeCapturedProfile(profile, policy)),
    blobs: snapshot.blobs.map((blob) => ({ sha256: blob.sha256, bytes: blob.bytes, bytesValue: Buffer.from(blob.bytesValue) })),
    archiveBytes: snapshot.archiveBytes
  };
}

function gitPublication(snapshot: ProfileZipSnapshot | GitProfileSnapshot, localizedProfile: CapturedProfileV1): PublicationState | null {
  if (!('source' in snapshot)) return null;
  return {
    transport: 'git',
    origin: snapshot.source.origin,
    installedCommit: snapshot.commit,
    latestSeenCommit: snapshot.latestCommit,
    baselineCaptureSha256: capturedProfileContentBaselineSha256(localizedProfile, capturedProfileLimitPolicy()),
    visibility: snapshot.visibility
  };
}

async function idempotentLinkedImportResult(home: string, profileName: string, inspection: ProfileImportInspection): Promise<ImportProfileResult> {
  const origin = inspection.canonicalOrigin;
  if (origin === null) throw changed(profileName);
  const expectation = await capturePhysicalProfileExpectation(home, profileName);
  const snapshot = await readOptionalManagedProfileState(home, profileName);
  if (snapshot === undefined || snapshot.sha256 !== expectation.sidecarSha256 || snapshot.state.publication?.origin !== origin) throw changed(profileName);
  await assertSingleOriginOwner(home, origin, profileName);
  const active = (await readOptionalActiveProfileSnapshot(home))?.profileId === profileName;
  await assertPhysicalProfileExpectation(home, profileName, expectation);
  await assertSingleOriginOwner(home, origin, profileName);
  const missingResourceIds = snapshot.state.importedResources
    .filter((resource) => resource.source.kind === 'missingRemoteGit')
    .map((resource) => resource.capturedResourceId)
    .sort();
  return {
    action: 'already-linked', profileName, active, incomplete: missingResourceIds.length > 0,
    missingResourceIds, publication: structuredClone(snapshot.state.publication), inspection,
    effects: noProfileLifecycleMutationEffects()
  };
}

async function assertSingleOriginOwner(home: string, origin: string, expectedName: string): Promise<void> {
  const owners = (await readProfileSystemView(home)).profiles.filter((profile) => profile.publication?.origin === origin);
  if (owners.length !== 1 || owners[0]?.name !== expectedName) throw changed(expectedName);
}

function packageAuthorization(yes: boolean, authorize: AuthorizePackageBuild | undefined): ProfilePackageBuildAuthorization {
  if (yes) return { mode: 'preauthorized' };
  if (authorize !== undefined) return { mode: 'interactive', authorize };
  return { mode: 'decline' };
}

async function requiredLinkedState(home: string, profileName: string): Promise<ManagedProfileStateV1> {
  assertSafeProfileId(profileName);
  const snapshot = await readOptionalManagedProfileState(home, profileName);
  if (snapshot?.state.publication === null || snapshot === undefined) throw new BazframeError('PROFILE_NOT_PUBLISHED', `Profile ${JSON.stringify(profileName)} is not linked to GitHub.`);
  return snapshot.state;
}

async function assertOriginUnlinked(home: string, origin: string): Promise<void> {
  const view = await readProfileSystemView(home);
  const owners = view.profiles.filter((profile) => profile.publication?.origin === origin);
  if (owners.length > 1) throw invalid('canonical GitHub origin is linked by more than one profile');
  const owner = owners[0];
  if (owner !== undefined) throw new BazframeError('PROFILE_IMPORT_ALREADY_LINKED', `GitHub profile is already linked as ${JSON.stringify(owner.name)}; use profile update.`);
}

function sourceFromPublication(publication: PublicationState): CanonicalProfileGithubSource {
  return parseProfileGithubSource(`git:${publication.origin.slice('github.com/'.length)}`);
}

function requiredGit(dependencies: ProfileLifecycleDependencies): ProfileLifecycleGitAdapter {
  if (dependencies.git === undefined) throw new BazframeError('PROFILE_GIT_ADAPTER_REQUIRED', 'Git profile transport is unavailable.');
  return dependencies.git;
}

async function profileExists(home: string, profileName: string): Promise<boolean> {
  try {
    const metadata = await lstat(join(home, 'profiles', profileName));
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalid('profile destination is not a physical directory');
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function firstFreeSuffix(home: string, base: string): Promise<string> {
  for (let suffix = 1; suffix <= PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries + 1; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (candidate.length > 64) throw invalid('profile name has no representable safe suffix');
    if (!await profileExists(home, candidate)) return candidate;
  }
  throw invalid('profile namespace has no free safe suffix');
}

function validateTransportSnapshot(snapshot: ProfileZipSnapshot | GitProfileSnapshot): void {
  const policy = capturedProfileLimitPolicy();
  const profile = decodeCapturedProfileObject(snapshot.profile, policy);
  const canonical = Buffer.from(encodeCapturedProfile(profile, policy));
  if (!canonical.equals(snapshot.manifestBytes)) throw invalid('transport adapter returned noncanonical manifest bytes');
  if (snapshot.blobs.length !== profile.blobs.length) throw invalid('transport adapter returned an incomplete blob closure');
  for (let index = 0; index < profile.blobs.length; index += 1) {
    const expected = profile.blobs[index]!;
    const actual = snapshot.blobs[index];
    if (actual === undefined || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw invalid('transport adapter returned an unordered blob closure');
    assertBlobBytes(expected, actual.bytesValue);
  }
  if ('source' in snapshot) {
    assertCommit(snapshot.commit);
    assertCommit(snapshot.latestCommit);
    if (snapshot.source.origin !== parseProfileGithubSource(snapshot.source.entered).origin) throw invalid('Git adapter returned a noncanonical source');
  }
}
function assertRevisionSelector(value: string): void {
  if (!/^[a-f0-9]+$/u.test(value) || value.length > 64) throw invalid('commit selector must be nonempty lowercase hexadecimal');
}
function assertCommit(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) throw invalid('Git adapter returned an invalid full commit ID');
}
function sha256(bytes: Uint8Array): Sha256 { return createHash('sha256').update(bytes).digest('hex'); }
function changed(profileName: string): BazframeError { return new BazframeError('PROFILE_LIFECYCLE_CHANGED', `Profile ${JSON.stringify(profileName)} changed during lifecycle authorization.`); }
function invalid(detail: string): BazframeError { return new BazframeError('PROFILE_LIFECYCLE_INVALID', `Invalid profile lifecycle operation: ${detail}.`); }
