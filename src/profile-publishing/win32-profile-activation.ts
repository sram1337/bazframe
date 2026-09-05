import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { BazframeWin32NativeBackend, BazframeWin32LockBackend, WindowsDirectoryEntryObservation, WindowsPathInspection } from '../core/win32-native.js';
import { BazframeError } from '../core/errors.js';
import { PROFILE_PORTABILITY_PRODUCTION_LIMITS } from '../profile-portability/profile-portability-policy.js';
import { isSafeProfileId } from '../profiles/profile-id.js';
import { readWindowsPrivateFileSnapshot, readWindowsSelectionSnapshot } from '../profiles/win32-profile-selection.js';
import { createWindowsAddedSkillPlatformServicesForInternalTesting, enumerateWindowsPrivateDirectory } from '../skills/added-skill-platform-services.js';
import { inspectDefaultSkillCatalog, readDefaultSkillRegistration } from '../skills/default-skill-catalog.js';
import { requireDirectChild, requireEntryMatchesObject } from '../state/win32-directory-closure.js';
import { profilePublishingOperationLockRoot } from '../state/paths.js';
import { publishWindowsSelection, type WindowsSelectionPublicationIo, type WindowsSelectionPublicationHooks } from '../state/win32-atomic-file.js';
import { withWindowsOperationLock, type WindowsOperationLockIo } from '../state/win32-operation-lock.js';
import { admitWindowsPrivateDirectory, ensureWindowsPrivateDirectoryPath, isValidWindowsPathComponent } from '../state/win32-private-directory.js';
import { capturePhysicalProfileExpectation, samePhysicalProfileExpectation, type PhysicalProfileReadServices } from './physical-profile-closure.js';
import type { ManagedProfileActivationServices, ManagedProfileActivationAuthority } from './profile-managed-lifecycle.js';
import { orderedProfileOperationKeys } from './profile-operation-lock.js';
import { readProfileSystemView, type ProfileSystemViewReadServices } from './profile-view.js';
import { isReservedProfileSiblingName, publicationSidecarName } from './publication-state.js';

export interface WindowsProfileActivationTestOptions {
  selectionIo?: WindowsSelectionPublicationIo;
  lockIo?: WindowsOperationLockIo;
  hooks?: WindowsSelectionPublicationHooks & {
    afterOperationLock?(key: string): void | Promise<void>;
    afterStateLock?(): void | Promise<void>;
    beforeReturn?(): void | Promise<void>;
  };
}

