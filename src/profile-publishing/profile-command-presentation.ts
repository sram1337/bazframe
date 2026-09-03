import { types as utilTypes } from 'node:util';
import { BazframeError } from '../core/errors.js';
import { boundedTextForDisplay } from '../core/safe-text.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { isSafeSkillId } from '../skills/skill-id.js';
import { canonicalProfileGitHubOrigin } from '../providers/managed-git-source.js';
import type { CapturedResourceKey, ResourceKind, Sha256 } from './captured-profile.js';
import type { ProfileDomainView } from './profile-view.js';
import { noProfileLifecycleMutationEffects, type ProfileLifecycleMutationEffects } from './profile-lifecycle-effects.js';

export type JsonScalar = string | number | boolean | null;
export type JsonDetailsV2 = Record<string, JsonScalar | JsonScalar[]>;
export interface JsonDiagnosticV2 { level: 'warning' | 'info'; code: string; message: string }
export interface JsonMissingResourceV2 { kind: ResourceKind; name: string; code: string }
export interface JsonPublicationV2 { repository: string; installedCommit: string; latestSeenCommit: string; visibility: 'private' | 'public' }
export interface JsonProfileStateV2 { name: string; active: boolean; completeness: 'complete' | 'incomplete'; missingResources: JsonMissingResourceV2[]; publication: JsonPublicationV2 | null }
export interface JsonCapturedFileV2 { logicalPath: string; resourceKind: ResourceKind | 'profile'; resourceName: string | null; bytes: number; sha256: Sha256; executable: boolean }
export type JsonMutationEffectsV2 = ProfileLifecycleMutationEffects;
export interface JsonResourceKeyV2 { kind: ResourceKind; name: string }
export interface JsonVersionV2 { commit: string; current: boolean; latest: boolean }

export interface JsonProfileExportResultV2 { profile: JsonProfileStateV2; output: string; captureSha256: Sha256; files: JsonCapturedFileV2[]; overwritten: boolean }
export interface JsonProfilePublishResultV2 { profile: JsonProfileStateV2; repository: string; commit: string; visibility: 'private' | 'public'; captureSha256: Sha256; files: JsonCapturedFileV2[] }
export interface JsonProfileImportResultV2 { mode: 'executed' | 'dry-run'; source: { kind: 'zip' } | { kind: 'git'; repository: string; resolvedCommit: string }; requestedName: string; resolvedName: string; collisionResolution: 'none' | 'safe-suffix' | 'overwrite'; profile: JsonProfileStateV2 | null; effects: JsonMutationEffectsV2 }
export interface JsonProfileUpdateResultV2 { profile: JsonProfileStateV2; previousCommit: string; currentCommit: string; movedToNewCommit: boolean; repairedResources: JsonResourceKeyV2[] }
export interface JsonProfileVersionListResultV2 { profile: string; currentCommit: string; latestCommit: string; versions: JsonVersionV2[] }
export interface JsonProfileVersionUseResultV2 { profile: JsonProfileStateV2; previousCommit: string; currentCommit: string }

export type JsonConfirmationV2 = 'publish-preview' | 'public-visibility' | 'package-build';
export type JsonRefusalInteractionV2 =
  | { kind: 'none' }
  | { kind: 'confirmation-required'; confirmations: JsonConfirmationV2[]; acceptedBy: '--yes' }
  | { kind: 'overwrite-required'; operation: 'replace-profile' | 'discard-local-changes' | 'replace-output'; acceptedBy: '--overwrite' }
  | { kind: 'collision-choice-required'; suggestedName: string; safeDefaultAcceptedBy: '--yes'; replacementAcceptedBy: '--overwrite' };
export interface JsonRefusalV2 { code: string; message: string; interaction: JsonRefusalInteractionV2; details?: JsonDetailsV2 }
export interface JsonErrorV2 { category: 'usage' | 'authentication' | 'network' | 'integrity' | 'operational' | 'internal'; code: string; message: string; details?: JsonDetailsV2 }
export type LifecycleCommandV2 = 'profile.export' | 'profile.publish' | 'profile.import' | 'profile.update' | 'profile.version.list' | 'profile.version.use';
export interface LifecycleResultByCommandV2 {
  'profile.export': JsonProfileExportResultV2;
  'profile.publish': JsonProfilePublishResultV2;
  'profile.import': JsonProfileImportResultV2;
  'profile.update': JsonProfileUpdateResultV2;
  'profile.version.list': JsonProfileVersionListResultV2;
  'profile.version.use': JsonProfileVersionUseResultV2;
}
export type JsonLifecycleV2<T = unknown> =
  | { schemaVersion: 2; command: LifecycleCommandV2; outcome: 'success'; result: T; diagnostics: JsonDiagnosticV2[] }
  | { schemaVersion: 2; command: LifecycleCommandV2; outcome: 'refusal'; refusal: JsonRefusalV2; diagnostics: JsonDiagnosticV2[] }
  | { schemaVersion: 2; command: LifecycleCommandV2; outcome: 'error'; error: JsonErrorV2; diagnostics: JsonDiagnosticV2[] };

