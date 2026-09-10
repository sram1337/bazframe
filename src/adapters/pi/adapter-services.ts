import type path from 'node:path';
import type { PolicyServices, PolicySnapshot, PolicyWriter } from '../../policy/policy-services.js';
import type { PiRuntimeBinding } from './runtime-binding.js';

export interface PiAdapterServices {
  paths: typeof path;
  files: PolicyServices;
  readPackagedArtifact(url: URL): Promise<Uint8Array>;
  desiredBinding(version: string): Promise<PiRuntimeBinding>;
  detachAliasCache(home: string, writer: PolicyWriter): Promise<void>;
}
export interface AdapterFileSnapshots {
  extension: PolicySnapshot;
  manifest: PolicySnapshot;
  binding: PolicySnapshot;
}
export type AdapterFileWriter = PolicyWriter;
