import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { inspect } from 'node:util';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sameSelectionCandidateObject, selectionCandidateCommitted, selectionCandidateRetained, withSharingDenied } from './test-win32-profile-activation.mjs';

// Targeted native smoke. Supply a built package root and an admitted private local-NTFS parent.
// New disposable state is retained privately; stdout/stderr contain only fixed status messages.
let failureLog;
async function runWindowsTransactionJournalSmoke(packageRoot, parent) {
  assert.equal(process.platform, 'win32');
  assert.ok(win32.isAbsolute(parent));
  const load = (name) => import(pathToFileURL(join(packageRoot, `dist/${name}.js`)).href);
  const { loadBazframeWin32Native } = await load('core/win32-native');
  const privateState = await load('state/win32-private-directory');
  const { readWindowsPrivateFileSnapshot } = await load('profiles/win32-profile-selection');
  const { enumerateWindowsPrivateDirectory } = await load('skills/added-skill-platform-services');
  const { createWindowsOrdinaryProfileReads } = await load('profile-publishing/win32-physical-profile-reads');
  const { serializeWindowsPhysicalProfileProof } = await load('profile-publishing/physical-profile-closure');
  const codec = await load('profile-publishing/transaction-journal');
  const storage = await load('profile-publishing/win32-transaction-journal');
  const { withWindowsProfileOperationLocksForInternalTesting } = await load('profile-publishing/profile-operation-lock');
  const backend = loadBazframeWin32Native();
  privateState.admitWindowsPrivateDirectory(backend, parent);
  const component = `journal-smoke-${randomBytes(16).toString('hex')}`;
  privateState.createWindowsPrivateDirectory(backend, parent, component);
  const home = win32.join(parent, component), root = win32.join(home, 'profile-publishing', 'transactions');
  privateState.createWindowsPrivateFile(backend, home, 'failure.log');
  failureLog = win32.join(home, 'failure.log');
  for (const [directory, name] of [[home, 'profiles'], [win32.join(home, 'profiles'), 'work'], [win32.join(home, 'profiles', 'work'), 'skills']]) {
    privateState.createWindowsPrivateDirectory(backend, directory, name);
  }
  const profile = win32.join(home, 'profiles', 'work');
  privateState.createWindowsPrivateFile(backend, profile, 'AGENTS.md');
  await writeReal(win32.join(profile, 'AGENTS.md'), Buffer.from('journal smoke\r\n'));
  const reader = createWindowsOrdinaryProfileReads(backend);
  const expected = await reader.captureExpectation(home, 'work');
  const proof = serializeWindowsPhysicalProfileProof(expected);
  const record = () => {
    const id = randomBytes(16).toString('hex');
    return { schemaVersion: 2, identityDomain: 'win32-ntfs', kind: 'candidate-swap', transactionId: id,
      operation: 'overwrite', profileName: 'work', expectedOld: { kind: 'physical-directory', ...proof },
      candidate: { token: `candidate:${id}`, identity: null, sidecarSha256: null, profileClosureSha256: null },
      backup: null, activeProfileBefore: null, phase: 'PLANNED', possiblePackageEffects: [] };
  };
  const path = (value) => win32.join(root, `${value.transactionId}.json`);
  const snapshot = (file) => readWindowsPrivateFileSnapshot(backend, file, 1024 * 1024);
  const names = async () => (await enumerateWindowsPrivateDirectory(backend, root, 32768)).names;
  const read = (value) => storage.readWindowsTransactionJournal(backend, home, value.transactionId);
  const write = (authority, value, options) => storage.writeWindowsTransactionJournal(backend, home, authority, value, options);
  const locked = (value, operation) => withWindowsProfileOperationLocksForInternalTesting(backend, home, codec.transactionJournalRequiredAuthorityKeys(value), value.transactionId, operation);
  const planned = record();
  assert.equal(await read(planned), undefined);
  await locked(planned, async (authority) => {
    let created;
    assert.deepEqual(await write(authority, planned, { hooks: { async afterPrivateCreation() {
      created = await snapshot(path(planned));
      assert.equal(created.bytes.length, 0);
    } } }), planned);
    assert.ok(sameSelectionCandidateObject(created, await snapshot(path(planned))));
    const next = codec.transitionTransactionJournal(planned, 'MATERIALIZING');
    assert.deepEqual(await write(authority, next), next);
    assert.deepEqual(await read(planned), next);
    assert.deepEqual((await snapshot(path(planned))).bytes, Buffer.from(codec.encodeTransactionJournal(next)));
  });

  const reopened = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--reopen', packageRoot, home, planned.transactionId], { stdio: ['ignore', 'ignore', 'pipe'] });
  assert.equal(reopened.error, undefined);
  assert.equal(reopened.signal, null);
  assert.equal(reopened.status, 0, reopened.stderr?.toString('utf8'));

  for (const partial of [false, true]) {
    const value = record();
    await locked(value, async (authority) => {
      await assert.rejects(() => write(authority, value, partial ? { io: {
        async writeExistingFile(file, bytes) { await writeReal(file, bytes.subarray(0, 1)); throw new Error('interrupted'); }, rename
      } } : { hooks: { afterPrivateCreation() { throw new Error('interrupted'); } } }), { code: 'WINDOWS_TRANSACTION_JOURNAL_BEFORE_REPLACEMENT' });
      const occupied = await snapshot(path(value));
      assert.deepEqual(occupied.bytes, partial ? Buffer.from('{') : Buffer.alloc(0));
      await assert.rejects(() => read(value), { code: 'WINDOWS_TRANSACTION_JOURNAL_REFUSED' });
      await assert.rejects(() => write(authority, value), { code: 'WINDOWS_TRANSACTION_JOURNAL_BEFORE_REPLACEMENT' });
      assert.ok(selectionCandidateRetained(occupied, await snapshot(path(value))));
    });
  }

  for (const outcome of ['sharing', 'rename-error', 'altered']) {
    const value = record(), next = codec.transitionTransactionJournal(value, 'MATERIALIZING');
    await locked(value, async (authority) => {
      await write(authority, value);
      const old = await snapshot(path(value)), before = new Set(await names());
      let candidate, temporary;
      const operation = () => write(authority, next, { io: { writeExistingFile: writeReal, async rename(source, destination) {
        await rename(source, destination);
        if (outcome === 'rename-error') throw new Error('post-rename error');
      } }, hooks: {
        async afterCandidateRead() {
          const added = (await names()).filter((name) => !before.has(name));
          assert.equal(added.length, 1);
          assert.match(added[0], /^\.tmp-[a-f0-9]{32}$/u);
          temporary = win32.join(root, added[0]);
          candidate = await snapshot(temporary);
          assert.deepEqual(candidate.bytes, Buffer.from(codec.encodeTransactionJournal(next)));
        },
        async afterReplacement() {
          if (outcome === 'altered') await writeReal(path(value), Buffer.concat([candidate.bytes, Buffer.from('\n')]));
        }
      } });
      if (outcome === 'sharing') {
        await withSharingDenied(path(value), () => assert.rejects(operation, { code: 'WINDOWS_TRANSACTION_JOURNAL_NO_EFFECT' }));
        assert.ok(selectionCandidateRetained(old, await snapshot(path(value))));
        assert.ok(selectionCandidateRetained(candidate, await snapshot(temporary)));
      } else {
        if (outcome === 'altered') await assert.rejects(operation, { code: 'WINDOWS_TRANSACTION_JOURNAL_AMBIGUOUS' });
        else assert.deepEqual(await operation(), next);
        assert.ok(!(await names()).includes(win32.basename(temporary)));
        const final = await snapshot(path(value));
        if (outcome === 'rename-error') assert.ok(selectionCandidateCommitted(candidate, final, undefined));
        else {
          assert.ok(sameSelectionCandidateObject(candidate, final));
          assert.deepEqual(final.bytes, Buffer.concat([candidate.bytes, Buffer.from('\n')]));
        }
      }
    });
  }
  await reader.assertExpectation(home, 'work', expected);
}

