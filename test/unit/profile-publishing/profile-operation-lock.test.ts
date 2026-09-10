import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { basename, join, win32 } from 'node:path';
import { createTempDirectory, type TempDirectory } from '../../helpers/temp-directory.js';
import { assertWindowsOperationMutationAuthority, assertOperationMutationAuthority, operationAuthorityTransactionId, profileOperationSocketPath, withProfileOperationLocks, withWindowsProfileOperationLocksForInternalTesting, type OperationMutationAuthority } from '../../../src/profile-publishing/profile-operation-lock.js';
import { createHash } from 'node:crypto';
import { BazframeError } from '../../../src/core/errors.js';
import { windowsProvisioningFixture } from '../../helpers/windows-provisioning-fixture.js';
import { profilePublishingOperationLockRoot } from '../../../src/state/paths.js';
let temporary:TempDirectory|undefined;let child:ChildProcess|undefined;
afterEach(async()=>{vi.unstubAllGlobals();child?.kill('SIGKILL');child=undefined;await temporary?.cleanup();temporary=undefined;});
async function holder(path:string):Promise<ChildProcess>{await mkdir(profilePublishingOperationLockRoot(temporary!.root),{recursive:true});const process=fork(new URL('../../fixtures/profile-operation-lock-holder.mjs',import.meta.url),[],{env:{...globalThis.process.env,LOCK_PATH:path},stdio:['ignore','ignore','ignore','ipc']});await new Promise<void>((resolve,reject)=>{process.once('message',()=>resolve());process.once('error',reject);});return process;}
describe('profile operation lock',()=>{
 it('rejects forged, wrong-key, wrong-home, and expired authority',async()=>{temporary=await createTempDirectory('/tmp/bzf-op-');const home=temporary.root;let expired:OperationMutationAuthority|undefined;await withProfileOperationLocks(home,['work','@store'],async(authority)=>{expired=authority;expect(()=>assertOperationMutationAuthority(authority,home,['work','@store'])).not.toThrow();expect(()=>assertOperationMutationAuthority(authority,home,['other'])).toThrow();expect(()=>assertOperationMutationAuthority(authority,`${home}-other`,['work'])).toThrow();});expect(()=>assertOperationMutationAuthority(expired!,home,['work'])).toThrow();expect(()=>assertOperationMutationAuthority({} as OperationMutationAuthority,home,['work'])).toThrow();});
 it('detects a live socket and recovers a refused stale socket after process death',async()=>{temporary=await createTempDirectory('/tmp/bzf-op-');const path=profileOperationSocketPath(temporary.root,'work');child=await holder(path);await expect(withProfileOperationLocks(temporary.root,['work'],async()=>undefined)).rejects.toMatchObject({code:'PROFILE_OPERATION_LOCK_BUSY'});child.kill('SIGKILL');await new Promise<void>((resolve)=>child!.once('exit',()=>resolve()));child=undefined;await expect(withProfileOperationLocks(temporary.root,['work'],async()=> 'ok')).resolves.toBe('ok');});
 it('uses live takeover claims to prevent acquisition through a stale-replacement gap',async()=>{temporary=await createTempDirectory('/tmp/bzf-op-');const path=profileOperationSocketPath(temporary.root,'work');const claim=join(profilePublishingOperationLockRoot(temporary.root),`.c${basename(path).slice(0,9)}.${'a'.repeat(10)}`);child=await holder(claim);await expect(withProfileOperationLocks(temporary.root,['work'],async()=>undefined)).rejects.toMatchObject({code:'PROFILE_OPERATION_LOCK_BUSY'});child.kill('SIGKILL');await new Promise<void>((resolve)=>child!.once('exit',()=>resolve()));child=undefined;await expect(withProfileOperationLocks(temporary.root,['work'],async()=> 'ok')).resolves.toBe('ok');});
 it('reclaims an orphan private owner socket left before canonical linking',async()=>{temporary=await createTempDirectory('/tmp/bzf-op-');const root=profilePublishingOperationLockRoot(temporary.root);const orphan=join(root,`.o-${'a'.repeat(19)}`);child=await holder(orphan);child.kill('SIGKILL');await new Promise<void>((resolve)=>child!.once('exit',()=>resolve()));child=undefined;await expect(withProfileOperationLocks(temporary.root,['work'],async()=>undefined)).resolves.toBeUndefined();expect(await readdir(root)).toEqual([]);});
 it('acquires multiple keys in canonical order and rejects empty or duplicate sets',async()=>{temporary=await createTempDirectory('/tmp/bzf-op-');await expect(withProfileOperationLocks(temporary.root,['z','a','@store'],async(authority)=>{assertOperationMutationAuthority(authority,temporary!.root,['a','z','@store']);})).resolves.toBeUndefined();await expect(withProfileOperationLocks(temporary.root,[],async()=>undefined)).rejects.toMatchObject({code:'PROFILE_OPERATION_LOCK_INVALID'});await expect(withProfileOperationLocks(temporary.root,['a','a'],async()=>undefined)).rejects.toMatchObject({code:'PROFILE_OPERATION_LOCK_INVALID'});});
 it('preflights Unix socket paths by UTF-8 byte length at the platform boundary',async()=>{temporary=await createTempDirectory('/tmp/bzf-op-');const maximumBytes=process.platform==='darwin'?103:107;const baseBytes=Buffer.byteLength(profileOperationSocketPath(temporary.root,'work'),'utf8');const acceptedHome=join(temporary.root,'x'.repeat(maximumBytes-baseBytes-1));expect(Buffer.byteLength(profileOperationSocketPath(acceptedHome,'work'),'utf8')).toBe(maximumBytes);await expect(withProfileOperationLocks(acceptedHome,['work'],async()=>undefined)).resolves.toBeUndefined();const refusedHome=join(temporary.root,'x'.repeat(maximumBytes-baseBytes));await expect(withProfileOperationLocks(refusedHome,['work'],async()=>undefined)).rejects.toMatchObject({code:'PROFILE_OPERATION_LOCK_PATH_UNSUPPORTED'});await expect(lstat(refusedHome)).rejects.toMatchObject({code:'ENOENT'});const unicodeHome=join(temporary.root,'é'.repeat(Math.ceil((maximumBytes-baseBytes)/2)));expect(profileOperationSocketPath(unicodeHome,'work').length).toBeLessThanOrEqual(maximumBytes);expect(Buffer.byteLength(profileOperationSocketPath(unicodeHome,'work'),'utf8')).toBeGreaterThan(maximumBytes);await expect(withProfileOperationLocks(unicodeHome,['work'],async()=>undefined)).rejects.toMatchObject({code:'PROFILE_OPERATION_LOCK_PATH_UNSUPPORTED'});});
});


