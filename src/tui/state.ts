import type { DashboardSnapshot } from '../application/tui-service.js';
import type { ProfileRemovalIdentity } from '../profiles/profile-removal-identity.js';

export const PROFILE_CREATE_ROW_ID = '@create-profile';

export type TuiTab = 'profiles' | 'skills' | 'settings';
export type TuiFocusRegion = 'tabs' | 'body';
export type ProfileRoute = 'list' | 'editor';
export type ProfilePane = 'included' | 'available';
export type ViewportRegion = 'profileList' | 'included' | 'available' | 'skillsBrowser';
export type ViewportRows = Readonly<Record<ViewportRegion, number>>;
export type ModalKind =
  | 'create'
  | 'duplicate'
  | 'rename'
  | 'remove-confirm'
  | 'remove-recursive'
  | 'help';

export interface TuiModal {
  kind: ModalKind;
  value: string;
  targetId?: string;
  directory?: string;
  removalIdentity?: ProfileRemovalIdentity;
  preservedTargets?: readonly string[];
}

export interface TuiState {
  activeTab: TuiTab;
  focusedTab: TuiTab;
  focusedRegion: TuiFocusRegion;
  profileRoute: ProfileRoute;
  selectedProfileId?: string;
  focusedPane: ProfilePane;
  includedSkillId?: string;
  availableSkillId?: string;
  browserSkillId?: string;
  profileListOffset: number;
  includedOffset: number;
  availableOffset: number;
  skillsBrowserOffset: number;
  expandedSourceIds: readonly string[];
  modal?: TuiModal;
}

export type TuiAction =
  | { type: 'activate-tab'; tab: TuiTab }
  | { type: 'focus-tab'; tab: TuiTab }
  | { type: 'cycle-focus'; direction: 1 | -1 }
  | { type: 'profile-route'; route: ProfileRoute }
  | { type: 'select-profile'; id?: string; ids?: readonly string[]; viewportRows?: number }
  | {
      type: 'select-profile-snapshot';
      id: string;
      profileIds: readonly string[];
      includedIds: readonly string[];
      availableIds: readonly string[];
      viewportRows: ViewportRows;
      openEditor?: boolean;
    }
  | { type: 'focus-pane'; pane: ProfilePane }
  | { type: 'select-included'; id?: string; ids?: readonly string[]; viewportRows?: number }
  | { type: 'select-available'; id?: string; ids?: readonly string[]; viewportRows?: number }
  | { type: 'select-browser-skill'; id?: string; ids?: readonly string[]; viewportRows?: number }
  | { type: 'toggle-source'; id: string; expanded?: boolean }
  | { type: 'clamp-viewports'; snapshot: DashboardSnapshot; viewportRows: ViewportRows }
  | { type: 'open-modal'; modal: TuiModal }
  | { type: 'set-modal-value'; value: string }
  | { type: 'close-modal' }
  | { type: 'reconcile'; snapshot: DashboardSnapshot; viewportRows: ViewportRows };