/** Internal healthy ordinary-profile composition; never constructed by public dispatch. */
export function createWindowsProfileActivationServicesForInternalTesting(
  backend: BazframeWin32NativeBackend & BazframeWin32LockBackend,
  options: WindowsProfileActivationTestOptions = {}
): ManagedProfileActivationServices {
  const platformServices = createWindowsAddedSkillPlatformServicesForInternalTesting(backend);
  const enumerate = (path: string, max: number = PROFILE_PORTABILITY_PRODUCTION_LIMITS.stagingEntries) => enumerateWindowsPrivateDirectory(backend, path, max);
  async function requireAbsentOrEmpty(home: string, component: string) {
    const root = await enumerate(home);
    const found = root.names.find((name) => portable(name) === portable(component));
    if (found === undefined) return;
    if (found !== component || (await enumerate(win32.join(home, component))).names.length !== 0) throw unsupported();
  }
  function physicalReads(profiles: Awaited<ReturnType<typeof enumerate>>, profilesPath: string): PhysicalProfileReadServices {
    const listed = new Map<string, { parent: WindowsPathInspection; entry: WindowsDirectoryEntryObservation }>();
    const list = (path: string, value: Awaited<ReturnType<typeof enumerate>>) => {
      for (const entry of value.nativeEntries) listed.set(win32.normalize(win32.join(path, entry.name)), { parent: value.inspection, entry });
    };
    list(profilesPath, profiles);
    const reconcile = (path: string, inspection: WindowsPathInspection, kind: 'file' | 'directory') => {
      const entry = listed.get(win32.normalize(path));
      if (entry === undefined) throw changed();
      requireDirectChild(entry.parent, inspection, entry.entry.name);
      requireEntryMatchesObject(entry.entry, inspection.object, kind === 'directory' ? 'entry-vs-directory-open' : 'entry-vs-file-open');
    };
    // Physical authorization evidence is additional to, never a replacement for, canonical closure entries.
    const observed = new Map<string, string>();
    function observe(path: string, value: unknown) {
      const exact = JSON.stringify(value);
      if (observed.has(path) && observed.get(path) !== exact) throw changed();
      observed.set(path, exact);
    }
    return {
      async openDirectory(path, trustedRoot) {
        const before = admitWindowsPrivateDirectory(backend, path);
        reconcile(path, before, 'directory');
        observe(path, before);
        return {
          identity: `${before.object.volumeIdentity}:${before.object.fileId}`, trustedRoot,
          childPath: (name) => win32.join(path, name),
          async enumerate(max) {
            const value = await enumerate(path, max);
            list(path, value);
            observe(`${path}:enumeration`, value);
            return value.names;
          },
          async assertStable() { observe(path, admitWindowsPrivateDirectory(backend, path)); },
          async close() { /* Native calls have already closed their bounded handles. */ }
        };
      },
      async readFile(path, maxBytes) {
        // Sidecars, collection references, and profile-local materialization are deferred, not ignored.
        if (win32.basename(path) !== 'AGENTS.md') throw unsupported();
        const snapshot = await readWindowsPrivateFileSnapshot(backend, path, maxBytes);
        reconcile(path, snapshot.inspection, 'file');
        observe(path, snapshot);
        return { bytes: snapshot.bytes, executable: false };
      },
      async inspectKind(path) {
        // Only the accepted exact junction representation is admitted in this slice.
        const link = backend.inspectMembershipLink(path);
        const entry = listed.get(win32.normalize(path));
        if (entry === undefined) throw changed();
        requireEntryMatchesObject(entry.entry, link.object, 'entry-vs-directory-open');
        observe(`${path}:native-link`, link);
        return 'link';
      },
      async membershipIdentity(home, path, name) {
        const registration = await readDefaultSkillRegistration(home, name, { platformServices });
        const catalog = platformServices.inspectSkillLink(win32.join(home, 'skills'), name, registration.target);
        const link = platformServices.inspectSkillLink(win32.dirname(path), name, registration.target);
        if (catalog.kind !== 'current' || link.kind !== 'current') throw changed();
        observe(`catalog:${name}`, { registration, catalog });
        observe(path, link);
        return `catalog:skill:${name}`;
      },
      observationIdentity() { return createHash('sha256').update('bazframe-win32-profile-observations-v1\0').update(JSON.stringify([...observed].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex'); }
    };
  }
  const capture: ManagedProfileActivationServices['captureExpectation'] = async (home, profileName, limits, hooks) => {
    if (!isSafeProfileId(profileName) || !isValidWindowsPathComponent(profileName)) throw unsupported();
    const profiles = await enumerate(win32.join(home, 'profiles'));
    if (!profiles.names.includes(profileName)) throw changed();
    const expectation = await capturePhysicalProfileExpectation(home, profileName, limits, hooks, physicalReads(profiles, win32.join(home, 'profiles')));
    if ((await enumerate(win32.join(home, 'profiles'))).identity !== profiles.identity) throw changed();
    return { ...expectation, observationIdentity: createHash('sha256').update(profiles.identity).update(expectation.observationIdentity!).digest('hex') };
  };
  const assertExpectation: ManagedProfileActivationServices['assertExpectation'] = async (home, name, expected) => {
    if (!samePhysicalProfileExpectation(await capture(home, name), expected)) throw changed();
  };
  const viewReads: ProfileSystemViewReadServices = {
    async scanProfileNames(home) {
      const entries = await enumerate(win32.join(home, 'profiles'));
      const names = entries.names.filter((name) => {
        if (isSafeProfileId(name) && isValidWindowsPathComponent(name)) return true;
        if (!isReservedProfileSiblingName(name)) throw unsupported();
        return false;
      });
      if (names.length > PROFILE_PORTABILITY_PRODUCTION_LIMITS.profileNamespaceEntries) throw unsupported();
      return names;
    },
    captureExpectation: capture, assertExpectation,
    async readManagedState(home, name) {
      const entries = await enumerate(win32.join(home, 'profiles', name));
      if (entries.names.some((entry) => portable(entry) === portable(publicationSidecarName()))) throw unsupported();
      return undefined;
    },
    async inspectCatalog(home) {
      const catalog = await inspectDefaultSkillCatalog(home, { platformServices });
      if (catalog.diagnostics.length !== 0) throw unsupported();
      return catalog;
    },
    async scanCollections(home) {
      for (const name of ['libraries', 'packages', 'providers']) await requireAbsentOrEmpty(home, name);
      const root = await enumerate(home);
      const publishing = root.names.find((name) => portable(name) === 'profile-publishing');
      if (publishing !== undefined) {
        if (publishing !== 'profile-publishing') throw unsupported();
        const path = win32.join(home, publishing);
        const entries = await enumerate(path);
        for (const name of entries.names) {
          if (name === 'operation-locks') continue;
          if (!['blobs', 'trees', 'staging', 'transactions'].includes(name)) throw unsupported();
          await requireAbsentOrEmpty(path, name);
        }
      }
      return { records: [], diagnostics: [] };
    }
  };
  return {
    captureExpectation: capture, assertExpectation,
    async readSystemView(home) {
      const before = await enumerate(win32.join(home, 'profiles'));
      const view = await readProfileSystemView(home, viewReads);
      if ((await enumerate(win32.join(home, 'profiles'))).identity !== before.identity) throw changed();
      return view;
    },
    async withOperationLocks<T>(home: string, keys: readonly string[], transactionId: string, operation: (authority: ManagedProfileActivationAuthority) => Promise<T>): Promise<T> {
      const ordered = orderedProfileOperationKeys(keys, transactionId);
      const admitted = admitWindowsPrivateDirectory(backend, home);
      const root = win32.normalize(profilePublishingOperationLockRoot(home));
      ensureWindowsPrivateDirectoryPath(backend, root);
      const held: Array<{ assertHeld(): void }> = [];
      let active = true;
      const authority = { assertHeld(requestedHome?: string, profileName?: string) {
        if ((requestedHome !== undefined && win32.normalize(requestedHome) !== win32.normalize(home))
          || (profileName !== undefined && (!ordered.includes('@store') || !ordered.includes(profileName)))) throw changed();
        if (!active || held.length !== ordered.length) throw changed();
        const current = admitWindowsPrivateDirectory(backend, home);
        if (current.canonicalPath !== admitted.canonicalPath || current.object.fileId !== admitted.object.fileId || current.object.volumeIdentity !== admitted.object.volumeIdentity) throw changed();
        for (const lock of held) lock.assertHeld();
      } };
      const acquire = async (index: number): Promise<T> => {
        if (index === ordered.length) return operation(authority);
        const key = ordered[index]!;
        const component = createHash('sha256').update('bazframe-profile-operation-key-v1\0').update(key).digest('hex');
        return withWindowsOperationLock({ backend, lockRootPath: root, lockComponent: component,
          details: { command: 'profile-managed-use', target: `${transactionId}:${key}` },
          ...(options.lockIo === undefined ? {} : { io: options.lockIo }) }, async (lock) => {
          held.push(lock);
          try { await options.hooks?.afterOperationLock?.(key); return await acquire(index + 1); }
          finally { held.pop(); }
        });
      };
      try { return await acquire(0); }
      finally { active = false; }
    },
    async withStateLock(home, profileName, operation) {
      const root = win32.join(home, 'locks');
      ensureWindowsPrivateDirectoryPath(backend, root);
      return withWindowsOperationLock({ backend, lockRootPath: root, lockComponent: 'state.lock',
        details: { command: 'profile-managed-use', target: profileName },
        ...(options.lockIo === undefined ? {} : { io: options.lockIo }) }, async (authority) => {
        await options.hooks?.afterStateLock?.();
        return operation({ assertHeld(requestedHome = home, requestedProfile = profileName) {
          if (win32.normalize(requestedHome) !== win32.normalize(home) || requestedProfile !== profileName) throw changed();
          authority.assertHeld();
        } });
      });
    },
    async publishSelection(home, profileName, authority, expectation) {
      authority.assertHeld(home, profileName);
      const expected = await readWindowsSelectionSnapshot(backend, home);
      await publishWindowsSelection({ backend, home, expected, bytes: Buffer.from(`${profileName}\n`), authority: { assertHeld: () => authority.assertHeld(home, profileName) },
        async validateDependencies() {
          await readProfileSystemView(home, viewReads);
          await assertExpectation(home, profileName, expectation);
        },
        ...(options.selectionIo === undefined ? {} : { io: options.selectionIo }),
        ...(options.hooks === undefined ? {} : { hooks: options.hooks }) });
    },
    async readSelection(home) { return (await readWindowsSelectionSnapshot(backend, home)).profileId; },
    ...(options.hooks?.beforeReturn === undefined ? {} : { beforeReturn: options.hooks.beforeReturn })
  };
}
function portable(value: string): string { return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase(); }
function unsupported(): BazframeError { return new BazframeError('WINDOWS_PROFILE_ACTIVATION_UNSUPPORTED_STATE', 'Activation requires proved healthy ordinary profiles and absent or empty deferred state. Occupied or uncertain state was preserved.'); }
function changed(): BazframeError { return new BazframeError('WINDOWS_PROFILE_ACTIVATION_CHANGED', 'Physical profile activation observations changed or authority expired.'); }
