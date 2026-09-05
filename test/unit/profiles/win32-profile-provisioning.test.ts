import { describe, expect, it } from 'vitest';
import { BazframeError } from '../../../src/core/errors.js';
import { addProfile, listProfiles } from '../../../src/profiles/profile-management.js';
import {
  createWindowsProfileProvisioningServicesForInternalTesting,
  type WindowsProfileProvisioningTestOptions
} from '../../../src/profiles/win32-profile-provisioning.js';
import { ensureWindowsPrivateDirectoryPath } from '../../../src/state/win32-private-directory.js';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';

const HOME = 'C:\\boundary\\missing\\home';
function fixture(options: WindowsProfileProvisioningTestOptions = {}) {
  const storage = windowsProvisioningFixture();
  const createServices = (overrides: WindowsProfileProvisioningTestOptions = {}) =>
    createWindowsProfileProvisioningServicesForInternalTesting(storage.backend, {
      publicationIo: storage.io, lockIo: storage.io, ...options, ...overrides
    });
  return { ...storage, createServices, provisioningServices: createServices() };
}

describe('internal Windows inactive profile provisioning', () => {
  it('lists absent state without bootstrapping, locking, or recovery', async () => {
    const f = fixture();
    const before = f.snapshot();
    expect(await listProfiles(HOME, f)).toEqual({ profileIds: [], diagnostics: [] });
    expect(f.snapshot()).toBe(before);
    expect(f.writes).toEqual([]);
  });

  it('bootstraps missing intermediates and publishes exactly empty physical profile content', async () => {
    const f = fixture();
    expect(await addProfile(HOME, 'focused', f)).toMatchObject({ action: 'added' });
    const profile = `${HOME}\\profiles\\focused`;
    expect([...f.nodes.keys()].filter((path) => path.startsWith(`${profile}\\`))).toEqual([
      `${profile}\\AGENTS.md`, `${profile}\\skills`
    ]);
    expect(f.nodes.get(`${profile}\\AGENTS.md`)?.bytes).toEqual(Buffer.alloc(0));
    expect(f.nodes.get(`${profile}\\skills`)?.kind).toBe('directory');
    expect(f.nodes.has(`${HOME}\\active-profile`)).toBe(false);
    expect(f.nodes.has(`${HOME}\\profile-favorites.json`)).toBe(false);
    expect(await addProfile(HOME, 'focused', f)).toMatchObject({ action: 'current' });
    await addProfile(HOME, 'alpha', f);
    expect(await listProfiles(HOME, f)).toEqual({ profileIds: ['alpha', 'focused'], diagnostics: [] });
  });

  it('preserves edited profile bytes, unrelated state, and exact CRLF selection on current and new add', async () => {
    const f = fixture();
    await addProfile(HOME, 'focused', f);
    const instructions = `${HOME}\\profiles\\focused\\AGENTS.md`;
    f.nodes.get(instructions)!.bytes = Buffer.from('# Personal\n');
    f.file(`${HOME}\\active-profile`, 'focused\r\n');
    f.file(`${HOME}\\profile-favorites.json`, 'opaque favorites');
    const identity = f.nodes.get(instructions)!.id;
    expect(await addProfile(HOME, 'focused', f)).toMatchObject({ action: 'current' });
    await addProfile(HOME, 'alpha', f);
    expect(f.nodes.get(instructions)).toMatchObject({ id: identity, bytes: Buffer.from('# Personal\n') });
    expect(f.nodes.get(`${HOME}\\active-profile`)?.bytes?.toString()).toBe('focused\r\n');
    expect(f.nodes.get(`${HOME}\\profile-favorites.json`)?.bytes?.toString()).toBe('opaque favorites');
  });

  it.each(['focused\nextra', 'focused\0', '', 'CON', 'x'.repeat(1025)])('refuses invalid bounded active bytes %j without publishing', async (bytes) => {
    const f = fixture();
    ensureWindowsPrivateDirectoryPath(f.backend, HOME);
    f.file(`${HOME}\\active-profile`, bytes);
    await expect(addProfile(HOME, 'focused', f)).rejects.toThrow();
    expect(f.nodes.has(`${HOME}\\profiles\\focused`)).toBe(false);
    expect(f.nodes.get(`${HOME}\\active-profile`)?.bytes?.toString()).toBe(bytes);
  });

  it('refuses a dangling destination selection and occupied alias cache without replacing either', async () => {
    for (const cache of [false, true]) {
      const f = fixture();
      ensureWindowsPrivateDirectoryPath(f.backend, HOME);
      if (cache) ensureWindowsPrivateDirectoryPath(f.backend, `${HOME}\\adapter-cache\\pi\\skill-aliases\\focused`);
      else f.file(`${HOME}\\active-profile`, 'focused\n');
      await expect(addProfile(HOME, 'focused', f)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_PROVISIONING_REFUSED' });
      expect(f.nodes.has(`${HOME}\\profiles\\focused`)).toBe(false);
    }
  });

  it.each(['CON', 'bad.', 'bad:stream'])('rejects Windows-reserved profile ID %s before bootstrap', async (id) => {
    const f = fixture();
    await expect(addProfile(HOME, id, f)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });

  it('refuses existing unsafe home unchanged and does not repair ACLs', async () => {
    const f = fixture();
    f.reparse('C:\\boundary\\home');
    const before = f.snapshot();
    await expect(addProfile('C:\\boundary\\home', 'focused', f)).rejects.toThrow();
    expect(f.snapshot()).toBe(before);
  });

  it('refuses case-alias profile destinations and preserves invalid occupants', async () => {
    const f = fixture();
    await addProfile(HOME, 'alpha', f);
    f.directory(`${HOME}\\profiles\\Focused`);
    await expect(addProfile(HOME, 'focused', f)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_PROVISIONING_REFUSED' });
    f.file(`${HOME}\\profiles\\occupied`, 'keep');
    await expect(addProfile(HOME, 'occupied', f)).rejects.toThrow();
    expect(f.nodes.get(`${HOME}\\profiles\\occupied`)?.bytes?.toString()).toBe('keep');
  });

  it.each(['PLANNED', 'CANDIDATE_READY', 'CANDIDATE_RENAME_INTENT', 'CANDIDATE_RENAME_PROVEN', 'DEPENDENT_STATE_PROVEN', 'COMMITTED'] as const)(
    'retries fresh publication interrupted at %s under the same state lock', async (phase) => {
      const f = fixture({ hooks: { afterPhase(observed) { if (observed === phase) throw new Error('interrupted'); } } });
      await expect(addProfile(HOME, 'focused', f)).rejects.toThrow('interrupted');
      const beforeList = f.snapshot();
      await listProfiles(HOME, f);
      expect(f.snapshot()).toBe(beforeList);
      const retry = { provisioningServices: f.createServices({ hooks: {} }) };
      expect(await addProfile(HOME, 'focused', retry)).toMatchObject({
        action: ['PLANNED', 'CANDIDATE_READY'].includes(phase) ? 'added' : 'current'
      });
      expect(await listProfiles(HOME, retry)).toMatchObject({ profileIds: ['focused'] });
    }
  );

  it('reconciles interruption immediately after final rename without replacing the complete live profile', async () => {
    const f = fixture({ hooks: { afterCandidateRename() { throw new Error('interrupted'); } } });
    await expect(addProfile(HOME, 'focused', f)).rejects.toThrow('interrupted');
    const liveId = f.nodes.get(`${HOME}\\profiles\\focused`)?.id;
    const retry = { provisioningServices: f.createServices({ hooks: {} }) };
    expect(await addProfile(HOME, 'focused', retry)).toMatchObject({ action: 'current' });
    expect(f.nodes.get(`${HOME}\\profiles\\focused`)?.id).toBe(liveId);
  });

  it('retains pre-effect sharing failures and converges on retry without replacement', async () => {
    const f = fixture();
    const blocked = { provisioningServices: f.createServices({ publicationIo: {
      ...f.io, async rename() { throw new BazframeError('WINDOWS_NATIVE_SHARING_VIOLATION', 'sharing'); }
    } }) };
    await expect(addProfile(HOME, 'focused', blocked)).rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_PUBLICATION_RETRY_REQUIRED' });
    expect(f.nodes.has(`${HOME}\\profiles\\focused`)).toBe(false);
    expect(await addProfile(HOME, 'focused', f)).toMatchObject({ action: 'current' });
  });

  it('refuses a changed recovery candidate and retains the entire private ambiguity', async () => {
    const f = fixture({ hooks: { afterPhase(phase) { if (phase === 'CANDIDATE_RENAME_INTENT') throw new Error('interrupted'); } } });
    await expect(addProfile(HOME, 'focused', f)).rejects.toThrow();
    const candidate = [...f.nodes.keys()].find((path) => path.includes('.bazframe-candidate-') && path.endsWith('AGENTS.md'))!;
    f.nodes.get(candidate)!.bytes = Buffer.from('unexpected');
    const retry = { provisioningServices: f.createServices({ hooks: {} }) };
    await expect(addProfile(HOME, 'focused', retry)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_PROVISIONING_REFUSED' });
    expect(f.nodes.get(candidate)!.bytes?.toString()).toBe('unexpected');
    expect(f.nodes.has(`${HOME}\\profiles\\focused`)).toBe(false);
  });

  it('refuses an incomplete own journal instead of treating its name as authority', async () => {
    const f = fixture();
    const root = `${HOME}\\windows-transactions\\profile-add\\focused\\${'a'.repeat(32)}`;
    ensureWindowsPrivateDirectoryPath(f.backend, root);
    f.file(`${root}\\00000000.json`, '{}');
    await expect(addProfile(HOME, 'focused', f)).rejects.toThrow();
    expect(f.nodes.get(`${root}\\00000000.json`)?.bytes?.toString()).toBe('{}');
    expect(f.nodes.has(`${HOME}\\profiles\\focused`)).toBe(false);
  });

  it('requires owner-private single-link active state and retains unsafe bytes unchanged', async () => {
    for (const mode of ['owner', 'hardlink', 'reparse']) {
      const f = fixture();
      ensureWindowsPrivateDirectoryPath(f.backend, HOME);
      const path = `${HOME}\\active-profile`;
      if (mode === 'reparse') f.reparse(path);
      else {
        f.file(path, 'other\n');
        if (mode === 'hardlink') f.nodes.get(path)!.numberOfLinks = 2;
        else f.nodes.get(path)!.security = { ...f.backend.inspectPath(path).security, ownerSid: 'S-1-5-18' };
      }
      const state = JSON.stringify(f.nodes.get(path));
      await expect(addProfile(HOME, 'focused', f)).rejects.toThrow();
      expect(JSON.stringify(f.nodes.get(path))).toBe(state);
      expect(f.nodes.has(`${HOME}\\profiles\\focused`)).toBe(false);
    }
  });

  it('re-admits cooperative bootstrap occupancy, but never reuses an ambiguous creation receipt', () => {
    const f = fixture();
    const create = f.backend.createPrivateDirectory;
    f.backend.createPrivateDirectory = (parent, name) => {
      create(parent, name);
      throw new BazframeError('WINDOWS_NATIVE_DIRECTORY_OCCUPIED', 'cooperator won');
    };
    expect(ensureWindowsPrivateDirectoryPath(f.backend, HOME).kind).toBe('directory');
    const other = fixture();
    const createOther = other.backend.createPrivateDirectory;
    other.backend.createPrivateDirectory = (parent, name) => {
      createOther(parent, name);
      throw new BazframeError('WINDOWS_NATIVE_CREATE_AMBIGUOUS', 'uncertain');
    };
    expect(() => ensureWindowsPrivateDirectoryPath(other.backend, HOME)).toThrow();
    expect(other.nodes.has('C:\\boundary\\missing')).toBe(true);
    expect(other.nodes.has(HOME)).toBe(false);
  });

  it('retains first-visible private creation after ancestor identity substitution', () => {
    const f = fixture();
    const create = f.backend.createPrivateDirectory;
    f.backend.createPrivateDirectory = (parent, name) => {
      const receipt = create(parent, name);
      f.nodes.get(parent)!.id += 100;
      return receipt;
    };
    expect(() => ensureWindowsPrivateDirectoryPath(f.backend, HOME)).toThrow();
    expect(f.nodes.has('C:\\boundary\\missing')).toBe(true);
    expect(f.nodes.has(HOME)).toBe(false);
  });

  it('retains malformed and foreign recovery entries privately without publishing', async () => {
    const f = fixture();
    const root = `${HOME}\\windows-transactions\\profile-add\\focused`;
    ensureWindowsPrivateDirectoryPath(f.backend, root);
    f.directory(`${root}\\foreign`);
    await expect(addProfile(HOME, 'focused', f)).rejects.toMatchObject({ code: 'WINDOWS_PROFILE_PROVISIONING_REFUSED' });
    expect(f.nodes.has(`${root}\\foreign`)).toBe(true);
    expect(f.nodes.has(`${HOME}\\profiles\\focused`)).toBe(false);
  });
});
