import { lstat, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  measureProviderOperation,
  type MeasuredProviderOperation
} from '../../helpers/provider-manifest.js';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import {
  addActiveProfileSource,
  addProfileSource,
  removeActiveProfileSource
} from '../../../src/profiles/profile-source-membership.js';

const directories: TempDirectory[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => directory.cleanup())));

async function fixture(): Promise<{ directory: TempDirectory; home: string; provider: string }> {
  const directory = await createTempDirectory('bazframe-source-membership-');
  directories.push(directory);
  const home = directory.path('home');
  const provider = await directory.mkdir('provider');
  await directory.write('provider/SKILL.md', '---\nname: provider\n---\n');
  await directory.write('home/active-profile', 'focused\n');
  await directory.write('home/profiles/focused/AGENTS.md', 'instructions\n');
  await directory.mkdir('home/profiles/focused/skills');
  await directory.write('home/profiles/other/AGENTS.md', 'other\n');
  await directory.mkdir('home/profiles/other/skills');
  return { directory, home, provider };
}

async function addSourceWithManifest(
  home: string,
  provider: string,
  sourceId: string
) {
  const descriptorPath = `${home}/profiles/focused/source-units/provider/${sourceId}.json`;
  const measured = await measureProviderOperation(
    [provider],
    [descriptorPath],
    () => addActiveProfileSource({ bazframeHome: home }, 'provider', sourceId, provider)
  );
  expectProviderPreserved(measured);
  expect(measured.ownedAfter).not.toEqual(measured.ownedBefore);
  const added = operationValue(measured);
  expect(added.action).toBe('added');
  return added;
}

function expectProviderPreserved<T>(measured: MeasuredProviderOperation<T>): void {
  expect(measured.providerAfter).toEqual(measured.providerBefore);
}

function operationValue<T>(measured: MeasuredProviderOperation<T>): T {
  if (!measured.outcome.ok) throw measured.outcome.error;
  return measured.outcome.value;
}

function operationError<T>(measured: MeasuredProviderOperation<T>): unknown {
  if (measured.outcome.ok) throw new Error('Expected measured operation to fail.');
  return measured.outcome.error;
}