export interface JsonProfileStateV1OptionalExtension { completeness?: 'complete' | 'incomplete'; missingResources?: JsonMissingResourceV2[]; publication?: JsonPublicationV2 }

const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DETAIL_KEY = /^[a-z][A-Za-z0-9]{0,63}$/u;
const KIND_ORDER: readonly ResourceKind[] = ['skill', 'library', 'package'];
const CONFIRMATION_ORDER: readonly JsonConfirmationV2[] = ['publish-preview', 'public-visibility', 'package-build'];
const ALLOWED_CODES = new Set([
  'CAPTURED_PROFILE_INVALID', 'CLI_USAGE', 'OFFLINE', 'PROFILE_ARTIFACT_TREE_ABSENT', 'PROFILE_ARTIFACT_TREE_INVALID',
  'PROFILE_ARTIFACT_TREE_OCCUPIED', 'PROFILE_AUTHENTICATION_REQUIRED', 'PROFILE_BLOB_ABSENT', 'PROFILE_BLOB_INVALID',
  'PROFILE_CAPTURE_CHANGED', 'PROFILE_CAPTURE_INVALID', 'PROFILE_CONFIRMATION_REQUIRED', 'PROFILE_GIT_ADAPTER_REQUIRED', 'PROFILE_INTERNAL_ERROR',
  'PROFILE_GITHUB_AUTH_REQUIRED', 'PROFILE_GITHUB_COMMIT_AMBIGUOUS', 'PROFILE_GITHUB_COMMIT_UNREACHABLE',
  'PROFILE_GITHUB_CREATION_PROOF_REQUIRED', 'PROFILE_GITHUB_CREATION_PROOF_STALE', 'PROFILE_GITHUB_CREATE_UNPROVEN', 'PROFILE_GITHUB_CLI_MISSING', 'PROFILE_GITHUB_GIT_INVALID', 'PROFILE_GITHUB_GIT_OBJECT_LIMIT',
  'PROFILE_GITHUB_METADATA_CHANGED', 'PROFILE_GITHUB_METADATA_INVALID', 'PROFILE_GITHUB_OUTPUT_INVALID', 'PROFILE_GITHUB_OUTPUT_LIMIT', 'PROFILE_GITHUB_OWNER_REFUSED', 'PROFILE_GITHUB_PUSH_UNPROVEN', 'PROFILE_GITHUB_VISIBILITY_UNPROVEN',
  'PROFILE_GITHUB_LEASE_STALE', 'PROFILE_GITHUB_MAIN_UNAVAILABLE', 'PROFILE_GITHUB_NETWORK_FAILED',
  'PROFILE_GITHUB_SOURCE_INVALID', 'PROFILE_IMPORT_ALREADY_LINKED', 'PROFILE_IMPORT_CANCELLED',
  'PROFILE_IMPORT_COLLISION_DECISION_REQUIRED', 'PROFILE_IMPORT_DANGLING_ACTIVE', 'PROFILE_IMPORT_DESTINATION_OCCUPIED',
  'PROFILE_INCOMPLETE', 'PROFILE_INTEGRITY_FAILED', 'PROFILE_LIFECYCLE_CHANGED', 'PROFILE_LIFECYCLE_INVALID',
  'PROFILE_LOCAL_DIVERGENCE', 'PROFILE_MATERIALIZATION_CHANGED', 'PROFILE_MATERIALIZATION_INVALID',
  'PROFILE_MUTATION_WOULD_WORSEN', 'PROFILE_NETWORK_FAILED', 'PROFILE_NOT_FOUND', 'PROFILE_NOT_PUBLISHED', 'PROFILE_OPERATION_INTERRUPTED',
  'PROFILE_PACKAGE_ARTIFACT_UNAVAILABLE', 'PROFILE_PACKAGE_BUILD_CONFIRMATION_REQUIRED', 'PROFILE_PACKAGE_PHASE_INVALID',
  'PROFILE_PHYSICAL_CLOSURE_CHANGED', 'PROFILE_PHYSICAL_CLOSURE_INVALID', 'PROFILE_PRESENTATION_INVALID',
  'PROFILE_PRESENTATION_LIMIT', 'PROFILE_PUBLICATION_CHANGED', 'PROFILE_PUBLICATION_INVALID',
  'PROFILE_PUBLICATION_STATE_INVALID', 'PROFILE_PUBLISH_CONFIRMATION_REQUIRED', 'PROFILE_PUBLISH_INCOMPLETE',
  'PROFILE_READY', 'PROFILE_RECOVERY_AMBIGUOUS', 'PROFILE_RECOVERY_REMOTE_REF_ABSENT', 'PROFILE_REMOTE_RESOURCE_UNAVAILABLE', 'PROFILE_REMOTE_STALE',
  'PROFILE_REPOSITORY_MISSING', 'PROFILE_REPOSITORY_UNLINKED_EXISTS', 'PROFILE_RESOURCE_SELECTOR_INVALID',
  'PROFILE_STATE_MIGRATION_CONFLICT', 'PROFILE_STATE_MIGRATION_INVALID', 'PROFILE_TRANSACTION_CHANGED', 'PROFILE_TRANSACTION_CROSS_DEVICE',
  'PROFILE_OPERATION_LOCK_BUSY', 'PROFILE_OPERATION_LOCK_FAILED', 'PROFILE_OPERATION_LOCK_INVALID', 'PROFILE_OPERATION_LOCK_PATH_UNSUPPORTED', 'PROFILE_OPERATION_LOCK_PLATFORM_UNSUPPORTED',
  'PROFILE_REMOTE_MATERIALIZATION_CLEANUP_UNPROVEN', 'PROFILE_REMOTE_MATERIALIZATION_RECOVERY_REQUIRED', 'NO_ACTIVE_PROFILE',
  'PROFILE_TRANSACTION_INVALID', 'PROFILE_VERSION_NOT_LATEST', 'PROFILE_VIEW_CHANGED', 'PROFILE_VIEW_INVALID',
  'PROFILE_VIEW_LIMIT', 'PROFILE_ZIP_INVALID', 'PROFILE_ZIP_OUTPUT_OCCUPIED', 'REMOTE_MATERIALIZER_UNAVAILABLE',
  'REMOTE_UNAVAILABLE', 'WINDOWS_PLATFORM_UNSUPPORTED'
]);

