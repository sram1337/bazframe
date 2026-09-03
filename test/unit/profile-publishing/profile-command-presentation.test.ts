import { describe, expect, it } from 'vitest';
import type { ProfileDomainView } from '../../../src/profile-publishing/profile-view.js';
import {
  dryRunMutationEffectsV2,
  jsonDiagnosticV2,
  jsonErrorV2,
  jsonRefusalV2,
  lifecycleErrorV2,
  lifecycleRefusalV2,
  lifecycleSuccessV2,
  projectProfileExportResultV2,
  projectProfileImportResultV2,
  projectProfilePublishResultV2,
  projectProfileStateV1Extension,
  projectProfileStateV2,
  projectProfileUpdateResultV2,
  projectProfileVersionListResultV2,
  projectProfileVersionUseResultV2,
  serializeLifecycleJsonV2,
  type JsonCapturedFileV2,
  type JsonMutationEffectsV2
} from '../../../src/profile-publishing/profile-command-presentation.js';

const current = 'a'.repeat(40);
const latest = 'b'.repeat(40);
const capture = 'c'.repeat(64);

function domain(managed = true, incomplete = true): ProfileDomainView {
  return {
    name: 'work',
    profileInstanceId: managed ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null,
    publication: managed ? { transport: 'git', origin: 'github.com/owner/work', installedCommit: current, latestSeenCommit: latest, baselineCaptureSha256: capture, visibility: 'private' } : null,
    publicationVersionState: managed ? 'older-installed' : 'unpublished',
    incomplete,
    missingResources: incomplete ? [
      { stableIdentity: 'imported:z', capturedResourceId: 'd'.repeat(64), key: { kind: 'package', name: 'builder' }, diagnosticCode: 'OFFLINE' },
      { stableIdentity: 'imported:a', capturedResourceId: 'e'.repeat(64), key: { kind: 'skill', name: 'review' }, diagnosticCode: 'REMOTE_UNAVAILABLE' },
      { stableIdentity: 'imported:b', capturedResourceId: 'f'.repeat(64), key: { kind: 'library', name: 'shared' }, diagnosticCode: 'OFFLINE' }
    ] : [],
    resourceIdentities: []
  };
}

function profile() { return projectProfileStateV2(domain(true, false), true); }
function capturedFiles(): JsonCapturedFileV2[] {
  return [{ logicalPath: 'AGENTS.md', resourceKind: 'profile', resourceName: null, bytes: 4, sha256: capture, executable: false }];
}
function effects(overrides: Partial<JsonMutationEffectsV2> = {}): JsonMutationEffectsV2 { return { ...dryRunMutationEffectsV2(), ...overrides }; }

