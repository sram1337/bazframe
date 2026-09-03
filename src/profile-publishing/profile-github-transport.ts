import { createHash } from 'node:crypto';
import { BazframeError } from '../core/errors.js';
import {
  createPrivateProfileGithubRepository,
  lookupProfileGithubRepository,
  parseProfileGithubSource,
  readProfileGithubAuthenticatedLogin,
  setProfileGithubRepositoryVisibility,
  type CanonicalProfileGithubSource,
  type ProfileGithubControlOptions,
  type ProfileGithubRepositoryCreationProof,
  type ProfileGithubRepositoryMetadata
} from './profile-github.js';
import {
  listCanonicalProfileGitVersions,
  publishCanonicalProfileGit,
  readCanonicalProfileGitTip,
  readCanonicalProfileGitVersion,
  type ProfileGithubGitOptions
} from './profile-github-git.js';
import type { ProfileLifecycleGitAdapter, GitProfileSnapshot, GitProfileVersion } from './profile-lifecycle.js';
import type { ProfilePublicationAdapter } from './profile-publication.js';
import type {
  ProfilePublicationRecoveryAdapter,
  PublicationRecoveryProof,
  PublicationRecoveryRepositoryProof
} from './profile-recovery.js';
import type { PublicationJournalV1 } from './transaction-journal.js';

export type ProductionProfileGithubTransportOptions = ProfileGithubGitOptions;

/**
 * One production transport boundary shared by publish, import/update/version,
 * and startup recovery. It delegates all process execution and filesystem
 * isolation to the reviewed GitHub control/Git implementations.
 */
export type ProductionProfileGithubTransportAdapter =
  ProfilePublicationAdapter & ProfileLifecycleGitAdapter & ProfilePublicationRecoveryAdapter;

/** Strict Git-only read adapter for public repositories; it never invokes gh. */
export function createPublicProfileGithubTransportAdapter(
  options: ProductionProfileGithubTransportOptions
): ProfileLifecycleGitAdapter {
  const git: ProfileGithubGitOptions = { ...options, authenticated: false };
  return {
    inspect: async (source, revision) => {
      const snapshot = await readCanonicalProfileGitVersion(source.fetchUrl, revision, git);
      return {
        profile: structuredClone(snapshot.profile),
        manifestBytes: Buffer.from(snapshot.manifestBytes),
        blobs: snapshot.blobs.map((blob) => ({ ...blob, bytesValue: Buffer.from(blob.bytesValue) })),
        archiveBytes: aggregateSnapshotBytes(snapshot.manifestBytes, snapshot.blobs),
        source: copySource(source),
        commit: snapshot.commit,
        latestCommit: snapshot.tip,
        visibility: 'public'
      };
    },
    list: async (source) => {
      const history = await listCanonicalProfileGitVersions(source.fetchUrl, git);
      return history.commits.map((commit) => ({ commit } satisfies GitProfileVersion));
    }
  };
}