const WINDOWS_HOME = 'C:\\boundary\\home';
const TRANSACTION_ID = 'a'.repeat(32);
function windowsLocks() {
  const f = windowsProvisioningFixture();
  f.directory(WINDOWS_HOME);
  return { ...f, run<T>(operation: (authority: OperationMutationAuthority) => Promise<T>, options: { afterOperationLock?(key: string): void | Promise<void> } = {}) {
    return withWindowsProfileOperationLocksForInternalTesting(f.backend, WINDOWS_HOME, ['work', '@store'], TRANSACTION_ID, operation, { lockIo: f.io, ...options });
  } };
}
function windowsComponent(key: string): string { return createHash('sha256').update('bazframe-profile-operation-key-v1\0').update(key).digest('hex'); }

describe('shared authority from internal Windows profile locks', () => {
  it('accepts only the issued Windows authority with the same backend and live scope without effects', async () => {
    const f = windowsLocks();
    let escaped: OperationMutationAuthority | undefined;
    await f.run(async (authority) => {
      escaped = authority;
      const before = f.snapshot();
      expect(() => assertWindowsOperationMutationAuthority(authority, f.backend, WINDOWS_HOME, ['work', '@store'], TRANSACTION_ID)).not.toThrow();
      expect(() => assertWindowsOperationMutationAuthority(authority, f.backend, `${WINDOWS_HOME}\\.`, ['work'], TRANSACTION_ID)).not.toThrow();
      const checks = [
        () => assertWindowsOperationMutationAuthority({} as OperationMutationAuthority, f.backend, WINDOWS_HOME, ['work'], TRANSACTION_ID),
        () => assertWindowsOperationMutationAuthority({ ...authority, assertHeld() {} } as OperationMutationAuthority, f.backend, WINDOWS_HOME, ['work'], TRANSACTION_ID),
        () => assertWindowsOperationMutationAuthority(authority, { ...f.backend }, WINDOWS_HOME, ['work'], TRANSACTION_ID),
        () => assertWindowsOperationMutationAuthority(authority, f.backend, `${WINDOWS_HOME}-other`, ['work'], TRANSACTION_ID),
        () => assertWindowsOperationMutationAuthority(authority, f.backend, WINDOWS_HOME.toLowerCase(), ['work'], TRANSACTION_ID),
        () => assertWindowsOperationMutationAuthority(authority, f.backend, WINDOWS_HOME, ['work', '@store', 'other'], TRANSACTION_ID),
        () => assertWindowsOperationMutationAuthority(authority, f.backend, WINDOWS_HOME, ['work'], 'b'.repeat(32))
      ];
      for (const check of checks) expect(check).toThrow(expect.objectContaining({ code: 'PROFILE_OPERATION_AUTHORITY_INVALID' }));
      expect(f.snapshot()).toBe(before);
    });
    const afterRelease = f.snapshot();
    expect(() => assertWindowsOperationMutationAuthority(escaped!, f.backend, WINDOWS_HOME, ['work'], TRANSACTION_ID)).toThrow(expect.objectContaining({ code: 'PROFILE_OPERATION_AUTHORITY_INVALID' }));
    expect(f.snapshot()).toBe(afterRelease);
  });

  it('rejects actual supported-platform issuance even with matching scope before Windows inspection or effects', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    const f = windowsLocks();
    const before = f.snapshot();
    const inspect = vi.spyOn(f.backend, 'inspectPath');
    await withProfileOperationLocks(temporary.root, ['work', '@store'], async (authority) => {
      assertOperationMutationAuthority(authority, temporary!.root, ['work', '@store'], TRANSACTION_ID);
      expect(() => assertWindowsOperationMutationAuthority(authority, f.backend, temporary!.root, ['work', '@store'], TRANSACTION_ID)).toThrow(expect.objectContaining({ code: 'PROFILE_OPERATION_AUTHORITY_INVALID' }));
    }, TRANSACTION_ID);
    expect(inspect).not.toHaveBeenCalled();
    expect(f.snapshot()).toBe(before);
  });

  it('issues only after sorted full acquisition, retains announcement bindings, and expires before reverse native release', async () => {
    const f = windowsLocks();
    const events: string[] = [];
    let escaped: OperationMutationAuthority | undefined;
    const acquire = f.backend.acquireFileLock;
    f.backend.acquireFileLock = (path) => {
      const result = acquire(path);
      if (result.state !== 'acquired') return result;
      return { ...result, capability: { assertHeld: () => result.capability.assertHeld(), release() {
        expect(() => assertOperationMutationAuthority(escaped!, WINDOWS_HOME, ['work'])).toThrow();
        expect(() => assertWindowsOperationMutationAuthority(escaped!, f.backend, WINDOWS_HOME, ['work'], TRANSACTION_ID)).toThrow();
        expect(() => operationAuthorityTransactionId(escaped!)).toThrow();
        events.push(`release:${win32.basename(win32.dirname(path))}`);
        result.capability.release();
      } } };
    };
    await expect(f.run(async (authority) => {
      escaped = authority;
      events.push('callback');
      assertOperationMutationAuthority(authority, WINDOWS_HOME, ['@store', 'work'], TRANSACTION_ID);
      assertOperationMutationAuthority(authority, `${WINDOWS_HOME}\\.`, ['work']);
      expect(operationAuthorityTransactionId(authority)).toBe(TRANSACTION_ID);
      for (const key of ['@store', 'work']) {
        const path = win32.join(WINDOWS_HOME, 'profile-publishing', 'operation-locks', windowsComponent(key), 'owner');
        expect(JSON.parse(f.nodes.get(path)!.bytes!.toString())).toMatchObject({ status: 'held', command: 'profile-managed-use', target: `${TRANSACTION_ID}:${key}` });
      }
      expect(() => assertOperationMutationAuthority(authority, WINDOWS_HOME, ['other'])).toThrow();
      expect(() => assertOperationMutationAuthority(authority, `${WINDOWS_HOME}-other`, ['work'])).toThrow();
      expect(() => assertOperationMutationAuthority(authority, WINDOWS_HOME.toLowerCase(), ['work'])).toThrow();
      expect(() => assertOperationMutationAuthority(authority, WINDOWS_HOME, ['work'], 'b'.repeat(32))).toThrow();
      return 'ok';
    }, { afterOperationLock(key) { expect(escaped).toBeUndefined(); events.push(key); } })).resolves.toBe('ok');
    expect(events).toEqual(['@store', 'work', 'callback', `release:${windowsComponent('work')}`, `release:${windowsComponent('@store')}`]);
    expect(() => assertOperationMutationAuthority(escaped!, WINDOWS_HOME, ['work'])).toThrow();
    expect(() => operationAuthorityTransactionId(escaped!)).toThrow();
    expect(() => assertOperationMutationAuthority({} as OperationMutationAuthority, WINDOWS_HOME, ['work'])).toThrow();
    expect(() => operationAuthorityTransactionId({} as OperationMutationAuthority)).toThrow();
  });

  it.each(['identity', 'admission', 'capability'] as const)('all authority accessors revalidate live %s proof without masking native refusals', async (kind) => {
    const f = windowsLocks();
    const nativeFailure = new BazframeError('WINDOWS_NATIVE_TEST_REFUSAL', 'native refusal');
    let failCapability = false;
    const acquire = f.backend.acquireFileLock;
    f.backend.acquireFileLock = (path) => {
      const result = acquire(path);
      if (result.state !== 'acquired') return result;
      return { ...result, capability: { release: () => result.capability.release(), assertHeld() {
        if (failCapability) throw nativeFailure;
        result.capability.assertHeld();
      } } };
    };
    await f.run(async (authority) => {
      const originalHome = f.nodes.get(WINDOWS_HOME)!;
      if (kind === 'identity') f.directory(WINDOWS_HOME);
      if (kind === 'admission') f.reparse(WINDOWS_HOME);
      if (kind === 'capability') failCapability = true;
      try {
        const checks = [() => assertOperationMutationAuthority(authority, WINDOWS_HOME, ['work'], TRANSACTION_ID), () => assertWindowsOperationMutationAuthority(authority, f.backend, WINDOWS_HOME, ['work'], TRANSACTION_ID), () => operationAuthorityTransactionId(authority)];
        for (const check of checks) {
          if (kind === 'capability') expect(check).toThrow(nativeFailure);
          else expect(check).toThrow();
        }
      } finally { f.nodes.set(WINDOWS_HOME, originalHome); failCapability = false; }
    });
  });

  it.each(['busy', 'acquisition', 'hook'] as const)('never issues on %s during partial acquisition and releases the first lock', async (kind) => {
    const f = windowsLocks();
    const callback = vi.fn(async () => undefined);
    const released: string[] = [];
    const failure = new Error('second lock failed');
    const acquire = f.backend.acquireFileLock;
    f.backend.acquireFileLock = (path) => {
      const result = acquire(path);
      if (result.state !== 'acquired') return result;
      if (path.includes(windowsComponent('work')) && kind !== 'hook') {
        result.capability.release();
        if (kind === 'acquisition') throw failure;
        return { state: 'busy', guardBefore: result.guardBefore, guardAfter: result.guardAfter, currentProcess: result.currentProcess };
      }
      return { ...result, capability: { assertHeld: () => result.capability.assertHeld(), release() { released.push(win32.basename(win32.dirname(path))); result.capability.release(); } } };
    };
    const result = f.run(callback, { afterOperationLock(key) { if (kind === 'hook' && key === 'work') throw failure; } });
    if (kind === 'busy') await expect(result).rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_BUSY_AMBIGUOUS' });
    else await expect(result).rejects.toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    expect(released).toEqual(kind === 'hook' ? [windowsComponent('work'), windowsComponent('@store')] : [windowsComponent('@store')]);
    f.backend.acquireFileLock = acquire;
    await expect(f.run(async () => 'retry')).resolves.toBe('retry');
  });

  it('retains a proved native busy announcement without issuing authority', async () => {
    const f = windowsLocks();
    const owners = new Map<string, Buffer>();
    await f.run(async () => {
      for (const [path, node] of f.nodes) if (win32.basename(path) === 'owner') owners.set(path, Buffer.from(node.bytes!));
    });
    for (const [path, bytes] of owners) f.nodes.get(path)!.bytes = bytes;
    f.backend.inspectProcessInstance = () => ({ state: 'running' });
    const acquire = f.backend.acquireFileLock;
    f.backend.acquireFileLock = (path) => {
      const result = acquire(path);
      if (result.state === 'acquired') result.capability.release();
      return { state: 'busy', guardBefore: result.guardBefore, guardAfter: result.guardAfter, currentProcess: result.currentProcess };
    };
    const callback = vi.fn(async () => undefined);
    const before = f.snapshot();
    await expect(f.run(callback)).rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_BUSY' });
    expect(callback).not.toHaveBeenCalled();
    expect(f.snapshot()).toBe(before);
  });

  it('validates logical scope before Windows admission or namespace writes', async () => {
    const f = windowsLocks();
    const before = f.snapshot();
    const callback = vi.fn(async () => undefined);
    for (const [keys, transaction] of [[[], TRANSACTION_ID], [['work', 'work'], TRANSACTION_ID], [['../bad'], TRANSACTION_ID], [['work'], 'bad']] as const) {
      await expect(withWindowsProfileOperationLocksForInternalTesting(f.backend, WINDOWS_HOME, keys, transaction, callback, { lockIo: f.io })).rejects.toMatchObject({ code: 'PROFILE_OPERATION_LOCK_INVALID' });
    }
    expect(callback).not.toHaveBeenCalled();
    expect(f.snapshot()).toBe(before);
  });

  it('retains same-process contention refusal without issuing nested authority', async () => {
    const f = windowsLocks();
    const callback = vi.fn(async () => undefined);
    await f.run(async () => { await expect(f.run(callback)).rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_REENTRANT' }); });
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([undefined, null, new Error('callback failed')])('preserves callback rejection %# exactly and expires authority', async (failure) => {
    const f = windowsLocks();
    let escaped: OperationMutationAuthority | undefined;
    await expect(f.run(async (authority) => { escaped = authority; throw failure; })).rejects.toBe(failure);
    expect(() => operationAuthorityTransactionId(escaped!)).toThrow();
    await expect(f.run(async () => 'retry')).resolves.toBe('retry');
  });

  it.each(['native', 'announcement'].flatMap((kind) => [false, true].map((rejectCallback) => ({ kind, rejectCallback }))))('retains $kind release failure precedence (callback rejected: $rejectCallback) and outer-over-inner failures', async ({ kind, rejectCallback }) => {
    const f = windowsLocks();
    const failures = new Map(['@store', 'work'].map((key) => [windowsComponent(key), new Error(key)]));
    const acquire = f.backend.acquireFileLock;
    f.backend.acquireFileLock = (path) => {
      const result = acquire(path);
      if (result.state !== 'acquired') return result;
      return { ...result, capability: { assertHeld: () => result.capability.assertHeld(), release() {
        result.capability.release();
        if (kind === 'native') throw failures.get(win32.basename(win32.dirname(path)));
      } } };
    };
    const write = f.io.writeExistingFile;
    f.io.writeExistingFile = async (path, bytes) => {
      if (kind === 'announcement' && JSON.parse(Buffer.from(bytes).toString()).status === 'released') throw failures.get(win32.basename(win32.dirname(path)));
      await write(path, bytes);
    };
    let escaped: OperationMutationAuthority | undefined;
    await expect(f.run(async (authority) => { escaped = authority; if (rejectCallback) throw undefined; return 'ok'; })).rejects.toMatchObject({ code: 'WINDOWS_OPERATION_LOCK_RELEASE_AMBIGUOUS', cause: failures.get(windowsComponent('@store')) });
    expect(() => operationAuthorityTransactionId(escaped!)).toThrow();
  });
});

describe('supported-platform authority compatibility', () => {
  it('validates transaction accessor and rejects replaced native proof', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await withProfileOperationLocks(temporary.root, ['work'], async (authority) => {
      expect(operationAuthorityTransactionId(authority)).toBe(TRANSACTION_ID);
      expect(() => assertOperationMutationAuthority(authority, temporary!.root, ['work'], 'b'.repeat(32))).toThrow();
      await unlink(profileOperationSocketPath(temporary!.root, 'work'));
      expect(() => assertOperationMutationAuthority(authority, temporary!.root, ['work'])).toThrow();
      expect(() => operationAuthorityTransactionId(authority)).toThrow();
    }, TRANSACTION_ID);
  });
  it('preserves supported-platform rejected-undefined and callback-over-release error behavior', async () => {
    temporary = await createTempDirectory('/tmp/bzf-op-');
    await expect(withProfileOperationLocks(temporary.root, ['work'], async () => { throw undefined; })).resolves.toBeUndefined();
    const failure = new Error('callback');
    await expect(withProfileOperationLocks(temporary.root, ['work'], async () => {
      await rename(profilePublishingOperationLockRoot(temporary!.root), `${profilePublishingOperationLockRoot(temporary!.root)}-moved`);
      throw failure;
    })).rejects.toBe(failure);
  });
  it('keeps the default Windows refusal before acquisition', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const operation = vi.fn(async () => undefined);
    await expect(withProfileOperationLocks(WINDOWS_HOME, ['work'], operation)).rejects.toMatchObject({ code: 'PROFILE_OPERATION_LOCK_PLATFORM_UNSUPPORTED' });
    expect(operation).not.toHaveBeenCalled();
  });
});
