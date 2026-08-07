import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertOnlyBazframeHomeWritable,
  captureImmutableInputs,
  prepareBrokenMembership,
  prepareFixture,
  writeSkill
} from './fixture.mjs';
import { resolveSourceUnit } from './resolver.mjs';

async function useFixture(t, options) {
  const fixture = await prepareFixture(options);
  t.after(async () => {
    try {
      assert.deepEqual(await captureImmutableInputs(fixture), fixture.before);
    } finally {
      await fixture.cleanup();
    }
  });
  return fixture;
}

async function resolveFixture(fixture) {
  return resolveSourceUnit({
    providerId: fixture.providerId,
    sourceId: fixture.sourceId,
    membershipPath: fixture.membershipPath
  });
}

function assertFailure(result, category, path, extra = {}) {
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { category, path, ...extra });
}

async function assertTreeReadOnly(root) {
  async function visit(path) {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink()) assert.equal(stats.mode & 0o222, 0, path);
    if (!stats.isDirectory()) return;
    for (const name of await readdir(path)) await visit(join(path, name));
  }
  await visit(root);
}

test('one direct membership resolves exact alpha and beta records without mutating inputs', async (t) => {
  const fixture = await useFixture(t);
  const result = await resolveFixture(fixture);
  assert.equal(result.ok, true);
  assert.deepEqual(result.directMembership, {
    providerId: 'fixture-provider',
    sourceId: 'fixture-source',
    membershipPath: fixture.membershipPath,
    sourceRoot: fixture.sourceRoot
  });
  assert.deepEqual(result.effectiveSkills, [
    {
      providerId: 'fixture-provider',
      sourceId: 'fixture-source',
      qualifiedId: 'fixture-provider/fixture-source/alpha',
      sourceRoot: fixture.sourceRoot,
      skillRoot: join(fixture.sourceRoot, 'alpha'),
      definitionPath: join(fixture.sourceRoot, 'alpha', 'SKILL.md'),
      declaredName: 'alpha'
    },
    {
      providerId: 'fixture-provider',
      sourceId: 'fixture-source',
      qualifiedId: 'fixture-provider/fixture-source/beta',
      sourceRoot: fixture.sourceRoot,
      skillRoot: join(fixture.sourceRoot, 'beta'),
      definitionPath: join(fixture.sourceRoot, 'beta', 'SKILL.md'),
      declaredName: 'beta'
    }
  ]);

  for (const skill of result.effectiveSkills) {
    const sharedPath = resolve(skill.skillRoot, '../shared/reference.md');
    assert.equal(await readFile(sharedPath, 'utf8'), 'provider-owned shared reference\n');
  }
  assert.equal(result.effectiveSkills.some((skill) => skill.declaredName === 'shared'), false);
  assert.equal(result.effectiveSkills.some((skill) => skill.declaredName === 'ordinary'), false);

  await writeFile(
    join(fixture.bazframeHome, 'structural-result.json'),
    `${JSON.stringify(result, null, 2)}\n`
  );
  assert.deepEqual(await captureImmutableInputs(fixture), fixture.before);
  await assertTreeReadOnly(fixture.sourceRoot);
  for (const destinationRoot of fixture.destinationRoots) {
    await assertTreeReadOnly(destinationRoot);
  }
  await assertTreeReadOnly(fixture.providerRoot);
  await assertTreeReadOnly(fixture.destinationsRoot);
  await assertOnlyBazframeHomeWritable(fixture);
});

test('a grouping root with no definitions succeeds with zero effective skills', async (t) => {
  const fixture = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      await mkdir(join(sourceRoot, 'shared'), { recursive: true });
      await writeFile(join(sourceRoot, 'shared', 'reference.md'), 'resource only\n');
    }
  });
  const result = await resolveFixture(fixture);
  assert.equal(result.ok, true);
  assert.deepEqual(result.effectiveSkills, []);
  assert.deepEqual(await captureImmutableInputs(fixture), fixture.before);
});