export function createProductionProfileGithubTransportAdapter(
  options: ProductionProfileGithubTransportOptions
): ProductionProfileGithubTransportAdapter {
  const control: ProfileGithubControlOptions = {
    process: options.process,
    isolation: options.isolation,
    cwd: options.cwd
  };
  const git: ProfileGithubGitOptions = {
    process: options.process,
    isolation: options.isolation,
    cwd: options.cwd,
    quarantineParent: options.quarantineParent,
    ...(options.allowFileProtocol === undefined ? {} : { allowFileProtocol: options.allowFileProtocol }),
    ...(options.authenticated === undefined ? {} : { authenticated: options.authenticated }),
    ...(options.limitPolicy === undefined ? {} : { limitPolicy: options.limitPolicy }),
    ...(options.acquisitionLimits === undefined ? {} : { acquisitionLimits: options.acquisitionLimits })
  };

  const inspect = async (source: CanonicalProfileGithubSource, revision?: string): Promise<GitProfileSnapshot> => {
    const before = await requiredRepository(control, source);
    const snapshot = await readCanonicalProfileGitVersion(source.fetchUrl, revision, git);
    const after = await requiredRepository(control, source);
    assertSameRepository(before, after, source);
    return {
      profile: structuredClone(snapshot.profile),
      manifestBytes: Buffer.from(snapshot.manifestBytes),
      blobs: snapshot.blobs.map((blob) => ({ ...blob, bytesValue: Buffer.from(blob.bytesValue) })),
      archiveBytes: aggregateSnapshotBytes(snapshot.manifestBytes, snapshot.blobs),
      source: copySource(source),
      commit: snapshot.commit,
      latestCommit: snapshot.tip,
      visibility: after.visibility
    };
  };

  const list = async (source: CanonicalProfileGithubSource): Promise<readonly GitProfileVersion[]> => {
    const before = await requiredRepository(control, source);
    const history = await listCanonicalProfileGitVersions(source.fetchUrl, git);
    const after = await requiredRepository(control, source);
    assertSameRepository(before, after, source);
    return history.commits.map((commit) => ({ commit } satisfies GitProfileVersion));
  };

  const proveRepository = async (journal: PublicationJournalV1): Promise<PublicationRecoveryRepositoryProof> => {
    const source = sourceFromOrigin(journal.origin);
    const before = await requiredRepository(control, source);
    const after = await requiredRepository(control, source);
    assertSameRepository(before, after, source);
    return {
      repositoryIdentityProven: true,
      repositoryId: after.repositoryId,
      origin: source.origin,
      visibility: after.visibility
    };
  };

  const prove = async (journal: PublicationJournalV1): Promise<PublicationRecoveryProof> => {
    const source = sourceFromOrigin(journal.origin);
    const before = await requiredRepository(control, source);
    let snapshot;
    try { snapshot = await readCanonicalProfileGitVersion(source.fetchUrl, undefined, git); }
    catch (error) {
      if (error instanceof BazframeError && error.code === 'PROFILE_GITHUB_MAIN_UNAVAILABLE'
        && await readCanonicalProfileGitTip(source.fetchUrl, git) === null) {
        throw new BazframeError('PROFILE_RECOVERY_REMOTE_REF_ABSENT', 'The publication ref is absent after a durable push intent.');
      }
      throw error;
    }
    const after = await requiredRepository(control, source);
    assertSameRepository(before, after, source);
    return {
      repositoryIdentityProven: true,
      repositoryId: after.repositoryId,
      origin: source.origin,
      visibility: after.visibility,
      tip: snapshot.tip,
      tipParent: snapshot.parent,
      tree: snapshot.tree,
      canonicalTreeProven: true,
      capturedManifestSha256: createHash('sha256').update(snapshot.manifestBytes).digest('hex'),
      manifestBytes: Buffer.from(snapshot.manifestBytes),
      profile: structuredClone(snapshot.profile),
      blobs: snapshot.blobs.map((blob) => ({ ...blob, bytesValue: Buffer.from(blob.bytesValue) }))
    };
  };

  const setRepositoryVisibility = async (
    journal: PublicationJournalV1,
    visibility: 'private' | 'public'
  ): Promise<PublicationRecoveryRepositoryProof> => {
    const source = sourceFromOrigin(journal.origin);
    const changed = await setProfileGithubRepositoryVisibility(control, source, visibility);
    if (journal.repositoryId !== null && changed.repositoryId !== journal.repositoryId) {
      throw new BazframeError('PROFILE_RECOVERY_AMBIGUOUS', 'Profile repository identity changed during recovery visibility convergence.');
    }
    return proveRepository(journal);
  };

  type SetVisibility = {
    (source: CanonicalProfileGithubSource, visibility: 'private' | 'public'): Promise<ProfileGithubRepositoryMetadata>;
    (journal: PublicationJournalV1, visibility: 'private' | 'public'): Promise<PublicationRecoveryProof>;
  };
  const setVisibility = (async (
    journalOrSource: PublicationJournalV1 | CanonicalProfileGithubSource,
    visibility: 'private' | 'public'
  ): Promise<ProfileGithubRepositoryMetadata | PublicationRecoveryProof> => {
    if ('kind' in journalOrSource) {
      const source = sourceFromOrigin(journalOrSource.origin);
      const changed = await setProfileGithubRepositoryVisibility(control, source, visibility);
      if (journalOrSource.repositoryId !== null && changed.repositoryId !== journalOrSource.repositoryId) {
        throw new BazframeError('PROFILE_RECOVERY_AMBIGUOUS', 'Profile repository identity changed during recovery visibility convergence.');
      }
      return prove(journalOrSource);
    }
    return setProfileGithubRepositoryVisibility(control, journalOrSource, visibility);
  }) as SetVisibility;

  const adapter: ProductionProfileGithubTransportAdapter = {
    resolveSource: async (profileName, linkedOrigin) => {
      if (linkedOrigin !== null) return sourceFromOrigin(linkedOrigin);
      const owner = await readProfileGithubAuthenticatedLogin(control);
      return parseProfileGithubSource(`git:${owner}/${profileName}`);
    },
    lookup: (source) => lookupProfileGithubRepository(control, source),
    readTip: async (source) => {
      const before = await lookupProfileGithubRepository(control, source);
      if (before === undefined) return null;
      assertRepository(before, source);
      const tip = await readCanonicalProfileGitTip(source.fetchUrl, git);
      const after = await requiredRepository(control, source);
      assertSameRepository(before, after, source);
      return tip;
    },
    createPrivate: async (source) => {
      const created = await createPrivateProfileGithubRepository(control, source);
      return { metadata: { ...created.metadata }, proof: created.proof };
    },
    push: (request) => publishCanonicalProfileGit({
      ...git,
      remoteUrl: request.source.fetchUrl,
      profile: request.profile,
      blobs: request.blobs,
      expectedOld: request.expectedOld,
      repositoryCreated: request.repositoryCreated,
      ...(request.creationProof === undefined
        ? {}
        : { repositoryCreationProof: request.creationProof as ProfileGithubRepositoryCreationProof }),
      beforeRefUpdate: request.beforeRefUpdate
    }),
    inspect,
    list,
    proveRepository,
    prove,
    setRepositoryVisibility,
    setVisibility
  };
  return adapter;
}