export function projectProfileStateV2(profile: ProfileDomainView, active: boolean): JsonProfileStateV2 {
  if (!validDomainProfile(profile) || typeof active !== 'boolean') throw invalid('profile projection input is malformed');
  const missingResources = domainMissingResources(profile.missingResources);
  if (profile.incomplete !== (missingResources.length > 0)) throw invalid('profile completeness conflicts with missing resources');
  return {
    name: profile.name,
    active,
    completeness: profile.incomplete ? 'incomplete' : 'complete',
    missingResources,
    publication: profile.publication === null ? null : domainPublication(profile.publication)
  };
}

/** Optional fields to append, in returned key order, to existing schema-v1 profile projections. */
export function projectProfileStateV1Extension(profile: ProfileDomainView): JsonProfileStateV1OptionalExtension {
  if (!validDomainProfile(profile)) throw invalid('profile projection input is malformed');
  const missingResources = domainMissingResources(profile.missingResources);
  if (profile.incomplete !== (missingResources.length > 0)) throw invalid('profile completeness conflicts with missing resources');
  const managed = profile.profileInstanceId !== null;
  if (!managed && !profile.incomplete && profile.publication === null) return {};
  return {
    completeness: profile.incomplete ? 'incomplete' : 'complete',
    missingResources,
    ...(profile.publication === null ? {} : { publication: domainPublication(profile.publication) })
  };
}

