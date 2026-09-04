import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  BazframeWin32NativeBackend,
  WindowsDirectoryEntryObservation,
  WindowsObjectObservation,
  WindowsPathInspection,
  WindowsSecurityObservation
} from '../../../src/core/win32-native.js';
import { BazframeError } from '../../../src/core/errors.js';
import {
  decodeWindowsDirectoryPublicationJournal,
  encodeWindowsDirectoryPublicationJournal,
  executeWindowsDirectoryPublication,
  recoverWindowsDirectoryPublication,
  type ExecuteWindowsDirectoryPublicationOptions,
  type WindowsDirectoryPublicationAuthority,
  type WindowsDirectoryPublicationIo,
  type WindowsDirectoryPublicationPhase
} from '../../../src/state/win32-directory-publication.js';

const VOLUME = '0020000000000001';
const USER = 'S-1-5-21-1';
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const FULL = 0x001f01ff;
const TRANSACTION = 'a'.repeat(32);
const DEPENDENT = createHash('sha256').update('active:none').digest('hex');
const PARENT = 'C:\\managed';
const JOURNALS = 'C:\\journals';
const DESTINATION = 'profile';

type TestNode = {
  kind: 'directory' | 'file' | 'reparse';
  id: number;
  bytes?: Buffer;
  attributes?: number;
  reparseTag?: number;
  numberOfLinks?: number;
  security?: WindowsSecurityObservation;
};

