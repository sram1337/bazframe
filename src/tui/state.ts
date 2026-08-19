import type {
  DashboardSnapshot,
  ProfileSummary,
  SkillSourceSummary,
  SkillSummary
} from '../application/tui-service.js';
import type { ProfileRemovalIdentity } from '../profiles/profile-removal-identity.js';

export const PROFILE_CREATE_ROW_ID = '@create-profile';

export type TuiTab = 'skills' | 'profiles' | 'adapters' | 'settings';
export type TuiFocusRegion = 'tabs' | 'body';
export type ProfileRoute = 'list' | 'editor';
export type SkillRoute = 'browser' | 'preview';
export type ProfilePane = 'included' | 'available';
export type ViewportRegion = 'profileList' | 'included' | 'available' | 'skillsBrowser' | 'skillPreview';
export type ViewportRows = Readonly<Record<ViewportRegion, number>>;
export type ModalKind =
  | 'create'
  | 'duplicate'
  | 'rename'
  | 'remove-confirm'
  | 'remove-recursive'
  | 'source-root'
  | 'source-confirm'
  | 'help';

export interface TuiModal {
  kind: ModalKind;
  value: string;
  targetId?: string;
  directory?: string;
  removalIdentity?: ProfileRemovalIdentity;
  preservedTargets?: readonly string[];
  sourceId?: string;
  root?: string;
  enteredRoot?: string;
  canonicalRoot?: string;
}

export interface TuiState {
  activeTab: TuiTab;
  focusedTab: TuiTab;
  focusedRegion: TuiFocusRegion;
  profileRoute: ProfileRoute;
  skillRoute: SkillRoute;
  selectedProfileId?: string;
  focusedPane: ProfilePane;
  includedSkillId?: string;
  availableSkillId?: string;
  browserSkillId?: string;
  profileListOffset: number;
  includedOffset: number;
  availableOffset: number;
  skillsBrowserOffset: number;
  skillPreviewOffset: number;
  expandedSourceIds: readonly string[];
  expandedAvailableSourceIds: readonly string[];
  modal?: TuiModal;
}

export type TuiAction =
  | { type: 'activate-tab'; tab: TuiTab }
  | { type: 'focus-tab'; tab: TuiTab }
  | { type: 'cycle-focus'; direction: 1 | -1 }
  | { type: 'profile-route'; route: ProfileRoute }
  | { type: 'skill-route'; route: SkillRoute }
  | { type: 'set-skill-preview-offset'; offset: number }
  | { type: 'select-profile'; id?: string; ids?: readonly string[]; viewportRows?: number }
  | {
      type: 'select-profile-snapshot';
      id: string;
      profileIds: readonly string[];
      includedIds: readonly string[];
      availableRowIds: readonly string[];
      viewportRows: ViewportRows;
      openEditor?: boolean;
    }
  | { type: 'focus-pane'; pane: ProfilePane }
  | { type: 'select-included'; id?: string; ids?: readonly string[]; viewportRows?: number }
  | { type: 'select-available'; id?: string; ids?: readonly string[]; viewportRows?: number }
  | { type: 'select-browser-skill'; id?: string; ids?: readonly string[]; viewportRows?: number }
  | { type: 'toggle-source'; id: string; expanded?: boolean }
  | {
      type: 'toggle-available-source';
      id: string;
      expanded?: boolean;
      rowIds?: readonly string[];
      viewportRows?: number;
    }
  | { type: 'clamp-viewports'; snapshot: DashboardSnapshot; viewportRows: ViewportRows }
  | { type: 'open-modal'; modal: TuiModal }
  | { type: 'set-modal-value'; value: string }
  | { type: 'close-modal' }
  | { type: 'reconcile'; snapshot: DashboardSnapshot; viewportRows: ViewportRows };

