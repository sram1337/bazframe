import { describe, expect, it } from 'vitest';
import {
  projectActivationProfileApplication,
  projectProfileListApplications,
  projectStatusProfileApplication,
  projectTuiProfileApplications
} from '../../../src/profile-publishing/profile-application-projection.js';
import type { ProfileSystemView } from '../../../src/profile-publishing/profile-view.js';

const view: ProfileSystemView = {
  profiles: [
    {
      name: 'ordinary', profileInstanceId: null, publication: null, publicationVersionState: 'unpublished',
      incomplete: false, missingResources: [], resourceIdentities: []
    },
    {
      name: 'linked', profileInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      publication: {
        transport: 'git', origin: 'github.com/owner/linked', installedCommit: 'a'.repeat(40),
        latestSeenCommit: 'b'.repeat(40), baselineCaptureSha256: 'c'.repeat(64), visibility: 'private'
      },
      publicationVersionState: 'older-installed', incomplete: true,
      missingResources: [{
        stableIdentity: 'imported:11111111-1111-4111-8111-111111111111', capturedResourceId: 'd'.repeat(64),
        key: { kind: 'package', name: 'builder' }, diagnosticCode: 'REMOTE_UNAVAILABLE'
      }],
      resourceIdentities: ['imported:11111111-1111-4111-8111-111111111111']
    }
  ],
  resources: [],
  namespace: [],
  skills: []
};

describe('shared hidden profile application projection', () => {
  it('keeps ordinary schema-v1 bytes extension-free and gives list/status/TUI/activation identical managed fields', () => {
    const list = projectProfileListApplications(view, 'linked');
    const tui = projectTuiProfileApplications(view, 'linked');
    const status = projectStatusProfileApplication(view, 'linked');
    const activation = projectActivationProfileApplication(view, 'linked', 'linked');

    expect(list[0]).toMatchObject({ name: 'ordinary', active: false, extension: {}, activationWarning: null });
    expect(list).toEqual(tui);
    expect(list[1]).toEqual(status);
    expect(status).toEqual(activation);
    expect(status).toEqual({
      name: 'linked',
      active: true,
      publicationVersionState: 'older-installed',
      extension: {
        completeness: 'incomplete',
        missingResources: [{ kind: 'package', name: 'builder', code: 'REMOTE_UNAVAILABLE' }],
        publication: { repository: 'github.com/owner/linked', installedCommit: 'a'.repeat(40), latestSeenCommit: 'b'.repeat(40), visibility: 'private' }
      },
      activationWarning: 'Profile "linked" is incomplete; missing resources: package builder (REMOTE_UNAVAILABLE). Activation is allowed; run `bazframe profile update --profile linked` to retry.'
    });
  });

  it('fails when active selection is absent rather than projecting inconsistent consumers', () => {
    expect(() => projectProfileListApplications(view, 'missing')).toThrow(expect.objectContaining({ code: 'PROFILE_VIEW_INVALID' }));
  });
});
