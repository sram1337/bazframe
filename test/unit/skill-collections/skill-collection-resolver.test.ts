import { chmod, mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { measureProviderOperation } from '../../helpers/provider-manifest.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { publishSkillSnapshot } from '../../../src/skill-collections/skill-snapshot.js';
import { encodeLibrary, encodePackage } from '../../../src/skill-collections/skill-collection-store.js';
import { encodeProfileCollectionReference } from '../../../src/profiles/profile-skill-collection-reference.js';
import {
  loadFlatSkillIdentities,
  resolveProfileSkillCollections,
  UNKNOWN_COLLECTION_ID,
  type DefinitionLoader
} from '../../../src/skill-collections/skill-collection-resolver.js';

const directories: TempDirectory[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));

async function fixture(): Promise<{ directory: TempDirectory; profile: string }> {
  const directory = await createTempDirectory('bazframe-source-resolver-');
  directories.push(directory);
  const profile = await directory.mkdir('profiles/profile');
  await directory.mkdir('profiles/profile/skills');
  await directory.write('profiles/profile/AGENTS.md', 'profile\n');
  return { directory, profile };
}

async function descriptor(
  directory: TempDirectory,
  _providerId: string,
  _collectionId: string,
  root: string
): Promise<void> {
  await collectionDescriptor(directory, 'library', root);
}