export const initialTuiState: TuiState = {
  activeTab: 'skills',
  focusedTab: 'skills',
  focusedRegion: 'body',
  profileRoute: 'list',
  skillRoute: 'browser',
  focusedPane: 'included',
  profileListOffset: 0,
  includedOffset: 0,
  availableOffset: 0,
  skillsBrowserOffset: 0,
  skillPreviewOffset: 0,
  expandedSourceIds: ['default'],
  expandedAvailableSourceIds: ['default']
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
    case 'skill-route':
      return { ...state, skillRoute: action.route };
    case 'set-skill-preview-offset':
      return { ...state, skillPreviewOffset: Math.max(0, action.offset) };
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
      const availableSkillId = keepOrAvailableNeighbor(action.availableRowIds, state.availableSkillId);
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
        availableOffset: clampAvailableViewportOffset(
          action.availableRowIds,
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
        availableOffset: availableSelectionOffset(
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
    case 'toggle-available-source': {
      const expanded = new Set(state.expandedAvailableSourceIds);
      const shouldExpand = action.expanded ?? !expanded.has(action.id);
      if (shouldExpand) expanded.add(action.id);
      else expanded.delete(action.id);
      const sourceRowId = availableSourceRowId(action.id);
      const selectedId = !shouldExpand && isAvailableChildOf(state.availableSkillId, action.id)
        ? sourceRowId
        : state.availableSkillId;
      return {
        ...state,
        expandedAvailableSourceIds: [...expanded],
        availableSkillId: selectedId,
        availableOffset: action.rowIds === undefined || action.viewportRows === undefined
          ? state.availableOffset
          : clampAvailableViewportOffset(
              action.rowIds,
              selectedId,
              state.availableOffset,
              action.viewportRows
            )
      };
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
    return state.focusedRegion === 'tabs'
      ? { ...state, focusedRegion: 'body' }
      : { ...state, focusedRegion: 'tabs', focusedTab: state.activeTab };
  }

  const current = state.focusedRegion === 'tabs' ? 'tabs' : state.focusedPane;
  const order = ['tabs', 'included', 'available'] as const;
  const currentIndex = order.indexOf(current);
  const next = order[(currentIndex + direction + order.length) % order.length]!;
  return next === 'tabs'
    ? { ...state, focusedRegion: 'tabs', focusedTab: state.activeTab }
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
  const availableRowIds = availableRowsFor(
    availableSourcesForProfile(snapshot, selectedProfile),
    new Set<string>(),
    state.expandedAvailableSourceIds
  ).map((row) => row.id);
  const browserIds = browserIdsFor(snapshot, state.expandedSourceIds);
  const next = {
    ...state,
    selectedProfileId,
    includedSkillId: keepOrFirst(includedIds, state.includedSkillId),
    availableSkillId: keepOrAvailableNeighbor(availableRowIds, state.availableSkillId),
    browserSkillId: keepOrBrowserNeighbor(browserIds, state.browserSkillId)
  };
  return clampOffsetsForIds(next, {
    profileList: [...profileIds, PROFILE_CREATE_ROW_ID],
    included: includedIds,
    available: availableRowIds,
    skillsBrowser: browserIds,
    skillPreview: []
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
  const availableRowIds = availableRowsFor(
    availableSourcesForProfile(snapshot, selectedProfile),
    new Set<string>(),
    state.expandedAvailableSourceIds
  ).map((row) => row.id);
  return clampOffsetsForIds({
    ...state,
    availableSkillId: keepOrAvailableNeighbor(availableRowIds, state.availableSkillId)
  }, {
    profileList: [...snapshot.profiles.map((profile) => profile.id), PROFILE_CREATE_ROW_ID],
    included: includedIds,
    available: availableRowIds,
    skillsBrowser: browserIdsFor(snapshot, state.expandedSourceIds),
    skillPreview: []
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
    availableOffset: clampAvailableViewportOffset(
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

export function clampAvailableViewportOffset(
  rowIds: readonly string[],
  selectedId: string | undefined,
  offset: number,
  viewportRows: number
): number {
  const rows = Math.max(1, Math.floor(viewportRows));
  const selectedIndex = selectedId === undefined ? -1 : rowIds.indexOf(selectedId);
  const selectedGroupHeading = selectedIndex > 0 && rowIds[selectedIndex - 1]?.startsWith('@source:')
    ? selectedIndex - 1
    : -1;
  if (rows <= 1 || selectedGroupHeading < 0) {
    return clampViewportOffset(rowIds, selectedId, offset, rows);
  }
  const maximumOffset = Math.max(0, rowIds.length - rows);
  const minimumForSelection = Math.max(0, selectedIndex - rows + 1);
  const maximumForHeading = Math.min(selectedGroupHeading, maximumOffset);
  return Math.max(minimumForSelection, Math.min(maximumForHeading, offset));
}

export function moveAvailableSelectionByRows(
  rowIds: readonly string[],
  currentId: string | undefined,
  delta: number
): string | undefined {
  return moveSelection(rowIds, currentId, delta);
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

function availableSelectionOffset(
  offset: number,
  ids: readonly string[] | undefined,
  selectedId: string | undefined,
  viewportRows: number | undefined
): number {
  return ids === undefined || viewportRows === undefined
    ? offset
    : clampAvailableViewportOffset(ids, selectedId, offset, viewportRows);
}

export type AvailableRow =
  | {
      id: string;
      kind: 'source';
      sourceId: string;
      label: string;
      root: string;
      expanded: boolean;
    }
  | { id: string; kind: 'skill'; sourceId: string; skill: SkillSummary };

export function availableSourcesForProfile(
  snapshot: DashboardSnapshot | undefined,
  profile: ProfileSummary | undefined
): SkillSourceSummary[] {
  if (snapshot === undefined) return [];
  const directSourceIds = new Set(
    directMembershipSources(snapshot).map((source) => source.id)
  );
  const includedSkillIds = new Set(
    profile?.memberships.map((membership) => membership.skillId) ?? []
  );
  const referencedManagedSourceIds = new Set(
    profile?.sourceReferences?.map((reference) => `managed:${reference.source}`) ?? []
  );
  const browsableSources = snapshot.skillRoots ?? snapshot.availableSkillSources ?? snapshot.sources ?? [];

  return browsableSources.flatMap((source) => {
    if (referencedManagedSourceIds.has(source.id)) return [];
    if (!directSourceIds.has(source.id)) return [source];
    const skills = source.skills.filter((skill) => !includedSkillIds.has(skill.id));
    return skills.length === 0 ? [] : [{ ...source, skills }];
  });
}

export function isDirectMembershipSource(
  snapshot: DashboardSnapshot,
  sourceId: string
): boolean {
  return directMembershipSources(snapshot).some((source) => source.id === sourceId);
}

function directMembershipSources(snapshot: DashboardSnapshot): readonly SkillSourceSummary[] {
  if (snapshot.availableSkillSources !== undefined) return snapshot.availableSkillSources;
  return snapshot.skillRoots === undefined ? snapshot.sources ?? [] : [];
}

export function availableRowsFor(
  sources: readonly SkillSourceSummary[],
  includedSkillIds: ReadonlySet<string>,
  expandedSourceIds: readonly string[]
): AvailableRow[] {
  const expanded = new Set(expandedSourceIds);
  const rows: AvailableRow[] = [];
  for (const source of sources) {
    const skills = source.skills.filter((skill) => !includedSkillIds.has(skill.id));
    if (skills.length === 0) continue;
    const isExpanded = expanded.has(source.id);
    rows.push({
      id: availableSourceRowId(source.id),
      kind: 'source',
      sourceId: source.id,
      label: source.label,
      root: source.root,
      expanded: isExpanded
    });
    if (isExpanded) {
      for (const skill of skills) {
        rows.push({
          id: `${skill.sourceId}:${skill.id}`,
          kind: 'skill',
          sourceId: source.id,
          skill
        });
      }
    }
  }
  return rows;
}

export function availableSourceRowId(sourceId: string): string {
  return `@source:${sourceId}`;
}

export function availableSourceIdForRow(
  rowIds: readonly string[],
  rowId: string | undefined
): string | undefined {
  if (rowId === undefined) return undefined;
  if (rowId.startsWith('@source:')) return rowId.slice('@source:'.length);
  const sourceRows = rowIds
    .filter((id) => id.startsWith('@source:'))
    .sort((left, right) => right.length - left.length);
  return sourceRows
    .map((id) => id.slice('@source:'.length))
    .find((sourceId) => rowId.startsWith(`${sourceId}:`));
}

function browserIdsFor(
  snapshot: DashboardSnapshot,
  expandedSourceIds: readonly string[]
): string[] {
  const roots = snapshot.skillRoots ?? snapshot.sources ?? [];
  const defaultSource = roots.filter((source) => source.id === 'default');
  const managed = (snapshot.managedSources ?? []).map((source) =>
    roots.find((root) => root.id === source.id) ?? { id: source.id, skills: [] });
  const managedIds = new Set(managed.map((source) => source.id));
  const remaining = roots.filter((source) => source.id !== 'default' && !managedIds.has(source.id));
  return [...defaultSource, ...managed, ...remaining].flatMap((source) => [
    `source:${source.id}`,
    ...(expandedSourceIds.includes(source.id)
      ? source.skills.map((skill) => `${skill.sourceId}:${skill.id}`)
      : [])
  ]);
}

function keepOrAvailableNeighbor(
  ids: readonly string[],
  currentId: string | undefined
): string | undefined {
  if (currentId === undefined) {
    return ids.find((id) => !id.startsWith('@source:')) ?? ids[0];
  }
  if (currentId.startsWith('@source:')) return keepOrFirst(ids, currentId);
  if (ids.includes(currentId)) return currentId;
  const sourceId = availableSourceIdForRow(ids, currentId);
  const sourceRowId = sourceId === undefined ? undefined : availableSourceRowId(sourceId);
  return sourceRowId !== undefined && ids.includes(sourceRowId)
    ? sourceRowId
    : keepOrFirst(ids, currentId);
}

function isAvailableChildOf(rowId: string | undefined, sourceId: string): boolean {
  return rowId !== undefined
    && !rowId.startsWith('@source:')
    && rowId.startsWith(`${sourceId}:`);
}

function keepOrBrowserNeighbor(
  ids: readonly string[],
  currentId: string | undefined
): string | undefined {
  if (currentId === undefined || currentId.startsWith('source:')) {
    return keepOrFirst(ids, currentId);
  }
  const sourceRow = ids
    .filter((id) => id.startsWith('source:'))
    .sort((left, right) => right.length - left.length)
    .find((id) => currentId.startsWith(`${id.slice('source:'.length)}:`));
  if (sourceRow === undefined) return keepOrFirst(ids, currentId);
  const sourceId = sourceRow.slice('source:'.length);
  const siblingIds = ids.filter((id) => id.startsWith(`${sourceId}:`));
  return keepOrFirst(siblingIds, currentId) ?? sourceRow;
}

function keepOrFirst(ids: readonly string[], currentId: string | undefined): string | undefined {
  if (currentId === undefined) return ids[0];
  if (ids.includes(currentId)) return currentId;
  return ids.find((id) => id > currentId) ?? ids[ids.length - 1];
}
