import { describe, expect, it } from 'vitest';
import {
  assertStage1ProfileArtifactCapabilities,
  assertStage2ProfileArtifactCapabilities,
  assertStage3ProfileArtifactCapabilities,
  decodeProfileArtifactBytes,
  decodeProfileArtifactObject,
  encodeProfileArtifact,
  type ProfileArtifact,
  type ProfileArtifactLimitPolicy,
  type ProfileArtifactResource
} from '../../../src/profile-portability/profile-artifact.js';

function remoteGitSource(id: string) {
  return {
    type: 'remoteGit' as const,
    remote: `example.test/team/${id}`,
    fetchUrl: `https://example.test/team/${id}.git`,
    branch: 'main',
    revision: 'a'.repeat(40)
  };
}

function packageResource(
  source: ReturnType<typeof remoteGitSource> | { type: 'localMapping' }
): ProfileArtifactResource {
  return source.type === 'remoteGit'
    ? { kind: 'package', id: 'automation', source }
    : { kind: 'package', id: 'automation', source };
}

function remoteGitFixture(): ProfileArtifact {
  return {
    schemaVersion: 1,
    kind: 'bazframe-profile-export',
    profile: {
      id: 'focused',
      instructions: {
        path: 'profile/AGENTS.md',
        sha256: 'b'.repeat(64)
      },
      skills: ['review-tools'],
      omittedLocalSkills: ['workstation-helper'],
      libraries: ['toolkit'],
      packages: []
    },
    resources: [
      { kind: 'skill', id: 'review-tools', source: remoteGitSource('review-tools') },
      { kind: 'library', id: 'toolkit', source: remoteGitSource('toolkit') }
    ]
  };
}

function clone(value: ProfileArtifact): ProfileArtifact {
  return structuredClone(value);
}

function profileEntryCount(value: ProfileArtifact): number {
  return value.profile.skills.length
    + value.profile.omittedLocalSkills.length
    + value.profile.libraries.length
    + value.profile.packages.length;
}

// These policies are intentionally derived from each test fixture. They are not product defaults.
function testPolicyFor(value: ProfileArtifact): ProfileArtifactLimitPolicy {
  const fixtureBytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const fixtureEntries = profileEntryCount(value);
  return {
    maxManifestBytes: fixtureBytes * 4,
    maxProfileEntries: fixtureEntries + 8,
    maxResources: value.resources.length + 8
  };
}

function decode(value: ProfileArtifact): ProfileArtifact {
  return decodeProfileArtifactObject(value, testPolicyFor(value));
}

