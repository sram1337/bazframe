import { describe, expect, it } from 'vitest';
import type { DashboardSnapshot } from '../../../src/application/tui-service.js';
import {
  initialTuiState,
  moveSelection,
  PROFILE_CREATE_ROW_ID,
  tuiReducer,
  type TuiState,
  type ViewportRows
} from '../../../src/tui/state.js';

const VIEWPORT_ROWS: ViewportRows = {
  profileList: 5,
  included: 4,
  available: 3,
  skillsBrowser: 6
};

describe('TUI state', () => {
  it('keeps active tab, focused tab, and body focus independent', () => {
    const topFocused = tuiReducer(initialTuiState, {
      type: 'cycle-focus',
      direction: 1
    });
    const cursorMoved = tuiReducer(topFocused, { type: 'focus-tab', tab: 'skills' });
    expect(cursorMoved).toMatchObject({
      activeTab: 'profiles',
      focusedTab: 'skills',
      focusedRegion: 'tabs'
    });

    expect(tuiReducer(cursorMoved, { type: 'activate-tab', tab: 'skills' })).toMatchObject({
      activeTab: 'skills',
      focusedTab: 'skills',
      focusedRegion: 'tabs'
    });
  });

  it('cycles focus between top tabs and ordinary tab bodies in either direction', () => {
    for (const direction of [1, -1] as const) {
      const tabs = tuiReducer(initialTuiState, { type: 'cycle-focus', direction });
      expect(tabs.focusedRegion).toBe('tabs');
      expect(tuiReducer(tabs, { type: 'cycle-focus', direction }).focusedRegion).toBe('body');
    }
  });

  it('cycles tabs, Included, and Available focus in the profile editor', () => {
    const editor = tuiReducer(initialTuiState, { type: 'profile-route', route: 'editor' });
    const tabs = tuiReducer(editor, { type: 'cycle-focus', direction: -1 });
    const available = tuiReducer(tabs, { type: 'cycle-focus', direction: -1 });
    const included = tuiReducer(available, { type: 'cycle-focus', direction: -1 });
    expect(tabs).toMatchObject({ focusedRegion: 'tabs', focusedPane: 'included' });
    expect(available).toMatchObject({ focusedRegion: 'body', focusedPane: 'available' });
    expect(included).toMatchObject({ focusedRegion: 'body', focusedPane: 'included' });

    const forwardAvailable = tuiReducer(editor, { type: 'cycle-focus', direction: 1 });
    const forwardTabs = tuiReducer(forwardAvailable, { type: 'cycle-focus', direction: 1 });
    expect(forwardAvailable).toMatchObject({ focusedRegion: 'body', focusedPane: 'available' });
    expect(forwardTabs.focusedRegion).toBe('tabs');
  });

  it('moves and clamps stable-ID selections', () => {
    expect(moveSelection(['a', 'b', 'c'], undefined, 1)).toBe('a');
    expect(moveSelection(['a', 'b', 'c'], undefined, -1)).toBe('c');
    expect(moveSelection(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(moveSelection(['a', 'b', 'c'], 'a', 5)).toBe('c');
    expect(moveSelection(['a', 'b', 'c'], 'c', -5)).toBe('a');
    expect(moveSelection(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(moveSelection([], 'a', -1)).toBeUndefined();
  });

  it('reconciles by stable ID and falls back after resource removal', () => {
    const first = snapshot(['focused', 'reviewer'], ['one', 'two']);
    let state = tuiReducer(initialTuiState, {
      type: 'reconcile',
      snapshot: first,
      viewportRows: VIEWPORT_ROWS
    });
    state = tuiReducer(state, { type: 'select-profile', id: 'reviewer' });
    state = tuiReducer(state, { type: 'select-included', id: 'two' });
    state = tuiReducer(state, { type: 'profile-route', route: 'editor' });

    state = tuiReducer(state, {
      type: 'reconcile',
      snapshot: snapshot(['focused', 'reviewer'], ['one', 'two']),
      viewportRows: VIEWPORT_ROWS
    });
    state = tuiReducer(state, { type: 'cycle-focus', direction: -1 });
    state = tuiReducer(state, { type: 'focus-tab', tab: 'settings' });

    expect(state).toMatchObject({
      selectedProfileId: 'reviewer',
      includedSkillId: 'two',
      profileRoute: 'editor',
      activeTab: 'profiles',
      focusedTab: 'settings',
      focusedRegion: 'tabs'
    });

    state = tuiReducer(state, {
      type: 'reconcile',
      snapshot: snapshot(['focused'], ['one']),
      viewportRows: VIEWPORT_ROWS
    });
    expect(state).toMatchObject({
      selectedProfileId: 'focused',
      includedSkillId: 'one',
      profileRoute: 'editor',
      activeTab: 'profiles',
      focusedTab: 'settings',
      focusedRegion: 'tabs'
    });
  });

  it('selects the create row when no profiles exist', () => {
    const state = tuiReducer(initialTuiState, {
      type: 'reconcile',
      snapshot: snapshot([], []),
      viewportRows: VIEWPORT_ROWS
    });
    expect(state.selectedProfileId).toBe(PROFILE_CREATE_ROW_ID);
  });

  it('tracks source expansion independently from browser selection', () => {
    const collapsed = tuiReducer(initialTuiState, {
      type: 'toggle-source',
      id: 'skillbook',
      expanded: false
    });
    expect(collapsed.expandedSourceIds).toEqual([]);
    const expanded = tuiReducer(collapsed, {
      type: 'toggle-source',
      id: 'skillbook',
      expanded: true
    });
    expect(expanded.expandedSourceIds).toEqual(['skillbook']);
  });

  it('owns four independent offsets across tab and profile-route changes', () => {
    const profileIds = ids('profile', 20);
    const membershipIds = ids('included', 20);
    const availableIds = ids('available', 24);
    const dashboard = snapshot(profileIds, membershipIds, availableIds);
    let state = tuiReducer(initialTuiState, {
      type: 'reconcile',
      snapshot: dashboard,
      viewportRows: VIEWPORT_ROWS
    });
    state = tuiReducer(state, {
      type: 'select-profile',
      id: profileIds[10],
      ids: [...profileIds, PROFILE_CREATE_ROW_ID],
      viewportRows: VIEWPORT_ROWS.profileList
    });
    state = tuiReducer(state, { type: 'profile-route', route: 'editor' });
    state = tuiReducer(state, {
      type: 'select-included',
      id: membershipIds[10],
      ids: membershipIds,
      viewportRows: VIEWPORT_ROWS.included
    });
    const availableCompositeIds = availableIds.map((id) => `skillbook:${id}`);
    state = tuiReducer(state, {
      type: 'select-available',
      id: availableCompositeIds[10],
      ids: availableCompositeIds,
      viewportRows: VIEWPORT_ROWS.available
    });
    const browserIds = ['source:skillbook', ...availableCompositeIds];
    state = tuiReducer(state, {
      type: 'select-browser-skill',
      id: availableCompositeIds[15],
      ids: browserIds,
      viewportRows: VIEWPORT_ROWS.skillsBrowser
    });

    expect(state).toMatchObject({
      profileListOffset: 6,
      includedOffset: 7,
      availableOffset: 8,
      skillsBrowserOffset: 11
    });

    state = tuiReducer(state, {
      type: 'reconcile',
      snapshot: dashboard,
      viewportRows: VIEWPORT_ROWS
    });
    expect(state).toMatchObject({
      profileListOffset: 6,
      includedOffset: 7,
      availableOffset: 8,
      skillsBrowserOffset: 11
    });

    state = tuiReducer(state, { type: 'activate-tab', tab: 'skills' });
    state = tuiReducer(state, { type: 'activate-tab', tab: 'profiles' });
    state = tuiReducer(state, { type: 'profile-route', route: 'list' });
    state = tuiReducer(state, { type: 'profile-route', route: 'editor' });
    expect(state).toMatchObject({
      profileListOffset: 6,
      includedOffset: 7,
      availableOffset: 8,
      skillsBrowserOffset: 11
    });
  });

  it('reconciles both panes from authoritative IDs when opening a different profile', () => {
    const focusedIncluded = ids('focused-member', 8);
    const focusedAvailable = ids('z-available', 10).map((id) => `skillbook:${id}`);
    const reviewerIncluded = ids('reviewer-member', 4);
    const reviewerAvailable = ids('a-available', 5).map((id) => `skillbook:${id}`);
    const viewportRows = { ...VIEWPORT_ROWS, profileList: 1 };
    let state: TuiState = {
      ...initialTuiState,
      selectedProfileId: 'focused',
      profileListOffset: 1,
      browserSkillId: 'skillbook:browser-09',
      skillsBrowserOffset: 7
    };
    state = tuiReducer(state, {
      type: 'select-included',
      id: focusedIncluded[7],
      ids: focusedIncluded,
      viewportRows: viewportRows.included
    });
    state = tuiReducer(state, {
      type: 'select-available',
      id: focusedAvailable[9],
      ids: focusedAvailable,
      viewportRows: viewportRows.available
    });
    expect(state).toMatchObject({ includedOffset: 4, availableOffset: 7 });

    state = tuiReducer(state, {
      type: 'select-profile-snapshot',
      id: 'reviewer',
      profileIds: ['focused', 'reviewer'],
      includedIds: reviewerIncluded,
      availableIds: reviewerAvailable,
      viewportRows,
      openEditor: true
    });

    expect(state).toMatchObject({
      selectedProfileId: 'reviewer',
      profileRoute: 'editor',
      includedSkillId: 'reviewer-member-00',
      availableSkillId: 'skillbook:a-available-04',
      profileListOffset: 1,
      includedOffset: 0,
      availableOffset: 2,
      browserSkillId: 'skillbook:browser-09',
      skillsBrowserOffset: 7
    });
    expect(focusedIncluded).not.toContain(state.includedSkillId);
    expect(focusedAvailable).not.toContain(state.availableSkillId);
  });

  it('reconciles removed stable IDs and clamps every shrunken viewport', () => {
    const profileIds = ids('profile', 20);
    const membershipIds = ids('included', 20);
    const availableIds = ids('available', 20);
    let state = tuiReducer(initialTuiState, {
      type: 'reconcile',
      snapshot: snapshot(profileIds, membershipIds, availableIds),
      viewportRows: VIEWPORT_ROWS
    });
    state = tuiReducer(state, {
      type: 'select-profile',
      id: profileIds[18],
      ids: [...profileIds, PROFILE_CREATE_ROW_ID],
      viewportRows: VIEWPORT_ROWS.profileList
    });
    state = tuiReducer(state, {
      type: 'select-included',
      id: membershipIds[18],
      ids: membershipIds,
      viewportRows: VIEWPORT_ROWS.included
    });
    const availableCompositeIds = availableIds.map((id) => `skillbook:${id}`);
    state = tuiReducer(state, {
      type: 'select-available',
      id: availableCompositeIds[18],
      ids: availableCompositeIds,
      viewportRows: VIEWPORT_ROWS.available
    });
    state = tuiReducer(state, {
      type: 'select-browser-skill',
      id: availableCompositeIds[18],
      ids: ['source:skillbook', ...availableCompositeIds],
      viewportRows: VIEWPORT_ROWS.skillsBrowser
    });

    const smallerProfiles = ids('profile', 8);
    const smallerMemberships = ids('included', 6);
    const smallerAvailable = ids('available', 5);
    state = tuiReducer(state, {
      type: 'reconcile',
      snapshot: snapshot(smallerProfiles, smallerMemberships, smallerAvailable),
      viewportRows: VIEWPORT_ROWS
    });

    expect(state).toMatchObject({
      selectedProfileId: 'profile-07',
      includedSkillId: 'included-05',
      availableSkillId: 'skillbook:available-04',
      browserSkillId: 'skillbook:available-04',
      profileListOffset: 4,
      includedOffset: 2,
      availableOffset: 2,
      skillsBrowserOffset: 0
    });
  });

  it('changes offsets on compact resize only when clamping or visibility requires it', () => {
    const profileIds = ids('profile', 30);
    const membershipIds = ids('included', 30);
    const availableIds = ids('available', 30);
    const dashboard = snapshot(profileIds, membershipIds, availableIds);
    let state = tuiReducer(initialTuiState, {
      type: 'reconcile',
      snapshot: dashboard,
      viewportRows: VIEWPORT_ROWS
    });
    state = tuiReducer(state, {
      type: 'select-profile',
      id: profileIds[20],
      ids: [...profileIds, PROFILE_CREATE_ROW_ID],
      viewportRows: 5
    });
    state = tuiReducer(state, {
      type: 'select-included',
      id: membershipIds[15],
      ids: membershipIds,
      viewportRows: 4
    });
    const availableCompositeIds = availableIds.map((id) => `skillbook:${id}`);
    state = tuiReducer(state, {
      type: 'select-available',
      id: availableCompositeIds[20],
      ids: availableCompositeIds,
      viewportRows: 3
    });
    state = tuiReducer(state, {
      type: 'select-browser-skill',
      id: availableCompositeIds[25],
      ids: ['source:skillbook', ...availableCompositeIds],
      viewportRows: 6
    });
    expect(state).toMatchObject({
      profileListOffset: 16,
      includedOffset: 12,
      availableOffset: 18,
      skillsBrowserOffset: 21
    });

    state = tuiReducer(state, {
      type: 'clamp-viewports',
      snapshot: dashboard,
      viewportRows: { profileList: 15, included: 6, available: 6, skillsBrowser: 13 }
    });
    expect(state).toMatchObject({
      profileListOffset: 16,
      includedOffset: 12,
      availableOffset: 18,
      skillsBrowserOffset: 18
    });

    state = tuiReducer(state, {
      type: 'clamp-viewports',
      snapshot: dashboard,
      viewportRows: { profileList: 5, included: 3, available: 3, skillsBrowser: 5 }
    });
    expect(state).toMatchObject({
      profileListOffset: 16,
      includedOffset: 13,
      availableOffset: 18,
      skillsBrowserOffset: 22
    });
  });

  it('gives modal input precedence and restores state when it closes', () => {
    const open = tuiReducer(initialTuiState, {
      type: 'open-modal',
      modal: { kind: 'create', value: '' }
    });
    const typed = tuiReducer(open, { type: 'set-modal-value', value: 'focused' });
    expect(typed.modal).toEqual({ kind: 'create', value: 'focused' });
    expect(tuiReducer(typed, { type: 'close-modal' }).modal).toBeUndefined();
  });
});

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => (
    `${prefix}-${String(index).padStart(2, '0')}`
  ));
}

function snapshot(
  profileIds: string[],
  membershipIds: string[],
  availableIds: string[] = ['available']
): DashboardSnapshot {
  return {
    revision: 1,
    activeProfileId: profileIds[0],
    profiles: profileIds.map((id) => ({
      id,
      directory: `/profiles/${id}`,
      instructionsPath: `/profiles/${id}/AGENTS.md`,
      removalIdentity: {
        schemaVersion: 1,
        directory: { device: '1', inode: id },
        fingerprint: `fingerprint-${id}`
      },
      active: id === profileIds[0],
      membershipWritable: true,
      memberships: membershipIds.map((skillId) => ({
        id: skillId,
        membershipId: `${id}:skillbook:${skillId}`,
        sourceId: 'skillbook',
        skillId,
        path: `/profiles/${id}/skills/${skillId}`,
        kind: 'managed' as const,
        manageable: true
      }))
    })),
    sources: [{
      id: 'skillbook',
      provider: 'skillbook',
      label: 'Skillbook',
      root: '/skills',
      artifactWritesSupported: false,
      skills: availableIds.map((id) => ({
        id,
        sourceId: 'skillbook',
        directory: `/skills/${id}`
      }))
    }],
    status: {
      state: 'unavailable',
      diagnostic: { id: 'setup-status', severity: 'error', message: 'Unavailable in reducer fixture.' }
    },
    diagnostics: []
  };
}
