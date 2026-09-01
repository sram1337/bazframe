import { describe, expect, it } from 'vitest';
import { BazframeError } from '../../../src/core/errors.js';
import {
  PackageBuildReportAccumulator,
  createPackageBuildAuthorizationReport
} from '../../../src/profile-portability/profile-import-package-build.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../../../src/profile-portability/profile-portability-policy.js';

const root = '/private/candidate/package-one';
const context = {
  packageId: 'package-one',
  rootIdentity: { root, device: 12n, inode: 34n },
  manifestSnapshot: {
    manifest: {
      schemaVersion: 1 as const,
      build: ['node', 'build.mjs', '--literal=value'],
      artifactRoot: 'dist',
      skillsRoot: 'skills'
    },
    path: `${root}/bazframe-package.json`,
    device: 56n,
    inode: 78n,
    contentSha256: 'a'.repeat(64)
  }
};

describe('profile import package build authorization reports', () => {
  it('projects only the approved report fields without physical identity or environment values', () => {
    const report = createPackageBuildAuthorizationReport(
      'package-one',
      {
        type: 'remoteGit', remote: 'example.test/team/package-one',
        fetchUrl: 'https://example.test/team/package-one.git', branch: 'main', revision: 'b'.repeat(40)
      },
      context
    );
    expect(report).toEqual({
      packageId: 'package-one',
      source: {
        type: 'remoteGit', remote: 'example.test/team/package-one',
        fetchUrl: 'https://example.test/team/package-one.git', branch: 'main', revision: 'b'.repeat(40)
      },
      candidateRoot: root,
      cwd: root,
      argv: ['node', 'build.mjs', '--literal=value'],
      manifest: { path: 'bazframe-package.json', sha256: 'a'.repeat(64) },
      artifactRoot: 'dist', skillsRoot: 'skills', shell: false,
      environment: { inherited: true, namesAndValuesExposed: false },
      authority: { sandboxed: false, user: 'current-process-user', access: ['credentials', 'network', 'user-files'] },
      warning: 'Package build side effects are not rollbackable.'
    });
    const text = JSON.stringify(report);
    for (const forbidden of ['device', 'inode', 'manifestSnapshot', 'rootIdentity', 'process.env']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('copies reports and refuses another report before exceeding the aggregate budget', () => {
    const reports = new PackageBuildReportAccumulator();
    const report = createPackageBuildAuthorizationReport(
      'package-one',
      { type: 'localMapping', root },
      {
        ...context,
        manifestSnapshot: {
          ...context.manifestSnapshot,
          manifest: { ...context.manifestSnapshot.manifest, build: ['x'.repeat(4096)] }
        }
      }
    );
    const first = reports.add(report);
    report.argv[0] = 'mutated';
    expect(reports.reports()[0]!.argv[0]).toBe('x'.repeat(4096));
    expect(Object.isFrozen(first)).toBe(true);
    report.argv[0] = 'x'.repeat(4096);

    let failure: unknown;
    try {
      for (let index = 0; index < 300; index += 1) reports.add(report);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(BazframeError);
    expect(failure).toMatchObject({ code: 'PROFILE_IMPORT_REPORT_LIMIT' });
    const authorizationBytes = reports.reports().reduce(
      (total, item) => total + Buffer.byteLength(JSON.stringify(item), 'utf8'),
      0
    );
    const maximumGeneratedDiagnosticBytes = 5 * PROFILE_PORTABILITY_PRODUCTION_LIMITS.diagnosticBytes;
    expect(authorizationBytes + maximumGeneratedDiagnosticBytes)
      .toBeLessThanOrEqual(PROFILE_PORTABILITY_PRODUCTION_LIMITS.diagnosticReportBytes);
  });
});
