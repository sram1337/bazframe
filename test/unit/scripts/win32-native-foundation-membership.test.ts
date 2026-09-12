import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = await readFile('scripts/test-win32-native-foundation.mjs', 'utf8');
function between(start: string, end: string) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  if (first < 0 || last < 0) throw new Error(`Missing foundation fixture boundary: ${start}`);
  return source.slice(first, last);
}
// Execute the real fixture statements and assertion helpers, without running the native lane.
const fixtureSource = between('  const chainedTarget =', '  const foreignAclMembership =');
const observationSource = between('  const membershipForeignReparseRefused =', '  const membershipExistingAclAdmitted =');
const helpers = between('async function expectCode(', 'function sameRegularFilePhysicalIdentity(');
const membershipParent = 'C:\\temporary\\private\\skill-memberships';
const outside = 'C:\\temporary\\outside';
const membershipTarget = win32.join(outside, 'membership-target');
const membershipMarker = win32.join(membershipTarget, 'marker.txt');
const canonical = (path: string) => `\\\\?\\Volume{11111111-1111-1111-1111-111111111111}${path.slice(2)}`;
const targetBefore = {
  canonicalPath: canonical(membershipTarget),
  object: { volumeIdentity: '1'.repeat(16), fileId: '2'.repeat(32) }
};
function supportedReceipt() {
  return {
    canonicalPath: canonical(win32.join(membershipParent, 'directory-symlink')),
    object: { reparseTag: 0xa000000c, volumeIdentity: '1'.repeat(16), fileId: '3'.repeat(32) },
    normalizedTarget: targetBefore.canonicalPath,
    targetVolumeIdentity: targetBefore.object.volumeIdentity,
    targetFileId: targetBefore.object.fileId
  };
}
type Receipt = ReturnType<typeof supportedReceipt>;
interface Options {
  mutate?: (receipt: Receipt, inspection: number) => void;
  negative?: { name: string; code: string | null };
  corruptMarker?: 'absolute' | 'relative' | 'physical';
  relativeTarget?: string;
}

// Synthetic Windows paths, filesystem effects and already-validated backend fields only.
// This proves harness decisions/fixture construction, not NTFS or native receipt validation.
async function runFixture(options: Options = {}) {
  const links = new Map<string, { target: string; type: string }>();
  const directories = new Set([membershipTarget]);
  const reads: string[] = [], inspections: string[] = [];
  let absoluteInspections = 0;
  const outcome = await runInNewContext(`(async () => {
    ${helpers}
    ${fixtureSource}
    ${observationSource}
    return membershipForeignReparseRefused;
  })()`, {
    ...win32,
    relative: options.relativeTarget === undefined ? win32.relative : () => options.relativeTarget,
    membershipParent, membershipTarget, membershipMarker, membershipTargetBefore: targetBefore, outside,
    Error,
    safeError: (error: { code?: string; message?: string }) => error,
    symlink: async (target: string, path: string, type: string) => { links.set(path, { target, type }); },
    mkdir: async (path: string) => { directories.add(path); },
    rmdir: async (path: string) => { directories.delete(path); },
    readFile: async (path: string) => {
      reads.push(path);
      const parent = win32.dirname(path), link = links.get(parent);
      if (link && !directories.has(win32.resolve(win32.dirname(parent), link.target))) {
        throw new Error('Synthetic fixture marker is not readable');
      }
      const kind = parent === membershipTarget ? 'physical'
        : parent === win32.join(membershipParent, 'directory-symlink') ? 'absolute' : 'relative';
      return options.corruptMarker === kind ? 'changed\n' : 'membership target\n';
    },
    backend: {
      inspectPath: (path: string) => ({ canonicalPath: canonical(path) }),
      inspectMembershipLink: (path: string) => {
        inspections.push(path);
        const name = win32.basename(path);
        if (name === 'directory-symlink') {
          const receipt = supportedReceipt();
          absoluteInspections += 1;
          options.mutate?.(receipt, absoluteInspections);
          return receipt;
        }
        const link = links.get(path);
        if (!link) throw new Error('Missing synthetic link fixture');
        if (name === 'chained-skill') expect(links.has(link.target)).toBe(true);
        else if (name === 'dangling-skill') expect(directories.has(link.target)).toBe(false);
        else {
          expect(link.type).toBe('dir');
          expect(win32.isAbsolute(link.target)).toBe(false);
          expect(win32.resolve(membershipParent, link.target)).toBe(membershipTarget);
        }
        const code = options.negative?.name === name ? options.negative.code
          : name === 'chained-skill' || name === 'dangling-skill'
            ? 'WINDOWS_NATIVE_MEMBERSHIP_TARGET_INVALID' : 'WINDOWS_NATIVE_MEMBERSHIP_LINK_INVALID';
        if (code === null) return supportedReceipt();
        throw Object.assign(new Error('Synthetic native refusal'), { code });
      }
    }
  }) as boolean;
  return { outcome, links, reads, inspections, absoluteInspections };
}

