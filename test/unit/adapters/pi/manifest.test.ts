import { describe, expect, it } from 'vitest';
import {
  createPiAdapterManifest,
  decodePiAdapterManifest,
  encodePiAdapterManifest
} from '../../../../src/adapters/pi/manifest.js';
import {
  classifyPiAdapterInstallation,
  type PiAdapterInstallState
} from '../../../../src/adapters/pi/ownership.js';
import { identifyBytes } from '../../../../src/state/file-identity.js';

describe('Pi adapter ownership manifest', () => {
  it('round-trips a schema-v1 manifest deterministically', () => {
    const artifact = identifyBytes('export default function bazframe() {}\n');
    const manifest = createPiAdapterManifest(
      '0.1.0',
      '/users/alice/.pi/agent/extensions/bazframe.ts',
      artifact
    );
    const encoded = encodePiAdapterManifest(manifest);

    expect(encoded.endsWith('\n')).toBe(true);
    expect(decodePiAdapterManifest(encoded)).toEqual(manifest);
  });

  it('rejects malformed schema, paths, hashes, and byte counts', () => {
    const valid = {
      schemaVersion: 1,
      adapter: 'pi',
      bazframeVersion: '0.1.0',
      installedPath: '/users/alice/.pi/agent/extensions/bazframe.ts',
      artifactSha256: 'a'.repeat(64),
      artifactBytes: 10
    };

    for (const value of [
      { ...valid, schemaVersion: 2 },
      { ...valid, installedPath: 'relative/bazframe.ts' },
      { ...valid, artifactSha256: 'bad' },
      { ...valid, artifactBytes: -1 }
    ]) {
      expect(() => decodePiAdapterManifest(JSON.stringify(value))).toThrow(/schema-v1/u);
    }
    expect(() => decodePiAdapterManifest('{')).toThrow(/Invalid JSON/u);
  });
});

describe('Pi adapter ownership comparison', () => {
  it('classifies every installation state', () => {
    const targetPath = '/users/alice/.pi/agent/extensions/bazframe.ts';
    const desired = identifyBytes('desired');
    const old = identifyBytes('old');
    const drift = identifyBytes('drift');
    const currentManifest = createPiAdapterManifest('0.1.0', targetPath, desired);
    const oldManifest = createPiAdapterManifest('0.0.9', targetPath, old);

    const cases: Array<{
      expected: PiAdapterInstallState;
      manifest?: typeof currentManifest;
      installed?: typeof desired;
      path?: string;
    }> = [
      { expected: 'missing' },
      { expected: 'adoptable', installed: desired },
      { expected: 'occupied', installed: old },
      { expected: 'current', manifest: currentManifest, installed: desired },
      { expected: 'managed-outdated', manifest: oldManifest, installed: old },
      { expected: 'managed-missing', manifest: currentManifest },
      { expected: 'drifted', manifest: currentManifest, installed: drift },
      {
        expected: 'manifest-path-mismatch',
        manifest: currentManifest,
        installed: desired,
        path: '/different/extensions/bazframe.ts'
      }
    ];

    for (const testCase of cases) {
      expect(classifyPiAdapterInstallation({
        targetPath: testCase.path ?? targetPath,
        desired,
        ...(testCase.manifest === undefined ? {} : { manifest: testCase.manifest }),
        ...(testCase.installed === undefined ? {} : { installed: testCase.installed })
      })).toBe(testCase.expected);
    }
  });
});