export function projectProfileExportResultV2(input: JsonProfileExportResultV2): JsonProfileExportResultV2 {
  const value = exact(input, ['profile','output','captureSha256','files','overwritten'], 'export result');
  return { profile: profileState(value.profile), output: safeRequiredString(value.output, 'output'), captureSha256: sha(value.captureSha256), files: files(value.files), overwritten: boolean(value.overwritten, 'overwritten') };
}
export function projectProfilePublishResultV2(input: JsonProfilePublishResultV2): JsonProfilePublishResultV2 {
  const value = exact(input, ['profile','repository','commit','visibility','captureSha256','files'], 'publish result');
  return { profile: profileState(value.profile), repository: repository(value.repository), commit: commit(value.commit), visibility: visibility(value.visibility), captureSha256: sha(value.captureSha256), files: files(value.files) };
}
export function projectProfileImportResultV2(input: JsonProfileImportResultV2): JsonProfileImportResultV2 {
  const value = exact(input, ['mode','source','requestedName','resolvedName','collisionResolution','profile','effects'], 'import result');
  const mode = enumValue(value.mode, ['executed','dry-run'] as const, 'mode');
  if (!plainRecord(value.source)) throw invalid('import source is malformed');
  const sourceValue = exact(value.source, value.source.kind === 'git' ? ['kind','repository','resolvedCommit'] : ['kind'], 'import source');
  const source = sourceValue.kind === 'zip'
    ? { kind: 'zip' as const }
    : sourceValue.kind === 'git'
      ? { kind: 'git' as const, repository: repository(sourceValue.repository), resolvedCommit: commit(sourceValue.resolvedCommit) }
      : (() => { throw invalid('import source kind is invalid'); })();
  const profile = value.profile === null ? null : profileState(value.profile);
  const effects = mutationEffects(value.effects);
  if (mode === 'dry-run' && (profile !== null || Object.values(effects).some(Boolean))) throw invalid('dry-run import must have null profile and false effects');
  if (mode === 'executed' && profile === null) throw invalid('executed import must include profile state');
  return { mode, source, requestedName: profileName(value.requestedName), resolvedName: profileName(value.resolvedName), collisionResolution: enumValue(value.collisionResolution, ['none','safe-suffix','overwrite'] as const, 'collision resolution'), profile, effects };
}
export function projectProfileUpdateResultV2(input: JsonProfileUpdateResultV2): JsonProfileUpdateResultV2 {
  const value = exact(input, ['profile','previousCommit','currentCommit','movedToNewCommit','repairedResources'], 'update result');
  const repairedResources = resourceKeys(value.repairedResources);
  return { profile: profileState(value.profile), previousCommit: commit(value.previousCommit), currentCommit: commit(value.currentCommit), movedToNewCommit: boolean(value.movedToNewCommit, 'movedToNewCommit'), repairedResources };
}
export function projectProfileVersionListResultV2(input: JsonProfileVersionListResultV2): JsonProfileVersionListResultV2 {
  const value = exact(input, ['profile','currentCommit','latestCommit','versions'], 'version list result');
  if (!plainArray(value.versions) || value.versions.length === 0 || value.versions.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileEntries) throw invalid('versions are invalid');
  const versions = value.versions.map((entry) => { const item = exact(entry, ['commit','current','latest'], 'version'); return { commit: commit(item.commit), current: boolean(item.current, 'current'), latest: boolean(item.latest, 'latest') }; });
  if (new Set(versions.map((entry) => entry.commit)).size !== versions.length || versions.filter((entry) => entry.current).length !== 1 || versions.filter((entry) => entry.latest).length !== 1) throw invalid('versions must contain unique commits and one current/latest entry');
  const currentCommit = commit(value.currentCommit); const latestCommit = commit(value.latestCommit);
  if (!versions.some((entry) => entry.current && entry.commit === currentCommit) || !versions.some((entry) => entry.latest && entry.commit === latestCommit)) throw invalid('version summary does not match entries');
  return { profile: profileName(value.profile), currentCommit, latestCommit, versions };
}
export function projectProfileVersionUseResultV2(input: JsonProfileVersionUseResultV2): JsonProfileVersionUseResultV2 {
  const value = exact(input, ['profile','previousCommit','currentCommit'], 'version use result');
  return { profile: profileState(value.profile), previousCommit: commit(value.previousCommit), currentCommit: commit(value.currentCommit) };
}

function projectLifecycleResult<C extends LifecycleCommandV2>(command: C, value: unknown): LifecycleResultByCommandV2[C] {
  const projected = command === 'profile.export' ? projectProfileExportResultV2(value as JsonProfileExportResultV2)
    : command === 'profile.publish' ? projectProfilePublishResultV2(value as JsonProfilePublishResultV2)
      : command === 'profile.import' ? projectProfileImportResultV2(value as JsonProfileImportResultV2)
        : command === 'profile.update' ? projectProfileUpdateResultV2(value as JsonProfileUpdateResultV2)
          : command === 'profile.version.list' ? projectProfileVersionListResultV2(value as JsonProfileVersionListResultV2)
            : projectProfileVersionUseResultV2(value as JsonProfileVersionUseResultV2);
  return projected as LifecycleResultByCommandV2[C];
}

export function dryRunMutationEffectsV2(): JsonMutationEffectsV2 {
  return noProfileLifecycleMutationEffects();
}

export function projectLifecycleSafeMessage(message: unknown): string { return safeMessage(message); }

