import { describe, expect, it } from 'vitest';
import { profilePublishingBlobRoot, profilePublishingOperationLockRoot, profilePublishingRoot, profilePublishingStagingRoot, profilePublishingTransactionRoot, profilePublishingTreeRoot, resolveBazframeHome, resolvePiAgentDirectory } from '../../../src/state/paths.js';

describe('external state paths', () => {
  it('resolves Bazframe and Pi defaults from the user home', () => {
    expect(resolveBazframeHome({}, '/users/alice')).toBe('/users/alice/.bazframe');
    expect(resolvePiAgentDirectory({}, '/users/alice')).toBe('/users/alice/.pi/agent');
  });

  it('derives profile-publishing store, transaction, staging, and operation-lock paths', () => {
    expect(profilePublishingRoot('/home')).toBe('/home/profile-publishing');
    expect(profilePublishingBlobRoot('/home')).toBe('/home/profile-publishing/blobs');
    expect(profilePublishingTreeRoot('/home')).toBe('/home/profile-publishing/trees');
    expect(profilePublishingTransactionRoot('/home')).toBe('/home/profile-publishing/transactions');
    expect(profilePublishingStagingRoot('/home')).toBe('/home/profile-publishing/staging');
    expect(profilePublishingOperationLockRoot('/home')).toBe('/home/profile-publishing/operation-locks');
  });

  it('accepts normalized absolute overrides', () => {
    expect(resolveBazframeHome({ BAZFRAME_HOME: '/tmp/baz/../baz-home' }, '/ignored'))
      .toBe('/tmp/baz-home');
    expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: '/tmp/pi agent' }, '/ignored'))
      .toBe('/tmp/pi agent');
  });

  it('ignores unrelated environment variables when resolving Bazframe home', () => {
    expect(resolveBazframeHome({ UNRELATED_LIBRARY: '/tmp/other' }, '/users/alice'))
      .toBe('/users/alice/.bazframe');
  });

  it('rejects empty, relative, and NUL-containing overrides', () => {
    expect(() => resolveBazframeHome({ BAZFRAME_HOME: '' })).toThrow(/non-empty absolute/u);
    expect(() => resolveBazframeHome({ BAZFRAME_HOME: 'relative' })).toThrow(/absolute path/u);
    expect(() => resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: '' }))
      .toThrow(/non-empty absolute/u);
    expect(() => resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: 'relative' }))
      .toThrow(/absolute path/u);
    expect(() => resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: '/tmp/pi\0bad' }))
      .toThrow(/NUL/u);
  });
});