async function requiredRepository(
  control: ProfileGithubControlOptions,
  source: CanonicalProfileGithubSource
): Promise<ProfileGithubRepositoryMetadata> {
  const metadata = await lookupProfileGithubRepository(control, source);
  if (metadata === undefined) throw new BazframeError('PROFILE_REPOSITORY_MISSING', 'The linked GitHub profile repository no longer exists.');
  assertRepository(metadata, source);
  return metadata;
}

function assertSameRepository(
  before: ProfileGithubRepositoryMetadata,
  after: ProfileGithubRepositoryMetadata,
  source: CanonicalProfileGithubSource
): void {
  assertRepository(before, source);
  assertRepository(after, source);
  if (before.repositoryId !== after.repositoryId
    || before.origin !== after.origin
    || before.owner !== after.owner
    || before.repository !== after.repository
    || before.defaultBranch !== after.defaultBranch
    || before.visibility !== after.visibility) {
    throw new BazframeError('PROFILE_GITHUB_METADATA_CHANGED', 'GitHub repository identity or metadata changed during profile transport inspection.');
  }
}

function assertRepository(metadata: ProfileGithubRepositoryMetadata, source: CanonicalProfileGithubSource): void {
  if (metadata.origin !== source.origin || metadata.owner !== source.owner || metadata.repository !== source.repository) {
    throw new BazframeError('PROFILE_GITHUB_METADATA_INVALID', 'GitHub repository metadata does not match the requested canonical origin.');
  }
}

function sourceFromOrigin(origin: string): CanonicalProfileGithubSource {
  if (!origin.startsWith('github.com/')) throw new BazframeError('PROFILE_GITHUB_SOURCE_INVALID', 'Linked profile origin is not canonical GitHub transport state.');
  const source = parseProfileGithubSource(`git:${origin.slice('github.com/'.length)}`);
  if (source.origin !== origin) throw new BazframeError('PROFILE_GITHUB_SOURCE_INVALID', 'Linked profile origin is not canonical GitHub transport state.');
  return source;
}

function aggregateSnapshotBytes(
  manifest: Uint8Array,
  blobs: readonly { bytes: number }[]
): number {
  let total = manifest.byteLength;
  for (const blob of blobs) {
    total += blob.bytes;
    if (!Number.isSafeInteger(total)) throw new BazframeError('PROFILE_GITHUB_OUTPUT_LIMIT', 'Git profile snapshot aggregate byte count is invalid.');
  }
  return total;
}

function copySource(source: CanonicalProfileGithubSource): CanonicalProfileGithubSource {
  return {
    entered: source.entered,
    owner: source.owner,
    repository: source.repository,
    repositoryWithOwner: source.repositoryWithOwner,
    origin: source.origin,
    fetchUrl: source.fetchUrl
  };
}