test('a standalone root is one terminal effective skill', async (t) => {
  const fixture = await useFixture(t, {
    sourceName: 'standalone',
    sourceId: 'standalone-source',
    populate: async ({ sourceRoot }) => {
      await writeSkill(sourceRoot, 'standalone');
      await mkdir(join(sourceRoot, 'references'), { recursive: true });
      await writeFile(join(sourceRoot, 'references', 'notes.md'), 'supporting file\n');
    }
  });
  const result = await resolveFixture(fixture);
  assert.equal(result.ok, true);
  assert.deepEqual(result.effectiveSkills, [{
    providerId: 'fixture-provider',
    sourceId: 'standalone-source',
    qualifiedId: 'fixture-provider/standalone-source/standalone',
    sourceRoot: fixture.sourceRoot,
    skillRoot: fixture.sourceRoot,
    definitionPath: join(fixture.sourceRoot, 'SKILL.md'),
    declaredName: 'standalone'
  }]);
});

test('depth 8 is accepted and depth 9 fails at the directory', async (t) => {
  const atBoundary = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      let directory = sourceRoot;
      for (let depth = 1; depth <= 8; depth += 1) {
        directory = join(directory, `chain-${depth}`);
        await mkdir(directory);
      }
      await writeSkill(directory, 'chain-8');
    }
  });
  const accepted = await resolveFixture(atBoundary);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.effectiveSkills.length, 1);

  const overBoundary = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      let directory = sourceRoot;
      for (let depth = 1; depth <= 9; depth += 1) {
        directory = join(directory, `chain-${depth}`);
        await mkdir(directory);
      }
    }
  });
  const rejected = await resolveFixture(overBoundary);
  assertFailure(
    rejected,
    'limit-exceeded',
    'chain-1/chain-2/chain-3/chain-4/chain-5/chain-6/chain-7/chain-8/chain-9',
    { limit: 'depth', maximum: 8, observed: 9 }
  );
});

test('256 visited entries are accepted and the 257th fails', async (t) => {
  const atBoundary = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      for (let index = 0; index < 256; index += 1) {
        await writeFile(join(sourceRoot, `entry-${String(index).padStart(3, '0')}`), 'x');
      }
    }
  });
  const accepted = await resolveFixture(atBoundary);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.counts, { visitedEntries: 256, skills: 0 });

  const overBoundary = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      for (let index = 0; index < 257; index += 1) {
        await writeFile(join(sourceRoot, `entry-${String(index).padStart(3, '0')}`), 'x');
      }
    }
  });
  const rejected = await resolveFixture(overBoundary);
  assertFailure(rejected, 'limit-exceeded', 'entry-256', {
    limit: 'entries', maximum: 256, observed: 257
  });
});

test('64 effective skills are accepted and the 65th fails', async (t) => {
  async function populateSkills(sourceRoot, count) {
    for (let index = 0; index < count; index += 1) {
      const name = `skill-${String(index).padStart(2, '0')}`;
      await writeSkill(join(sourceRoot, name), name);
    }
  }

  const atBoundary = await useFixture(t, {
    populate: ({ sourceRoot }) => populateSkills(sourceRoot, 64)
  });
  const accepted = await resolveFixture(atBoundary);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.effectiveSkills.length, 64);

  const overBoundary = await useFixture(t, {
    populate: ({ sourceRoot }) => populateSkills(sourceRoot, 65)
  });
  const rejected = await resolveFixture(overBoundary);
  assertFailure(rejected, 'limit-exceeded', 'skill-64/SKILL.md', {
    limit: 'skills', maximum: 64, observed: 65
  });
});

test('a missing membership target is broken-root', async (t) => {
  const fixture = await prepareBrokenMembership();
  t.after(fixture.cleanup);
  const result = await resolveFixture(fixture);
  assertFailure(result, 'broken-root', '.');
});

