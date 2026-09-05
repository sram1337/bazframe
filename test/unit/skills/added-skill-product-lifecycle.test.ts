import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AddedSkillLinkState,
  AddedSkillMutationAuthority,
  AddedSkillPlatformServices
} from '../../../src/skills/added-skill-platform-services.js';
import {
  addDefaultSkill,
  inspectDefaultSkillCatalog,
  removeDefaultSkill
} from '../../../src/skills/default-skill-catalog.js';
import {
  addProfileSkill,
  addActiveProfileSkill,
  removeActiveProfileSkill,
  removeProfileSkill
} from '../../../src/profiles/profile-skill-membership.js';
import { captureProfileSkillReferenceIndex } from '../../../src/profiles/profile-skill-reference-index.js';
import { loadProfile } from '../../../src/profiles/profile-store.js';
import { BazframeError } from '../../../src/core/errors.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('internal Windows added-Skill product lifecycle', () => {
  it('adds, attaches, discovers, reference-guards, detaches, and removes without touching source', async () => {
    const fixture = await setup();
    const options = { platformServices: fixture.services };
    const membershipOptions = { bazframeHome: fixture.home, platformServices: fixture.services };

    await expect(addDefaultSkill(fixture.home, fixture.target, options))
      .resolves.toMatchObject({ action: 'added', id: 'demo-skill' });
    await expect(addDefaultSkill(fixture.home, fixture.target, options))
      .resolves.toMatchObject({ action: 'current' });
    await expect(addProfileSkill(membershipOptions, 'focused', 'demo-skill'))
      .resolves.toMatchObject({ action: 'added', sourceDirectory: fixture.target });
    await expect(addProfileSkill(membershipOptions, 'focused', 'demo-skill'))
      .resolves.toMatchObject({ action: 'current' });

    await expect(inspectDefaultSkillCatalog(fixture.home, options))
      .resolves.toMatchObject({ skillIds: ['demo-skill'], diagnostics: [] });
    await expect(loadProfile(fixture.home, 'focused', options))
      .resolves.toMatchObject({ instructions: '# Focused\n', skillDirectories: [fixture.target] });
    await expect(captureProfileSkillReferenceIndex(
      fixture.home,
      'demo-skill',
      fixture.target,
      options
    )).resolves.toMatchObject({ profileIds: ['focused'], diagnostics: [] });
    await expect(removeDefaultSkill(fixture.home, 'demo-skill', options))
      .rejects.toMatchObject({ code: 'DEFAULT_SKILL_REFERENCED' });

    await expect(removeProfileSkill(membershipOptions, 'focused', 'demo-skill'))
      .resolves.toMatchObject({ action: 'removed' });
    await expect(removeProfileSkill(membershipOptions, 'focused', 'demo-skill'))
      .resolves.toMatchObject({ action: 'absent' });
    await expect(removeDefaultSkill(fixture.home, 'demo-skill', options))
      .resolves.toMatchObject({ action: 'removed' });
    await expect(removeDefaultSkill(fixture.home, 'demo-skill', options))
      .resolves.toMatchObject({ action: 'absent' });

    expect(await readFile(join(fixture.target, 'SKILL.md'), 'utf8')).toBe(fixture.skillBytes);
    expect(fixture.links.size).toBe(0);
    expect(fixture.lockEvents).toContain(`enter:${join(fixture.home, 'locks', 'state.lock')}`);
    const nested = fixture.lockEvents.findIndex((event) => event.includes('focused.skills.lock'));
    const global = fixture.lockEvents.lastIndexOf(`enter:${join(fixture.home, 'locks', 'state.lock')}`, nested);
    expect(global).toBeGreaterThanOrEqual(0);
    expect(nested).toBeGreaterThan(global);
  });

  it('resolves active membership inside state lock and keeps explicit targeting selection-independent', async () => {
    const fixture = await setup();
    const options = { platformServices: fixture.services };
    await addDefaultSkill(fixture.home, fixture.target, options);
    let reads = 0;
    const selectionReadServices = { async readSelectedProfileId() {
      reads += 1;
      expect(fixture.lockEvents.at(-1)).toBe(`enter:${join(fixture.home, 'locks', 'state.lock')}`);
      return 'focused';
    } };
    const membership = { bazframeHome: fixture.home, ...options, selectionReadServices };
    expect(await addActiveProfileSkill(membership, 'demo-skill')).toMatchObject({ profileId: 'focused', action: 'added' });
    expect(await addActiveProfileSkill(membership, 'demo-skill')).toMatchObject({ profileId: 'focused', action: 'current' });
    expect(reads).toBe(2);
    await removeProfileSkill({ ...membership, selectionReadServices: { async readSelectedProfileId() { throw new Error('must not read'); } } }, 'focused', 'demo-skill');
    expect(await removeActiveProfileSkill(membership, 'demo-skill')).toMatchObject({ profileId: 'focused', action: 'absent' });
    expect(reads).toBe(3);
    const before = [...fixture.links];
    await expect(addActiveProfileSkill({ ...membership, selectionReadServices: { async readSelectedProfileId() { return undefined; } } }, 'demo-skill')).rejects.toMatchObject({ code: 'NO_ACTIVE_PROFILE' });
    expect([...fixture.links]).toEqual(before);
  });

  it('keeps usable drive spelling separate from canonical target authority', async () => {
    const fixture = await setup();
    const canonicalTarget = join(dirname(fixture.target), 'canonical', 'demo-skill');
    fixture.setCanonicalTarget(canonicalTarget);
    const added = await addDefaultSkill(fixture.home, fixture.target, {
      platformServices: fixture.services
    });
    expect(added.target).toBe(fixture.target);
    const catalog = await inspectDefaultSkillCatalog(fixture.home, {
      platformServices: fixture.services
    });
    expect(catalog.registrations[0]?.target).toBe(fixture.target);

    const overlap = await setup();
    overlap.setCanonicalTarget(join(overlap.home, 'nested', 'demo-skill'));
    await expect(addDefaultSkill(overlap.home, overlap.target, {
      platformServices: overlap.services
    })).rejects.toMatchObject({ code: 'DEFAULT_SKILL_TARGET_OVERLAPS_BAZFRAME_HOME' });
    expect(overlap.links.size).toBe(0);
  });

  it('fails closed on same-name replacement during reference inspection', async () => {
    const fixture = await setup();
    const options = { platformServices: fixture.services };
    await addDefaultSkill(fixture.home, fixture.target, options);
    await addProfileSkill(
      { bazframeHome: fixture.home, platformServices: fixture.services },
      'focused',
      'demo-skill'
    );
    const membershipPath = join(
      fixture.home,
      'profiles',
      'focused',
      'skills',
      'demo-skill'
    );
    const index = await captureProfileSkillReferenceIndex(
      fixture.home,
      'demo-skill',
      fixture.target,
      {
        platformServices: fixture.services,
        afterSkillsOpened() { fixture.replaceLinkIdentity(membershipPath); }
      }
    );
    expect(index.diagnostics).toEqual([
      { profileId: 'focused', path: join(fixture.home, 'profiles', 'focused') }
    ]);
    await expect(removeDefaultSkill(fixture.home, 'demo-skill', options))
      .rejects.toMatchObject({ code: 'DEFAULT_SKILL_REFERENCED' });
  });

  it('fails closed on foreign membership and reference-index uncertainty', async () => {
    const fixture = await setup();
    const options = { platformServices: fixture.services };
    await addDefaultSkill(fixture.home, fixture.target, options);
    fixture.foreign.add(join(fixture.home, 'profiles', 'focused', 'skills', 'demo-skill'));

    await expect(addProfileSkill(
      { bazframeHome: fixture.home, platformServices: fixture.services },
      'focused',
      'demo-skill'
    )).rejects.toMatchObject({ code: 'WINDOWS_TEST_FOREIGN_LINK' });
    await expect(removeDefaultSkill(fixture.home, 'demo-skill', options))
      .rejects.toMatchObject({ code: 'DEFAULT_SKILL_REFERENCE_INDEX_INVALID' });

    const unknown = await setup();
    await addDefaultSkill(unknown.home, unknown.target, {
      platformServices: unknown.services
    });
    await writeFile(
      join(unknown.home, 'profiles', 'focused', 'skills', 'unknown-entry'),
      'foreign\n'
    );
    await expect(removeDefaultSkill(unknown.home, 'demo-skill', {
      platformServices: unknown.services
    })).rejects.toMatchObject({ code: 'DEFAULT_SKILL_REFERENCE_INDEX_INVALID' });
  });

  it('refuses target drift and lock contention before link mutation', async () => {
    const drift = await setup();
    await expect(addDefaultSkill(drift.home, drift.target, {
      platformServices: drift.services,
      async beforeCommit() {
        await writeFile(join(drift.target, 'SKILL.md'), '---\nname: changed-skill\n---\n');
      }
    })).rejects.toMatchObject({ code: 'DEFAULT_SKILL_CHANGED' });
    expect(drift.links.size).toBe(0);

    const publishDrift = await setup();
    await expect(addDefaultSkill(publishDrift.home, publishDrift.target, {
      platformServices: publishDrift.services,
      async beforePublish() {
        await writeFile(
          join(publishDrift.target, 'SKILL.md'),
          '---\nname: changed-after-validation\n---\n'
        );
      }
    })).rejects.toMatchObject({ code: 'DEFAULT_SKILL_CHANGED' });
    expect(publishDrift.links.size).toBe(0);

    const busy = await setup();
    const busyServices: AddedSkillPlatformServices = {
      ...busy.services,
      async withLock() {
        throw new BazframeError('WINDOWS_OPERATION_LOCK_BUSY', 'busy');
      }
    };
    await expect(addDefaultSkill(busy.home, busy.target, { platformServices: busyServices }))
      .rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_BUSY' });
    expect(busy.links.size).toBe(0);
  });

  it('does not adapt an ambiguous present removal into success', async () => {
    const fixture = await setup();
    await addDefaultSkill(fixture.home, fixture.target, { platformServices: fixture.services });
    const ambiguous: AddedSkillPlatformServices = {
      ...fixture.services,
      async removeSkillLink() {
        throw new BazframeError('WINDOWS_ADDED_SKILL_REMOVE_AMBIGUOUS', 'present');
      }
    };
    await expect(removeDefaultSkill(fixture.home, 'demo-skill', { platformServices: ambiguous }))
      .rejects.toMatchObject({ code: 'WINDOWS_ADDED_SKILL_REMOVE_AMBIGUOUS' });
    expect(fixture.links.size).toBe(1);
    expect(await readFile(join(fixture.target, 'SKILL.md'), 'utf8')).toBe(fixture.skillBytes);
  });

  it('keeps active-profile selection outside the injected slice', async () => {
    const fixture = await setup();
    const { addActiveProfileSkill } = await import('../../../src/profiles/profile-skill-membership.js');
    await expect(addActiveProfileSkill(
      { bazframeHome: fixture.home, platformServices: fixture.services },
      'demo-skill'
    )).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_SKILL_EXPLICIT_PROFILE_REQUIRED' });
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bazframe-win-product-'));
  roots.push(root);
  const home = join(root, 'home');
  const enteredTarget = join(root, 'external', 'demo-skill');
  await mkdir(join(home, 'profiles', 'focused', 'skills'), { recursive: true });
  await mkdir(join(home, 'locks', 'profiles'), { recursive: true });
  await mkdir(enteredTarget, { recursive: true });
  const target = await realpath(enteredTarget);
  await writeFile(join(home, 'profiles', 'focused', 'AGENTS.md'), '# Focused\n');
  const skillBytes = '---\nname: demo-skill\n---\n# Demo\n';
  await writeFile(join(target, 'SKILL.md'), skillBytes);
  const links = new Map<string, string>();
  const canonicalPaths = new Map<string, string>();
  const linkGenerations = new Map<string, number>();
  const foreign = new Set<string>();
  const lockEvents: string[] = [];

  const services: AddedSkillPlatformServices = {
    async withLock(lockPath, _details, operation) {
      lockEvents.push(`enter:${lockPath}`);
      let held = true;
      const authority: AddedSkillMutationAuthority = {
        assertHeld() { if (!held) throw new Error('expired authority'); }
      };
      try { return await operation(authority); }
      finally { held = false; lockEvents.push(`exit:${lockPath}`); }
    },
    inspectPhysicalDirectory(path) {
      const proof = directory(path);
      return { ...proof, canonicalPath: canonicalPaths.get(path) ?? proof.canonicalPath };
    },
    inspectPrivateDirectory(path) { return directory(path); },
    ensurePrivateDirectory(parentPath, component) {
      const path = join(parentPath, component);
      if (!existsSync(path)) mkdirSync(path);
      return directory(path);
    },
    async enumeratePrivateDirectory(path, maxEntries) {
      if (!existsSync(path)) throw new BazframeError('WINDOWS_NATIVE_PATH_NOT_FOUND', 'absent');
      const names = new Set(readdirSync(path));
      for (const linkPath of links.keys()) if (dirname(linkPath) === path) names.add(linkPath.slice(path.length + 1));
      for (const linkPath of foreign) if (dirname(linkPath) === path) names.add(linkPath.slice(path.length + 1));
      const sorted = [...names].sort();
      if (sorted.length > maxEntries) throw new BazframeError('WINDOWS_TEST_LIMIT', 'limit');
      return {
        names: sorted,
        entries: sorted.map((name) => {
          const entry = join(path, name);
          return {
            name,
            directory: links.has(entry) || foreign.has(entry) || statSync(entry).isDirectory(),
            reparseTag: links.has(entry) || foreign.has(entry) ? 0xa0000003 : null
          };
        }),
        identity: namespaceIdentity(path, sorted, links, foreign, linkGenerations)
      };
    },
    async readStableUtf8File(path, _label, maxBytes) {
      const bytes = await readFile(path);
      if (bytes.byteLength > maxBytes) throw new Error('too large');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    },
    async readSkillLink(parentPath, skillId) {
      return inspectLink(
        join(parentPath, skillId),
        links,
        foreign,
        canonicalPaths,
        linkGenerations
      );
    },
    inspectSkillLink(parentPath, skillId, targetPath) {
      const state = inspectLink(
        join(parentPath, skillId),
        links,
        foreign,
        canonicalPaths,
        linkGenerations
      );
      if (state.kind === 'current' && state.targetPath !== targetPath) {
        throw new BazframeError('WINDOWS_TEST_WRONG_TARGET', 'wrong target');
      }
      return state;
    },
    async createSkillLink(authority, parentPath, skillId, targetPath) {
      authority.assertHeld();
      const path = join(parentPath, skillId);
      if (foreign.has(path)) throw new BazframeError('WINDOWS_TEST_FOREIGN_LINK', 'foreign');
      const previous = links.get(path);
      if (previous !== undefined && previous !== targetPath) throw new Error('occupied');
      links.set(path, targetPath);
      if (previous === undefined) linkGenerations.set(path, 1);
      return previous === undefined ? 'added' : 'current';
    },
    async removeSkillLink(authority, parentPath, skillId, targetPath) {
      authority.assertHeld();
      const path = join(parentPath, skillId);
      if (foreign.has(path)) throw new BazframeError('WINDOWS_TEST_FOREIGN_LINK', 'foreign');
      const previous = links.get(path);
      if (previous === undefined) return 'absent';
      if (previous !== targetPath) throw new Error('changed');
      links.delete(path);
      linkGenerations.delete(path);
      return 'removed';
    }
  };
  return {
    home,
    target,
    skillBytes,
    services,
    links,
    foreign,
    lockEvents,
    setCanonicalTarget(canonicalPath: string) { canonicalPaths.set(target, canonicalPath); },
    replaceLinkIdentity(path: string) {
      linkGenerations.set(path, (linkGenerations.get(path) ?? 0) + 1);
    }
  };
}

function directory(path: string) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new BazframeError('WINDOWS_NATIVE_PATH_NOT_FOUND', 'absent');
  }
  const stat = statSync(path, { bigint: true });
  return { canonicalPath: path, identity: `${stat.dev}:${stat.ino}` };
}