describe('profile source membership', () => {
  it('adds an exact descriptor, is idempotent, and preserves provider bytes', async () => {
    const { directory, home, provider } = await fixture();
    const descriptorPath = directory.path(
      'home/profiles/focused/source-units/provider/source.json'
    );
    const measuredAdd = await measureProviderOperation(
      [provider],
      [descriptorPath],
      () => addActiveProfileSource(
        { bazframeHome: home },
        'provider',
        'source',
        provider
      )
    );
    expectProviderPreserved(measuredAdd);
    expect(measuredAdd.ownedAfter).not.toEqual(measuredAdd.ownedBefore);
    const added = operationValue(measuredAdd);
    expect(added.action).toBe('added');

    const measuredIdempotentAdd = await measureProviderOperation(
      [provider],
      [descriptorPath],
      () => addActiveProfileSource(
        { bazframeHome: home },
        'provider',
        'source',
        provider
      )
    );
    expectProviderPreserved(measuredIdempotentAdd);
    expect(measuredIdempotentAdd.ownedAfter).toEqual(measuredIdempotentAdd.ownedBefore);
    const current = operationValue(measuredIdempotentAdd);
    expect(current.action).toBe('current');
    expect(JSON.parse(await readFile(added.descriptorPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      providerId: 'provider',
      sourceId: 'source',
      sourceRoot: await realpath(provider)
    });
    expect(await lstat(directory.path('home/profiles/focused/source-units/provider')))
      .toMatchObject({});
  });

  it('targets an inactive profile without requiring active selection', async () => {
    const { directory, home, provider } = await fixture();
    await rm(directory.path('home/active-profile'));
    const descriptorPath = directory.path(
      'home/profiles/other/source-units/provider/source.json'
    );
    const measured = await measureProviderOperation(
      [provider],
      [descriptorPath],
      () => addProfileSource(
        { bazframeHome: home },
        'other',
        'provider',
        'source',
        provider
      )
    );
    expectProviderPreserved(measured);
    expect(measured.ownedAfter).not.toEqual(measured.ownedBefore);
    const result = operationValue(measured);
    expect(result.profileId).toBe('other');
    expect(result.action).toBe('added');
  });

  it('refuses retargeting and occupied malformed or linked descriptors', async () => {
    const { directory, home, provider } = await fixture();
    const other = await directory.mkdir('other-provider');
    const descriptorPath = directory.path(
      'home/profiles/focused/source-units/provider/source.json'
    );
    const initialAdd = await measureProviderOperation(
      [provider, other],
      [descriptorPath],
      () => addActiveProfileSource({ bazframeHome: home }, 'provider', 'source', provider)
    );
    expectProviderPreserved(initialAdd);
    expect(initialAdd.ownedAfter).not.toEqual(initialAdd.ownedBefore);
    operationValue(initialAdd);

    const retarget = await measureProviderOperation(
      [provider, other],
      [descriptorPath],
      () => addActiveProfileSource({ bazframeHome: home }, 'provider', 'source', other)
    );
    expectProviderPreserved(retarget);
    expect(retarget.ownedAfter).toEqual(retarget.ownedBefore);
    expect(operationError(retarget)).toMatchObject({ code: 'SOURCE_DESCRIPTOR_UNMANAGED' });

    const malformedPath = await directory.write(
      'home/profiles/focused/source-units/provider/bad.json',
      '{}\n'
    );
    const malformed = await measureProviderOperation(
      [provider, other],
      [malformedPath],
      () => addActiveProfileSource({ bazframeHome: home }, 'provider', 'bad', provider)
    );
    expectProviderPreserved(malformed);
    expect(malformed.ownedAfter).toEqual(malformed.ownedBefore);
    expect(operationError(malformed)).toMatchObject({ code: 'SOURCE_DESCRIPTOR_UNMANAGED' });

    const linkedPath = directory.path(
      'home/profiles/focused/source-units/provider/linked.json'
    );
    await symlink(descriptorPath, linkedPath);
    const linked = await measureProviderOperation(
      [provider, other],
      [linkedPath],
      () => addActiveProfileSource({ bazframeHome: home }, 'provider', 'linked', provider)
    );
    expectProviderPreserved(linked);
    expect(linked.ownedAfter).toEqual(linked.ownedBefore);
    expect(operationError(linked)).toMatchObject({ code: 'SOURCE_DESCRIPTOR_UNMANAGED' });
  });

  it('removes a descriptor with a missing provider root and prunes owned empty directories', async () => {
    const { directory, home, provider } = await fixture();
    const added = await addSourceWithManifest(home, provider, 'source');
    await rm(provider, { recursive: true });
    const measuredRemove = await measureProviderOperation(
      [provider],
      [added.descriptorPath],
      () => removeActiveProfileSource({ bazframeHome: home }, 'provider', 'source')
    );
    expectProviderPreserved(measuredRemove);
    expect(measuredRemove.ownedAfter).not.toEqual(measuredRemove.ownedBefore);
    const removed = operationValue(measuredRemove);
    expect(removed.action).toBe('removed');

    const sourceUnitsRoot = directory.path('home/profiles/focused/source-units');
    const measuredAbsent = await measureProviderOperation(
      [provider],
      [added.descriptorPath, sourceUnitsRoot],
      () => removeActiveProfileSource({ bazframeHome: home }, 'provider', 'source')
    );
    expectProviderPreserved(measuredAbsent);
    expect(measuredAbsent.ownedAfter).toEqual(measuredAbsent.ownedBefore);
    const absent = operationValue(measuredAbsent);
    expect(absent.action).toBe('absent');
    await expect(lstat(added.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(directory.path('home/profiles/focused/source-units')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a same-content descriptor substitution and a symlink swap before unlink', async () => {
    const { directory, home, provider } = await fixture();
    const first = await addSourceWithManifest(home, provider, 'first');
    const firstBytes = await readFile(first.descriptorPath);
    const replacement = await directory.write('replacement.json', firstBytes);
    const saved = directory.path('saved-first.json');
    const substitution = await measureProviderOperation(
      [provider],
      [first.descriptorPath, saved],
      () => removeActiveProfileSource(
        { bazframeHome: home },
        'provider',
        'first',
        {
          beforeRemoveRevalidation: async (path) => {
            await rename(path, saved);
            await rename(replacement, path);
          }
        }
      )
    );
    expectProviderPreserved(substitution);
    expect(substitution.ownedAfter).not.toEqual(substitution.ownedBefore);
    expect(operationError(substitution)).toMatchObject({ code: 'SOURCE_DESCRIPTOR_UNMANAGED' });
    expect(await readFile(first.descriptorPath)).toEqual(firstBytes);
    expect(await readFile(saved)).toEqual(firstBytes);

    const second = await addSourceWithManifest(home, provider, 'second');
    const savedSecond = directory.path('saved-second.json');
    const symlinkSwap = await measureProviderOperation(
      [provider],
      [second.descriptorPath, savedSecond],
      () => removeActiveProfileSource(
        { bazframeHome: home },
        'provider',
        'second',
        {
          beforeRemoveRevalidation: async (path) => {
            await rename(path, savedSecond);
            await symlink(savedSecond, path);
          }
        }
      )
    );
    expectProviderPreserved(symlinkSwap);
    expect(symlinkSwap.ownedAfter).not.toEqual(symlinkSwap.ownedBefore);
    expect(operationError(symlinkSwap)).toMatchObject({ code: 'SOURCE_DESCRIPTOR_UNMANAGED' });
    expect((await lstat(second.descriptorPath)).isSymbolicLink()).toBe(true);
  });

  it('accepts valid descriptors larger than 64 KiB', async () => {
    const { directory, home, provider } = await fixture();
    const canonical = await realpath(provider);
    await directory.write(
      'home/profiles/focused/source-units/provider/source.json',
      `${JSON.stringify({
        schemaVersion: 1,
        providerId: 'provider',
        sourceId: 'source',
        sourceRoot: canonical
      })}${' '.repeat(70 * 1024)}\n`
    );
    const descriptorPath = directory.path(
      'home/profiles/focused/source-units/provider/source.json'
    );
    const measured = await measureProviderOperation(
      [provider],
      [descriptorPath],
      () => addActiveProfileSource({ bazframeHome: home }, 'provider', 'source', provider)
    );
    expectProviderPreserved(measured);
    expect(measured.ownedAfter).toEqual(measured.ownedBefore);
    expect(operationValue(measured)).toMatchObject({ action: 'current' });
  });

  it('prunes empty owned directories on absent retry and reports post-remove prune failure honestly', async () => {
    const { directory, home, provider } = await fixture();
    const added = await addSourceWithManifest(home, provider, 'source');
    const providerDirectory = directory.path('home/profiles/focused/source-units/provider');
    const pruneError = Object.assign(new Error('injected prune failure'), { code: 'EACCES' });
    const failedPrune = await measureProviderOperation(
      [provider],
      [added.descriptorPath, providerDirectory],
      () => removeActiveProfileSource(
        { bazframeHome: home },
        'provider',
        'source',
        { removeDirectory: async () => { throw pruneError; } }
      )
    );
    expectProviderPreserved(failedPrune);
    expect(failedPrune.ownedAfter).not.toEqual(failedPrune.ownedBefore);
    expect(operationError(failedPrune)).toMatchObject({
      code: 'SOURCE_DIRECTORY_PRUNE_FAILED',
      message: expect.stringContaining('descriptor was removed')
    });
    await expect(lstat(added.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(providerDirectory)).isDirectory()).toBe(true);

    const sourceUnitsRoot = directory.path('home/profiles/focused/source-units');
    const absentRetry = await measureProviderOperation(
      [provider],
      [sourceUnitsRoot],
      () => removeActiveProfileSource({ bazframeHome: home }, 'provider', 'source')
    );
    expectProviderPreserved(absentRetry);
    expect(absentRetry.ownedAfter).not.toEqual(absentRetry.ownedBefore);
    expect(operationValue(absentRetry)).toMatchObject({ action: 'absent' });
    await expect(lstat(sourceUnitsRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects relative, missing, and symlink roots before creating descriptor state', async () => {
    const { directory, home, provider } = await fixture();
    const sourceUnitsRoot = directory.path('home/profiles/focused/source-units');
    const relative = await measureProviderOperation(
      [provider],
      [sourceUnitsRoot],
      () => addActiveProfileSource(
        { bazframeHome: home }, 'provider', 'relative', 'relative/path'
      )
    );
    expectProviderPreserved(relative);
    expect(relative.ownedAfter).toEqual(relative.ownedBefore);
    expect(operationError(relative)).toMatchObject({ code: 'SOURCE_ROOT_INVALID' });

    const missing = directory.path('missing');
    const missingResult = await measureProviderOperation(
      [missing],
      [sourceUnitsRoot],
      () => addActiveProfileSource({ bazframeHome: home }, 'provider', 'missing', missing)
    );
    expectProviderPreserved(missingResult);
    expect(missingResult.ownedAfter).toEqual(missingResult.ownedBefore);
    expect(operationError(missingResult)).toMatchObject({ code: 'DIRECTORY_READ_FAILED' });

    await symlink(provider, directory.path('provider-link'));
    const linked = await measureProviderOperation(
      [provider],
      [sourceUnitsRoot],
      () => addActiveProfileSource(
        { bazframeHome: home }, 'provider', 'linked', directory.path('provider-link')
      )
    );
    expectProviderPreserved(linked);
    expect(linked.ownedAfter).toEqual(linked.ownedBefore);
    expect(operationError(linked)).toMatchObject({ code: 'DIRECTORY_NOT_PHYSICAL' });
    await expect(lstat(sourceUnitsRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