test('every source-internal symbolic link is rejected without being followed', async (t) => {
  const fixture = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      await writeFile(join(sourceRoot, 'target.txt'), 'target\n');
      await symlink('target.txt', join(sourceRoot, 'link'));
    }
  });
  const result = await resolveFixture(fixture);
  assertFailure(result, 'internal-symlink', 'link');
  assert.deepEqual(await captureImmutableInputs(fixture), fixture.before);
});

test('a root definition plus a descendant definition is mixed-root', async (t) => {
  const fixture = await useFixture(t, {
    sourceName: 'standalone',
    populate: async ({ sourceRoot }) => {
      await writeSkill(sourceRoot, 'standalone');
      await writeSkill(join(sourceRoot, 'child'), 'child');
    }
  });
  const result = await resolveFixture(fixture);
  assertFailure(result, 'mixed-root', 'child/SKILL.md');
});

test('missing name metadata and filesystem/name mismatch are invalid definitions', async (t) => {
  const missingName = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      await mkdir(join(sourceRoot, 'missing'));
      await writeFile(join(sourceRoot, 'missing', 'SKILL.md'), '---\ndescription: missing name\n---\n');
    }
  });
  assertFailure(
    await resolveFixture(missingName),
    'invalid-definition',
    'missing/SKILL.md',
    { reason: 'name is not Agent Skills-compatible' }
  );

  const mismatchedName = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      await writeSkill(join(sourceRoot, 'directory-name'), 'other-name');
    }
  });
  assertFailure(
    await resolveFixture(mismatchedName),
    'invalid-definition',
    'directory-name/SKILL.md',
    {
      reason: 'declared name does not match skill directory',
      declaredName: 'other-name',
      expectedName: 'directory-name'
    }
  );
});

test('duplicate declared names fail at the second lexical definition', async (t) => {
  const fixture = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      await writeSkill(join(sourceRoot, 'group-a', 'same'), 'same');
      await writeSkill(join(sourceRoot, 'group-b', 'same'), 'same');
    }
  });
  const result = await resolveFixture(fixture);
  assertFailure(result, 'duplicate-name', 'group-b/same/SKILL.md', {
    declaredName: 'same',
    firstDefinitionPath: 'group-a/same/SKILL.md'
  });
});

test('the entry limit takes precedence over symlink rejection for one entry', async (t) => {
  const fixture = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      for (let index = 0; index < 256; index += 1) {
        await writeFile(join(sourceRoot, `entry-${String(index).padStart(3, '0')}`), 'x');
      }
      await symlink('entry-000', join(sourceRoot, 'z-link'));
    }
  });
  assertFailure(await resolveFixture(fixture), 'limit-exceeded', 'z-link', {
    limit: 'entries', maximum: 256, observed: 257
  });
});

test('multiple failures use lexical depth-first encounter precedence', async (t) => {
  const linkFirst = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      await writeFile(join(sourceRoot, 'target'), 'target\n');
      await symlink('target', join(sourceRoot, 'a-link'));
      await mkdir(join(sourceRoot, 'z-invalid'));
      await writeFile(join(sourceRoot, 'z-invalid', 'SKILL.md'), 'invalid\n');
    }
  });
  assertFailure(await resolveFixture(linkFirst), 'internal-symlink', 'a-link');

  const definitionFirst = await useFixture(t, {
    populate: async ({ sourceRoot }) => {
      await mkdir(join(sourceRoot, 'a-invalid'));
      await writeFile(join(sourceRoot, 'a-invalid', 'SKILL.md'), 'invalid\n');
      await writeFile(join(sourceRoot, 'target'), 'target\n');
      await symlink('target', join(sourceRoot, 'z-link'));
    }
  });
  assertFailure(
    await resolveFixture(definitionFirst),
    'invalid-definition',
    'a-invalid/SKILL.md',
    { reason: 'missing opening frontmatter' }
  );
});
