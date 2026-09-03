import { BazframeError } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { canonicalProfileGitHubOrigin } from '../providers/managed-git-source.js';
import { isCanonicalGitBranchName } from './profile-git-ref.js';
import {
  assertProfileGithubCommand,
  runProfileGithubCommand,
  type ProfileGithubInteractionMode,
  type ProfileGithubIsolation,
  type ProfileGithubProcess,
  type ProfileGithubProcessResult
} from './profile-github-process.js';

export interface CanonicalProfileGithubSource {
  entered: string;
  owner: string;
  repository: string;
  repositoryWithOwner: string;
  origin: string;
  fetchUrl: string;
}

export interface ProfileGithubRepositoryMetadata {
  repositoryId: number;
  origin: string;
  owner: string;
  repository: string;
  defaultBranch: string;
  visibility: 'private' | 'public';
}

export interface ProfileGithubRepositoryCreationProof {
  readonly kind: 'profile-github-repository-creation-proof';
}

export interface CreatedProfileGithubRepository {
  metadata: ProfileGithubRepositoryMetadata;
  proof: ProfileGithubRepositoryCreationProof;
}

const repositoryCreationProofs = new WeakMap<object, { fetchUrl: string; repositoryId: number }>();

export interface ProfileGithubControlOptions {
  process: ProfileGithubProcess;
  isolation: ProfileGithubIsolation;
  cwd: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/u;

export function parseProfileGithubSource(value: string): CanonicalProfileGithubSource {
  if (typeof value !== 'string' || !value.startsWith('git:') || value.includes('\u0000')) throw invalidSource();
  const repositoryWithOwner = value.slice(4);
  const segments = repositoryWithOwner.split('/');
  if (segments.length !== 2) throw invalidSource();
  const [enteredOwner, enteredRepository] = segments as [string, string];
  if (!OWNER.test(enteredOwner) || !REPOSITORY.test(enteredRepository)
    || enteredRepository === '.' || enteredRepository === '..' || enteredRepository.toLowerCase().endsWith('.git')) {
    throw invalidSource();
  }
  const owner = enteredOwner.toLowerCase();
  const repository = enteredRepository.toLowerCase();
  const origin = canonicalProfileGitHubOrigin(`github.com/${owner}/${repository}`);
  return {
    entered: value,
    owner,
    repository,
    repositoryWithOwner: `${owner}/${repository}`,
    origin,
    fetchUrl: `https://github.com/${owner}/${repository}.git`
  };
}

export async function requireProfileGithubAuthentication(
  options: ProfileGithubControlOptions,
  mode: ProfileGithubInteractionMode
): Promise<{ loginStarted: boolean }> {
  const version = await gh(options, ['--version']);
  if (commandMissing(version)) {
    throw new BazframeError('PROFILE_GITHUB_CLI_MISSING', 'GitHub CLI (gh) is required. Install it from https://cli.github.com/.');
  }
  assertProfileGithubCommand(version, 'PROFILE_GITHUB_CLI_FAILED', 'GitHub CLI could not be started.');
  const status = await gh(options, ['auth', 'status', '--hostname', 'github.com']);
  if (status.status === 0 && status.failure === undefined && status.error === undefined) return { loginStarted: false };
  if (mode !== 'human') {
    throw new BazframeError('PROFILE_GITHUB_AUTH_REQUIRED', 'GitHub authentication is required; JSON and dry-run modes never start login.');
  }
  const login = await gh(options, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], 'inherit');
  assertProfileGithubCommand(login, 'PROFILE_GITHUB_AUTH_FAILED', 'GitHub login did not complete successfully.');
  const verified = await gh(options, ['auth', 'status', '--hostname', 'github.com']);
  assertProfileGithubCommand(verified, 'PROFILE_GITHUB_AUTH_FAILED', 'GitHub authentication could not be verified after login.');
  return { loginStarted: true };
}

export async function readProfileGithubAuthenticatedLogin(options: ProfileGithubControlOptions): Promise<string> {
  const result = await gh(options, ['api', 'user', '--jq', '.login']);
  const value = checkedOutput(result, 'PROFILE_GITHUB_METADATA_FAILED', 'GitHub account metadata lookup failed.').trim();
  if (!OWNER.test(value)) throw metadataInvalid();
  return value.toLowerCase();
}

export async function lookupProfileGithubRepository(
  options: ProfileGithubControlOptions,
  source: CanonicalProfileGithubSource
): Promise<ProfileGithubRepositoryMetadata | undefined> {
  const result = await gh(options, ['api', `repos/${source.repositoryWithOwner}`]);
  if (result.status === 1 && safeGhNotFound(result.stderr)) return undefined;
  const stdout = checkedOutput(result, 'PROFILE_GITHUB_METADATA_FAILED', 'GitHub repository metadata lookup failed.');
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw metadataInvalid(); }
  if (!isRecord(value)
    || !Number.isSafeInteger(value.id) || Number(value.id) <= 0
    || typeof value.full_name !== 'string'
    || value.full_name.toLowerCase() !== source.repositoryWithOwner
    || typeof value.private !== 'boolean'
    || typeof value.default_branch !== 'string'
    || !isCanonicalGitBranchName(value.default_branch)) throw metadataInvalid();
  return {
    repositoryId: Number(value.id),
    origin: source.origin,
    owner: source.owner,
    repository: source.repository,
    defaultBranch: value.default_branch,
    visibility: value.private ? 'private' : 'public'
  };
}