describe('foundation membership fixtures (synthetic host harness proof, not native proof)', () => {
  it('admits the exact absolute directory symlink twice and refuses real relative/chained/dangling fixtures', async () => {
    const result = await runFixture();
    expect(result.outcome).toBe(true);
    expect(result.absoluteInspections).toBe(2);
    expect(result.links.get(win32.join(membershipParent, 'directory-symlink'))).toEqual({ target: membershipTarget, type: 'dir' });
    const relativePath = win32.join(membershipParent, 'relative-directory-symlink');
    expect(result.links.get(relativePath)).toEqual({ target: win32.relative(membershipParent, membershipTarget), type: 'dir' });
    expect(result.inspections).toContain(relativePath);
    expect(result.reads).toEqual(expect.arrayContaining([
      membershipMarker, win32.join(membershipParent, 'directory-symlink', 'marker.txt'), win32.join(relativePath, 'marker.txt')
    ]));
  });

  it('compares extended canonical paths case-insensitively rather than to raw drive paths', async () => {
    expect((await runFixture({ mutate: (receipt) => {
      receipt.canonicalPath = receipt.canonicalPath.toUpperCase();
      receipt.normalizedTarget = receipt.normalizedTarget.toUpperCase();
    } })).outcome).toBe(true);
  });

  const mutations: [string, (receipt: Receipt) => void][] = [
    ['tag', (r) => { r.object.reparseTag = 0xa0000003; }],
    ['link path', (r) => { r.canonicalPath += '-other'; }],
    ['target path', (r) => { r.normalizedTarget += '-other'; }],
    ['target volume', (r) => { r.targetVolumeIdentity = '4'.repeat(16); }],
    ['target file', (r) => { r.targetFileId = '4'.repeat(32); }]
  ];
  it.each(mutations)('rejects incorrect first %s evidence', async (_name, mutate) => {
    await expect(runFixture({ mutate: (receipt, count) => { if (count === 1) mutate(receipt); } }))
      .rejects.toThrow('Native conformance failed: absolute directory symlink exact repeated inspection');
  });
  it.each([
    ...mutations,
    ['link volume', (r: Receipt) => { r.object.volumeIdentity = '4'.repeat(16); }],
    ['link file', (r: Receipt) => { r.object.fileId = '4'.repeat(32); }]
  ] as [string, (receipt: Receipt) => void][])('rejects repeated %s drift', async (_name, mutate) => {
    await expect(runFixture({ mutate: (receipt, count) => { if (count === 2) mutate(receipt); } }))
      .rejects.toThrow('Native conformance failed: absolute directory symlink exact repeated inspection');
  });

  it.each(['chained-skill', 'relative-directory-symlink', 'dangling-skill'])('requires the exact refusal for %s', async (name) => {
    for (const code of [null, 'WINDOWS_NATIVE_PATH_INVALID', name === 'relative-directory-symlink'
      ? 'WINDOWS_NATIVE_MEMBERSHIP_TARGET_INVALID' : 'WINDOWS_NATIVE_MEMBERSHIP_LINK_INVALID']) {
      await expect(runFixture({ negative: { name, code } })).rejects.toThrow('Expected WINDOWS_NATIVE_MEMBERSHIP_');
    }
  });
  it.each(['absolute', 'relative', 'physical'] as const)('requires preserved %s marker bytes', async (corruptMarker) => {
    await expect(runFixture({ corruptMarker })).rejects.toThrow('Native conformance failed:');
  });
  it.each(['', membershipTarget, '..\\not-the-target'])('rejects invalid relative fixture spelling %j before inspection', async (relativeTarget) => {
    await expect(runFixture({ relativeTarget })).rejects.toThrow('Native conformance failed: relative directory symlink fixture target');
  });
});