function inspectLink(
  path: string,
  links: Map<string, string>,
  foreign: Set<string>,
  canonicalPaths: Map<string, string>,
  linkGenerations: Map<string, number>
): AddedSkillLinkState {
  if (foreign.has(path)) throw new BazframeError('WINDOWS_TEST_FOREIGN_LINK', 'foreign');
  const targetPath = links.get(path);
  if (targetPath === undefined) return { kind: 'absent', identity: `absent:${path}` };
  return {
    kind: 'current',
    targetPath,
    canonicalTargetPath: canonicalPaths.get(targetPath) ?? targetPath,
    identity: `link:${path}:${targetPath}:${linkGenerations.get(path) ?? 0}`
  };
}

function namespaceIdentity(
  path: string,
  names: string[],
  links: Map<string, string>,
  foreign: Set<string>,
  linkGenerations: Map<string, number>
): string {
  const stat = statSync(path, { bigint: true });
  const material = names.map((name) => {
    const entry = join(path, name);
    return `${name}:${links.get(entry) ?? (foreign.has(entry) ? 'foreign' : 'physical')}:${linkGenerations.get(entry) ?? 0}`;
  }).join('\n');
  return createHash('sha256').update(`${stat.dev}:${stat.ino}\n${material}`).digest('hex');
}