export const initialTuiState: TuiState = {
  activeTab: 'profiles',
  focusedTab: 'profiles',
  focusedRegion: 'body',
  profileRoute: 'list',
  focusedPane: 'included',
  profileListOffset: 0,
  includedOffset: 0,
  availableOffset: 0,
  skillsBrowserOffset: 0,
  expandedSourceIds: ['skillbook']
};

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'activate-tab':
      return { ...state, activeTab: action.tab, focusedTab: action.tab };
    case 'focus-tab':
      return { ...state, focusedTab: action.tab };
    case 'cycle-focus':
      return cycleFocus(state, action.direction);
    case 'profile-route':
      return { ...state, profileRoute: action.route };
    case 'select-profile':
      return {
        ...state,
        selectedProfileId: action.id,
        profileListOffset: selectionOffset(
          state.profileListOffset,
          action.ids,
          action.id,
          action.viewportRows
        )
      };
    case 'select-profile-snapshot': {
      const includedSkillId = keepOrFirst(action.includedIds, state.includedSkillId);
      const availableSkillId = keepOrFirst(action.availableIds, state.availableSkillId);
      return {
        ...state,
        selectedProfileId: action.id,
        profileRoute: action.openEditor === true ? 'editor' : state.profileRoute,
        includedSkillId,
        availableSkillId,
        profileListOffset: clampViewportOffset(
          [...action.profileIds, PROFILE_CREATE_ROW_ID],
          action.id,
          state.profileListOffset,
          action.viewportRows.profileList
        ),
        includedOffset: clampViewportOffset(
          action.includedIds,
          includedSkillId,
          state.includedOffset,
          action.viewportRows.included
        ),
        availableOffset: clampViewportOffset(
          action.availableIds,
          availableSkillId,
          state.availableOffset,
          action.viewportRows.available
        )
      };
    }
    case 'focus-pane':
      return { ...state, focusedPane: action.pane };
    case 'select-included':
      return {
        ...state,
        includedSkillId: action.id,
        includedOffset: selectionOffset(
          state.includedOffset,
          action.ids,
          action.id,
          action.viewportRows
        )
      };
    case 'select-available':
      return {
        ...state,
        availableSkillId: action.id,
        availableOffset: selectionOffset(
          state.availableOffset,
          action.ids,
          action.id,
          action.viewportRows
        )
      };
    case 'select-browser-skill':
      return {
        ...state,
        browserSkillId: action.id,
        skillsBrowserOffset: selectionOffset(
          state.skillsBrowserOffset,
          action.ids,
          action.id,
          action.viewportRows
        )
      };
    case 'toggle-source': {
      const expanded = new Set(state.expandedSourceIds);
      const shouldExpand = action.expanded ?? !expanded.has(action.id);
      if (shouldExpand) expanded.add(action.id);
      else expanded.delete(action.id);
      return { ...state, expandedSourceIds: [...expanded] };
    }
    case 'clamp-viewports':
      return clampViewportOffsets(state, action.snapshot, action.viewportRows);
    case 'open-modal':
      return { ...state, modal: action.modal };
    case 'set-modal-value':
      return state.modal === undefined
        ? state
        : { ...state, modal: { ...state.modal, value: action.value } };
    case 'close-modal': {
      const next = { ...state };
      delete next.modal;
      return next;
    }
    case 'reconcile':
      return reconcileState(state, action.snapshot, action.viewportRows);
  }
}

export function cycleFocus(state: TuiState, direction: 1 | -1): TuiState {
  if (state.activeTab !== 'profiles' || state.profileRoute !== 'editor') {
    return { ...state, focusedRegion: state.focusedRegion === 'tabs' ? 'body' : 'tabs' };
  }

  const current = state.focusedRegion === 'tabs' ? 'tabs' : state.focusedPane;
  const order = ['tabs', 'included', 'available'] as const;
  const currentIndex = order.indexOf(current);
  const next = order[(currentIndex + direction + order.length) % order.length]!;
  return next === 'tabs'
    ? { ...state, focusedRegion: 'tabs' }
    : { ...state, focusedRegion: 'body', focusedPane: next };
}

export function moveSelection(
  ids: readonly string[],
  currentId: string | undefined,
  delta: number
): string | undefined {
  if (ids.length === 0) return undefined;
  const currentIndex = currentId === undefined ? -1 : ids.indexOf(currentId);
  if (currentIndex < 0) return delta >= 0 ? ids[0] : ids[ids.length - 1];
  const nextIndex = Math.max(0, Math.min(ids.length - 1, currentIndex + delta));
  return ids[nextIndex];
}

function reconcileState(
  state: TuiState,
  snapshot: DashboardSnapshot,
  viewportRows: ViewportRows
): TuiState {
  const profileIds = snapshot.profiles.map((profile) => profile.id);
  const selectedProfileId = state.selectedProfileId === PROFILE_CREATE_ROW_ID
    ? PROFILE_CREATE_ROW_ID
    : keepOrFirst(profileIds, state.selectedProfileId) ?? PROFILE_CREATE_ROW_ID;
  const selectedProfile = snapshot.profiles.find((profile) => profile.id === selectedProfileId);
  const includedIds = selectedProfile?.memberships.map((membership) => membership.id) ?? [];
  const includedSkillIds = new Set(
    selectedProfile?.memberships.map((membership) => membership.skillId) ?? []
  );
  const availableIds = snapshot.sources.flatMap((source) => source.skills)
    .filter((skill) => !includedSkillIds.has(skill.id))
    .map((skill) => `${skill.sourceId}:${skill.id}`);
  const browserIds = browserIdsFor(snapshot, state.expandedSourceIds);
  const next = {
    ...state,
    selectedProfileId,
    includedSkillId: keepOrFirst(includedIds, state.includedSkillId),
    availableSkillId: keepOrFirst(availableIds, state.availableSkillId),
    browserSkillId: keepOrBrowserNeighbor(browserIds, state.browserSkillId)
  };
  return clampOffsetsForIds(next, {
    profileList: [...profileIds, PROFILE_CREATE_ROW_ID],
    included: includedIds,
    available: availableIds,
    skillsBrowser: browserIds
  }, viewportRows);
}

