import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { BazframeError, errorCode } from '../core/errors.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface AtomicWriteOptions {
  managedRoot: string;
  mode?: number;
  chmodExistingDirectories?: boolean;
  /** A rename is the commit point; a later directory-sync failure is reported only when false. */
  commitOnRename?: boolean;
  directorySync?: (path: string) => Promise<void>;
}

export interface ManagedDirectoryOptions {
  chmodExistingDirectories?: boolean;
}

export async function writeFileAtomic(
  destination: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions
): Promise<void> {
  const managedRoot = normalizedAbsolutePath(options.managedRoot, 'managed root');
  const target = normalizedAbsolutePath(destination, 'atomic-write destination');
  assertPathWithin(managedRoot, target);
  if (target === managedRoot) {
    throw new BazframeError(
      'MANAGED_PATH_INVALID',
      `Atomic-write destination must be below its managed root: ${target}`
    );
  }

  const parent = dirname(target);
  await ensureManagedDirectory(managedRoot, parent, {
    chmodExistingDirectories: options.chmodExistingDirectories
  });
  await assertReplaceableDestination(target);

  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      options.mode ?? FILE_MODE
    );
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, target);
    renamed = true;
    try {
      await (options.directorySync ?? syncDirectory)(parent);
    } catch (error) {
      if (options.commitOnRename === true) return;
      throw error;
    }
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The original failure remains the actionable error.
      }
    }
    if (!renamed) await rm(temporaryPath, { force: true });
    if (error instanceof BazframeError) throw error;
    throw new BazframeError(
      'ATOMIC_WRITE_FAILED',
      `Could not atomically write ${target}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
}

export async function ensureManagedDirectory(
  managedRoot: string,
  directory: string,
  options: ManagedDirectoryOptions = {}
): Promise<void> {
  const root = normalizedAbsolutePath(managedRoot, 'managed root');
  const target = normalizedAbsolutePath(directory, 'managed directory');
  assertPathWithin(root, target);

  const rootCreated = await createDirectory(root, true);
  await assertDirectory(root);
  if (rootCreated || options.chmodExistingDirectories !== false) {
    await chmod(root, DIRECTORY_MODE);
  }

  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '') return;

  let current = root;
  for (const segment of pathFromRoot.split(sep)) {
    current = resolve(current, segment);
    const created = await createDirectory(current, false);
    await assertDirectory(current);
    if (created || options.chmodExistingDirectories !== false) {
      await chmod(current, DIRECTORY_MODE);
    }
  }
}

async function createDirectory(path: string, recursive: boolean): Promise<boolean> {
  try {
    const created = await mkdir(path, { recursive, mode: DIRECTORY_MODE });
    return recursive ? created !== undefined : true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw new BazframeError(
      'MANAGED_DIRECTORY_CREATE_FAILED',
      `Could not create Bazframe-managed directory ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
}

export async function removeManagedDirectoryTree(
  managedRoot: string,
  directory: string
): Promise<void> {
  const root = normalizedAbsolutePath(managedRoot, 'managed root');
  const target = normalizedAbsolutePath(directory, 'managed directory');
  assertPathWithin(root, target);
  if (target === root) {
    throw new BazframeError(
      'MANAGED_PATH_INVALID',
      `Managed directory removal must target a child of its root: ${target}`
    );
  }

  const pathFromRoot = relative(root, target);
  let current = root;
  for (const segment of ['', ...pathFromRoot.split(sep)]) {
    if (segment !== '') current = resolve(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new BazframeError(
        'MANAGED_DIRECTORY_INVALID',
        `Bazframe-managed directory must be a physical directory: ${current}`
      );
    }
  }
  await rm(target, { recursive: true });
}

export function assertPathWithin(managedRoot: string, candidate: string): void {
  const pathFromRoot = relative(managedRoot, candidate);
  if (
    pathFromRoot === ''
    || (pathFromRoot !== '..'
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot))
  ) {
    return;
  }
  throw new BazframeError(
    'MANAGED_PATH_ESCAPE',
    `Bazframe-managed path escapes its root: ${candidate} (root: ${managedRoot})`
  );
}

async function assertDirectory(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new BazframeError(
      'MANAGED_DIRECTORY_INVALID',
      `Could not inspect Bazframe-managed directory ${path}${formatErrorCode(error)}`,
      { cause: error }
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BazframeError(
      'MANAGED_DIRECTORY_INVALID',
      `Bazframe-managed directory must be a physical directory: ${path}`
    );
  }
}

async function assertReplaceableDestination(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new BazframeError(
        'MANAGED_DESTINATION_INVALID',
        `Bazframe-managed destination must be a physical regular file: ${path}`
      );
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM']).has(errorCode(error) ?? '')) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function normalizedAbsolutePath(path: string, label: string): string {
  if (path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw new BazframeError(
      'MANAGED_PATH_INVALID',
      `${label} must be a non-empty absolute path without NUL bytes: ${path}`
    );
  }
  return resolve(path);
}

function formatErrorCode(error: unknown): string {
  const code = errorCode(error);
  return code === undefined ? '' : ` (${code})`;
}