describe('profile artifact object codec', () => {
  it('canonically round-trips remote Git direct Skills and libraries', () => {
    const fixture = remoteGitFixture();
    const policy = testPolicyFor(fixture);
    const encoded = encodeProfileArtifact(fixture, policy);

    expect(decodeProfileArtifactObject(JSON.parse(encoded), policy)).toEqual(fixture);
    expect(encodeProfileArtifact(decodeProfileArtifactObject(fixture, policy), policy)).toBe(encoded);
    expect(() => assertStage1ProfileArtifactCapabilities(decode(fixture))).not.toThrow();
  });

  it('requires omittedLocalSkills, accepts it empty, and requires sorted unique omissions', () => {
    const fixture = remoteGitFixture();
    const empty = clone(fixture);
    empty.profile.omittedLocalSkills = [];
    expect(decode(empty).profile.omittedLocalSkills).toEqual([]);
    expect(decode(fixture).profile.omittedLocalSkills).toEqual(['workstation-helper']);

    const missing = clone(fixture) as unknown as Record<string, unknown>;
    delete (missing.profile as Record<string, unknown>).omittedLocalSkills;
    expect(() => decodeProfileArtifactObject(missing, testPolicyFor(fixture))).toThrow(/exactly/u);
    for (const omittedLocalSkills of [
      ['z-local', 'a-local'],
      ['local-helper', 'local-helper']
    ]) {
      const invalid = clone(fixture);
      invalid.profile.omittedLocalSkills = omittedLocalSkills;
      expect(() => decode(invalid)).toThrow(/lexical order/u);
    }
  });

  it('encodes fixed key order with two spaces and exactly one trailing LF', () => {
    const fixture = remoteGitFixture();
    const encoded = encodeProfileArtifact(fixture, testPolicyFor(fixture));
    expect(encoded).toBe(`${JSON.stringify(fixture, null, 2)}\n`);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.endsWith('\n\n')).toBe(false);
    expect(encoded.indexOf('"schemaVersion"')).toBeLessThan(encoded.indexOf('"kind"'));
    expect(encoded.indexOf('"skills"')).toBeLessThan(encoded.indexOf('"omittedLocalSkills"'));
  });

  it('rejects unknown keys and malformed instruction digests, paths, and IDs', () => {
    const fixture = remoteGitFixture();
    const policy = testPolicyFor(fixture);
    expect(() => decodeProfileArtifactObject({ ...fixture, unknown: true }, policy)).toThrow(/exactly/u);

    const unknownProfile = clone(fixture) as unknown as { profile: Record<string, unknown> };
    unknownProfile.profile.unknown = true;
    expect(() => decodeProfileArtifactObject(unknownProfile, policy)).toThrow(/exactly/u);

    const unknownInstructions = clone(fixture) as unknown as { profile: { instructions: Record<string, unknown> } };
    unknownInstructions.profile.instructions.unknown = true;
    expect(() => decodeProfileArtifactObject(unknownInstructions, policy)).toThrow(/exactly/u);

    const unknownResource = clone(fixture) as unknown as { resources: Record<string, unknown>[] };
    unknownResource.resources[0]!.unknown = true;
    expect(() => decodeProfileArtifactObject(unknownResource, policy)).toThrow(/exactly/u);

    const badDigest = clone(fixture);
    badDigest.profile.instructions.sha256 = 'B'.repeat(64);
    expect(() => decode(badDigest)).toThrow(/sha256/u);
    const badPath = clone(fixture);
    badPath.profile.instructions.path = '../AGENTS.md' as 'profile/AGENTS.md';
    expect(() => decode(badPath)).toThrow(/instruction path/u);
    const badProfile = clone(fixture);
    badProfile.profile.id = '../focused';
    expect(() => decode(badProfile)).toThrow(/profile id/u);
    const badSkill = clone(fixture);
    badSkill.profile.skills = ['Bad_Skill'];
    expect(() => decode(badSkill)).toThrow(/invalid ID/u);
  });

  it('rejects duplicate, unsorted, overlapping, missing, and orphan closure entries', () => {
    const fixture = remoteGitFixture();
    const duplicate = clone(fixture);
    duplicate.profile.skills = ['review-tools', 'review-tools'];
    expect(() => decode(duplicate)).toThrow(/lexical order/u);

    const unsorted = clone(fixture);
    unsorted.profile.skills = ['z-skill', 'a-skill'];
    expect(() => decode(unsorted)).toThrow(/lexical order/u);

    const overlap = clone(fixture);
    overlap.profile.omittedLocalSkills = ['review-tools'];
    expect(() => decode(overlap)).toThrow(/disjoint/u);

    const matchingOmissionResource = clone(fixture);
    matchingOmissionResource.profile.omittedLocalSkills = ['review-tools'];
    matchingOmissionResource.profile.skills = [];
    expect(() => decode(matchingOmissionResource)).toThrow(/must not have matching resources/u);

    const missing = clone(fixture);
    missing.resources = missing.resources.slice(1);
    expect(() => decode(missing)).toThrow(/exactly match/u);

    const orphan = clone(fixture);
    orphan.resources.push({ kind: 'library', id: 'unused', source: remoteGitSource('unused') });
    expect(() => decode(orphan)).toThrow(/ordered|exactly match/u);

    const duplicateResource = clone(fixture);
    duplicateResource.resources.splice(1, 0, clone(fixture).resources[0]!);
    expect(() => decode(duplicateResource)).toThrow(/unique and ordered/u);

    const wrongOrder = clone(fixture);
    wrongOrder.resources.reverse();
    expect(() => decode(wrongOrder)).toThrow(/unique and ordered/u);
  });

  it('rejects mismatched remote Git identity and path, transport, or unknown source leakage', () => {
    const fixture = remoteGitFixture();
    const mismatched = clone(fixture);
    const source = mismatched.resources[0]!.source as ReturnType<typeof remoteGitSource>;
    source.remote = 'elsewhere.test/team/review-tools';
    expect(() => decode(mismatched)).toThrow(/remote Git source identity/u);

    for (const fetchUrl of [
      'https://example.test/team/other.git',
      'https://user:secret@example.test/team/review-tools.git',
      'https://example.test/team/review-tools.git?ref=main',
      'https://example.test/team/review%2Dtools.git'
    ]) {
      const hostile = clone(fixture);
      (hostile.resources[0]!.source as ReturnType<typeof remoteGitSource>).fetchUrl = fetchUrl;
      expect(() => decode(hostile)).toThrow(/remote Git source identity/u);
    }
    const sha256 = clone(fixture);
    (sha256.resources[0]!.source as ReturnType<typeof remoteGitSource>).revision = 'b'.repeat(64);
    expect(decode(sha256).resources[0]!.source).toMatchObject({ revision: 'b'.repeat(64) });
    for (const length of [39, 41, 63, 65]) {
      const malformedRevision = clone(fixture);
      (malformedRevision.resources[0]!.source as ReturnType<typeof remoteGitSource>).revision = 'a'.repeat(length);
      expect(() => decode(malformedRevision)).toThrow(/remote Git source identity/u);
    }
    for (const branch of ['HEAD', 'head', 'Head']) {
      const pseudoBranch = clone(fixture);
      (pseudoBranch.resources[0]!.source as ReturnType<typeof remoteGitSource>).branch = branch;
      expect(() => decode(pseudoBranch)).toThrow(/remote Git source identity/u);
    }

    const githubCase = clone(fixture);
    githubCase.resources[0]!.source = {
      ...remoteGitSource('review-tools'),
      remote: 'github.com/example/review-tools',
      fetchUrl: 'https://github.com/Example/Review-Tools.git'
    };
    expect(() => decode(githubCase)).toThrow(/remote Git source identity/u);

    for (const extra of [
      { root: '/tmp/review-tools' },
      { transport: 'git' },
      { token: 'secret' }
    ]) {
      const leaked = clone(fixture);
      Object.assign(leaked.resources[0]!.source, extra);
      expect(() => decode(leaked)).toThrow(/exactly/u);
    }
  });

  it('rejects unknown source types', () => {
    const fixture = remoteGitFixture() as unknown as {
      resources: Array<{ source: Record<string, unknown> }>;
    };
    fixture.resources[0]!.source.type = 'unknown';
    expect(() => decodeProfileArtifactObject(fixture, testPolicyFor(fixture as unknown as ProfileArtifact)))
      .toThrow(/source type is invalid/u);
  });

  it('canonically round-trips schema-v1 local libraries and both package source variants', () => {
    const localLibrary = remoteGitFixture();
    localLibrary.resources[1]!.source = { type: 'localMapping' };
    expect(decode(localLibrary).resources[1]!.source).toEqual({ type: 'localMapping' });

    for (const packageSource of [remoteGitSource('automation'), { type: 'localMapping' as const }]) {
      const withPackage = remoteGitFixture();
      withPackage.profile.packages = ['automation'];
      withPackage.resources.push(packageResource(packageSource));
      const policy = testPolicyFor(withPackage);
      const encoded = encodeProfileArtifact(withPackage, policy);
      expect(JSON.parse(encoded)).toMatchObject({ schemaVersion: 1 });
      expect(decodeProfileArtifactBytes(Buffer.from(encoded), policy)).toEqual(withPackage);
      expect(() => assertStage3ProfileArtifactCapabilities(decode(withPackage))).not.toThrow();
    }
  });

  it('universally rejects local direct-Skill resources and makes them unrepresentable', () => {
    const fixture = remoteGitFixture();
    fixture.resources[0]!.source = { type: 'localMapping' };
    expect(() => decode(fixture)).toThrow(/not portable/u);

    // @ts-expect-error Local direct Skills are excluded from the compile-time artifact resource union.
    const impossible: ProfileArtifactResource = { kind: 'skill', id: 'alpha', source: { type: 'localMapping' } };
    expect(impossible.source.type).toBe('localMapping');
  });

  it('refuses local libraries and every package variant at the Stage 1 capability guard', () => {
    const localLibrary = remoteGitFixture();
    localLibrary.resources[1]!.source = { type: 'localMapping' };
    expect(() => assertStage1ProfileArtifactCapabilities(decode(localLibrary))).toThrow(/local mappings/u);

    for (const packageSource of [remoteGitSource('automation'), { type: 'localMapping' as const }]) {
      const withPackage = remoteGitFixture();
      withPackage.profile.packages = ['automation'];
      withPackage.resources.push(packageResource(packageSource));
      expect(() => assertStage1ProfileArtifactCapabilities(decode(withPackage))).toThrow(/packages/u);
    }
  });

  it('permits local libraries but refuses every package at the Stage 2 capability guard', () => {
    const localLibrary = clone(remoteGitFixture());
    localLibrary.resources[1]!.source = { type: 'localMapping' };
    expect(() => assertStage2ProfileArtifactCapabilities(decode(localLibrary))).not.toThrow();

    for (const source of [remoteGitSource('automation'), { type: 'localMapping' as const }]) {
      const withPackage = clone(remoteGitFixture());
      withPackage.profile.packages = ['automation'];
      withPackage.resources.push(packageResource(source));
      expect(() => assertStage2ProfileArtifactCapabilities(decode(withPackage))).toThrow(/packages/u);
    }
  });

  it('enforces package closure, ordering, uniqueness, and source validity without changing schema v1', () => {
    const fixture = remoteGitFixture();
    fixture.profile.packages = ['automation'];
    fixture.resources.push(packageResource({ type: 'localMapping' }));
    expect(decode(fixture).schemaVersion).toBe(1);

    const missing = clone(fixture);
    missing.resources.pop();
    expect(() => decode(missing)).toThrow(/exactly match/u);

    const orphan = clone(fixture);
    orphan.profile.packages = [];
    expect(() => decode(orphan)).toThrow(/exactly match/u);

    const duplicate = clone(fixture);
    duplicate.profile.packages = ['automation', 'automation'];
    expect(() => decode(duplicate)).toThrow(/lexical order/u);

    const wrongOrder = clone(fixture);
    wrongOrder.resources = [wrongOrder.resources[2]!, wrongOrder.resources[0]!, wrongOrder.resources[1]!];
    expect(() => decode(wrongOrder)).toThrow(/unique and ordered/u);

    const wrongSource = clone(fixture) as unknown as { resources: Array<{ source: Record<string, unknown> }> };
    wrongSource.resources[2]!.source = { type: 'localPackagePath', root: '/private/package' };
    expect(() => decodeProfileArtifactObject(wrongSource, testPolicyFor(fixture))).toThrow(/source type is invalid/u);

    const leakedLocalPath = clone(fixture) as unknown as { resources: Array<{ source: Record<string, unknown> }> };
    leakedLocalPath.resources[2]!.source.root = '/private/package';
    expect(() => decodeProfileArtifactObject(leakedLocalPath, testPolicyFor(fixture))).toThrow(/exactly/u);
  });

  it('enforces fixture-derived below, at, and above canonical manifest byte ceilings', () => {
    const fixture = remoteGitFixture();
    const exactBytes = Buffer.byteLength(`${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    const base = testPolicyFor(fixture);
    expect(() => decodeProfileArtifactObject(fixture, { ...base, maxManifestBytes: exactBytes - 1 })).toThrow(/canonical manifest/u);
    expect(() => decodeProfileArtifactObject(fixture, { ...base, maxManifestBytes: exactBytes })).not.toThrow();
    expect(() => decodeProfileArtifactObject(fixture, { ...base, maxManifestBytes: exactBytes + 1 })).not.toThrow();
  });

  it('enforces fixture-derived below, at, and above total profile-entry ceilings', () => {
    const fixture = remoteGitFixture();
    const exactEntries = profileEntryCount(fixture);
    const base = testPolicyFor(fixture);
    expect(() => decodeProfileArtifactObject(fixture, { ...base, maxProfileEntries: exactEntries - 1 })).toThrow(/profile entries|entry limit/u);
    expect(() => decodeProfileArtifactObject(fixture, { ...base, maxProfileEntries: exactEntries })).not.toThrow();
    expect(() => decodeProfileArtifactObject(fixture, { ...base, maxProfileEntries: exactEntries + 1 })).not.toThrow();
  });

  it('enforces fixture-derived below, at, and above resource-count ceilings', () => {
    const fixture = remoteGitFixture();
    const exactResources = fixture.resources.length;
    const base = testPolicyFor(fixture);
    expect(() => decodeProfileArtifactObject(fixture, { ...base, maxResources: exactResources - 1 })).toThrow(/resources.*entry limit/u);
    expect(() => decodeProfileArtifactObject(fixture, { ...base, maxResources: exactResources })).not.toThrow();
    expect(() => decodeProfileArtifactObject(fixture, { ...base, maxResources: exactResources + 1 })).not.toThrow();
  });

  it('decodes only exact canonical raw manifest bytes', () => {
    const fixture = remoteGitFixture();
    const policy = testPolicyFor(fixture);
    const canonical = Buffer.from(encodeProfileArtifact(fixture, policy), 'utf8');
    expect(decodeProfileArtifactBytes(canonical, policy)).toEqual(fixture);

    const text = canonical.toString('utf8');
    const duplicateKey = Buffer.from(text.replace(
      '  "schemaVersion": 1,',
      '  "schemaVersion": 1,\n  "schemaVersion": 1,'
    ), 'utf8');
    const reordered = Buffer.from(`${JSON.stringify({
      kind: fixture.kind,
      schemaVersion: fixture.schemaVersion,
      profile: fixture.profile,
      resources: fixture.resources
    }, null, 2)}\n`, 'utf8');
    const compact = Buffer.from(`${JSON.stringify(fixture)}\n`, 'utf8');
    const withoutFinalLf = canonical.subarray(0, canonical.byteLength - 1);
    const extraFinalLf = Buffer.concat([canonical, Buffer.from('\n')]);

    for (const bytes of [duplicateKey, reordered, compact, withoutFinalLf, extraFinalLf]) {
      expect(() => decodeProfileArtifactBytes(bytes, {
        ...policy,
        maxManifestBytes: Math.max(canonical.byteLength, bytes.byteLength)
      })).toThrow(/not canonical/u);
    }
  });

  it('rejects invalid UTF-8, invalid JSON, and raw bytes outside the injected ceiling', () => {
    const fixture = remoteGitFixture();
    const canonical = Buffer.from(encodeProfileArtifact(fixture, testPolicyFor(fixture)), 'utf8');
    const policy = {
      ...testPolicyFor(fixture),
      maxManifestBytes: canonical.byteLength
    };

    expect(() => decodeProfileArtifactBytes(Uint8Array.from([0xff]), policy))
      .toThrow(/valid UTF-8/u);
    expect(() => decodeProfileArtifactBytes(Buffer.from('{', 'utf8'), policy))
      .toThrow(/valid JSON/u);
    expect(() => decodeProfileArtifactBytes(canonical, {
      ...policy,
      maxManifestBytes: canonical.byteLength - 1
    })).toThrow(/byte limit/u);
    expect(() => decodeProfileArtifactBytes(canonical, policy)).not.toThrow();
    expect(() => decodeProfileArtifactBytes(canonical, {
      ...policy,
      maxManifestBytes: canonical.byteLength + 1
    })).not.toThrow();

    const padded = Buffer.concat([Buffer.from(' '), canonical]);
    expect(() => decodeProfileArtifactBytes(padded, policy)).toThrow(/byte limit/u);
  });

  it('requires explicit finite nonnegative integer test policies', () => {
    const fixture = remoteGitFixture();
    const policy = testPolicyFor(fixture);
    for (const key of ['maxManifestBytes', 'maxProfileEntries', 'maxResources'] as const) {
      for (const value of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5]) {
        expect(() => decodeProfileArtifactObject(fixture, { ...policy, [key]: value }))
          .toThrow(expect.objectContaining({ code: 'PROFILE_ARTIFACT_INVALID' }));
        expect(() => decodeProfileArtifactObject(fixture, { ...policy, [key]: value }))
          .toThrow(/finite nonnegative integer/u);
      }
    }
  });
});