describe('Windows directory publication composition', () => {
  it('publishes a fresh private candidate with append-only intent and predicate proofs', async () => {
    const fixture = harness();
    const result = await executeWindowsDirectoryPublication(fixture.executeOptions('fresh'));

    expect(result).toEqual({
      transactionId: TRANSACTION,
      action: 'committed',
      phase: 'COMMITTED',
      backupRetained: false
    });
    expect(fixture.file(`${PARENT}\\${DESTINATION}\\new.txt`).bytes?.toString()).toBe('new\n');
    expect(fixture.has(fixture.candidate)).toBe(false);
    expect(fixture.has(fixture.backup)).toBe(false);
    expect(fixture.phases()).toEqual([
      'PLANNED', 'CANDIDATE_READY', 'CANDIDATE_RENAME_INTENT',
      'CANDIDATE_RENAME_PROVEN', 'DEPENDENT_STATE_PROVEN', 'COMMITTED'
    ]);
    expect(fixture.renameCalls).toEqual([[fixture.candidate, fixture.destination]]);
  });

  it('refuses every fresh destination occupant without a journal, candidate, or rename', async () => {
    for (const occupant of [dir(20), file(21, 'occupied'), reparse(22)]) {
      const fixture = harness({ destination: occupant });
      await expect(executeWindowsDirectoryPublication(fixture.executeOptions('fresh')))
        .rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_PUBLICATION_DESTINATION_OCCUPIED' });
      expect(fixture.file(fixture.destination).id).toBe(occupant.id);
      expect(fixture.has(fixture.journalDirectory)).toBe(false);
      expect(fixture.has(fixture.candidate)).toBe(false);
      expect(fixture.renameCalls).toEqual([]);
    }
  });

  it('requires literal explicit-overwrite authorization before any mutation', async () => {
    const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
    const options = fixture.executeOptions('replacement') as ExecuteWindowsDirectoryPublicationOptions;
    (options.operation as { overwriteAuthorization: string }).overwriteAuthorization = 'yes';
    await expect(executeWindowsDirectoryPublication(options)).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_PUBLICATION_OVERWRITE_REQUIRED'
    });
    expect(fixture.has(fixture.journalDirectory)).toBe(false);
    expect(fixture.renameCalls).toEqual([]);
  });

  it('replaces only the exact expected old closure and retains its private backup', async () => {
    const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
    const result = await executeWindowsDirectoryPublication(fixture.executeOptions('replacement'));

    expect(result).toMatchObject({ action: 'committed', backupRetained: true });
    expect(fixture.file(`${fixture.destination}\\new.txt`).bytes?.toString()).toBe('new\n');
    expect(fixture.file(`${fixture.backup}\\old.txt`).bytes?.toString()).toBe('old\n');
    expect(fixture.has(fixture.candidate)).toBe(false);
    expect(fixture.phases()).toEqual([
      'PLANNED', 'CANDIDATE_READY', 'OLD_RENAME_INTENT', 'OLD_RENAME_PROVEN',
      'CANDIDATE_RENAME_INTENT', 'CANDIDATE_RENAME_PROVEN',
      'DEPENDENT_STATE_PROVEN', 'COMMITTED'
    ]);
  });

  it('records pre-readiness namespace drift as ambiguity rather than abort', async () => {
    const fixture = harness();
    const options = fixture.executeOptions('fresh');
    options.materialize = (candidatePath) => {
      fixture.nodes.set(`${candidatePath}\\new.txt`, file(90, 'new\n'));
      fixture.nodes.set(fixture.destination, dir(91));
    };
    await expect(executeWindowsDirectoryPublication(options)).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_PUBLICATION_AMBIGUOUS'
    });
    expect(fixture.phases()).toEqual(['PLANNED', 'AMBIGUOUS']);
    const recovered = await recoverWindowsDirectoryPublication(fixture.recoverOptions());
    expect(recovered).toMatchObject({ action: 'ambiguous', phase: 'AMBIGUOUS' });
  });

  it('records unprovable namespace inspection after intent as retained ambiguity', async () => {
    const fixture = harness();
    const options = fixture.executeOptions('fresh');
    const base = options.backend;
    let failInspection = false;
    options.backend = {
      ...base,
      async enumerateStableDirectory(path, maximum) {
        if (failInspection) {
          failInspection = false;
          throw new BazframeError('WINDOWS_NATIVE_SHARING_VIOLATION', 'sharing');
        }
        return base.enumerateStableDirectory(path, maximum);
      }
    };
    options.hooks = {
      afterPhase(phase) {
        if (phase === 'CANDIDATE_RENAME_INTENT') failInspection = true;
      }
    };
    const result = await executeWindowsDirectoryPublication(options);
    expect(result).toMatchObject({ action: 'ambiguous', phase: 'AMBIGUOUS' });
    expect(fixture.renameCalls).toEqual([]);
    expect(fixture.has(fixture.candidate)).toBe(true);
  });

  it('retains a no-effect sharing failure at durable intent and completes on recovery', async () => {
    const fixture = harness();
    fixture.failRenameBeforeEffect = 1;
    await expect(executeWindowsDirectoryPublication(fixture.executeOptions('fresh')))
      .rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_PUBLICATION_RETRY_REQUIRED' });
    expect(fixture.phases().at(-1)).toBe('CANDIDATE_RENAME_INTENT');
    expect(fixture.has(fixture.candidate)).toBe(true);
    expect(fixture.has(fixture.destination)).toBe(false);

    const recovered = await recoverWindowsDirectoryPublication(fixture.recoverOptions());
    expect(recovered).toMatchObject({ action: 'committed', phase: 'COMMITTED' });
    expect(fixture.has(fixture.destination)).toBe(true);
  });

  it('accepts a rename that took effect before the call reported an error', async () => {
    const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
    fixture.failRenameAfterEffect = 2;
    const result = await executeWindowsDirectoryPublication(fixture.executeOptions('replacement'));
    expect(result).toMatchObject({ action: 'committed', backupRetained: true });
    expect(fixture.has(fixture.destination)).toBe(true);
    expect(fixture.has(fixture.backup)).toBe(true);
  });

  it.each([
    ['PLANNED', 'aborted'],
    ['CANDIDATE_READY', 'aborted'],
    ['OLD_RENAME_INTENT', 'committed'],
    ['OLD_RENAME_PROVEN', 'committed'],
    ['CANDIDATE_RENAME_INTENT', 'committed'],
    ['CANDIDATE_RENAME_PROVEN', 'committed'],
    ['DEPENDENT_STATE_PROVEN', 'committed'],
    ['COMMITTED', 'terminal']
  ] as const)('recovers a clean-process interruption after %s as %s', async (phase, action) => {
    const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
    const options = fixture.executeOptions('replacement');
    options.hooks = {
      afterPhase(current) {
        if (current === phase) throw new Error(`crash after ${phase}`);
      }
    };
    await expect(executeWindowsDirectoryPublication(options)).rejects.toThrow(`crash after ${phase}`);
    const recovered = await recoverWindowsDirectoryPublication(fixture.recoverOptions());
    expect(recovered.action).toBe(action);
  });

  it('recovers interruptions immediately after either namespace mutation', async () => {
    for (const hook of ['afterOldRename', 'afterCandidateRename'] as const) {
      const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
      const options = fixture.executeOptions('replacement');
      options.hooks = { [hook]: () => { throw new Error(`crash ${hook}`); } };
      await expect(executeWindowsDirectoryPublication(options)).rejects.toThrow(`crash ${hook}`);
      const recovered = await recoverWindowsDirectoryPublication(fixture.recoverOptions());
      expect(recovered).toMatchObject({ action: 'committed', backupRetained: true });
    }
  });

  it('records retained ambiguity on candidate, destination, backup, or dependent-state drift', async () => {
    const mutations: Array<(fixture: Harness) => void> = [
      (fixture) => { fixture.file(`${fixture.candidate}\\new.txt`).bytes = Buffer.from('changed\n'); },
      (fixture) => { fixture.nodes.set(fixture.destination, dir(80)); },
      (fixture) => { fixture.nodes.set(fixture.backup, dir(81)); },
      (fixture) => { fixture.dependent = createHash('sha256').update('changed').digest('hex'); }
    ];
    for (const mutate of mutations) {
      const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
      const options = fixture.executeOptions('replacement');
      options.hooks = {
        afterPhase(phase) {
          if (phase === 'CANDIDATE_READY') mutate(fixture);
        }
      };
      const result = await executeWindowsDirectoryPublication(options);
      expect(result).toMatchObject({ action: 'ambiguous', phase: 'AMBIGUOUS' });
      expect(fixture.has(fixture.candidate)).toBe(true);
    }
  });

  it('re-proves dependent state immediately before rename and does not publish after drift', async () => {
    const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
    const options = fixture.executeOptions('replacement');
    options.hooks = {
      afterPhase(phase) {
        if (phase === 'CANDIDATE_RENAME_INTENT') {
          fixture.dependent = createHash('sha256').update('changed-before-rename').digest('hex');
        }
      }
    };
    const result = await executeWindowsDirectoryPublication(options);
    expect(result).toMatchObject({ action: 'ambiguous', phase: 'AMBIGUOUS' });
    expect(fixture.renameCalls).toEqual([[fixture.destination, fixture.backup]]);
    expect(fixture.has(fixture.destination)).toBe(false);
    expect(fixture.has(fixture.candidate)).toBe(true);
  });

  it('records dependent drift discovered by recovery as terminal ambiguity', async () => {
    const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
    const options = fixture.executeOptions('replacement');
    options.hooks = {
      afterPhase(phase) {
        if (phase === 'OLD_RENAME_INTENT') throw new Error('crash before old rename');
      }
    };
    await expect(executeWindowsDirectoryPublication(options)).rejects.toThrow('crash before old rename');
    fixture.dependent = createHash('sha256').update('recovery-dependent-drift').digest('hex');
    const recovered = await recoverWindowsDirectoryPublication(fixture.recoverOptions());
    expect(recovered).toMatchObject({ action: 'ambiguous', phase: 'AMBIGUOUS' });
    const repeated = await recoverWindowsDirectoryPublication(fixture.recoverOptions());
    expect(repeated).toMatchObject({ action: 'ambiguous', phase: 'AMBIGUOUS' });
    expect(fixture.renameCalls).toEqual([]);
  });

  it('returns a terminal ambiguity idempotently even when dependent drift persists', async () => {
    const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
    const options = fixture.executeOptions('replacement');
    options.hooks = {
      afterCandidateRename() {
        fixture.dependent = createHash('sha256').update('changed-after-rename').digest('hex');
      }
    };
    const first = await executeWindowsDirectoryPublication(options);
    expect(first).toMatchObject({ action: 'ambiguous', phase: 'AMBIGUOUS' });
    const recovered = await recoverWindowsDirectoryPublication(fixture.recoverOptions());
    expect(recovered).toMatchObject({ action: 'ambiguous', phase: 'AMBIGUOUS' });
  });

  it('retains state and reports an unprovable journal update after parent drift', async () => {
    const fixture = harness({ destination: dir(20), oldFile: 'old\n' });
    const options = fixture.executeOptions('replacement');
    options.hooks = {
      afterPhase(phase) {
        if (phase === 'CANDIDATE_READY') fixture.file(PARENT).id = 82;
      }
    };
    await expect(executeWindowsDirectoryPublication(options)).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_PUBLICATION_JOURNAL_WRITE_AMBIGUOUS'
    });
    expect(fixture.has(fixture.candidate)).toBe(true);
  });

  it('rejects corrupted or noncanonical journal records without another rename', async () => {
    const fixture = harness();
    fixture.failRenameBeforeEffect = 1;
    await expect(executeWindowsDirectoryPublication(fixture.executeOptions('fresh'))).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_PUBLICATION_RETRY_REQUIRED'
    });
    const latest = fixture.recordPaths().at(-1)!;
    fixture.file(latest).bytes = Buffer.from('{"broken":true}\n');
    const calls = fixture.renameCalls.length;
    await expect(recoverWindowsDirectoryPublication(fixture.recoverOptions()))
      .rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_PUBLICATION_JOURNAL_INVALID' });
    expect(fixture.renameCalls).toHaveLength(calls);
  });

  it('validates canonical journal bytes, fixed-width identities, and immutable fields', async () => {
    const fixture = harness();
    fixture.failRenameBeforeEffect = 1;
    await expect(executeWindowsDirectoryPublication(fixture.executeOptions('fresh'))).rejects.toBeInstanceOf(BazframeError);
    const bytes = Buffer.from(fixture.file(fixture.recordPaths()[0]!).bytes!);
    const decoded = decodeWindowsDirectoryPublicationJournal(bytes);
    expect(encodeWindowsDirectoryPublicationJournal(decoded)).toBe(bytes.toString());
    await expect(async () => decodeWindowsDirectoryPublicationJournal(
      Buffer.from(encodeWindowsDirectoryPublicationJournal({
        ...decoded,
        parentIdentity: '1:2'
      }))
    )).rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_PUBLICATION_JOURNAL_INVALID' });
    expect(() => decodeWindowsDirectoryPublicationJournal(Buffer.from(JSON.stringify(decoded))))
      .toThrow(expect.objectContaining({ code: 'WINDOWS_DIRECTORY_PUBLICATION_JOURNAL_INVALID' }));
  });

  it('rejects proofs introduced before their exact phase or in a terminal transition', async () => {
    const readyFixture = harness({ destination: dir(20), oldFile: 'old\n' });
    const readyOptions = readyFixture.executeOptions('replacement');
    readyOptions.hooks = {
      afterPhase(phase) {
        if (phase === 'CANDIDATE_READY') throw new Error('stop at ready');
      }
    };
    await expect(executeWindowsDirectoryPublication(readyOptions)).rejects.toThrow('stop at ready');
    const ready = decodeWindowsDirectoryPublicationJournal(
      readyFixture.file(readyFixture.recordPaths().at(-1)!).bytes!
    );
    expect(() => encodeWindowsDirectoryPublicationJournal({
      ...ready,
      backup: ready.expectedOld
    })).toThrow(expect.objectContaining({ code: 'WINDOWS_DIRECTORY_PUBLICATION_JOURNAL_INVALID' }));

    const plannedFixture = harness();
    const plannedOptions = plannedFixture.executeOptions('fresh');
    plannedOptions.hooks = {
      afterPhase(phase) {
        if (phase === 'PLANNED') throw new Error('stop at planned');
      }
    };
    await expect(executeWindowsDirectoryPublication(plannedOptions)).rejects.toThrow('stop at planned');
    const planned = decodeWindowsDirectoryPublicationJournal(
      plannedFixture.file(plannedFixture.recordPaths()[0]!).bytes!
    );
    const introduced = Buffer.from(encodeWindowsDirectoryPublicationJournal({
      ...planned,
      sequence: 1,
      candidate: {
        rootIdentity: `${VOLUME}:${fileId(999)}`,
        closureSha256: 'b'.repeat(64)
      },
      phase: 'ABORTED'
    }));
    plannedFixture.nodes.set(
      `${plannedFixture.journalDirectory}\\00000001.json`,
      { ...file(999, ''), bytes: introduced }
    );
    await expect(recoverWindowsDirectoryPublication(plannedFixture.recoverOptions()))
      .rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_PUBLICATION_JOURNAL_INVALID' });
  });

  it('rejects overlapping publication and journal roots before mutation', async () => {
    const fixture = harness();
    const options = fixture.executeOptions('fresh');
    options.journalRootPath = PARENT;
    options.destinationName = TRANSACTION;
    await expect(executeWindowsDirectoryPublication(options)).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_PUBLICATION_STORAGE_INVALID'
    });
    expect(fixture.has(`${PARENT}\\${TRANSACTION}`)).toBe(false);
    expect(fixture.has(fixture.candidate)).toBe(false);
  });

  it('rejects overlapping roots reconstructed during recovery before rename', async () => {
    const fixture = harness();
    fixture.failRenameBeforeEffect = 1;
    await expect(executeWindowsDirectoryPublication(fixture.executeOptions('fresh'))).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_PUBLICATION_RETRY_REQUIRED'
    });
    const oldDirectory = fixture.journalDirectory;
    const movedDirectory = `${PARENT}\\${TRANSACTION}`;
    const oldRecords = fixture.recordPaths();
    moveTree(fixture.nodes, oldDirectory, movedDirectory);
    for (const oldPath of oldRecords) {
      const newPath = `${movedDirectory}${oldPath.slice(oldDirectory.length)}`;
      const record = decodeWindowsDirectoryPublicationJournal(fixture.file(newPath).bytes!);
      fixture.file(newPath).bytes = Buffer.from(encodeWindowsDirectoryPublicationJournal({
        ...record,
        journalRootIdentity: `${VOLUME}:${fileId(2)}`
      }));
    }
    const recovery = fixture.recoverOptions();
    recovery.journalRootPath = PARENT;
    const calls = fixture.renameCalls.length;
    await expect(recoverWindowsDirectoryPublication(recovery)).rejects.toMatchObject({
      code: 'WINDOWS_DIRECTORY_PUBLICATION_STORAGE_INVALID'
    });
    expect(fixture.renameCalls).toHaveLength(calls);
  });

  it('checks exclusive authority before creating journal or candidate state', async () => {
    const fixture = harness();
    fixture.authorityHeld = false;
    await expect(executeWindowsDirectoryPublication(fixture.executeOptions('fresh')))
      .rejects.toMatchObject({ code: 'WINDOWS_DIRECTORY_PUBLICATION_AUTHORITY_INVALID' });
    expect(fixture.has(fixture.journalDirectory)).toBe(false);
  });
});