async function writeReal(path, bytes) {
  const handle = await open(path, 'r+');
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--reopen') {
      assert.equal(process.platform, 'win32');
      assert.equal(process.argv.length, 6);
      const load = (name) => import(pathToFileURL(join(resolve(process.argv[3]), `dist/${name}.js`)).href);
      const { loadBazframeWin32Native } = await load('core/win32-native');
      const { readWindowsTransactionJournal } = await load('profile-publishing/win32-transaction-journal');
      const privateState = await load('state/win32-private-directory');
      const backend = loadBazframeWin32Native();
      privateState.createWindowsPrivateFile(backend, process.argv[4], 'reopen-failure.log');
      failureLog = win32.join(process.argv[4], 'reopen-failure.log');
      const value = await readWindowsTransactionJournal(backend, process.argv[4], process.argv[5]);
      assert.equal(value.kind, 'candidate-swap');
      assert.equal(value.profileName, 'work');
      assert.equal(value.phase, 'MATERIALIZING');
    } else {
      assert.equal(process.argv.length, 4);
      await runWindowsTransactionJournalSmoke(resolve(process.argv[2]), process.argv[3]);
      process.stdout.write('Windows journal smoke passed; private state retained.\n');
    }
  } catch (error) {
    let retained = false;
    if (failureLog !== undefined) {
      try { await writeReal(failureLog, Buffer.from(`${inspect(error, { depth: 8 })}\n`)); retained = true; }
      catch { /* Report explicitly when private diagnostics could not be saved. */ }
    }
    process.stderr.write(retained
      ? 'Windows journal smoke failed; original error saved in the private smoke directory.\n'
      : 'Windows journal smoke failed; unable to retain private diagnostics. Preserve state.\n');
    process.exitCode = 1;
  }
}
