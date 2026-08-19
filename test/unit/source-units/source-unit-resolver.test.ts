import { chmod, mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { measureProviderOperation } from '../../helpers/provider-manifest.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { publishSourceSnapshot } from '../../../src/source-units/source-snapshot.js';
import { encodeGlobalSource } from '../../../src/sources/source-store.js';
import { encodeProfileSourceReference } from '../../../src/profiles/profile-source-reference.js';
import {
  loadFlatSkillIdentities,
  resolveProfileSourceUnits,
  UNKNOWN_SOURCE_ID,
  type DefinitionLoader
} from '../../../src/source-units/source-unit-resolver.js';

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
  _sourceId: string,
  root: string
): Promise<void> {
  const sourceRoot = await realpath(root);
  const sourceId = basename(sourceRoot);
  const snapshot = await publishSourceSnapshot(directory.root, sourceRoot);
  await directory.write(
    `sources/${sourceId}.json`,
    encodeGlobalSource({
      schemaVersion: 1,
      source: sourceId,
      root: sourceRoot,
      digest: snapshot.digest,
      sourceUnitRoot: '.'
    })
  );
  await directory.write(
    `profiles/profile/sources/${sourceId}.json`,
    encodeProfileSourceReference({ schemaVersion: 1, source: sourceId })
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
    [`${profile}/sources`],
    operation
  );
  expect(measured.providerAfter).toEqual(measured.providerBefore);
  expect(measured.ownedAfter).toEqual(measured.ownedBefore);
  if (!measured.outcome.ok) throw measured.outcome.error;
  return measured.outcome.value;
}