type Harness = ReturnType<typeof harness>;

function harness(options: { destination?: TestNode; oldFile?: string } = {}) {
  let nextId = 200;
  const nodes = new Map<string, TestNode>([
    ['C:\\', dir(1)],
    [PARENT, dir(2)],
    [JOURNALS, dir(3)]
  ]);
  const destination = `${PARENT}\\${DESTINATION}`;
  const candidate = `${PARENT}\\.bazframe-candidate-${TRANSACTION}`;
  const backup = `${PARENT}\\.bazframe-backup-${TRANSACTION}`;
  const journalDirectory = `${JOURNALS}\\${TRANSACTION}`;
  if (options.destination !== undefined) nodes.set(destination, options.destination);
  if (options.oldFile !== undefined) nodes.set(`${destination}\\old.txt`, file(21, options.oldFile));
  const renameCalls: Array<[string, string]> = [];
  const fixture = {
    nodes,
    destination,
    candidate,
    backup,
    journalDirectory,
    renameCalls,
    dependent: DEPENDENT,
    authorityHeld: true,
    failRenameBeforeEffect: 0,
    failRenameAfterEffect: 0,
    has(path: string) { return nodes.has(path); },
    file(path: string) { return required(nodes, path); },
    recordPaths() {
      return [...nodes.keys()].filter((path) => path.startsWith(`${journalDirectory}\\`)).sort();
    },
    phases(): WindowsDirectoryPublicationPhase[] {
      return fixture.recordPaths().map((path) => decodeWindowsDirectoryPublicationJournal(
        required(nodes, path).bytes!
      ).phase);
    },
    executeOptions(mode: 'fresh' | 'replacement'): ExecuteWindowsDirectoryPublicationOptions {
      const common = {
        backend,
        parentPath: PARENT,
        journalRootPath: JOURNALS,
        destinationName: DESTINATION,
        dependentState: { expectedSha256: DEPENDENT, observeSha256: () => fixture.dependent },
        authority,
        io,
        materialize(path: string) { nodes.set(`${path}\\new.txt`, file(nextId++, 'new\n')); }
      };
      if (mode === 'fresh') return { ...common, operation: { mode: 'fresh' } };
      return {
        ...common,
        operation: {
          mode: 'replacement',
          expectedOld: expectationFor(destination),
          overwriteAuthorization: 'explicit-overwrite'
        }
      };
    },
    recoverOptions() {
      return {
        backend,
        parentPath: PARENT,
        journalRootPath: JOURNALS,
        destinationName: DESTINATION,
        transactionId: TRANSACTION,
        dependentState: { expectedSha256: DEPENDENT, observeSha256: () => fixture.dependent },
        authority,
        io
      };
    }
  };

  const backend: BazframeWin32NativeBackend = {
    inspectPath(path) {
      const node = required(nodes, path);
      if (node.kind === 'reparse') throw new BazframeError('WINDOWS_NATIVE_REPARSE_REFUSED', 'reparse');
      return inspection(path, node);
    },
    createPrivateDirectory(parentPath, finalComponent) {
      const parent = required(nodes, parentPath);
      const path = win32.join(parentPath, finalComponent);
      if (nodes.has(path)) throw new BazframeError('WINDOWS_NATIVE_DIRECTORY_OCCUPIED', 'occupied');
      const parentBefore = inspection(parentPath, parent);
      const created = dir(nextId++);
      nodes.set(path, created);
      return { parentBefore, created: inspection(path, created), parentAfter: inspection(parentPath, parent) };
    },
    async renameDirectoryNoReplace(parentPath, sourceComponent, destinationComponent) {
      renameCalls.push([
        win32.join(parentPath, sourceComponent),
        win32.join(parentPath, destinationComponent)
      ]);
      moveTree(
        nodes,
        win32.join(parentPath, sourceComponent),
        win32.join(parentPath, destinationComponent)
      );
    },
    async readStableFile(path, maximum) {
      const node = required(nodes, path);
      if (node.kind !== 'file' || node.bytes === undefined || node.bytes.byteLength > maximum) {
        throw new BazframeError('WINDOWS_NATIVE_READ_LIMIT_EXCEEDED', 'refused');
      }
      const object = objectObservation(node);
      return { bytes: Buffer.from(node.bytes), byteCount: hex(node.bytes.byteLength), before: object, after: { ...object } };
    },
    async enumerateStableDirectory(path, maximum) {
      const parent = required(nodes, path);
      if (parent.kind !== 'directory') throw new Error('not directory');
      const prefix = path.endsWith('\\') ? path : `${path}\\`;
      const entries = [...nodes.entries()]
        .filter(([candidatePath]) => candidatePath.startsWith(prefix)
          && !candidatePath.slice(prefix.length).includes('\\'))
        .map(([candidatePath, node]) => entry(candidatePath.slice(prefix.length), node))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      if (entries.length > maximum) throw new BazframeError('WINDOWS_NATIVE_ENUMERATION_LIMIT_EXCEEDED', 'limit');
      const observed = inspection(path, parent);
      return { directoryBefore: observed, entries, directoryAfter: inspection(path, parent) };
    }
  };

  const io: WindowsDirectoryPublicationIo = {
    async appendFileExclusive(path, bytes) {
      if (nodes.has(path)) throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
      nodes.set(path, { ...file(nextId++, ''), bytes: Buffer.from(bytes) });
    },
    async rename(source, target) {
      renameCalls.push([source, target]);
      if (fixture.failRenameBeforeEffect > 0) {
        fixture.failRenameBeforeEffect -= 1;
        throw new BazframeError('WINDOWS_NATIVE_SHARING_VIOLATION', 'sharing');
      }
      moveTree(nodes, source, target);
      if (fixture.failRenameAfterEffect > 0) {
        fixture.failRenameAfterEffect -= 1;
        throw new BazframeError('WINDOWS_NATIVE_IO_FAILED', 'reported after effect');
      }
    }
  };

  const authority: WindowsDirectoryPublicationAuthority = {
    transactionId: TRANSACTION,
    assertHeld() {
      if (!fixture.authorityHeld) throw new Error('authority released');
    }
  };

  function expectationFor(path: string) {
    const root = required(nodes, path);
    if (root.kind !== 'directory') throw new Error('expected directory fixture');
    const entries = [...nodes.entries()]
      .filter(([candidatePath]) => candidatePath.startsWith(`${path}\\`))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([candidatePath, node]) => {
        const relativePath = candidatePath.slice(path.length + 1).replaceAll('\\', '/');
        if (node.kind === 'directory') {
          return { path: relativePath, kind: 'directory', volumeIdentity: VOLUME, fileId: fileId(node.id) };
        }
        const bytes = node.bytes ?? Buffer.alloc(0);
        return {
          path: relativePath,
          kind: 'file',
          volumeIdentity: VOLUME,
          fileId: fileId(node.id),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.byteLength
        };
      });
    const canonical = `${JSON.stringify({
      schemaVersion: 1,
      root: { volumeIdentity: VOLUME, fileId: fileId(root.id) },
      entries
    }, null, 2)}\n`;
    return {
      rootIdentity: `${VOLUME}:${fileId(root.id)}`,
      closureSha256: createHash('sha256')
        .update('bazframe-win32-directory-closure-v1\0')
        .update(canonical)
        .digest('hex')
    };
  }

  return fixture;
}

