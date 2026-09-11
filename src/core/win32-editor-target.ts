import { win32 } from 'node:path';
import { BazframeError } from './errors.js';
import type { BazframeWin32EditorBackend, BazframeWin32NativeBackend, WindowsEditorTargetInspection, WindowsPathInspection } from './win32-native.js';
import { stableWindowsObjectObservation, stableWindowsPathInspection } from './win32-stable-observation.js';
import { admitWindowsPhysicalDirectory, admitWindowsPhysicalFile, isValidWindowsPathComponent } from '../state/win32-private-directory.js';

export interface EditorTargetProof { path: string; cwd: string; revalidate(): Promise<void> }
/** Native read-only proof, followed by adjacent revalidation. No instruction contents are inspected. */
export function proveWindowsEditorTarget(backend: BazframeWin32NativeBackend & BazframeWin32EditorBackend, root: string, filename: 'AGENTS.md' | 'SKILL.md'): EditorTargetProof {
  const entered = win32.join(root, filename);
  function inspect() {
    const admitted = admitWindowsPhysicalDirectory(backend, root);
    const value = backend.inspectEditorTarget(root, entered);
    const canonicalRoot = value.root.canonicalPath;
    const relative = win32.relative(canonicalRoot, value.target.canonicalPath);
    if (JSON.stringify(stableWindowsPathInspection(admitted)) !== JSON.stringify(stableWindowsPathInspection(value.root)) || value.root.kind !== 'directory' || value.parent.canonicalPath !== canonicalRoot || value.entryPath !== win32.join(canonicalRoot, filename)
      || value.target.kind !== 'regular-file' || value.target.object.reparseTag !== null
      || value.entryObject.directory || value.entryObject.deletePending
      || ![null, 0xa000000c].includes(value.entryObject.reparseTag)
      || relative === '' || relative === '..' || relative.startsWith('..\\') || win32.isAbsolute(relative)
      || !relative.split('\\').every(isValidWindowsPathComponent)) throw invalid();
    const targetParents: WindowsPathInspection[] = [];
    for (let path = win32.dirname(value.targetPath);;) {
      const parent = admitWindowsPhysicalDirectory(backend, path);
      if (win32.basename(parent.canonicalPath) !== win32.basename(path)) throw invalid();
      targetParents.push(parent);
      if (parent.canonicalPath === canonicalRoot) break;
      if (win32.dirname(path) === path) throw invalid();
      path = win32.dirname(path);
    }
    const target = admitWindowsPhysicalFile(backend, value.targetPath);
    if (target.canonicalPath !== win32.join(targetParents[0]!.canonicalPath, win32.basename(value.targetPath))) throw invalid();
    if (JSON.stringify(stableWindowsPathInspection(target)) !== JSON.stringify(stableWindowsPathInspection(value.target))) throw invalid();
    return { ...value, targetParents };
  }
  const before = inspect();
  return { path: before.targetPath, cwd: root, async revalidate() {
    if (binding(before) !== binding(inspect())) throw invalid();
  } };
}
function binding(value: WindowsEditorTargetInspection & { targetParents: WindowsPathInspection[] }): string {
  return JSON.stringify({ ...value, targetParents: value.targetParents.map(stableWindowsPathInspection), root: stableWindowsPathInspection(value.root), parent: stableWindowsPathInspection(value.parent), target: stableWindowsPathInspection(value.target), entryObject: stableWindowsObjectObservation(value.entryObject) });
}
function invalid(): BazframeError { return new BazframeError('WINDOWS_EDITOR_TARGET_REFUSED', 'Editor target changed or is not a contained physical regular file or supported authorized final file symlink.'); }