export function jsonDiagnosticV2(level: JsonDiagnosticV2['level'], codeValue: string, message: string): JsonDiagnosticV2 {
  return { level: enumValue(level, ['warning','info'] as const, 'diagnostic level'), code: code(codeValue), message: safeMessage(message) };
}
export function jsonRefusalV2(codeValue: string, message: string, interaction: JsonRefusalInteractionV2, details?: Readonly<JsonDetailsV2>): JsonRefusalV2 {
  const copiedDetails = details === undefined ? undefined : safeDetails(details);
  return { code: code(codeValue), message: safeMessage(message), interaction: refusalInteraction(interaction), ...(copiedDetails === undefined || Object.keys(copiedDetails).length === 0 ? {} : { details: copiedDetails }) };
}
export function jsonErrorV2(category: JsonErrorV2['category'], codeValue: string, message: string, details?: Readonly<JsonDetailsV2>): JsonErrorV2 {
  const copiedDetails = details === undefined ? undefined : safeDetails(details);
  return { category: enumValue(category, ['usage','authentication','network','integrity','operational','internal'] as const, 'error category'), code: code(codeValue), message: safeMessage(message), ...(copiedDetails === undefined || Object.keys(copiedDetails).length === 0 ? {} : { details: copiedDetails }) };
}
export function lifecycleSuccessV2<C extends LifecycleCommandV2>(command: C, result: LifecycleResultByCommandV2[C], diagnostics: readonly JsonDiagnosticV2[] = []): JsonLifecycleV2<LifecycleResultByCommandV2[C]> {
  const canonicalCommand = lifecycleCommand(command) as C;
  const projected = projectLifecycleResult(canonicalCommand, result);
  return { schemaVersion: 2, command: canonicalCommand, outcome: 'success', result: projected, diagnostics: diagnosticsV2(diagnostics) };
}
export function lifecycleRefusalV2(command: LifecycleCommandV2, refusal: JsonRefusalV2, diagnostics: readonly JsonDiagnosticV2[] = []): JsonLifecycleV2<never> {
  if (!plainRecord(refusal)) throw invalid('refusal is malformed');
  const item = exact(refusal, Object.hasOwn(refusal, 'details') ? ['code','message','interaction','details'] : ['code','message','interaction'], 'refusal');
  return { schemaVersion: 2, command: lifecycleCommand(command), outcome: 'refusal', refusal: jsonRefusalV2(code(item.code), safeMessage(item.message), item.interaction as JsonRefusalInteractionV2, item.details as JsonDetailsV2 | undefined), diagnostics: diagnosticsV2(diagnostics) };
}
export function lifecycleErrorV2(command: LifecycleCommandV2, error: JsonErrorV2, diagnostics: readonly JsonDiagnosticV2[] = []): JsonLifecycleV2<never> {
  if (!plainRecord(error)) throw invalid('error is malformed');
  const item = exact(error, Object.hasOwn(error, 'details') ? ['category','code','message','details'] : ['category','code','message'], 'error');
  return { schemaVersion: 2, command: lifecycleCommand(command), outcome: 'error', error: jsonErrorV2(enumValue(item.category, ['usage','authentication','network','integrity','operational','internal'] as const, 'error category'), code(item.code), safeMessage(item.message), item.details as JsonDetailsV2 | undefined), diagnostics: diagnosticsV2(diagnostics) };
}
export function serializeLifecycleJsonV2(document: JsonLifecycleV2): string {
  if (!plainRecord(document) || document.schemaVersion !== 2) throw invalid('lifecycle document is malformed');
  const command = lifecycleCommand(document.command);
  const diagnostics = diagnosticsV2(document.diagnostics as readonly JsonDiagnosticV2[]);
  let canonical: JsonLifecycleV2;
  if (document.outcome === 'success') {
    const item = exact(document, ['schemaVersion','command','outcome','result','diagnostics'], 'success document');
    const result = projectLifecycleResult(command, item.result);
    canonical = { schemaVersion: 2, command, outcome: 'success', result, diagnostics };
  } else if (document.outcome === 'refusal') {
    const item = exact(document, ['schemaVersion','command','outcome','refusal','diagnostics'], 'refusal document');
    const refusal = exact(item.refusal, plainRecord(item.refusal) && Object.hasOwn(item.refusal, 'details') ? ['code','message','interaction','details'] : ['code','message','interaction'], 'refusal');
    canonical = { schemaVersion: 2, command, outcome: 'refusal', refusal: jsonRefusalV2(code(refusal.code), safeMessage(refusal.message), refusal.interaction as JsonRefusalInteractionV2, refusal.details as JsonDetailsV2 | undefined), diagnostics };
  } else if (document.outcome === 'error') {
    const item = exact(document, ['schemaVersion','command','outcome','error','diagnostics'], 'error document');
    const error = exact(item.error, plainRecord(item.error) && Object.hasOwn(item.error, 'details') ? ['category','code','message','details'] : ['category','code','message'], 'error');
    canonical = { schemaVersion: 2, command, outcome: 'error', error: jsonErrorV2(enumValue(error.category, ['usage','authentication','network','integrity','operational','internal'] as const, 'error category'), code(error.code), safeMessage(error.message), error.details as JsonDetailsV2 | undefined), diagnostics };
  } else throw invalid('lifecycle document outcome is invalid');
  let encoded: string;
  try { encoded = `${JSON.stringify(canonical)}\n`; } catch (error) { throw new BazframeError('PROFILE_PRESENTATION_INVALID', 'Lifecycle JSON document is not serializable.', { cause: error }); }
  if (Buffer.byteLength(encoded, 'utf8') > PROFILE_PORTABILITY_PRODUCTION_LIMITS.diagnosticReportBytes) throw new BazframeError('PROFILE_PRESENTATION_LIMIT', 'Lifecycle JSON document exceeds the bounded report limit.');
  return encoded;
}

