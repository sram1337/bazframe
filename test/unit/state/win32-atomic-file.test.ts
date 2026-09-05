import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWindowsSelectionSnapshot } from '../../../src/profiles/win32-profile-selection.js';
import { publishWindowsSelection, type WindowsSelectionPublicationHooks } from '../../../src/state/win32-atomic-file.js';
import { ensureWindowsPrivateDirectoryPath } from '../../../src/state/win32-private-directory.js';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
const HOME = 'C:\\boundary\\home';
const PATH = `${HOME}\\active-profile`;
function fixture() {
  const f = windowsProvisioningFixture();
  ensureWindowsPrivateDirectoryPath(f.backend, HOME);
  const io = { ...f.io, async rename(source: string, destination: string) {
    const node = f.nodes.get(source)!;
    if (node.kind !== 'file' || win32.dirname(source) !== win32.dirname(destination)) throw new Error('not sibling files');
    f.nodes.delete(source); f.nodes.set(destination, node);
  } };
  return { ...f, io, temps: () => [...f.nodes.keys()].filter((name) => /selection-[a-f0-9]{32}\.tmp$/u.test(name)) };
}

describe('private selection replacement predicate reconciliation', () => {
  it('publishes absent, different, and repeated selection with new identity and complete canonical bytes', async () => {
    const f = fixture();
    let priorId: number | undefined;
    for (const id of ['alpha', 'bravo', 'bravo']) {
      const expected = await readWindowsSelectionSnapshot(f.backend, HOME);
      const events: string[] = [];
      const hooks: WindowsSelectionPublicationHooks = {
        afterPrivateCreation() { expect(f.nodes.get(f.temps()[0]!)?.bytes).toEqual(Buffer.alloc(0)); events.push('private'); },
        afterCandidateRead() { expect(f.nodes.get(f.temps()[0]!)?.bytes).toEqual(Buffer.from(`${id}\n`)); events.push('complete'); },
        beforeReplacement() { expect(f.nodes.get(PATH)?.id).toBe(priorId); events.push('before'); },
        afterReplacement() { expect(f.nodes.get(PATH)?.bytes).toEqual(Buffer.from(`${id}\n`)); events.push('after'); }
      };
      expect(await publishWindowsSelection({ backend: f.backend, home: HOME, expected, bytes: Buffer.from(`${id}\n`), authority: { assertHeld() {} }, io: f.io, hooks })).toEqual({ effect: 'committed' });
      expect(f.nodes.get(PATH)?.id).not.toBe(priorId);
      priorId = f.nodes.get(PATH)!.id;
      expect(f.temps()).toEqual([]);
      expect(events).toEqual(['private', 'complete', 'before', 'after']);
    }
  });
  it.each(['no-effect', 'after-effect', 'ambiguous'] as const)('observes %s after a rename error rather than trusting return flags', async (outcome) => {
    const f = fixture(); f.file(PATH, 'alpha\r\n');
    const old = { ...f.nodes.get(PATH)! };
    const expected = await readWindowsSelectionSnapshot(f.backend, HOME);
    const operation = publishWindowsSelection({ backend: f.backend, home: HOME, expected, bytes: Buffer.from('bravo\n'), authority: { assertHeld() {} }, io: {
      ...f.io, async rename(source, destination) {
        if (outcome !== 'no-effect') await f.io.rename(source, destination);
        if (outcome === 'ambiguous') f.file(PATH, 'bravo\n');
        throw new Error('sharing or after-effect failure');
      }
    } });
    if (outcome === 'after-effect') { await expect(operation).resolves.toEqual({ effect: 'committed' }); expect(f.nodes.get(PATH)?.bytes).toEqual(Buffer.from('bravo\n')); }
    else await expect(operation).rejects.toMatchObject({ code: outcome === 'no-effect' ? 'WINDOWS_SELECTION_NO_EFFECT' : 'WINDOWS_SELECTION_AMBIGUOUS' });
    if (outcome === 'no-effect') { expect(f.nodes.get(PATH)).toEqual(old); expect(f.temps()).toHaveLength(1); }
  });
  it.each(['old-identity', 'old-bytes', 'candidate', 'authority'] as const)('refuses final %s drift before selection effects and retains private candidate', async (kind) => {
    const f = fixture(); f.file(PATH, 'alpha\n');
    const expected = await readWindowsSelectionSnapshot(f.backend, HOME);
    let held = true;
    await expect(publishWindowsSelection({ backend: f.backend, home: HOME, expected, bytes: Buffer.from('bravo\n'), authority: { assertHeld() { if (!held) throw new Error('expired'); } }, io: f.io, hooks: {
      beforeReplacement() {
        if (kind === 'old-identity') f.file(PATH, 'alpha\n');
        if (kind === 'old-bytes') f.nodes.get(PATH)!.bytes = Buffer.from('other\n');
        if (kind === 'candidate') f.nodes.get(f.temps()[0]!)!.bytes = Buffer.from('other\n');
        if (kind === 'authority') held = false;
      }
    } })).rejects.toMatchObject({ code: 'WINDOWS_SELECTION_BEFORE_EFFECT' });
    expect(f.nodes.get(PATH)?.bytes).toEqual(Buffer.from(kind === 'old-bytes' ? 'other\n' : 'alpha\n'));
    expect(f.temps()).toHaveLength(1);
  });
  it('refuses malformed old bytes before creating a candidate', async () => {
    const f = fixture(); const expected = await readWindowsSelectionSnapshot(f.backend, HOME);
    f.file(PATH, 'bad\n\n'); const before = f.snapshot();
    await expect(publishWindowsSelection({ backend: f.backend, home: HOME, expected, bytes: Buffer.from('alpha\n'), authority: { assertHeld() {} }, io: f.io })).rejects.toThrow();
    expect(f.snapshot()).toBe(before);
  });
});