function moveTree(nodes: Map<string, TestNode>, source: string, target: string): void {
  if (!nodes.has(source)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  if (nodes.has(target)) throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
  const moving = [...nodes.entries()].filter(([path]) => path === source || path.startsWith(`${source}\\`));
  for (const [path] of moving) nodes.delete(path);
  for (const [path, node] of moving) nodes.set(`${target}${path.slice(source.length)}`, node);
}

function dir(id: number): TestNode { return { kind: 'directory', id, attributes: 0x10 }; }
function file(id: number, value: string): TestNode {
  return { kind: 'file', id, bytes: Buffer.from(value), attributes: 0x20 };
}
function reparse(id: number): TestNode {
  return { kind: 'reparse', id, attributes: 0x410, reparseTag: 0xa0000003 };
}

function entry(name: string, node: TestNode): WindowsDirectoryEntryObservation {
  const object = objectObservation(node);
  return {
    name,
    fileId: object.fileId,
    size: object.size,
    allocationSize: object.allocationSize,
    creationTime: object.creationTime,
    lastWriteTime: object.lastWriteTime,
    changeTime: object.changeTime,
    attributes: object.attributes,
    reparseTag: node.reparseTag ?? null,
    directory: node.kind !== 'file'
  };
}

function inspection(path: string, node: TestNode): WindowsPathInspection {
  const object = objectObservation(node);
  return {
    canonicalPath: canonical(path),
    kind: node.kind === 'directory' ? 'directory' : 'regular-file',
    volume: {
      identity: VOLUME,
      filesystemName: 'NTFS',
      driveType: 'fixed',
      canonicalVolumeGuidPath: '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\',
      remoteDevice: false
    },
    object,
    security: node.security ?? security(),
    ancestryReparseFree: true
  };
}

function objectObservation(node: TestNode): WindowsObjectObservation {
  const size = node.bytes?.byteLength ?? 0;
  return {
    volumeIdentity: VOLUME,
    fileId: fileId(node.id),
    size: hex(size),
    allocationSize: hex(size),
    numberOfLinks: (node.numberOfLinks ?? 1).toString(16).padStart(8, '0'),
    creationTime: '0000000000000001',
    lastAccessTime: '0000000000000001',
    lastWriteTime: '0000000000000001',
    changeTime: '0000000000000001',
    attributes: node.attributes ?? (node.kind === 'file' ? 0x20 : 0x10),
    reparseTag: node.reparseTag ?? null,
    deletePending: false,
    directory: node.kind !== 'file'
  };
}

function canonical(path: string): string {
  const root = '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\';
  const suffix = path.slice(3);
  return suffix === '' ? root : `${root}${suffix}`;
}

function security(): WindowsSecurityObservation {
  return {
    descriptorControl: 0x1004,
    daclPresent: true,
    daclNull: false,
    daclDefaulted: false,
    daclBytes: privateAcl(),
    ownerSid: USER,
    ownerDefaulted: false,
    groupSid: USER,
    groupDefaulted: false,
    currentUserSid: USER
  };
}

function privateAcl(): Buffer {
  return acl([ace(USER), ace(SYSTEM), ace(ADMINISTRATORS)]);
}

function acl(aces: Buffer[]): Buffer {
  const size = 8 + aces.reduce((total, value) => total + value.byteLength, 0);
  const header = Buffer.alloc(8);
  header[0] = 2;
  header.writeUInt16LE(size, 2);
  header.writeUInt16LE(aces.length, 4);
  return Buffer.concat([header, ...aces]);
}

function ace(sid: string): Buffer {
  const sidBytes = binarySid(sid);
  const value = Buffer.alloc(8 + sidBytes.byteLength);
  value[0] = 0;
  value[1] = 3;
  value.writeUInt16LE(value.byteLength, 2);
  value.writeUInt32LE(FULL, 4);
  sidBytes.copy(value, 8);
  return value;
}

function binarySid(value: string): Buffer {
  const parts = value.split('-');
  const authority = BigInt(parts[2]!);
  const subauthorities = parts.slice(3).map(Number);
  const result = Buffer.alloc(8 + subauthorities.length * 4);
  result[0] = 1;
  result[1] = subauthorities.length;
  let remaining = authority;
  for (let index = 7; index >= 2; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  subauthorities.forEach((part, index) => result.writeUInt32LE(part, 8 + index * 4));
  return result;
}

function required(nodes: Map<string, TestNode>, path: string): TestNode {
  const node = nodes.get(path);
  if (node === undefined) throw Object.assign(new Error(`missing test node: ${path}`), { code: 'ENOENT' });
  return node;
}

function fileId(value: number): string { return value.toString(16).padStart(32, '0'); }
function hex(value: number): string { return value.toString(16).padStart(16, '0'); }