function profileState(value: unknown): JsonProfileStateV2 {
  const item = exact(value, ['name','active','completeness','missingResources','publication'], 'profile state');
  const missingResources = missingArray(item.missingResources);
  const completeness = enumValue(item.completeness, ['complete','incomplete'] as const, 'completeness');
  if ((completeness === 'incomplete') !== (missingResources.length > 0)) throw invalid('profile completeness conflicts with missing resources');
  return { name: profileName(item.name), active: boolean(item.active, 'active'), completeness, missingResources, publication: item.publication === null ? null : publication(item.publication) };
}
function domainPublication(value: unknown): JsonPublicationV2 {
  const item = exact(value, ['transport','origin','installedCommit','latestSeenCommit','baselineCaptureSha256','visibility'], 'domain publication');
  if (item.transport !== 'git') throw invalid('domain publication transport is invalid');
  sha(item.baselineCaptureSha256);
  return { repository: repository(item.origin), installedCommit: commit(item.installedCommit), latestSeenCommit: commit(item.latestSeenCommit), visibility: visibility(item.visibility) };
}
function publication(value: unknown): JsonPublicationV2 {
  const item = exact(value, ['repository','installedCommit','latestSeenCommit','visibility'], 'publication');
  return { repository: repository(item.repository), installedCommit: commit(item.installedCommit), latestSeenCommit: commit(item.latestSeenCommit), visibility: visibility(item.visibility) };
}
function missingArray(value: unknown): JsonMissingResourceV2[] {
  if (!plainArray(value) || value.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.resources) throw invalid('missing resources are invalid');
  const result = value.map((entry) => { const item = exact(entry, ['kind','name','code'], 'missing resource'); return missingResource({ kind: enumValue(item.kind, KIND_ORDER, 'resource kind'), name: skillName(item.name) }, code(item.code)); }).sort(compareMissing);
  if (new Set(result.map((entry) => `${entry.kind}\0${entry.name}\0${entry.code}`)).size !== result.length) throw invalid('missing resources must be unique');
  return result;
}
function missingResource(key: CapturedResourceKey, codeValue: string): JsonMissingResourceV2 { const item = exact(key, ['kind','name'], 'resource key'); return { kind: enumValue(item.kind, KIND_ORDER, 'resource kind'), name: skillName(item.name), code: code(codeValue) }; }
function domainMissingResources(value: readonly unknown[]): JsonMissingResourceV2[] {
  if (value.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.resources) throw invalid('missing resources are invalid');
  const result = value.map((entry) => { const item = exact(entry, ['stableIdentity','capturedResourceId','key','diagnosticCode'], 'domain missing resource'); if (typeof item.stableIdentity !== 'string' || item.stableIdentity.length === 0) throw invalid('stable resource identity is invalid'); sha(item.capturedResourceId); return missingResource(item.key as CapturedResourceKey, code(item.diagnosticCode)); }).sort(compareMissing);
  if (new Set(result.map((entry) => `${entry.kind}\0${entry.name}\0${entry.code}`)).size !== result.length) throw invalid('missing resources must be unique');
  return result;
}
function files(value: unknown): JsonCapturedFileV2[] {
  if (!plainArray(value) || value.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) throw invalid('captured files are invalid');
  const result = value.map((entry) => { const item = exact(entry, ['logicalPath','resourceKind','resourceName','bytes','sha256','executable'], 'captured file'); const resourceKind = enumValue(item.resourceKind, ['profile',...KIND_ORDER] as const, 'captured resource kind'); const resourceName = item.resourceName === null ? null : skillName(item.resourceName); if ((resourceKind === 'profile') !== (resourceName === null)) throw invalid('captured file resource name conflicts with its kind'); return { logicalPath: logicalPath(item.logicalPath), resourceKind, resourceName, bytes: nonnegative(item.bytes, 'bytes'), sha256: sha(item.sha256), executable: boolean(item.executable, 'executable') }; });
  if (new Set(result.map((entry) => `${entry.resourceKind}\0${entry.resourceName ?? ''}\0${entry.logicalPath}`)).size !== result.length) throw invalid('captured files must be unique');
  return result;
}
function resourceKeys(value: unknown): JsonResourceKeyV2[] { if (!plainArray(value) || value.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.resources) throw invalid('resource keys are invalid'); const result = value.map((entry) => { const item = exact(entry, ['kind','name'], 'resource key'); return { kind: enumValue(item.kind, KIND_ORDER, 'resource kind'), name: skillName(item.name) }; }).sort((left,right) => kindIndex(left.kind)-kindIndex(right.kind) || compare(left.name,right.name)); if (new Set(result.map((entry) => `${entry.kind}\0${entry.name}`)).size !== result.length) throw invalid('resource keys must be unique'); return result; }
function mutationEffects(value: unknown): JsonMutationEffectsV2 { const keys = ['localStateWritten','profilePublished','cacheWritten','lockAcquired','buildExecuted','loginStarted','repositoryCreated','refUpdated','commitCreated','visibilityChanged'] as const; const item = exact(value, [...keys], 'mutation effects'); return Object.fromEntries(keys.map((key) => [key, boolean(item[key], key)])) as unknown as JsonMutationEffectsV2; }
function refusalInteraction(value: JsonRefusalInteractionV2): JsonRefusalInteractionV2 {
  if (!plainRecord(value) || typeof value.kind !== 'string') throw invalid('refusal interaction is malformed');
  if (value.kind === 'none') { exact(value, ['kind'], 'refusal interaction'); return { kind: 'none' }; }
  if (value.kind === 'confirmation-required') { const item = exact(value, ['kind','confirmations','acceptedBy'], 'confirmation interaction'); if (item.acceptedBy !== '--yes' || !plainArray(item.confirmations)) throw invalid('confirmation interaction is malformed'); const confirmations = item.confirmations.map((entry) => enumValue(entry, CONFIRMATION_ORDER, 'confirmation')).sort((a,b) => CONFIRMATION_ORDER.indexOf(a)-CONFIRMATION_ORDER.indexOf(b)); if (confirmations.length === 0 || new Set(confirmations).size !== confirmations.length) throw invalid('confirmations must be nonempty and unique'); return { kind: 'confirmation-required', confirmations, acceptedBy: '--yes' }; }
  if (value.kind === 'overwrite-required') { const item = exact(value, ['kind','operation','acceptedBy'], 'overwrite interaction'); if (item.acceptedBy !== '--overwrite') throw invalid('overwrite interaction is malformed'); return { kind: 'overwrite-required', operation: enumValue(item.operation, ['replace-profile','discard-local-changes','replace-output'] as const, 'overwrite operation'), acceptedBy: '--overwrite' }; }
  if (value.kind === 'collision-choice-required') { const item = exact(value, ['kind','suggestedName','safeDefaultAcceptedBy','replacementAcceptedBy'], 'collision interaction'); if (item.safeDefaultAcceptedBy !== '--yes' || item.replacementAcceptedBy !== '--overwrite') throw invalid('collision interaction is malformed'); return { kind: 'collision-choice-required', suggestedName: profileName(item.suggestedName), safeDefaultAcceptedBy: '--yes', replacementAcceptedBy: '--overwrite' }; }
  throw invalid('refusal interaction kind is invalid');
}
function safeDetails(value: Readonly<JsonDetailsV2>): JsonDetailsV2 { if (!plainRecord(value) || Object.keys(value).length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.resources) throw invalid('details are malformed'); const result: JsonDetailsV2 = {}; for (const key of Object.keys(value).sort()) { if (!DETAIL_KEY.test(key) || /(?:path|checkout|environment|authorization|token|secret|password|credential|apiKey|cause|stack|body|url)/iu.test(key)) throw invalid('detail key is invalid or private'); const item = value[key]; if (Array.isArray(item) && !plainArray(item)) throw invalid('detail array is malformed'); if (Array.isArray(item) && item.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileEntries) throw invalid('detail array is too large'); result[key] = Array.isArray(item) ? item.map(safeScalar) : safeScalar(item); } return result; }
function safeScalar(value: unknown): JsonScalar { if (value === null || typeof value === 'boolean') return value; if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value,-0)) return value; if (typeof value === 'string') return safeMessage(value); throw invalid('detail scalar is invalid'); }
function diagnosticsV2(values: readonly JsonDiagnosticV2[]): JsonDiagnosticV2[] { if (!plainArray(values) || values.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.resources) throw invalid('diagnostics are invalid'); return values.map((value) => { const item = exact(value, ['level','code','message'], 'diagnostic'); return { level: enumValue(item.level, ['warning','info'] as const, 'diagnostic level'), code: code(item.code), message: safeMessage(item.message) }; }); }
function safeMessage(value: unknown): string { if (typeof value !== 'string') throw invalid('message is invalid'); const redacted = value
  .replace(/\b[A-Z][A-Z0-9_]{1,63}\s*=[^\r\n]*/gu, (match) => `${match.slice(0, match.indexOf('='))}=[redacted]`)
  .replace(/\b(authorization|password|token|secret|credential|api(?:[\s_-]?key)|apikey)\b["']?\s*[:=]\s*["']?[^\r\n]*/giu, '$1=[redacted]')
  .replace(/\bBearer\s+[^\r\n]*/giu, 'Bearer [redacted]')
  .replace(/([?&][^=&\s]*(?:token|secret|password|credential|api[-_]?key|apikey)[^=&\s]*=)[^&#\s]*/giu, '$1[redacted]')
  .replace(/(https?:\/\/)[^\s/@]+@/giu, '$1[userinfo-redacted]@')
  .replace(/(^|[\s("'=:])\/(?!\/)[^\r\n]*/gmu, '$1[path redacted]')
  .replace(/(^|[\s("'=:])[A-Za-z]:\\[^\r\n]*/gmu, '$1[path redacted]'); return boundedTextForDisplay(redacted); }
function logicalPath(value: unknown): string { if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.split('/').some((part) => part === '' || part === '.' || part === '..') || Buffer.byteLength(value) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingPathBytes) throw invalid('logical path is invalid'); return value; }
function repository(value: unknown): string { if (typeof value !== 'string') throw invalid('repository is invalid'); try { const result = canonicalProfileGitHubOrigin(value); if (result !== value) throw new Error('noncanonical'); return result; } catch { throw invalid('repository is invalid'); } }
function profileName(value: unknown): string { if (typeof value !== 'string' || !isSafeProfileId(value)) throw invalid('profile name is invalid'); return value; }
function skillName(value: unknown): string { if (typeof value !== 'string' || !isSafeSkillId(value)) throw invalid('resource name is invalid'); return value; }
function code(value: unknown): string { if (typeof value !== 'string' || !CODE.test(value) || !ALLOWED_CODES.has(value)) throw invalid('code is invalid or not allowlisted'); return value; }
function commit(value: unknown): string { if (typeof value !== 'string' || !COMMIT.test(value)) throw invalid('commit is invalid'); return value; }
function sha(value: unknown): Sha256 { if (typeof value !== 'string' || !SHA.test(value)) throw invalid('SHA-256 is invalid'); return value; }
function visibility(value: unknown): 'private'|'public' { return enumValue(value, ['private','public'] as const, 'visibility'); }
function boolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw invalid(`${label} is invalid`); return value; }
function nonnegative(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0 || Object.is(value,-0)) throw invalid(`${label} is invalid`); return Number(value); }
function safeRequiredString(value: unknown, label: string): string { if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingPathBytes) throw invalid(`${label} is invalid`); return value; }
function lifecycleCommand(value: unknown): LifecycleCommandV2 { return enumValue(value, ['profile.export','profile.publish','profile.import','profile.update','profile.version.list','profile.version.use'] as const, 'command'); }
function validDomainProfile(value: unknown): value is ProfileDomainView {
  if (!plainRecord(value) || Object.keys(value).sort().join(',') !== 'incomplete,missingResources,name,profileInstanceId,publication,publicationVersionState,resourceIdentities'
    || typeof value.name !== 'string' || !isSafeProfileId(value.name)
    || (value.profileInstanceId !== null && (typeof value.profileInstanceId !== 'string' || !UUID.test(value.profileInstanceId)))
    || typeof value.incomplete !== 'boolean' || !plainArray(value.missingResources) || !plainArray(value.resourceIdentities)
    || !enumMember(value.publicationVersionState, ['unpublished','latest-installed','older-installed'])
    || (value.publication !== null && !plainRecord(value.publication))
    || (value.profileInstanceId === null && (value.publication !== null || value.incomplete || value.missingResources.length !== 0))) return false;
  if (value.publication === null) return value.publicationVersionState === 'unpublished';
  if (value.publicationVersionState === 'unpublished') return false;
  return value.publicationVersionState === (value.publication.installedCommit === value.publication.latestSeenCommit ? 'latest-installed' : 'older-installed');
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { if (!plainRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value,key))) throw invalid(`${label} is malformed`); return value; }
function plainRecord(value: unknown): value is Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false; const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) return false; return Reflect.ownKeys(value).every((key) => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!, 'value') && Object.getOwnPropertyDescriptor(value,key)!.enumerable === true); }
function plainArray(value: unknown): value is unknown[] { if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false; const descriptors = Object.getOwnPropertyDescriptors(value); for (let index=0;index<value.length;index+=1) { const descriptor=descriptors[String(index)]; if (descriptor===undefined || !Object.hasOwn(descriptor,'value') || descriptor.enumerable!==true) return false; } return true; }
function enumMember<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === 'string' && values.includes(value as T); }
function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T { if (typeof value !== 'string' || !values.includes(value as T)) throw invalid(`${label} is invalid`); return value as T; }
function compareMissing(left: JsonMissingResourceV2,right: JsonMissingResourceV2): number { return kindIndex(left.kind)-kindIndex(right.kind) || compare(left.name,right.name) || compare(left.code,right.code); }
function kindIndex(kind: ResourceKind): number { return KIND_ORDER.indexOf(kind); }
function compare(left:string,right:string):number{return left<right?-1:left>right?1:0;}
function invalid(detail:string):BazframeError{return new BazframeError('PROFILE_PRESENTATION_INVALID',`Invalid profile command presentation: ${detail}.`);}
