import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InheritedChildRunner } from '../../../src/core/external-editor.js';
import {
  editSkillDefinition,
  resolveSkillDefinitionEditorTarget
} from '../../../src/skills/skill-definition-editor.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('skill definition editor', () => {
  it('opens malformed provider content without parsing it and ignores disclosed preview paths', async () => {
    if (process.platform === 'win32') return;
    const value = await fixture();
    await writeFile(value.definition, Uint8Array.from([0xff, 0x00, 0xfe]));
    const environment = { VISUAL: '/editor path', EDITOR: 'ignored' };
    const childRunner = vi.fn<InheritedChildRunner>(async (_executable, args) => {
      await writeFile(args[0]!, '---\nname: demo-skill\ndescription: repaired\n---\n');
      return { exitCode: 0, signal: null };
    });

    await expect(editSkillDefinition({
      bazframeHome: value.home,
      skillId: 'demo-skill',
      environment,
      childRunner
    })).resolves.toEqual({ exitCode: 0, signal: null });

    expect(childRunner).toHaveBeenCalledWith(
      '/editor path',
      [value.definition],
      { cwd: value.provider, environment, ignoreParentSignals: ['SIGINT'] }
    );
    expect(await readFile(value.definition, 'utf8')).toContain('repaired');
  });

  it('allows an internal final SKILL.md symlink but rejects an escaping one', async () => {
    if (process.platform === 'win32') return;
    const internal = await fixture();
    const nested = join(internal.provider, 'definition.md');
    await writeFile(nested, 'repair me\n');
    await rm(internal.definition);
    await symlink(nested, internal.definition);
    await expect(resolveSkillDefinitionEditorTarget({
      bazframeHome: internal.home,
      skillId: 'demo-skill'
    })).resolves.toMatchObject({ definitionPath: nested, providerRoot: internal.provider });

    const escaping = await fixture();
    const outside = join(escaping.root, 'outside.md');
    await writeFile(outside, 'outside\n');
    await rm(escaping.definition);
    await symlink(outside, escaping.definition);
    await expect(resolveSkillDefinitionEditorTarget({
      bazframeHome: escaping.home,
      skillId: 'demo-skill'
    })).rejects.toThrow(/must remain within its provider root/u);
  });

  it('rejects registration, catalog, and provider substitutions before launch', async () => {
    if (process.platform === 'win32') return;

    const registrationSwap = await fixture();
    const otherProvider = join(registrationSwap.root, 'other', 'demo-skill');
    await mkdir(otherProvider, { recursive: true });
    await writeFile(join(otherProvider, 'SKILL.md'), 'other\n');
    const otherCanonical = await realpath(otherProvider);
    await expect(resolveSkillDefinitionEditorTarget({
      bazframeHome: registrationSwap.home,
      skillId: 'demo-skill',
      testHooks: {
        beforeRevalidate: async () => {
          await rm(registrationSwap.registration);
          await symlink(otherCanonical, registrationSwap.registration, 'dir');
        }
      }
    })).rejects.toThrow(/changed default skill registration/u);

    const catalogSwap = await fixture();
    const foreign = join(catalogSwap.root, 'foreign-catalog');
    await mkdir(foreign);
    await symlink(catalogSwap.provider, join(foreign, 'demo-skill'), 'dir');
    await expect(resolveSkillDefinitionEditorTarget({
      bazframeHome: catalogSwap.home,
      skillId: 'demo-skill',
      testHooks: {
        beforeRevalidate: async () => {
          await rename(join(catalogSwap.home, 'skills'), join(catalogSwap.home, 'skills-original'));
          await symlink(foreign, join(catalogSwap.home, 'skills'));
        }
      }
    })).rejects.toThrow(/physical directory/u);

    const providerSwap = await fixture();
    await expect(resolveSkillDefinitionEditorTarget({
      bazframeHome: providerSwap.home,
      skillId: 'demo-skill',
      testHooks: {
        beforeRevalidate: async () => {
          await rename(providerSwap.provider, `${providerSwap.provider}-original`);
          await mkdir(providerSwap.provider);
          await writeFile(providerSwap.definition, 'replacement\n');
        }
      }
    })).rejects.toThrow(/changed default skill registration/u);
  });

  it('rejects physical registrations, noncanonical targets, missing definitions, and invalid IDs', async () => {
    if (process.platform === 'win32') return;
    const physical = await fixture();
    await rm(physical.registration);
    await mkdir(physical.registration);
    await expect(resolveSkillDefinitionEditorTarget({
      bazframeHome: physical.home,
      skillId: 'demo-skill'
    })).rejects.toThrow(/occupied/u);

    const missing = await fixture();
    await rm(missing.definition);
    await expect(resolveSkillDefinitionEditorTarget({
      bazframeHome: missing.home,
      skillId: 'demo-skill'
    })).rejects.toThrow(/definition does not exist/u);

    await expect(resolveSkillDefinitionEditorTarget({
      bazframeHome: missing.home,
      skillId: '../demo-skill'
    })).rejects.toThrow(/Invalid skill ID/u);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bazframe-skill-editor-'));
  roots.push(root);
  const home = join(root, 'home');
  const provider = join(root, 'provider', 'demo-skill');
  const definition = join(provider, 'SKILL.md');
  const registration = join(home, 'skills', 'demo-skill');
  await mkdir(join(home, 'skills'), { recursive: true });
  await mkdir(provider, { recursive: true });
  await writeFile(definition, '---\nname: demo-skill\ndescription: test\n---\n');
  const canonicalProvider = await realpath(provider);
  const canonicalDefinition = await realpath(definition);
  await symlink(canonicalProvider, registration, 'dir');
  return { root, home, provider: canonicalProvider, definition: canonicalDefinition, registration };
}