function clampViewportOffsets(
  state: TuiState,
  snapshot: DashboardSnapshot,
  viewportRows: ViewportRows
): TuiState {
  const selectedProfile = snapshot.profiles.find(
    (profile) => profile.id === state.selectedProfileId
  );
  const includedIds = selectedProfile?.memberships.map((membership) => membership.id) ?? [];
  const includedSkillIds = new Set(
    selectedProfile?.memberships.map((membership) => membership.skillId) ?? []
  );
  const availableIds = snapshot.sources.flatMap((source) => source.skills)
    .filter((skill) => !includedSkillIds.has(skill.id))
    .map((skill) => `${skill.sourceId}:${skill.id}`);
  return clampOffsetsForIds(state, {
    profileList: [...snapshot.profiles.map((profile) => profile.id), PROFILE_CREATE_ROW_ID],
    included: includedIds,
    available: availableIds,
    skillsBrowser: browserIdsFor(snapshot, state.expandedSourceIds)
  }, viewportRows);
}

function clampOffsetsForIds(
  state: TuiState,
  ids: Readonly<Record<ViewportRegion, readonly string[]>>,
  viewportRows: ViewportRows
): TuiState {
  return {
    ...state,
    profileListOffset: clampViewportOffset(
      ids.profileList,
      state.selectedProfileId,
      state.profileListOffset,
      viewportRows.profileList
    ),
    includedOffset: clampViewportOffset(
      ids.included,
      state.includedSkillId,
      state.includedOffset,
      viewportRows.included
    ),
    availableOffset: clampViewportOffset(
      ids.available,
      state.availableSkillId,
      state.availableOffset,
      viewportRows.available
    ),
    skillsBrowserOffset: clampViewportOffset(
      ids.skillsBrowser,
      state.browserSkillId,
      state.skillsBrowserOffset,
      viewportRows.skillsBrowser
    )
  };
}

export function clampViewportOffset(
  ids: readonly string[],
  selectedId: string | undefined,
  offset: number,
  viewportRows: number
): number {
  const rows = Math.max(1, Math.floor(viewportRows));
  const maximumOffset = Math.max(0, ids.length - rows);
  let nextOffset = Math.max(0, Math.min(maximumOffset, offset));
  const selectedIndex = selectedId === undefined ? -1 : ids.indexOf(selectedId);
  if (selectedIndex < 0) return nextOffset;
  if (selectedIndex < nextOffset) nextOffset = selectedIndex;
  else if (selectedIndex >= nextOffset + rows) nextOffset = selectedIndex - rows + 1;
  return nextOffset;
}

function selectionOffset(
  offset: number,
  ids: readonly string[] | undefined,
  selectedId: string | undefined,
  viewportRows: number | undefined
): number {
  return ids === undefined || viewportRows === undefined
    ? offset
    : clampViewportOffset(ids, selectedId, offset, viewportRows);
}

function browserIdsFor(
  snapshot: DashboardSnapshot,
  expandedSourceIds: readonly string[]
): string[] {
  return snapshot.sources.flatMap((source) => [
    `source:${source.id}`,
    ...(expandedSourceIds.includes(source.id)
      ? source.skills.map((skill) => `${skill.sourceId}:${skill.id}`)
      : [])
  ]);
}

function keepOrBrowserNeighbor(
  ids: readonly string[],
  currentId: string | undefined
): string | undefined {
  if (currentId === undefined || currentId.startsWith('source:')) {
    return keepOrFirst(ids, currentId);
  }
  const separator = currentId.indexOf(':');
  const sourceId = separator < 0 ? undefined : currentId.slice(0, separator);
  if (sourceId === undefined) return keepOrFirst(ids, currentId);
  const siblingIds = ids.filter((id) => id.startsWith(`${sourceId}:`));
  return keepOrFirst(siblingIds, currentId)
    ?? ids.find((id) => id === `source:${sourceId}`)
    ?? keepOrFirst(ids, currentId);
}

function keepOrFirst(ids: readonly string[], currentId: string | undefined): string | undefined {
  if (currentId === undefined) return ids[0];
  if (ids.includes(currentId)) return currentId;
  return ids.find((id) => id > currentId) ?? ids[ids.length - 1];
}
