import { isRetainedResourceFile } from '../skill-collections/resource-identity.js';
import { createHash } from 'node:crypto';
import { stableWindowsMembershipLinkInspection, stableWindowsPathInspection } from '../core/win32-stable-observation.js';
import { win32 } from 'node:path';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend, WindowsDirectoryEntryObservation, WindowsPathInspection } from '../core/win32-native.js';
import { BazframeError } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { readWindowsPhysicalFileSnapshot } from '../profiles/win32-profile-selection.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting, enumerateWindowsPhysicalDirectory } from '../skills/added-skill-platform-services.js';
import { readDefaultSkillRegistration } from '../skills/default-skill-catalog.js';
import { requireDirectChild, requireEntryMatchesObject } from '../state/win32-directory-closure.js';
import { admitWindowsPhysicalDirectory, admitWindowsPhysicalFile, isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { capturePhysicalProfileAtPath, samePhysicalProfileExpectation, serializeWindowsPhysicalProfileProof, type PhysicalProfileReadServices, type PhysicalProfileExpectation } from './physical-profile-closure.js';
import { windowsPhysicalIdentityText } from './profile-filesystem.js';
import type { ManagedProfileActivationServices } from './profile-managed-lifecycle.js';
import { capturedProfileLimitPolicy, type CapturedProfileLimitPolicy } from './profile-publishing-policy.js';
import { decodeManagedProfileStateBytes, publicationSidecarName } from './publication-state.js';
import type { ManagedProfileStateContentSnapshot } from './managed-profile-state.js';
import { decodeWindowsExecutableMetadata, WINDOWS_EXECUTABLE_METADATA } from './win32-profile-executable.js';

/** One capture-local observation scope. Reparse classification never follows a failed physical admission. */
export function createWindowsPhysicalReads(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend, profileRoot?: string, lower: Partial<CapturedProfileLimitPolicy> = {}): PhysicalProfileReadServices {
  const policy = capturedProfileLimitPolicy(lower);
  const admitDirectory = admitWindowsPhysicalDirectory;
  const platform = createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
  const listed = new Map<string, { parent: WindowsPathInspection; entry: WindowsDirectoryEntryObservation }>();
  const observed = new Map<string, string>();
  const portableEntries = new Map<string, { path: string; entry: WindowsDirectoryEntryObservation }>();
  let modeMappings: Array<{ path: string; executable: boolean }> = [];
  let cachedModes: Map<string, boolean> | undefined;
  const normalize = (path: string) => win32.normalize(path);
  function observe(path: string, value: unknown) {
    const exact = JSON.stringify(value);
    if (observed.has(path) && observed.get(path) !== exact) throw changed();
    observed.set(path, exact);
  }
  async function enumerate(path: string, max: number) {
    const value = await enumerateWindowsPhysicalDirectory(backend, path, max);
    observe(`${path}:enumeration`, { ...value, inspection: stableWindowsPathInspection(value.inspection) });
    for (const entry of value.nativeEntries) {
      const child = normalize(win32.join(path, entry.name));
      listed.set(child, { parent: value.inspection, entry }); portableEntries.set(portable(child), { path: child, entry });
    }
    return value;
  }
  async function reconcile(path: string, inspection: WindowsPathInspection, kind: 'file' | 'directory') {
    if (!listed.has(normalize(path))) await enumerate(win32.dirname(path), policy.maxEntries);
    const entry = listed.get(normalize(path));
    if (entry === undefined) throw changed();
    requireDirectChild(entry.parent, inspection, entry.entry.name);
    requireEntryMatchesObject(entry.entry, inspection.object, kind === 'directory' ? 'entry-vs-directory-open' : 'entry-vs-file-open');
  }
  async function rawFile(path: string, max: number) {
    const snapshot = await readWindowsPhysicalFileSnapshot(backend, path, max);
    await reconcile(path, snapshot.inspection, 'file');
    observe(path, stableWindowsPathInspection(snapshot.inspection));
    observe(`${path}:bytes`, createHash('sha256').update(snapshot.bytes).digest('hex'));
    return snapshot.bytes;
  }
  async function mode(path: string): Promise<boolean> {
    if (profileRoot === undefined || path === win32.join(profileRoot, WINDOWS_EXECUTABLE_METADATA)) return false;
    const relative = win32.relative(profileRoot, path).split('\\').join('/');
    if (relative !== 'AGENTS.md' && !relative.startsWith('skills/')) return false;
    if (cachedModes === undefined) {
      const names = (await enumerate(profileRoot, policy.maxEntries)).names;
      const files = names.includes(WINDOWS_EXECUTABLE_METADATA)
        ? decodeWindowsExecutableMetadata(await rawFile(win32.join(profileRoot, WINDOWS_EXECUTABLE_METADATA), policy.maxManifestBytes), policy).files : [];
      cachedModes = new Map(files.map((entry) => [entry.path, entry.executable]));
    }
    return cachedModes.get(relative) ?? false;
  }
  return {
    collectionReferenceBytes: true,
    async retainedRootFile(path, name) { if (!/^resource-[a-f0-9]{32}\.tmp$/u.test(name)) return false; await reconcile(path, admitWindowsPhysicalFile(backend, path), 'file'); return true; },
    async retainedCollectionFile(path, name) { if (!isRetainedResourceFile(name)) return false; await reconcile(path, admitWindowsPhysicalFile(backend, path), 'file'); return true; },
    ...(profileRoot === undefined ? {} : { rootMetadata: { name: WINDOWS_EXECUTABLE_METADATA, validate(bytes: Buffer, limits: CapturedProfileLimitPolicy) { modeMappings = decodeWindowsExecutableMetadata(bytes, limits).files; return modeMappings.length; },
      validateClosure() {
        for (const mapping of modeMappings) {
          const parts = mapping.path.split('/');
          for (let length = 1; length <= parts.length; length++) {
            const path = win32.join(profileRoot, ...parts.slice(0, length)); const actual = portableEntries.get(portable(path));
            if (actual !== undefined && (actual.path !== path || actual.entry.reparseTag !== null || actual.entry.directory !== (length < parts.length))) throw changed();
          }
        }
      } } }),
    async openDirectory(path, trustedRoot) {
      const before = admitDirectory(backend, path);
      await reconcile(path, before, 'directory'); observe(path, stableWindowsPathInspection(before));
      return { identity: windowsPhysicalIdentityText(before.object.volumeIdentity, before.object.fileId), trustedRoot,
        childPath: (name) => win32.join(path, name),
        async enumerate(max) { return (await enumerate(path, max)).names; },
        async assertStable() { observe(path, stableWindowsPathInspection(admitDirectory(backend, path))); },
        async close() { /* Native bounded handles are already closed. */ }
      };
    },
    async readFile(path, max) { return { bytes: await rawFile(path, max), executable: await mode(path) }; },
    async inspectKind(path) {
      if (!listed.has(normalize(path))) await enumerate(win32.dirname(path), policy.maxEntries);
      const listedEntry = listed.get(normalize(path));
      if (listedEntry === undefined) throw changed();
      const entry = listedEntry.entry;
      // Only the shared closure's exact membership branch may inspect this reparse.
      if (entry.reparseTag !== null) return 'link';
      const inspection = backend.inspectPath(path);
      await reconcile(path, inspection, entry.directory ? 'directory' : 'file');
      observe(path, stableWindowsPathInspection(inspection));
      return inspection.kind === 'directory' ? 'directory' : inspection.kind === 'regular-file' ? 'file' : 'other';
    },
    async membershipIdentity(home, path, name) {
      const native = backend.inspectMembershipLink(path);
      const entry = listed.get(normalize(path));
      if (entry === undefined) throw changed();
      requireEntryMatchesObject(entry.entry, native.object, 'entry-vs-directory-open');
      observe(`${path}:native-link`, stableWindowsMembershipLinkInspection(native));
      const registration = await readDefaultSkillRegistration(home, name, { platformServices: platform });
      const catalog = platform.inspectSkillLink(win32.join(home, 'skills'), name, registration.target);
      const link = platform.inspectSkillLink(win32.dirname(path), name, registration.target);
      if (catalog.kind !== 'current' || link.kind !== 'current') throw changed();
      observe(`catalog:${name}`, { registration, catalog }); observe(`${path}:membership`, link);
      return `catalog:skill:${name}`;
    }
  };
}

export function createWindowsOrdinaryProfileReads(backend: BazframeWin32NativeBackend & BazframeWin32LockBackend): Pick<ManagedProfileActivationServices, 'captureExpectation' | 'assertExpectation'> & {
  captureSibling(home: string, name: string, component: string, limits?: Partial<CapturedProfileLimitPolicy>, hooks?: { beforeSecondPass?: () => Promise<void> }): Promise<PhysicalProfileExpectation | undefined>;
  readManagedState(home: string, name: string, limits?: Partial<CapturedProfileLimitPolicy>): Promise<ManagedProfileStateContentSnapshot | undefined>;
} {
  const enumerate = (path: string) => enumerateWindowsPhysicalDirectory(backend, path, PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries);
  async function captureSibling(home: string, profileName: string, component: string, limits = {}, hooks = {}): Promise<PhysicalProfileExpectation | undefined> {
    if (!isSafeProfileId(profileName) || !isValidWindowsPathComponent(profileName)
      || !(isSafeProfileId(component) && isValidWindowsPathComponent(component)) && !/^\.bazframe-(?:candidate|backup)-[a-f0-9]{32}$/u.test(component)) throw unsupported();
    const path = win32.join(home, 'profiles'); const profiles = await enumerate(path);
    const matches = profiles.names.filter((name) => portable(name) === portable(component));
    if (matches.length === 0) return undefined;
    if (matches.length !== 1 || matches[0] !== component) throw changed();
    const root = win32.join(path, component);
    const expectation = await capturePhysicalProfileAtPath(home, root, profileName, limits, hooks, createWindowsPhysicalReads(backend, root, limits));
    if ((await enumerate(path)).identity !== profiles.identity) throw changed();
    return { closure: expectation.closure, ...serializeWindowsPhysicalProfileProof(expectation) };
  }
  const capture: ManagedProfileActivationServices['captureExpectation'] = async (home, profileName, limits, hooks) => {
    const value = await captureSibling(home, profileName, profileName, limits, hooks);
    if (value === undefined) throw changed(); return value;
  };
  return { captureExpectation: capture, captureSibling,
    async assertExpectation(home, name, expected) { if (!samePhysicalProfileExpectation(await capture(home, name), expected)) throw changed(); },
    async readManagedState(home, name, lower = {}) {
      if (!isSafeProfileId(name) && !/^\.bazframe-(?:candidate|backup)-[a-f0-9]{32}$/u.test(name)) throw unsupported();
      const policy = capturedProfileLimitPolicy(lower); const root = win32.join(home, 'profiles', name);
      const reads = createWindowsPhysicalReads(backend, root, policy); const directory = await reads.openDirectory(root, home);
      const names = await directory.enumerate(policy.maxEntries);
      if (!names.includes(publicationSidecarName())) return undefined;
      const file = await reads.readFile(directory.childPath(publicationSidecarName()), policy.maxManifestBytes);
      await directory.assertStable();
      return { state: decodeManagedProfileStateBytes(file.bytes, policy), bytes: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') };
    }
  };
}
function portable(value: string): string { return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase(); }
function unsupported(): BazframeError { return new BazframeError('WINDOWS_PROFILE_ACTIVATION_UNSUPPORTED_STATE', 'Unsupported Windows profile state was preserved.'); }
function changed(): BazframeError { return new BazframeError('WINDOWS_PROFILE_ACTIVATION_CHANGED', 'Physical profile observations changed or authority expired.'); }