describe('hidden profile command presentation', () => {
  it('projects one shared profile state and sorted missing resources defensively', () => {
    const source = domain();
    const projected = projectProfileStateV2(source, true);
    expect(projected).toEqual({
      name: 'work', active: true, completeness: 'incomplete',
      missingResources: [
        { kind: 'skill', name: 'review', code: 'REMOTE_UNAVAILABLE' },
        { kind: 'library', name: 'shared', code: 'OFFLINE' },
        { kind: 'package', name: 'builder', code: 'OFFLINE' }
      ],
      publication: { repository: 'github.com/owner/work', installedCommit: current, latestSeenCommit: latest, visibility: 'private' }
    });
    projected.missingResources[0]!.name = 'changed';
    expect(source.missingResources[1]!.key.name).toBe('review');
  });

  it('preserves ordinary schema-v1 projection bytes and appends managed fields in exact order', () => {
    expect(projectProfileStateV1Extension(domain(false, false))).toEqual({});
    const extension = projectProfileStateV1Extension(domain(true, false));
    expect(Object.keys(extension)).toEqual(['completeness', 'missingResources', 'publication']);
    expect(extension).toEqual({
      completeness: 'complete', missingResources: [],
      publication: { repository: 'github.com/owner/work', installedCommit: current, latestSeenCommit: latest, visibility: 'private' }
    });
    const incomplete = projectProfileStateV1Extension({ ...domain(true, true), publication: null, publicationVersionState: 'unpublished' });
    expect(Object.keys(incomplete)).toEqual(['completeness', 'missingResources']);
  });

  it('projects all six lifecycle result DTOs from explicit authoritative facts', () => {
    const state = profile(); const files = capturedFiles();
    expect(projectProfileExportResultV2({ profile: state, output: './work.zip', captureSha256: capture, files, overwritten: false })).toMatchObject({ output: './work.zip', overwritten: false });
    expect(projectProfilePublishResultV2({ profile: state, repository: 'github.com/owner/work', commit: latest, visibility: 'public', captureSha256: capture, files })).toMatchObject({ commit: latest, visibility: 'public' });
    expect(projectProfileImportResultV2({ mode: 'executed', source: { kind: 'git', repository: 'github.com/owner/work', resolvedCommit: latest }, requestedName: 'work', resolvedName: 'work-1', collisionResolution: 'safe-suffix', profile: state, effects: effects({ localStateWritten: true, profilePublished: true, lockAcquired: true }) })).toMatchObject({ mode: 'executed', resolvedName: 'work-1' });
    expect(projectProfileUpdateResultV2({ profile: state, previousCommit: current, currentCommit: latest, movedToNewCommit: true, repairedResources: [{ kind: 'package', name: 'builder' }, { kind: 'skill', name: 'review' }] }).repairedResources.map((item) => item.kind)).toEqual(['skill','package']);
    expect(projectProfileVersionListResultV2({ profile: 'work', currentCommit: current, latestCommit: latest, versions: [{ commit: latest, current: false, latest: true }, { commit: current, current: true, latest: false }] }).versions).toHaveLength(2);
    expect(projectProfileVersionUseResultV2({ profile: state, previousCommit: current, currentCommit: latest })).toMatchObject({ previousCommit: current, currentCommit: latest });
  });

  it('enforces mutation-free dry-run import facts', () => {
    const projected = projectProfileImportResultV2({ mode: 'dry-run', source: { kind: 'zip' }, requestedName: 'work', resolvedName: 'work', collisionResolution: 'none', profile: null, effects: dryRunMutationEffectsV2() });
    expect(Object.values(projected.effects)).toEqual(Array(10).fill(false));
    expect(() => projectProfileImportResultV2({ ...projected, effects: effects({ lockAcquired: true }) })).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_INVALID' }));
    expect(() => projectProfileImportResultV2({ ...projected, profile: profile() })).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_INVALID' }));
  });

  it('constructs canonical refusal/error envelopes and sanitizes diagnostics', () => {
    const diagnostic = jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', 'token=secret\u001b[31m Authorization:abc');
    expect(diagnostic.message).not.toContain('secret');
    expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', "TOKEN='alpha beta'").message).toBe('TOKEN=[redacted]');
    expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', 'Authorization: Bearer HIGH_RISK_SECRET').message).toBe('Authorization=[redacted]');
    expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', 'https://HIGH_RISK_SECRET@github.com/owner/repo').message).not.toContain('HIGH_RISK_SECRET');
    expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', 'https://example.test/path?access_token=HIGH_RISK_SECRET&ok=yes').message).not.toContain('HIGH_RISK_SECRET');
    expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', 'https://example.test/path?client_secret=HIGH_RISK_SECRET').message).not.toContain('HIGH_RISK_SECRET');
    for (const key of ['api key', 'api-key', 'api_key', 'apikey', 'x-api-key']) {
      expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', `https://example.test/path?${key}=HIGH_RISK_SECRET`).message).not.toContain('HIGH_RISK_SECRET');
      expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', `${key}: HIGH_RISK_SECRET`).message).not.toContain('HIGH_RISK_SECRET');
    }
    expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', '{"api_key":"HIGH_RISK_SECRET"}').message).not.toContain('HIGH_RISK_SECRET');
    expect(() => jsonErrorV2('operational','PROFILE_LIFECYCLE_CHANGED','Changed.',{ apiKey: 'HIGH_RISK_SECRET' })).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_INVALID' }));
    expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', "checkout '/private/tmp/my work'\nthen continue").message).toBe("checkout '[path redacted]\\u000athen continue");
    expect(jsonDiagnosticV2('warning', 'REMOTE_UNAVAILABLE', 'checkout "C:\\Temp\\my work"\nthen continue').message).toBe('checkout "[path redacted]\\u000athen continue');
    expect(diagnostic.message).not.toContain('\u001b');
    expect(diagnostic.message).toContain('[redacted]');
    const refusal = jsonRefusalV2('PROFILE_CONFIRMATION_REQUIRED', 'Review required.', { kind: 'confirmation-required', confirmations: ['public-visibility','publish-preview'], acceptedBy: '--yes' }, { suggestedName: 'work-1' });
    expect(refusal.interaction).toEqual({ kind: 'confirmation-required', confirmations: ['publish-preview','public-visibility'], acceptedBy: '--yes' });
    const refusalEnvelope = lifecycleRefusalV2('profile.publish', refusal, [diagnostic]);
    expect(Object.keys(refusalEnvelope)).toEqual(['schemaVersion','command','outcome','refusal','diagnostics']);
    const error = jsonErrorV2('network', 'PROFILE_NETWORK_FAILED', 'Bearer top-secret', { repository: 'github.com/owner/work' });
    expect(error.message).toBe('Bearer [redacted]');
    expect(jsonDiagnosticV2('info', 'PROFILE_READY', 'checkout /private/tmp/work')).toMatchObject({ message: 'checkout [path redacted]' });
    expect(jsonDiagnosticV2('info', 'PROFILE_READY', 'HOME=/Users/alice GH_TOKEN=supersecret C:\\Temp\\work').message).not.toMatch(/alice|supersecret|Temp/u);
    expect(() => jsonErrorV2('network', 'PROFILE_NETWORK_FAILED', 'Safe.', { checkoutPath: '/private/work' } as never)).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_INVALID' }));
    expect(jsonErrorV2('network', 'PROFILE_NETWORK_FAILED', 'Safe.', {})).not.toHaveProperty('details');
    expect(lifecycleErrorV2('profile.update', error)).toMatchObject({ schemaVersion: 2, outcome: 'error' });
  });

  it('serializes exactly one bounded newline-terminated document and validates success by command', () => {
    const result = { profile: profile(), output: './work.zip', captureSha256: capture, files: capturedFiles(), overwritten: false };
    const document = lifecycleSuccessV2('profile.export', result, [jsonDiagnosticV2('info','PROFILE_READY','Ready.')]);
    result.output = './changed.zip';
    const encoded = serializeLifecycleJsonV2(document);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.slice(0,-1)).not.toContain('\n');
    expect(JSON.parse(encoded).result.output).toBe('./work.zip');
    const reordered = { diagnostics: [], result: { profile: profile(), output: './work.zip', captureSha256: capture, files: capturedFiles(), overwritten: false }, outcome: 'success', command: 'profile.export', schemaVersion: 2 } as never;
    expect(Object.keys(JSON.parse(serializeLifecycleJsonV2(reordered)))).toEqual(['schemaVersion','command','outcome','result','diagnostics']);
    expect(() => serializeLifecycleJsonV2({ schemaVersion: 2, command: 'profile.export', outcome: 'success', result: { token: 'secret' }, diagnostics: [] } as never)).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_INVALID' }));
    const manyFiles = Array.from({ length: 7000 }, (_, index) => ({ ...capturedFiles()[0]!, logicalPath: `files/${index}` }));
    expect(() => lifecycleSuccessV2('profile.export', { profile: profile(), output: './work.zip', captureSha256: capture, files: manyFiles, overwritten: false })).not.toThrow();
    expect(() => serializeLifecycleJsonV2(lifecycleSuccessV2('profile.export', { profile: profile(), output: './work.zip', captureSha256: capture, files: manyFiles, overwritten: false }))).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_LIMIT' }));
  });

  it('rejects malformed and privacy-unsafe projector inputs without leaking arbitrary errors', () => {
    expect(() => projectProfileStateV2(new Proxy(domain(), {}) as never, true)).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_INVALID' }));
    expect(() => projectProfilePublishResultV2({ profile: profile(), repository: 'https://user:secret@github.com/owner/work', commit: latest, visibility: 'public', captureSha256: capture, files: capturedFiles() })).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_INVALID' }));
    expect(() => jsonErrorV2('internal', 'bad-code', 'raw')).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_INVALID' }));
    expect(() => projectProfileExportResultV2({ profile: profile(), output: './x', captureSha256: capture, files: [{ ...capturedFiles()[0]!, logicalPath: '../secret' }], overwritten: false })).toThrow(expect.objectContaining({ code: 'PROFILE_PRESENTATION_INVALID' }));
  });
});
