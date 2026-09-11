import { describe, expect, it } from 'vitest';
import { windowsApplicationFixture, HOME } from '../../helpers/windows-application-fixture.js';
import { proveWindowsEditorTarget } from '../../../src/core/win32-editor-target.js';
import { editProfileInstructions } from '../../../src/profiles/profile-instruction-editor.js';
import { editSkillDefinition } from '../../../src/skills/skill-definition-editor.js';
import type { WindowsEditorTargetInspection } from '../../../src/core/win32-native.js';

describe('Windows read-only editor proof and real editor launch paths', () => {
  it.each(['', '\u0000not utf8/frontmatter', 'x'.repeat(1024 * 1024 + 1)])('opens repairable profile bytes without reading or validating content', async (bytes) => {
    const f = windowsApplicationFixture(), root = HOME + '\\profiles\\work';
    f.file(root + '\\AGENTS.md', bytes);
    let reads = 0; f.backend.readStableFile = async () => { reads++; throw new Error('content read'); };
    const launches: unknown[] = [];
    const result = await editProfileInstructions({ bazframeHome: HOME, profileId: 'work', environment: f.environment, ...f.application.profileEditor,
      childRunner: async (...args) => { launches.push(args); return { exitCode: 0, signal: null }; } });
    expect(result.exitCode).toBe(0); expect(reads).toBe(0);
    expect(launches).toEqual([['C:\\tools\\editor.exe', [root + '\\AGENTS.md'], expect.objectContaining({ cwd: root, environment: f.environment })]]);
    expect((launches[0] as unknown[])[2]).not.toHaveProperty('forwardSignals');
  });
  it('refuses replacement after asynchronous executable selection before spawning', async () => {
    const f = windowsApplicationFixture(), root = HOME + '\\profiles\\work'; f.file(root + '\\AGENTS.md', 'repair');
    let spawned = false;
    await expect(editProfileInstructions({ bazframeHome: HOME, profileId: 'work', environment: f.environment, targetProof: f.application.profileEditor!.targetProof,
      resolveExecutable: async () => { f.file(root + '\\AGENTS.md', 'replacement'); return 'C:\\tools\\editor.exe'; },
      childRunner: async () => { spawned = true; return { exitCode: 0, signal: null }; } })).rejects.toThrow(/changed|contained/);
    expect(spawned).toBe(false);
  });
  it.each(['escape', 'chain', 'junction', 'ancestor', 'directory', 'pending'])('refuses an adverse %s receipt', (change) => {
    const f = windowsApplicationFixture(), root = HOME + '\\profiles\\work'; f.file(root + '\\AGENTS.md', 'repair');
    const inspect = f.backend.inspectEditorTarget;
    f.backend.inspectEditorTarget = (...args) => {
      const value = structuredClone(inspect(...args));
      if (change === 'escape') value.target.canonicalPath = value.root.volume.canonicalVolumeGuidPath + 'elsewhere\\AGENTS.md';
      if (change === 'chain') value.target.object.reparseTag = 0xa000000c;
      if (change === 'junction') value.entryObject.reparseTag = 0xa0000003;
      if (change === 'ancestor') value.parent.canonicalPath += '\\elsewhere';
      if (change === 'directory') value.entryObject.directory = true;
      if (change === 'pending') value.entryObject.deletePending = true;
      return value;
    };
    expect(() => proveWindowsEditorTarget(f.backend, root, 'AGENTS.md')).toThrow();
  });
  it('admits a contained product-authorized final file link with different OS ownership and launches its physical target', async () => {
    const f = windowsApplicationFixture(), root = 'C:\\boundary\\source\\demo', targetPath = root + '\\repair.md';
    f.file(root + '\\SKILL.md', 'entry'); f.file(targetPath, 'malformed repair');
    f.nodes.get(root + '\\SKILL.md')!.security = { ...f.security(root + '\\SKILL.md'), ownerSid: 'S-1-5-21-999' };
    f.directories(HOME + '\\skills'); f.junction(HOME + '\\skills\\demo', root);
    const inspect = f.backend.inspectEditorTarget;
    f.backend.inspectEditorTarget = (...args): WindowsEditorTargetInspection => { const value = inspect(...args); return { ...value, entryObject: { ...value.entryObject, reparseTag: 0xa000000c }, targetPath, target: f.backend.inspectPath(targetPath) }; };
    let target: readonly string[] = [];
    await editSkillDefinition({ bazframeHome: HOME, skillId: 'demo', environment: f.environment, ...f.application.skillEditor, childRunner: async (_exe, args) => { target = args; return { exitCode: 0, signal: null }; } });
    expect(target).toEqual([targetPath]);
  });
  it.each(['alias', 'replaced-parent'])('refuses a nested external target with %s', async (change) => {
    const f = windowsApplicationFixture(), root = 'C:\\boundary\\source\\demo', targetPath = root + '\\nested\\repair.md';
    f.file(root + '\\SKILL.md', 'link'); f.file(targetPath, 'repair');
    const inspect = f.backend.inspectEditorTarget;
    f.backend.inspectEditorTarget = (...args) => { const value = inspect(...args); return { ...value, entryObject: { ...value.entryObject, reparseTag: 0xa000000c }, targetPath: change === 'alias' ? root + '\\NESTED\\repair.md' : targetPath, target: f.backend.inspectPath(targetPath) }; };
    if (change === 'replaced-parent') { const proof = proveWindowsEditorTarget(f.backend, root, 'SKILL.md'); f.directory(root + '\\nested'); await expect(proof.revalidate()).rejects.toThrow(); }
    else expect(() => proveWindowsEditorTarget(f.backend, root, 'SKILL.md')).toThrow();
  });
  it('admits hardlinked editor input under differently owned existing ancestors without reading bytes', async () => {
    const f = windowsApplicationFixture(), root = HOME + '\\profiles\\work';
    f.file(root + '\\AGENTS.md', 'repair');
    f.nodes.get(root + '\\AGENTS.md')!.numberOfLinks = 2;
    for (const [path, node] of f.nodes) node.security = { ...f.security(path), ownerSid: 'S-1-5-21-999' };
    f.backend.readStableFile = async () => { throw new Error('no content reads'); };
    await expect(proveWindowsEditorTarget(f.backend, root, 'AGENTS.md').revalidate()).resolves.toBeUndefined();
  });
  it.each(['Visual', 'blank-visual', 'conflict'])('applies Windows editor environment policy for %s without changing the inherited environment', async (variant) => {
    const f = windowsApplicationFixture(), root = HOME + '\\profiles\\work'; f.file(root + '\\AGENTS.md', 'repair');
    const environment = { ...f.environment, VISUAL: variant === 'conflict' ? 'different.exe' : undefined, Visual: variant === 'blank-visual' ? '  ' : 'editor.exe', Editor: 'editor.exe' };
    let inherited: NodeJS.ProcessEnv | undefined;
    const launch = editProfileInstructions({ bazframeHome: HOME, profileId: 'work', environment, ...f.application.profileEditor, childRunner: async (_exe, _args, options) => { inherited = options.environment; return { exitCode: 0, signal: null }; } });
    if (variant === 'conflict') { await expect(launch).rejects.toThrow(/Conflicting/); expect(inherited).toBeUndefined(); }
    else { await launch; expect(inherited).toBe(environment); }
  });

});
