import { describe, expect, it } from 'vitest';
import { assertManagedGitIndexMatchesTree, decodeManagedGitTreeEvidence } from '../../../src/providers/managed-git-tree.js';
const object = 'a'.repeat(40);
const tree = (path: string, mode = '100755') => Buffer.from(`${mode} blob ${object}\t${path}\0`);
describe('exact managed Git tree/index evidence', () => {
  it.each([40, 64])('preserves %i-character Git object IDs in exact tree/index matching', (length) => {
    const object = 'a'.repeat(length);
    const evidence = decodeManagedGitTreeEvidence(Buffer.from(`100755 blob ${object}\thelper\0`), 'tree');
    expect(evidence.entries).toEqual([{ path: 'helper', mode: '100755', object }]);
    assertManagedGitIndexMatchesTree(evidence, decodeManagedGitTreeEvidence(Buffer.from(`100755 ${object} 0\thelper\0`), 'index'));
    expect(() => assertManagedGitIndexMatchesTree(evidence, decodeManagedGitTreeEvidence(Buffer.from(`100755 ${'b'.repeat(length)} 0\thelper\0`), 'index'))).toThrow(/differ/);
  });
  it('preserves logical modes and matches an exact index independently of order', () => {
    const evidence = decodeManagedGitTreeEvidence(Buffer.concat([tree('z', '100644'), tree('a')]), 'tree');
    expect(evidence.entries.map((entry) => [entry.path, entry.mode])).toEqual([['a', '100755'], ['z', '100644']]);
    assertManagedGitIndexMatchesTree(evidence, decodeManagedGitTreeEvidence(Buffer.from(`100755 ${object} 0\ta\0` + `100644 ${object} 0\tz\0`), 'index'));
  });
  it.each(['120000', '160000', '040000', '100664'])('refuses disguised Git type/mode %s before materialization', (mode) => {
    expect(() => decodeManagedGitTreeEvidence(tree('file', mode), 'tree')).toThrow(/unsupported type/);
  });
  it.each(['../escape', 'a/../b', '.git/config', 'a\\b', '.', '/root', 'NUL', 'file.', 'stream:ads', 'a?b', 'a\t'])('refuses unsafe path %s', (path) => {
    expect(() => decodeManagedGitTreeEvidence(tree(path), 'tree')).toThrow();
  });
  it('refuses duplicate, portable alias, and file/directory collisions', () => {
    for (const paths of [['a', 'a'], ['a', 'A'], ['dir/file', 'DIR/other'], ['a', 'a/b'], ['a/b', 'a']]) {
      expect(() => decodeManagedGitTreeEvidence(Buffer.concat(paths.map((path) => tree(path))), 'tree')).toThrow();
    }
  });
  it('refuses malformed UTF-8, truncation, staged conflict, and lowered limits', () => {
    expect(() => decodeManagedGitTreeEvidence(Buffer.concat([Buffer.from(`100644 blob ${object}\t`), Buffer.from([255, 0])]), 'tree')).toThrow(/UTF-8/);
    expect(() => decodeManagedGitTreeEvidence(tree('a').subarray(0, -1), 'tree')).toThrow(/truncated/);
    expect(() => decodeManagedGitTreeEvidence(Buffer.from(`100644 ${object} 1\ta\0`), 'index')).toThrow();
    expect(() => decodeManagedGitTreeEvidence(tree('a'), 'tree', { maxCheckoutEntries: 0 })).toThrow();
  });
  it('refuses index object or executable drift', () => {
    const evidence = decodeManagedGitTreeEvidence(tree('a'), 'tree');
    for (const output of [`100644 ${object} 0\ta\0`, `100755 ${'b'.repeat(40)} 0\ta\0`]) {
      expect(() => assertManagedGitIndexMatchesTree(evidence, decodeManagedGitTreeEvidence(Buffer.from(output), 'index'))).toThrow(/differ/);
    }
  });
});