/** First-publish creation is always private and restricted to the authenticated user's account. */
export async function createPrivateProfileGithubRepository(
  options: ProfileGithubControlOptions,
  source: CanonicalProfileGithubSource
): Promise<CreatedProfileGithubRepository> {
  const login = await readProfileGithubAuthenticatedLogin(options);
  if (login !== source.owner) {
    throw new BazframeError('PROFILE_GITHUB_OWNER_REFUSED', 'First publication may create a repository only in the authenticated user account.');
  }
  const result = await gh(options, ['repo', 'create', source.repositoryWithOwner, '--private']);
  checkedOutput(result, 'PROFILE_GITHUB_CREATE_FAILED', 'GitHub repository creation failed.');
  const metadata = await lookupProfileGithubRepository(options, source);
  if (metadata === undefined || metadata.visibility !== 'private') {
    throw new BazframeError('PROFILE_GITHUB_CREATE_UNPROVEN', 'New GitHub repository identity and private visibility could not be proved.');
  }
  const proof: ProfileGithubRepositoryCreationProof = Object.freeze({ kind: 'profile-github-repository-creation-proof' });
  repositoryCreationProofs.set(proof, { fetchUrl: source.fetchUrl, repositoryId: metadata.repositoryId });
  return { metadata, proof };
}

export function assertProfileGithubRepositoryCreationProof(
  proof: ProfileGithubRepositoryCreationProof | undefined,
  fetchUrl: string
): number {
  const binding = proof === undefined ? undefined : repositoryCreationProofs.get(proof);
  if (binding === undefined || binding.fetchUrl !== fetchUrl) {
    throw new BazframeError('PROFILE_GITHUB_CREATION_PROOF_REQUIRED', 'First publication requires proof that Bazframe just created this private repository.');
  }
  return binding.repositoryId;
}

export async function setProfileGithubRepositoryVisibility(
  options: ProfileGithubControlOptions,
  source: CanonicalProfileGithubSource,
  visibility: 'private' | 'public'
): Promise<ProfileGithubRepositoryMetadata> {
  const result = await gh(options, [
    'repo', 'edit', source.repositoryWithOwner,
    '--visibility', visibility,
    '--accept-visibility-change-consequences'
  ]);
  checkedOutput(result, 'PROFILE_GITHUB_VISIBILITY_FAILED', 'GitHub repository visibility change failed.');
  const metadata = await lookupProfileGithubRepository(options, source);
  if (metadata === undefined || metadata.visibility !== visibility) {
    throw new BazframeError('PROFILE_GITHUB_VISIBILITY_UNPROVEN', 'GitHub repository visibility change could not be proved.');
  }
  return metadata;
}

async function gh(
  options: ProfileGithubControlOptions,
  args: readonly string[],
  stdin: 'ignore' | 'inherit' = 'ignore'
): Promise<ProfileGithubProcessResult> {
  const result = await runProfileGithubCommand(options.process, options.isolation, 'gh', args, options.cwd, { stdin });
  assertFakeRespectedBound(result);
  return result;
}

function checkedOutput(result: ProfileGithubProcessResult, code: string, message: string): string {
  assertFakeRespectedBound(result);
  return assertProfileGithubCommand(result, code, message);
}

function assertFakeRespectedBound(result: ProfileGithubProcessResult): void {
  if (Buffer.byteLength(result.stdout) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes
    || (result.stdoutBytes?.byteLength ?? 0) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes
    || Buffer.byteLength(result.stderr) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.gitStreamBytes) {
    throw new BazframeError('PROFILE_GITHUB_OUTPUT_LIMIT', 'GitHub process output exceeded its bounded capture limit.');
  }
}

function commandMissing(result: ProfileGithubProcessResult): boolean {
  const code = result.error !== undefined && 'code' in result.error ? String((result.error as Error & { code?: unknown }).code) : undefined;
  return result.status === null && (code === 'ENOENT' || result.failure === 'spawn');
}

function safeGhNotFound(stderr: string): boolean {
  return stderr === 'HTTP 404: Not Found (https://api.github.com/)\n' || stderr === 'gh: Not Found (HTTP 404)\n';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidSource(): BazframeError {
  return new BazframeError('PROFILE_GITHUB_SOURCE_INVALID', 'GitHub source must be git:<owner>/<repository>.');
}
function metadataInvalid(): BazframeError {
  return new BazframeError('PROFILE_GITHUB_METADATA_INVALID', 'GitHub returned invalid repository metadata.');
}