describe('source-unit resolver', () => {
  it('preserves unchanged absent-namespace behavior', async () => {
    const { profile } = await fixture();
    await expect(discoverPreservingProvider(
      profile,
      [],
      () => resolveProfileSourceUnits(profile, [])
    )).resolves.toEqual({
      directSourceUnits: [],
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
      () => resolveProfileSourceUnits(profile, [])
    );

    expect(result.directSourceUnits.map((item) => item.sourceId)).toEqual([
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

  it('uses Pi YAML parsing and directory fallback for source skill names', async () => {
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
      () => resolveProfileSourceUnits(profile, [])
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.derivedSkills.map((item) => [item.name, item.relativePath])).toEqual([
      ['directory-fallback', 'directory-fallback/SKILL.md'],
      ['folded-name', 'folded-directory/SKILL.md']
    ]);
    expect(result.derivedSkills.every((item) => item.baseDir.includes('/source-snapshots/sha256/'))).toBe(true);
  });

  it('reports exact placeholders for malformed source-units roots', async () => {
    const first = await fixture();
    await first.directory.write('profiles/profile/sources', 'not a directory\n');
    await expect(discoverPreservingProvider(
      first.profile,
      [],
      () => resolveProfileSourceUnits(first.profile, [])
    )).resolves.toEqual({
      directSourceUnits: [],
      derivedSkills: [],
      diagnostics: [{
        category: 'invalid-reference',
        sourceId: UNKNOWN_SOURCE_ID,
        path: '.'
      }]
    });

    const second = await fixture();
    await second.directory.mkdir('elsewhere');
    await symlink(second.directory.path('elsewhere'), second.directory.path('profiles/profile/sources'));
    await expect(discoverPreservingProvider(
      second.profile,
      [],
      () => resolveProfileSourceUnits(second.profile, [])
    )).resolves.toEqual({
      directSourceUnits: [],
      derivedSkills: [],
      diagnostics: [{
        category: 'invalid-reference',
        sourceId: UNKNOWN_SOURCE_ID,
        path: '.'
      }]
    });
  });

  it('reports every reachable flat namespace-shape problem and does not inspect siblings', async () => {
    const { directory, profile } = await fixture();
    await directory.mkdir('profiles/profile/sources/legacy-provider');
    await directory.write('profiles/profile/sources/bad.txt', '{}');
    await directory.mkdir('profiles/profile/sources/child.json');

    const result = await discoverPreservingProvider(profile, [], () => resolveProfileSourceUnits(profile, []));

    expect(result.directSourceUnits).toEqual([]);
    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([
      { category: 'invalid-reference', sourceId: UNKNOWN_SOURCE_ID, path: 'bad.txt' },
      { category: 'invalid-reference', sourceId: UNKNOWN_SOURCE_ID, path: 'legacy-provider' },
      { category: 'invalid-reference', sourceId: 'child', path: 'child.json' }
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
      () => resolveProfileSourceUnits(profile, [])
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      category: 'mixed-root',
      sourceId: 'mixed-precedence',
      path: '.child/SKILL.md'
    }]);
  });

  it('keeps ordinary source failures atomic while preserving other sources', async () => {
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
      () => resolveProfileSourceUnits(profile, [])
    );

    expect(result.derivedSkills.map((item) => item.name)).toEqual(['good-child']);
    expect(result.diagnostics).toEqual([{
      category: 'mixed-root',
      sourceId: 'mixed',
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
      () => resolveProfileSourceUnits(profile, [])
    );

    expect(result.derivedSkills.map((item) => [item.name, item.relativePath])).toEqual([
      ['depth-eight', 'd1/d2/d3/d4/d5/d6/d7/d8/SKILL.md']
    ]);
    expect(result.diagnostics).toEqual([
      {
        category: 'limit-exceeded',
        sourceId: 'deep',
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
      () => resolveProfileSourceUnits(profile, [])
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
      () => resolveProfileSourceUnits(profile, [])
    );

    expect(result.derivedSkills.filter((item) => item.sourceId === 'skills-at')).toHaveLength(64);
    expect(result.diagnostics).toEqual([
      {
        category: 'limit-exceeded',
        sourceId: 'entries-over',
        path: 'f256',
        limit: 'entries'
      },
      {
        category: 'limit-exceeded',
        sourceId: 'skills-over',
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
      () => resolveProfileSourceUnits(profile, [], () => {
        throw new Error('injected definition parse failure');
      })
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      category: 'invalid-definition',
      sourceId: 'invalid-definition',
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
      () => resolveProfileSourceUnits(profile, [])
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      category: 'pi-loader',
      sourceId: 'missing-description',
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
      () => resolveProfileSourceUnits(profile, [], loader)
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        category: 'pi-loader',
        sourceId: 'first',
        path: 'SKILL.md',
        diagnosticIndex: 0,
        message: 'first error'
      },
      {
        category: 'pi-loader',
        sourceId: 'first',
        path: 'SKILL.md',
        diagnosticIndex: 1,
        message: 'additional detail'
      },
      {
        category: 'pi-loader',
        sourceId: 'second',
        path: 'SKILL.md',
        diagnosticIndex: 0,
        message: 'Pi loader rejected definition without a diagnostic'
      }
    ]);
  });

  it('marks every duplicate path and withholds all involved source units while flat wins', async () => {
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
      () => resolveProfileSourceUnits(profile, [{
        name: 'flat-name',
        definitionPath: '/flat/SKILL.md'
      }])
    );

    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([
      { category: 'duplicate-name', sourceId: 'one', path: 'a/SKILL.md', name: 'shared' },
      { category: 'duplicate-name', sourceId: 'one', path: 'b/SKILL.md', name: 'within' },
      { category: 'duplicate-name', sourceId: 'one', path: 'c/SKILL.md', name: 'within' },
      { category: 'duplicate-name', sourceId: 'three', path: 'SKILL.md', name: 'flat-name' },
      { category: 'duplicate-name', sourceId: 'two', path: 'SKILL.md', name: 'shared' }
    ]);
  });

  it('fails closed when an activated snapshot is corrupt', async () => {
    const { directory, profile } = await fixture(); const root = await directory.mkdir('corrupt'); await directory.write('corrupt/SKILL.md', skill('corrupt'));
    await descriptor(directory, 'provider', 'corrupt', root);
    const stored = JSON.parse(await readFile(directory.path('sources/corrupt.json'), 'utf8')) as { digest: string };
    const artifact = directory.path('source-snapshots/sha256', stored.digest, 'artifact', 'SKILL.md');
    await chmod(artifact, 0o600); await writeFile(artifact, 'changed');
    const result = await resolveProfileSourceUnits(profile, []);
    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{ category: 'broken-snapshot', sourceId: 'corrupt', path: '.' }]);
    expect(result.directSourceUnits[0]).toMatchObject({ preparationState: 'failed' });
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
      () => resolveProfileSourceUnits(profile, [])
    );

    expect(result.derivedSkills.map((skill) => skill.name)).toEqual(['retargeted']);
    expect(result.directSourceUnits[0]).toMatchObject({ preparationState: 'ready', rebuildAvailability: 'unavailable' });
    expect(result.diagnostics).toEqual([]);
  });

  it('withholds a valid backed reference when a sibling reference is malformed', async () => {
    const { directory, profile } = await fixture();
    const root = await directory.mkdir('valid-backed');
    await directory.write('valid-backed/SKILL.md', skill('valid-backed'));
    await descriptor(directory, 'provider', 'source', root);
    await directory.write('profiles/profile/sources/broken.json', '{');

    const result = await resolveProfileSourceUnits(profile, []);

    expect(result).toEqual({
      directSourceUnits: [],
      derivedSkills: [],
      diagnostics: [{
        category: 'invalid-reference',
        sourceId: 'broken',
        path: 'broken.json'
      }]
    });
  });

  it('does not resolve global targets after finding a malformed sibling reference', async () => {
    const { directory, profile } = await fixture();
    await directory.write('profiles/profile/sources/broken.json', '{');
    await directory.write(
      'profiles/profile/sources/malformed.json',
      encodeProfileSourceReference({ schemaVersion: 1, source: 'malformed' })
    );
    await directory.write('sources/malformed.json', '{}\n');
    await directory.write(
      'profiles/profile/sources/missing.json',
      encodeProfileSourceReference({ schemaVersion: 1, source: 'missing' })
    );

    const result = await resolveProfileSourceUnits(profile, []);

    expect(result).toEqual({
      directSourceUnits: [],
      derivedSkills: [],
      diagnostics: [
        { category: 'invalid-reference', sourceId: 'broken', path: 'broken.json' }
      ]
    });
  });

  it('allows a zero-child snapshot and reports zero-child snapshots', async () => {
    const { directory, profile } = await fixture();
    const empty = await directory.mkdir('empty');
    await descriptor(directory, 'provider', 'empty', empty);
    const missing = directory.path('missing');
    await directory.write(
      'profiles/profile/sources/missing.json',
      encodeProfileSourceReference({ schemaVersion: 1, source: 'missing' })
    );

    const result = await discoverPreservingProvider(
      profile,
      [empty, missing],
      () => resolveProfileSourceUnits(profile, [])
    );
    expect(result.directSourceUnits).toHaveLength(2);
    expect(result.derivedSkills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      category: 'invalid-source',
      sourceId: 'missing',
      path: 'missing.json'
    }]);
  });
});