async function collectionDescriptor(
  directory: TempDirectory,
  kind: 'library' | 'package',
  root: string
): Promise<void> {
  const collectionRoot = await realpath(root);
  const collectionId = basename(collectionRoot);
  const snapshot = await publishSkillSnapshot(directory.root, collectionRoot);
  await directory.write(
    `${kind === 'library' ? 'libraries' : 'packages'}/${collectionId}.json`,
    kind === 'library'
      ? encodeLibrary({
          schemaVersion: 1,
          library: collectionId,
          root: collectionRoot,
          digest: snapshot.digest
        })
      : encodePackage({
          schemaVersion: 1,
          package: collectionId,
          root: collectionRoot,
          digest: snapshot.digest,
          artifactRoot: '.',
          skillsRoot: '.'
        })
  );
  await directory.write(
    `profiles/profile/${kind === 'library' ? 'libraries' : 'packages'}/${collectionId}.json`,
    encodeProfileCollectionReference(kind === 'library'
      ? { schemaVersion: 1, library: collectionId }
      : { schemaVersion: 1, package: collectionId })
  );
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`;
}

async function discoverPreservingProvider<T>(
  profile: string,
  providerRoots: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const measured = await measureProviderOperation(
    providerRoots,
    [`${profile}/libraries`, `${profile}/packages`],
    operation
  );
  expect(measured.providerAfter).toEqual(measured.providerBefore);
  expect(measured.ownedAfter).toEqual(measured.ownedBefore);
  if (!measured.outcome.ok) throw measured.outcome.error;
  return measured.outcome.value;
}

describe('Skill collection resolver', () => {
  it('preserves unchanged absent-namespace behavior', async () => {
    const { profile } = await fixture();
    await expect(discoverPreservingProvider(
      profile,
      [],
      () => resolveProfileSkillCollections(profile, [])
    )).resolves.toEqual({
      directCollections: [],
      derivedSkills: [],
      diagnostics: []
    });
  });

  it('loads ordered flat identities with Pi names, accepts warnings, and rejects missing children', async () => {
    const { directory } = await fixture();
    const folded = await directory.mkdir('flat/folded-directory');
    const fallback = await directory.mkdir('flat/directory-fallback');
    const warned = await directory.mkdir('flat/warned');
    const rejected = await directory.mkdir('flat/rejected');
    await directory.write(
      'flat/folded-directory/SKILL.md',
      '---\nname: >-\n  folded-name\ndescription: folded\n---\n\nfolded\n'
    );
    await directory.write(
      'flat/directory-fallback/SKILL.md',
      '---\ndescription: fallback\n---\n\nfallback\n'
    );
    await directory.write(
      'flat/warned/SKILL.md',
      `---\ndescription: ${'x'.repeat(1025)}\n---\n\nwarned\n`
    );
    await directory.write('flat/rejected/SKILL.md', '---\nname: rejected\n---\n');

    expect(loadFlatSkillIdentities([warned, fallback, folded])).toEqual([
      { name: 'warned', definitionPath: `${warned}/SKILL.md` },
      { name: 'directory-fallback', definitionPath: `${fallback}/SKILL.md` },
      { name: 'folded-name', definitionPath: `${folded}/SKILL.md` }
    ]);
    expect(() => loadFlatSkillIdentities([rejected])).toThrowError(
      expect.objectContaining({ code: 'INVALID_SKILL_DEFINITION' })
    );
  });

  it('resolves standalone and nested definitions in lexical DFS order and skips internals', async () => {
    const { directory, profile } = await fixture();
    const standalone = await directory.mkdir('standalone');
    const grouping = await directory.mkdir('grouping');
    await directory.write('standalone/SKILL.md', skill('standalone'));
    await directory.write('standalone/data.txt', 'data\n');
    await directory.write('grouping/zeta/SKILL.md', skill('zeta'));
    await directory.write('grouping/alpha/nested/SKILL.md', skill('nested'));
    await directory.write('grouping/shared/data.txt', 'ordinary\n');
    await directory.write('grouping/.git/deep/SKILL.md', skill('ignored'));
    await directory.write('grouping/node_modules/pkg/SKILL.md', skill('ignored-too'));
    await descriptor(directory, 'one-provider', 'standalone', standalone);
    await descriptor(directory, 'two-provider', 'grouping', grouping);

    const result = await discoverPreservingProvider(
      profile,
      [standalone, grouping],
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.directCollections.map((item) => item.collectionId)).toEqual([
      'grouping',
      'standalone'
    ]);
    expect(result.derivedSkills.map((item) => [item.name, item.relativePath])).toEqual([
      ['nested', 'alpha/nested/SKILL.md'],
      ['zeta', 'zeta/SKILL.md'],
      ['standalone', 'SKILL.md']
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('uses Pi YAML parsing and directory fallback for library Skill names', async () => {
    const { directory, profile } = await fixture();
    const root = await directory.mkdir('pi-name-parity');
    await directory.write(
      'pi-name-parity/folded-directory/SKILL.md',
      '---\nname: >-\n  folded-name\ndescription: folded\n---\n\nfolded\n'
    );
    await directory.write(
      'pi-name-parity/directory-fallback/SKILL.md',
      '---\ndescription: fallback\n---\n\nfallback\n'
    );
    await descriptor(directory, 'provider', 'source', root);

    const result = await discoverPreservingProvider(
      profile,
      [root],
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.derivedSkills.map((item) => [item.name, item.relativePath])).toEqual([
      ['directory-fallback', 'directory-fallback/SKILL.md'],
      ['folded-name', 'folded-directory/SKILL.md']
    ]);
    expect(result.derivedSkills.every((item) => item.baseDir.includes('/skill-snapshots/sha256/'))).toBe(true);
  });

  it('reports exact placeholders for malformed library reference roots', async () => {
    const first = await fixture();
    await first.directory.write('profiles/profile/libraries', 'not a directory\n');
    await expect(discoverPreservingProvider(
      first.profile,
      [],
      () => resolveProfileSkillCollections(first.profile, [])
    )).resolves.toEqual({
      directCollections: [],
      derivedSkills: [],
      diagnostics: [{
        category: 'invalid-reference',
        collectionKind: 'library',
        collectionId: UNKNOWN_COLLECTION_ID,
        path: '.'
      }]
    });

    const second = await fixture();
    await second.directory.mkdir('elsewhere');
    await symlink(second.directory.path('elsewhere'), second.directory.path('profiles/profile/libraries'));
    await expect(discoverPreservingProvider(
      second.profile,
      [],
      () => resolveProfileSkillCollections(second.profile, [])
    )).resolves.toEqual({
      directCollections: [],
      derivedSkills: [],
      diagnostics: [{
        category: 'invalid-reference',
        collectionKind: 'library',
        collectionId: UNKNOWN_COLLECTION_ID,
        path: '.'
      }]
    });
  });

  it('reports every reachable flat namespace-shape problem and does not inspect siblings', async () => {
    const { directory, profile } = await fixture();
    await directory.mkdir('profiles/profile/libraries/legacy-provider');
    await directory.write('profiles/profile/libraries/bad.txt', '{}');
    await directory.mkdir('profiles/profile/libraries/child.json');

    const result = await discoverPreservingProvider(profile, [], () => resolveProfileSkillCollections(profile, []));

    expect(result.directCollections).toEqual([]);
    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([
      { category: 'invalid-reference', collectionKind: 'library', collectionId: UNKNOWN_COLLECTION_ID, path: 'bad.txt' },
      { category: 'invalid-reference', collectionKind: 'library', collectionId: UNKNOWN_COLLECTION_ID, path: 'legacy-provider' },
      { category: 'invalid-reference', collectionKind: 'library', collectionId: 'child', path: 'child.json' }
    ]);
  });

  it('gives a physical root definition precedence over a lexically earlier malformed descendant', async () => {
    const { directory, profile } = await fixture();
    const root = await directory.mkdir('mixed-precedence');
    await directory.write('mixed-precedence/SKILL.md', skill('mixed-precedence'));
    await directory.write('mixed-precedence/.child/SKILL.md', 'not frontmatter\n');
    await descriptor(directory, 'provider', 'source', root);

    const result = await discoverPreservingProvider(
      profile,
      [root],
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      category: 'mixed-root',
      collectionKind: 'library',
        collectionId: 'mixed-precedence',
      path: '.child/SKILL.md'
    }]);
  });

  it('keeps ordinary object failures atomic while preserving other libraries/packages', async () => {
    const { directory, profile } = await fixture();
    const good = await directory.mkdir('good');
    const mixed = await directory.mkdir('mixed');
    await directory.write('good/child/SKILL.md', skill('good-child'));
    await directory.write('mixed/SKILL.md', skill('mixed'));
    await directory.write('mixed/child/SKILL.md', skill('mixed-child'));
    await descriptor(directory, 'provider', 'good', good);
    await descriptor(directory, 'provider', 'mixed', mixed);

    const result = await discoverPreservingProvider(
      profile,
      [good, mixed],
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.derivedSkills.map((item) => item.name)).toEqual(['good-child']);
    expect(result.diagnostics).toEqual([{
      category: 'mixed-root',
      collectionKind: 'library',
        collectionId: 'mixed',
      path: 'child/SKILL.md'
    }]);
  });

  it('rejects internal links and enforces the approved depth boundary', async () => {
    const { directory, profile } = await fixture();
    const linked = await directory.mkdir('linked');
    const depthAt = await directory.mkdir('depth-at');
    const deep = await directory.mkdir('deep');
    await directory.write('outside.txt', 'outside\n');
    await symlink(directory.path('outside.txt'), directory.path('linked/link'));
    let atRelative = 'depth-at';
    for (let depth = 1; depth <= 8; depth += 1) {
      atRelative += `/d${depth}`;
      await mkdir(directory.path(atRelative));
    }
    await directory.write(`${atRelative}/SKILL.md`, skill('depth-eight'));
    let relative = 'deep';
    for (let depth = 1; depth <= 9; depth += 1) {
      relative += `/d${depth}`;
      await mkdir(directory.path(relative));
    }
    await descriptor(directory, 'provider', 'depth-at', depthAt);
    await descriptor(directory, 'provider', 'deep', deep);
    await expect(descriptor(directory, 'provider', 'linked', linked)).rejects.toThrow(/symbolic link/u);
    const roots = [deep, depthAt, linked];

    const result = await discoverPreservingProvider(
      profile,
      roots,
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.derivedSkills.map((item) => [item.name, item.relativePath])).toEqual([
      ['depth-eight', 'd1/d2/d3/d4/d5/d6/d7/d8/SKILL.md']
    ]);
    expect(result.diagnostics).toEqual([
      {
        category: 'limit-exceeded',
        collectionKind: 'library',
        collectionId: 'deep',
        path: 'd1/d2/d3/d4/d5/d6/d7/d8/d9',
        limit: 'depth'
      }
    ]);
  });

  it('never enters skipped .git and node_modules roots, including their symlinks', async () => {
    const { directory, profile } = await fixture();
    const root = await directory.mkdir('skipped-links');
    await directory.mkdir('skipped-links/.git/deep');
    await directory.mkdir('skipped-links/node_modules/pkg');
    await directory.write('skipped-links/.git/deep/ignored', 'ignored');
    await directory.write('skipped-links/node_modules/pkg/ignored', 'ignored');
    await directory.write('skipped-links/valid/SKILL.md', skill('valid'));
    await descriptor(directory, 'provider', 'source', root);

    const result = await discoverPreservingProvider(
      profile,
      [root],
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.derivedSkills.map((item) => item.name)).toEqual(['valid']);
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts exact entry/skill bounds and fails the next encountered item', async () => {
    const { directory, profile } = await fixture();
    const entriesAt = await directory.mkdir('entries-at');
    const entriesOver = await directory.mkdir('entries-over');
    for (let index = 0; index < 257; index += 1) {
      const name = `f${String(index).padStart(3, '0')}`;
      if (index < 256) await directory.write(`entries-at/${name}`, 'x');
      await directory.write(`entries-over/${name}`, 'x');
    }
    await directory.write('entries-at/.git/ignored', 'not counted');
    const skillsAt = await directory.mkdir('skills-at');
    const skillsOver = await directory.mkdir('skills-over');
    for (let index = 0; index < 65; index += 1) {
      const name = `s${String(index).padStart(3, '0')}`;
      if (index < 64) await directory.write(`skills-at/${name}/SKILL.md`, skill(name));
      await directory.write(`skills-over/${name}/SKILL.md`, skill(name));
    }
    await descriptor(directory, 'provider', 'entries-at', entriesAt);
    await descriptor(directory, 'provider', 'entries-over', entriesOver);
    await descriptor(directory, 'provider', 'skills-at', skillsAt);
    await descriptor(directory, 'provider', 'skills-over', skillsOver);
    const roots = [entriesAt, entriesOver, skillsAt, skillsOver];

    const result = await discoverPreservingProvider(
      profile,
      roots,
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.derivedSkills.filter((item) => item.collectionId === 'skills-at')).toHaveLength(64);
    expect(result.diagnostics).toEqual([
      {
        category: 'limit-exceeded',
        collectionKind: 'library',
        collectionId: 'entries-over',
        path: 'f256',
        limit: 'entries'
      },
      {
        category: 'limit-exceeded',
        collectionKind: 'library',
        collectionId: 'skills-over',
        path: 's064/SKILL.md',
        limit: 'skills'
      }
    ]);
  }, 15_000);

  it('reports invalid-definition when definition loading throws', async () => {
    const { directory, profile } = await fixture();
    const root = await directory.mkdir('invalid-definition');
    await directory.write('invalid-definition/SKILL.md', skill('invalid-definition'));
    await descriptor(directory, 'provider', 'source', root);

    const result = await discoverPreservingProvider(
      profile,
      [root],
      () => resolveProfileSkillCollections(profile, [], () => {
        throw new Error('injected definition parse failure');
      })
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      category: 'invalid-definition',
      collectionKind: 'library',
        collectionId: 'invalid-definition',
      path: 'SKILL.md'
    }]);
  });

  it('uses Pi 0.82 to reject a missing-description definition on the production path', async () => {
    const { directory, profile } = await fixture();
    const root = await directory.mkdir('missing-description');
    await directory.write('missing-description/SKILL.md', '---\nname: missing-description\n---\n');
    await descriptor(directory, 'provider', 'source', root);

    const result = await discoverPreservingProvider(
      profile,
      [root],
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      category: 'pi-loader',
      collectionKind: 'library',
        collectionId: 'missing-description',
      path: 'SKILL.md',
      diagnosticIndex: 0,
      message: 'description is required'
    }]);
  });

  it('normalizes every loader diagnostic and uses the deterministic fallback', async () => {
    const { directory, profile } = await fixture();
    const first = await directory.mkdir('first');
    const second = await directory.mkdir('second');
    await directory.write('first/SKILL.md', skill('first'));
    await directory.write('second/SKILL.md', skill('second'));
    await descriptor(directory, 'provider', 'first', first);
    await descriptor(directory, 'provider', 'second', second);
    let loaderCalls = 0;
    const loader: DefinitionLoader = () => loaderCalls++ === 0
      ? {
          skills: [],
          diagnostics: [
            { type: 'error', message: 'first error' },
            { type: 'warning', message: 'additional detail' }
          ]
        }
      : { skills: [], diagnostics: [] };

    const result = await discoverPreservingProvider(
      profile,
      [first, second],
      () => resolveProfileSkillCollections(profile, [], loader)
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        category: 'pi-loader',
        collectionKind: 'library',
        collectionId: 'first',
        path: 'SKILL.md',
        diagnosticIndex: 0,
        message: 'first error'
      },
      {
        category: 'pi-loader',
        collectionKind: 'library',
        collectionId: 'first',
        path: 'SKILL.md',
        diagnosticIndex: 1,
        message: 'additional detail'
      },
      {
        category: 'pi-loader',
        collectionKind: 'library',
        collectionId: 'second',
        path: 'SKILL.md',
        diagnosticIndex: 0,
        message: 'Pi loader rejected definition without a diagnostic'
      }
    ]);
  });

  it('marks every duplicate path and withholds all involved libraries/packages while a profile Skill wins', async () => {
    const { directory, profile } = await fixture();
    const one = await directory.mkdir('one');
    const two = await directory.mkdir('two');
    const three = await directory.mkdir('three');
    await directory.write('one/a/SKILL.md', skill('shared'));
    await directory.write('one/b/SKILL.md', skill('within'));
    await directory.write('one/c/SKILL.md', skill('within'));
    await directory.write('two/SKILL.md', skill('shared'));
    await directory.write('three/SKILL.md', skill('flat-name'));
    await descriptor(directory, 'provider', 'one', one);
    await descriptor(directory, 'provider', 'two', two);
    await descriptor(directory, 'provider', 'three', three);

    const result = await discoverPreservingProvider(
      profile,
      [one, two, three],
      () => resolveProfileSkillCollections(profile, [{
        name: 'flat-name',
        definitionPath: '/flat/SKILL.md'
      }])
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([
      { category: 'duplicate-name', collectionKind: 'library', collectionId: 'one', path: 'a/SKILL.md', name: 'shared' },
      { category: 'duplicate-name', collectionKind: 'library', collectionId: 'one', path: 'b/SKILL.md', name: 'within' },
      { category: 'duplicate-name', collectionKind: 'library', collectionId: 'one', path: 'c/SKILL.md', name: 'within' },
      { category: 'duplicate-name', collectionKind: 'library', collectionId: 'three', path: 'SKILL.md', name: 'flat-name' },
      { category: 'duplicate-name', collectionKind: 'library', collectionId: 'two', path: 'SKILL.md', name: 'shared' }
    ]);
  });

  it('withholds package-internal, direct-Skill/package, and cross-kind duplicate conflicts atomically', async () => {
    const { directory, profile } = await fixture();
    const library = await directory.mkdir('library-cross');
    const crossPackage = await directory.mkdir('package-cross');
    const internalPackage = await directory.mkdir('package-internal');
    const flatPackage = await directory.mkdir('package-flat');
    await directory.write('library-cross/collision/SKILL.md', skill('cross-kind'));
    await directory.write('library-cross/noncolliding/SKILL.md', skill('library-only'));
    await directory.write('package-cross/collision/SKILL.md', skill('cross-kind'));
    await directory.write('package-cross/noncolliding/SKILL.md', skill('package-only'));
    await directory.write('package-internal/a/SKILL.md', skill('inside-package'));
    await directory.write('package-internal/b/SKILL.md', skill('inside-package'));
    await directory.write('package-flat/SKILL.md', skill('flat-name'));
    await collectionDescriptor(directory, 'library', library);
    await collectionDescriptor(directory, 'package', crossPackage);
    await collectionDescriptor(directory, 'package', internalPackage);
    await collectionDescriptor(directory, 'package', flatPackage);

    const result = await discoverPreservingProvider(
      profile,
      [library, crossPackage, internalPackage, flatPackage],
      () => resolveProfileSkillCollections(profile, [{
        name: 'flat-name',
        definitionPath: '/flat/SKILL.md'
      }])
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([
      { category: 'duplicate-name', collectionKind: 'library', collectionId: 'library-cross', path: 'collision/SKILL.md', name: 'cross-kind' },
      { category: 'duplicate-name', collectionKind: 'package', collectionId: 'package-cross', path: 'collision/SKILL.md', name: 'cross-kind' },
      { category: 'duplicate-name', collectionKind: 'package', collectionId: 'package-flat', path: 'SKILL.md', name: 'flat-name' },
      { category: 'duplicate-name', collectionKind: 'package', collectionId: 'package-internal', path: 'a/SKILL.md', name: 'inside-package' },
      { category: 'duplicate-name', collectionKind: 'package', collectionId: 'package-internal', path: 'b/SKILL.md', name: 'inside-package' }
    ]);
  });

  it('fails closed when an activated snapshot is corrupt', async () => {
    const { directory, profile } = await fixture(); const root = await directory.mkdir('corrupt'); await directory.write('corrupt/SKILL.md', skill('corrupt'));
    await descriptor(directory, 'provider', 'corrupt', root);
    const stored = JSON.parse(await readFile(directory.path('libraries/corrupt.json'), 'utf8')) as { digest: string };
    const artifact = directory.path('skill-snapshots/sha256', stored.digest, 'artifact', 'SKILL.md');
    await chmod(artifact, 0o600); await writeFile(artifact, 'changed');
    const result = await resolveProfileSkillCollections(profile, []);
    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{ category: 'broken-snapshot', collectionKind: 'library', collectionId: 'corrupt', path: '.' }]);
    expect(result.directCollections[0]).toMatchObject({ preparationState: 'failed' });
  });

  it('keeps an activated snapshot usable after the provider root is retargeted', async () => {
    const { directory, profile } = await fixture();
    const root = await directory.mkdir('retargeted');
    await directory.write('retargeted/SKILL.md', skill('retargeted'));
    await descriptor(directory, 'provider', 'source', root);
    await rename(root, directory.path('original-root'));
    const replacement = await directory.mkdir('replacement-root');
    await directory.write('replacement-root/SKILL.md', skill('replacement-root'));
    await symlink(replacement, root);

    const result = await discoverPreservingProvider(
      profile,
      [root],
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.derivedSkills.map((skill) => skill.name)).toEqual(['retargeted']);
    expect(result.directCollections[0]).toMatchObject({ preparationState: 'ready', rebuildAvailability: 'unavailable' });
    expect(result.diagnostics).toEqual([]);
  });

  it('withholds a valid backed reference when a sibling reference is malformed', async () => {
    const { directory, profile } = await fixture();
    const root = await directory.mkdir('valid-backed');
    await directory.write('valid-backed/SKILL.md', skill('valid-backed'));
    await descriptor(directory, 'provider', 'source', root);
    await directory.write('profiles/profile/libraries/broken.json', '{');

    const result = await resolveProfileSkillCollections(profile, []);

    expect(result).toEqual({
      directCollections: [],
      derivedSkills: [],
      diagnostics: [{
        category: 'invalid-reference',
        collectionKind: 'library',
        collectionId: 'broken',
        path: 'broken.json'
      }]
    });
  });

  it('does not resolve global targets after finding a malformed sibling reference', async () => {
    const { directory, profile } = await fixture();
    await directory.write('profiles/profile/libraries/broken.json', '{');
    await directory.write(
      'profiles/profile/libraries/malformed.json',
      JSON.stringify({ schemaVersion: 1, source: 'malformed' })
    );
    await directory.write('libraries/malformed.json', '{}\n');
    await directory.write(
      'profiles/profile/libraries/missing.json',
      JSON.stringify({ schemaVersion: 1, source: 'missing' })
    );

    const result = await resolveProfileSkillCollections(profile, []);

    expect(result).toEqual({
      directCollections: [],
      derivedSkills: [],
      diagnostics: [
        { category: 'invalid-reference', collectionKind: 'library', collectionId: 'broken', path: 'broken.json' },
        { category: 'invalid-reference', collectionKind: 'library', collectionId: 'malformed', path: 'malformed.json' },
        { category: 'invalid-reference', collectionKind: 'library', collectionId: 'missing', path: 'missing.json' }
      ]
    });
  });

  it('resolves package snapshots containing zero, one, and many Skills', async () => {
    const { directory, profile } = await fixture();
    const empty = await directory.mkdir('package-empty');
    const one = await directory.mkdir('package-one');
    const many = await directory.mkdir('package-many');
    await directory.write('package-one/only/SKILL.md', skill('only'));
    await directory.write('package-many/alpha/SKILL.md', skill('alpha'));
    await directory.write('package-many/beta/nested/SKILL.md', skill('beta'));
    await collectionDescriptor(directory, 'package', empty);
    await collectionDescriptor(directory, 'package', one);
    await collectionDescriptor(directory, 'package', many);

    const result = await discoverPreservingProvider(
      profile,
      [empty, one, many],
      () => resolveProfileSkillCollections(profile, [])
    );

    expect(result.directCollections.map((item) => [item.collectionKind, item.collectionId])).toEqual([
      ['package', 'package-empty'],
      ['package', 'package-many'],
      ['package', 'package-one']
    ]);
    expect(result.derivedSkills.map((item) => [item.collectionId, item.name, item.relativePath])).toEqual([
      ['package-many', 'alpha', 'alpha/SKILL.md'],
      ['package-many', 'beta', 'beta/nested/SKILL.md'],
      ['package-one', 'only', 'only/SKILL.md']
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('allows a zero-child library snapshot and reports missing library snapshots', async () => {
    const { directory, profile } = await fixture();
    const empty = await directory.mkdir('empty');
    await descriptor(directory, 'provider', 'empty', empty);
    const missing = directory.path('missing');
    await directory.write(
      'profiles/profile/libraries/missing.json',
      encodeProfileCollectionReference({ schemaVersion: 1, library: 'missing' })
    );

    const result = await discoverPreservingProvider(
      profile,
      [empty, missing],
      () => resolveProfileSkillCollections(profile, [])
    );
    expect(result.directCollections).toHaveLength(2);
    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      category: 'invalid-collection',
      collectionKind: 'library',
      collectionId: 'missing',
      path: 'missing.json'
    }]);
  });
});
