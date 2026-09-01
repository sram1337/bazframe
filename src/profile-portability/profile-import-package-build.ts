import { BazframeError } from '../core/errors.js';
import { PACKAGE_MANIFEST, type PackageManifestSnapshot } from '../packages/package-manifest.js';
import type { PathFreeManagedGitIdentity } from '../providers/managed-git-record.js';
import type { BeforePackageBuildContext } from '../skill-collections/skill-collection-preparation.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from './profile-portability-policy.js';

export type PackageBuildAuthorizationSource =
  | ({ type: 'remoteGit' } & PathFreeManagedGitIdentity)
  | { type: 'localMapping'; root: string };

/** Explicit public projection. Physical identity and lifecycle snapshots are intentionally absent. */
export interface PackageBuildAuthorizationReport {
  packageId: string;
  source: PackageBuildAuthorizationSource;
  candidateRoot: string;
  cwd: string;
  argv: string[];
  manifest: { path: typeof PACKAGE_MANIFEST; sha256: string };
  artifactRoot: string;
  skillsRoot: string;
  shell: false;
  environment: { inherited: true; namesAndValuesExposed: false };
  authority: {
    sandboxed: false;
    user: 'current-process-user';
    access: readonly ['credentials', 'network', 'user-files'];
  };
  warning: 'Package build side effects are not rollbackable.';
}

export type AuthorizePackageBuild = (
  report: PackageBuildAuthorizationReport
) => boolean | Promise<boolean>;

const MAX_GENERATED_IMPORT_DIAGNOSTICS = 5;
const GENERATED_IMPORT_DIAGNOSTIC_RESERVE_BYTES =
  MAX_GENERATED_IMPORT_DIAGNOSTICS * PROFILE_PORTABILITY_PRODUCTION_LIMITS.diagnosticBytes;

export class PackageBuildReportAccumulator {
  readonly #reports: PackageBuildAuthorizationReport[] = [];
  readonly #possibleEffects = new Set<string>();
  #bytes = 0;

  add(report: PackageBuildAuthorizationReport): PackageBuildAuthorizationReport {
    const copy = freezeReport(report);
    const bytes = Buffer.byteLength(JSON.stringify(copy), 'utf8');
    if (this.#bytes + bytes + GENERATED_IMPORT_DIAGNOSTIC_RESERVE_BYTES
      > PROFILE_PORTABILITY_PRODUCTION_LIMITS.diagnosticReportBytes) {
      throw new BazframeError(
        'PROFILE_IMPORT_REPORT_LIMIT',
        'Package build authorization reports and reserved generated diagnostics exceed the aggregate import-report limit.'
      );
    }
    this.#bytes += bytes;
    this.#reports.push(copy);
    return copy;
  }

  markPossibleEffect(packageId: string): void {
    this.#possibleEffects.add(packageId);
  }

  clearPossibleEffect(packageId: string): void {
    this.#possibleEffects.delete(packageId);
  }

  reports(): PackageBuildAuthorizationReport[] {
    return this.#reports.map(copyReport);
  }

  possibleEffects(): string[] {
    return [...this.#possibleEffects].sort(compare);
  }
}

export function createPackageBuildAuthorizationReport(
  packageId: string,
  source: PackageBuildAuthorizationSource,
  context: BeforePackageBuildContext
): PackageBuildAuthorizationReport {
  assertBoundContext(packageId, context);
  const manifest = context.manifestSnapshot.manifest;
  return {
    packageId,
    source: source.type === 'remoteGit' ? { ...source } : { ...source },
    candidateRoot: context.rootIdentity.root,
    cwd: context.rootIdentity.root,
    argv: [...manifest.build],
    manifest: { path: PACKAGE_MANIFEST, sha256: context.manifestSnapshot.contentSha256 },
    artifactRoot: manifest.artifactRoot,
    skillsRoot: manifest.skillsRoot,
    shell: false,
    environment: { inherited: true, namesAndValuesExposed: false },
    authority: {
      sandboxed: false,
      user: 'current-process-user',
      access: ['credentials', 'network', 'user-files']
    },
    warning: 'Package build side effects are not rollbackable.'
  };
}

export function sameAuthorizedPackageInputs(
  packageId: string,
  expectedRoot: { root: string; device: bigint; inode: bigint },
  expectedManifest: PackageManifestSnapshot,
  context: BeforePackageBuildContext
): boolean {
  return context.packageId === packageId
    && context.rootIdentity.root === expectedRoot.root
    && context.rootIdentity.device === expectedRoot.device
    && context.rootIdentity.inode === expectedRoot.inode
    && context.manifestSnapshot.path === expectedManifest.path
    && context.manifestSnapshot.device === expectedManifest.device
    && context.manifestSnapshot.inode === expectedManifest.inode
    && context.manifestSnapshot.contentSha256 === expectedManifest.contentSha256;
}

export function copyPackageBuildReport(report: PackageBuildAuthorizationReport): PackageBuildAuthorizationReport {
  return copyReport(report);
}

function assertBoundContext(packageId: string, context: BeforePackageBuildContext): void {
  if (context.packageId !== packageId) {
    throw new BazframeError('PROFILE_IMPORT_PACKAGE_CHANGED', `Package build identity changed for ${packageId}.`);
  }
}

function freezeReport(report: PackageBuildAuthorizationReport): PackageBuildAuthorizationReport {
  const copy = copyReport(report);
  Object.freeze(copy.argv);
  Object.freeze(copy.source);
  Object.freeze(copy.manifest);
  Object.freeze(copy.environment);
  Object.freeze(copy.authority.access);
  Object.freeze(copy.authority);
  return Object.freeze(copy);
}

function copyReport(report: PackageBuildAuthorizationReport): PackageBuildAuthorizationReport {
  return {
    packageId: report.packageId,
    source: report.source.type === 'remoteGit' ? { ...report.source } : { ...report.source },
    candidateRoot: report.candidateRoot,
    cwd: report.cwd,
    argv: [...report.argv],
    manifest: { ...report.manifest },
    artifactRoot: report.artifactRoot,
    skillsRoot: report.skillsRoot,
    shell: false,
    environment: { inherited: true, namesAndValuesExposed: false },
    authority: {
      sandboxed: false,
      user: 'current-process-user',
      access: ['credentials', 'network', 'user-files']
    },
    warning: 'Package build side effects are not rollbackable.'
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
