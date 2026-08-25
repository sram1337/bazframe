import { existsSync, renameSync, watch, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

const scenarios = ['graceful', 'forced', 'fatal-render', 'unicode-width'];
const unicodeTailSentinel = 'TAIL-SENTINEL-9F4C';
const unicodeWidthRoot = `/路径/Cafe\u0301/👩‍💻/\u001B[31mANSI\u001B[0m/${'x'.repeat(180)}-${unicodeTailSentinel}`;

let scenario;
let markerPath;
let pendingMutation;
let keepalive;
let revision = 0;

export function configureTuiServiceFixture(nextScenario, nextMarkerPath) {
  if (!scenarios.includes(nextScenario)) {
    throw new Error(`Unknown TUI service fixture scenario: ${nextScenario}`);
  }
  scenario = nextScenario;
  markerPath = nextMarkerPath;
  pendingMutation = undefined;
  keepalive = new MessageChannel();
  keepalive.port1.on('message', () => undefined);
  keepalive.port1.ref();
}

export function disposeTuiServiceFixture() {
  keepalive?.port1.close();
  keepalive?.port2.close();
  keepalive = undefined;
}

export function createBazframeTuiService() {
  if (scenario === undefined || markerPath === undefined) {
    throw new Error('TUI service fixture was not configured.');
  }
  return {
    loadDashboard: async () => dashboard(),
    createProfile: async () => undefined,
    duplicateProfile: async () => undefined,
    useProfile: async () => undefined,
    toggleProfileFavorite: async () => undefined,
    renameProfile: async () => undefined,
    removeProfile: async () => undefined,
    editProfileInstructions: async () => ({ exitCode: 0, signal: null }),
    editSkillDefinition: async () => ({ exitCode: 0, signal: null }),
    addMembership: async () => {
      const mutation = blockMutation();
      writeMarker('mutation-started');
      await mutation;
      writeMarker('mutation-resolved');
    },
    removeMembership: async () => undefined,
    loadSkillPreview: async ({ originId, skillId }) => ({
      originId,
      skillId,
      path: '/fixture/library/skills/demo-skill/SKILL.md',
      contents: '---\nname: demo-skill\ndescription: fixture\n---\n\nTUI-PREVIEW-SENTINEL\n'
    }),
    browseDirectories: async (input) => ({
      input,
      resolvedPath: '/fixture',
      selectablePath: '/fixture',
      entries: []
    }),
    inspectLibraryCandidate: async ({ root }) => ({
      libraryId: root.split('/').filter(Boolean).at(-1) ?? 'library',
      enteredRoot: root,
      canonicalRoot: root,
      packageManifest: { state: 'absent' }
    }),
    addLibrary: async ({ root }) => ({
      schemaVersion: 1,
      library: root.split('/').filter(Boolean).at(-1) ?? 'library',
      root,
      digest: 'a'.repeat(64),
      action: 'added',
      path: `/fixture/libraries/${root.split('/').filter(Boolean).at(-1) ?? 'library'}.json`
    })
  };
}

function blockMutation() {
  if (pendingMutation !== undefined) return pendingMutation;
  pendingMutation = new Promise((resolveMutation) => {
    if (scenario === 'graceful') {
      const completionPath = `${markerPath}.complete-mutation`;
      const watcher = watch(dirname(completionPath), () => {
        if (!existsSync(completionPath)) return;
        watcher.close();
        writeMarker('completion-signaled');
        resolveMutation();
      });
    }
  });
  return pendingMutation;
}

function writeMarker(state) {
  const path = `${markerPath}.${state}`;
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${state}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporaryPath, path);
}

function dashboard() {
  const value = {
    revision: ++revision,
    activeProfileId: 'focused',
    profiles: [{
      id: 'focused',
      directory: '/fixture/profiles/focused',
      instructionsPath: '/fixture/profiles/focused/AGENTS.md',
      removalIdentity: {
        schemaVersion: 1,
        directory: { device: 'fixture', inode: 'fixture' },
        fingerprint: 'fixture'
      },
      active: true,
      favorite: false,
      membershipWritable: true,
      memberships: []
    }],
    collections: [],
    skillGroups: [{
      id: 'default',
      label: scenario === 'unicode-width' ? 'U' : '(default)',
      root: scenario === 'unicode-width' ? unicodeWidthRoot : '/fixture/library/skills',
      artifactWritesSupported: false,
      skills: [{
        id: 'demo-skill',
        originId: 'default',
        directory: '/fixture/library/skills/demo-skill'
      }]
    }],
    availableSkillGroups: [{
      id: 'default',
      label: scenario === 'unicode-width' ? 'U' : '(default)',
      root: scenario === 'unicode-width' ? unicodeWidthRoot : '/fixture/library/skills',
      artifactWritesSupported: false,
      skills: [{ id: 'demo-skill', originId: 'default', directory: '/fixture/library/skills/demo-skill' }]
    }],
    diagnostics: []
  };
  if (scenario === 'fatal-render') {
    Object.defineProperty(value, 'status', {
      enumerable: false,
      get() {
        throw new Error('fatal renderer fixture');
      }
    });
  } else {
    value.adapterStatus = {
      state: 'unavailable',
      diagnostic: {
        id: 'fixture-adapter-status',
        severity: 'warning',
        message: 'Fixture adapter status unavailable.'
      }
    };
    value.status = {
      state: 'unavailable',
      diagnostic: {
        id: 'fixture-status',
        severity: 'warning',
        message: 'Fixture status unavailable.'
      }
    };
  }
  return value;
}
