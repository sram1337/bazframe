import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  Box,
  Text,
  useApp,
  useInput,
  useWindowSize,
  type Key
} from 'ink';
import type {
  BazframeTuiService,
  DashboardDiagnostic,
  DashboardSnapshot,
  DirectMembership,
  ManagedSourceSummary,
  ProfileSummary,
  SkillSummary
} from '../application/tui-service.js';
import { BazframeError } from '../core/errors.js';
import {
  initialTuiState,
  moveSelection,
  PROFILE_CREATE_ROW_ID,
  tuiReducer,
  type TuiAction,
  type TuiModal,
  type TuiTab,
  type ViewportRows
} from './state.js';

export interface TuiAppProps {
  service: BazframeTuiService;
  onExitCode?: (code: number) => void;
  onForceExit?: () => void;
  dimensions?: { columns: number; rows: number };
}

type MessageTone = 'info' | 'success' | 'error';
interface UiMessage {
  tone: MessageTone;
  text: string;
}

const MIN_COLUMNS = 60;
const MIN_ROWS = 16;
const TABS: readonly TuiTab[] = ['profiles', 'sources', 'skills', 'settings'];

export function TuiApp({ service, onExitCode, onForceExit, dimensions }: TuiAppProps) {
  const { exit } = useApp();
  const windowSize = useWindowSize();
  const columns = dimensions?.columns ?? windowSize.columns;
  const rows = dimensions?.rows ?? windowSize.rows;
  const tooSmall = columns < MIN_COLUMNS || rows < MIN_ROWS;
  const compact = !tooSmall && (columns < 80 || rows < 24);
  const shellRows = compact ? 5 : 7;
  const bodyRows = Math.max(1, rows - shellRows);
  const paneRows = profilePaneRows(bodyRows, compact);
  const viewportRows: ViewportRows = {
    profileList: Math.max(1, bodyRows - 4),
    included: paneRows,
    available: paneRows,
    sources: Math.max(1, bodyRows - 5),
    skillsBrowser: Math.max(1, bodyRows - 4)
  };
  const viewportRowsRef = useRef(viewportRows);
  if (!tooSmall) viewportRowsRef.current = viewportRows;
  const [state, reactDispatch] = useReducer(tuiReducer, initialTuiState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatch = useCallback((action: TuiAction) => {
    stateRef.current = tuiReducer(stateRef.current, action);
    reactDispatch(action);
  }, []);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [loading, setLoading] = useState(true);
  const [mutation, setMutation] = useState<string>();
  const [message, setMessage] = useState<UiMessage>();
  const snapshotRef = useRef<DashboardSnapshot | undefined>(undefined);
  const loadGeneration = useRef(0);
  const mutationActive = useRef(false);
  const exitRequested = useRef(false);
  const exitRequestedCode = useRef(0);
  const forceExitArmed = useRef(false);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const next = await service.loadDashboard();
      if (generation !== loadGeneration.current) return;
      snapshotRef.current = next;
      setSnapshot(next);
      dispatch({
        type: 'reconcile',
        snapshot: next,
        viewportRows: viewportRowsRef.current
      });
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setMessage({ tone: 'error', text: messageFor(error) });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const currentSnapshot = snapshotRef.current;
    if (tooSmall || currentSnapshot === undefined) return;
    dispatch({ type: 'clamp-viewports', snapshot: currentSnapshot, viewportRows });
  }, [
    tooSmall,
    viewportRows.profileList,
    viewportRows.included,
    viewportRows.available,
    viewportRows.skillsBrowser
  ]);

  const finishExit = useCallback((code = 0) => {
    onExitCode?.(code);
    exit();
  }, [exit, onExitCode]);

  const requestExit = useCallback((code: number, forceCapable: boolean) => {
    if (!mutationActive.current) {
      finishExit(code);
      return;
    }
    if (forceCapable && forceExitArmed.current) {
      onForceExit?.();
      finishExit(130);
      return;
    }
    if (forceCapable) forceExitArmed.current = true;
    exitRequested.current = true;
    exitRequestedCode.current = code;
    setMessage({
      tone: 'info',
      text: forceCapable
        ? 'Exit requested; waiting for the operation. Press Ctrl+C again to force exit.'
        : 'Exit requested; waiting for the operation.'
    });
  }, [finishExit, onForceExit]);

  const mutate = useCallback(async (
    label: string,
    operation: () => Promise<void>,
    afterSuccess?: () => void,
    onError?: (error: unknown) => boolean
  ) => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    setMutation(label);
    setMessage({ tone: 'info', text: `${label}...` });
    let succeeded = false;
    try {
      await operation();
      afterSuccess?.();
      setMessage({ tone: 'success', text: `${label} complete.` });
      succeeded = true;
    } catch (error) {
      if (onError?.(error) !== true) {
        setMessage({ tone: 'error', text: messageFor(error) });
      }
    } finally {
      mutationActive.current = false;
      setMutation(undefined);
    }
    if (exitRequested.current) {
      finishExit(exitRequestedCode.current);
      return;
    }
    if (succeeded) await load();
  }, [finishExit, load]);

  const selectedProfile = snapshot?.profiles.find(
    (profile) => profile.id === state.selectedProfileId
  );
  const availableSkills = useMemo(
    () => availableForProfile(snapshot, selectedProfile),
    [snapshot, selectedProfile]
  );
  const submitModal = useCallback(() => {
    const modal = state.modal;
    if (modal === undefined || mutation !== undefined) return;
    const rawValue = modal.value;
    const value = rawValue.trim();
    if (modal.kind === 'help') {
      dispatch({ type: 'close-modal' });
      return;
    }
    if (modal.kind === 'remove-confirm' && modal.targetId !== undefined) {
      void mutate(
        'Remove profile',
        () => service.removeProfile(modal.targetId!, { kind: 'generated-empty' }),
        () => {
          dispatch({ type: 'close-modal' });
          dispatch({ type: 'profile-route', route: 'list' });
        },
        (error) => {
          if (error instanceof BazframeError && error.code === 'PROFILE_NOT_EMPTY') {
            dispatch({
              type: 'open-modal',
              modal: { ...modal, kind: 'remove-recursive', value: '' }
            });
            setMessage({
              tone: 'error',
              text: 'Profile contains content. Exact-ID authorization is required.'
            });
            return true;
          }
          return false;
        }
      );
      return;
    }
    if (value.length === 0) {
      setMessage({ tone: 'error', text: 'A profile ID is required.' });
      return;
    }
    if (modal.kind === 'create') {
      void mutate('Create profile', () => service.createProfile(value), () => {
        dispatch({ type: 'close-modal' });
        dispatch({ type: 'select-profile', id: value });
        dispatch({ type: 'profile-route', route: 'editor' });
      });
      return;
    }
    if (modal.kind === 'duplicate' && modal.targetId !== undefined) {
      void mutate('Duplicate profile', () => service.duplicateProfile(modal.targetId!, value), () => {
        dispatch({ type: 'close-modal' });
        dispatch({ type: 'select-profile', id: value });
      });
      return;
    }
    if (modal.kind === 'rename' && modal.targetId !== undefined) {
      void mutate('Rename profile', () => service.renameProfile(modal.targetId!, value), () => {
        dispatch({ type: 'close-modal' });
        dispatch({ type: 'select-profile', id: value });
      });
      return;
    }
    if (
      modal.kind === 'remove-recursive'
      && modal.targetId !== undefined
      && modal.removalIdentity !== undefined
    ) {
      if (rawValue !== modal.targetId) {
        setMessage({
          tone: 'error',
          text: `Type ${JSON.stringify(modal.targetId)} exactly to authorize recursive removal.`
        });
        return;
      }
      void mutate(
        'Remove profile',
        () => service.removeProfile(modal.targetId!, {
          kind: 'recursive',
          confirmedProfileId: rawValue,
          removalIdentity: modal.removalIdentity!
        }),
        () => {
          dispatch({ type: 'close-modal' });
          dispatch({ type: 'profile-route', route: 'list' });
        },
        (error) => {
          if (
            error instanceof BazframeError
            && error.code === 'PROFILE_REMOVE_AUTHORIZATION_STALE'
          ) {
            dispatch({ type: 'close-modal' });
            setMessage({
              tone: 'error',
              text: 'Profile changed. Refreshing; review it and confirm removal again.'
            });
            void load();
            return true;
          }
          return false;
        }
      );
    }
  }, [load, mutation, mutate, service, state.modal]);

  const openProfileModal = useCallback((
    kind: 'duplicate' | 'rename',
    profile: ProfileSummary
  ) => {
    dispatch({
      type: 'open-modal',
      modal: { kind, value: kind === 'rename' ? profile.id : '', targetId: profile.id }
    });
  }, []);

  const openRemoveConfirmation = useCallback((profile: ProfileSummary) => {
    dispatch({
      type: 'open-modal',
      modal: {
        kind: 'remove-confirm',
        value: '',
        targetId: profile.id,
        directory: profile.directory,
        removalIdentity: profile.removalIdentity,
        preservedTargets: profile.memberships
          .map((membership) => membership.target)
          .filter((target): target is string => target !== undefined)
      }
    });
  }, []);

  const handleModalInput = useCallback((input: string, key: Key, modal: TuiModal) => {
    if (key.escape) {
      dispatch({ type: 'close-modal' });
      return;
    }
    if (modal.kind === 'remove-confirm') {
      if (input === 'y') submitModal();
      else if (input === 'n') dispatch({ type: 'close-modal' });
      return;
    }
    if (key.return) {
      submitModal();
      return;
    }
    if (modal.kind === 'help') return;
    if (key.backspace || key.delete) {
      dispatch({ type: 'set-modal-value', value: modal.value.slice(0, -1) });
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      const printable = input.replaceAll(/[\r\n\0]/gu, '');
      if (printable.length > 0) {
        dispatch({ type: 'set-modal-value', value: modal.value + printable });
      }
    }
  }, [submitModal]);

  useInput((input, key) => {
    const currentState = stateRef.current;
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'c') {
      requestExit(130, true);
      return;
    }
    if (currentState.modal !== undefined) {
      handleModalInput(input, key, currentState.modal);
      return;
    }
    if (tooSmall) {
      if (input === 'q') requestExit(0, false);
      else if (input === '?') {
        dispatch({ type: 'open-modal', modal: { kind: 'help', value: '' } });
      }
      return;
    }

    if (input === 'q') {
      requestExit(0, false);
      return;
    }
    if (input === '?') {
      dispatch({ type: 'open-modal', modal: { kind: 'help', value: '' } });
      return;
    }
    if (input === 'r') {
      if (!mutationActive.current) void load();
      return;
    }
    if (input === '1' || input === '2' || input === '3' || input === '4') {
      dispatch({ type: 'activate-tab', tab: TABS[Number(input) - 1]! });
      return;
    }
    if (input === '[' || input === ']') {
      const current = TABS.indexOf(currentState.activeTab);
      const delta = input === ']' ? 1 : -1;
      dispatch({ type: 'activate-tab', tab: TABS[(current + delta + TABS.length) % TABS.length]! });
      return;
    }
    if (key.tab) {
      dispatch({ type: 'cycle-focus', direction: key.shift ? -1 : 1 });
      return;
    }
    if (key.escape && currentState.activeTab === 'profiles' && currentState.profileRoute === 'editor') {
      dispatch({ type: 'profile-route', route: 'list' });
      return;
    }
    const vimLeft = !key.ctrl && !key.meta && input === 'h';
    const vimRight = !key.ctrl && !key.meta && input === 'l';
    const vimUp = !key.ctrl && !key.meta && input === 'k';
    const vimDown = !key.ctrl && !key.meta && input === 'j';

    if (currentState.focusedRegion === 'tabs') {
      if (key.leftArrow || key.rightArrow || vimLeft || vimRight) {
        const current = TABS.indexOf(currentState.focusedTab);
        const delta = key.rightArrow || vimRight ? 1 : -1;
        dispatch({
          type: 'focus-tab',
          tab: TABS[(current + delta + TABS.length) % TABS.length]!
        });
      } else if (key.return) {
        dispatch({ type: 'activate-tab', tab: currentState.focusedTab });
      }
      return;
    }
    const currentSnapshot = snapshotRef.current;
    if (currentSnapshot === undefined || mutationActive.current) return;
    const currentSelectedProfile = currentSnapshot.profiles.find(
      (profile) => profile.id === stateRef.current.selectedProfileId
    );
    const currentAvailableSkills = availableForProfile(currentSnapshot, currentSelectedProfile);

    if (currentState.activeTab === 'profiles') {
      if (currentState.profileRoute === 'list') {
        const ids = [
          ...currentSnapshot.profiles.map((profile) => profile.id),
          PROFILE_CREATE_ROW_ID
        ];
        if (
          key.upArrow || key.downArrow || vimUp || vimDown
          || key.pageUp || key.pageDown || key.home || key.end
        ) {
          const id = key.home
            ? ids[0]
            : key.end
              ? ids[ids.length - 1]
              : moveSelection(
                  ids,
                  currentState.selectedProfileId,
                  key.pageDown
                    ? Math.max(1, bodyRows - 4)
                    : key.pageUp
                      ? -Math.max(1, bodyRows - 4)
                      : key.downArrow || vimDown ? 1 : -1
                );
          const profile = currentSnapshot.profiles.find((candidate) => candidate.id === id);
          dispatch(profile === undefined
            ? {
                type: 'select-profile',
                id,
                ids,
                viewportRows: viewportRowsRef.current.profileList
              }
            : profileSnapshotSelection(
                currentSnapshot,
                profile,
                viewportRowsRef.current
              ));
          return;
        }
        if (key.return && currentState.selectedProfileId === PROFILE_CREATE_ROW_ID) {
          dispatch({ type: 'open-modal', modal: { kind: 'create', value: '' } });
          return;
        }
        if (key.return && currentSelectedProfile !== undefined) {
          dispatch(profileSnapshotSelection(
            currentSnapshot,
            currentSelectedProfile,
            viewportRowsRef.current,
            true
          ));
          return;
        }
        if (input === 'c') {
          dispatch({ type: 'open-modal', modal: { kind: 'create', value: '' } });
          return;
        }
        if (input === 'D' && currentSelectedProfile !== undefined) {
          openProfileModal('duplicate', currentSelectedProfile);
          return;
        }
        if (input === 'R' && currentSelectedProfile !== undefined) {
          openProfileModal('rename', currentSelectedProfile);
          return;
        }
        if (input === 'd' && currentSelectedProfile !== undefined) {
          openRemoveConfirmation(currentSelectedProfile);
          return;
        }
        if (input === 'u' && currentSelectedProfile !== undefined) {
          void mutate('Activate profile', () => service.useProfile(currentSelectedProfile.id));
          return;
        }
        return;
      }

      const jumpDown = !key.ctrl && !key.meta && input === 'J';
      const jumpUp = !key.ctrl && !key.meta && input === 'K';
      if ((key.shift && (key.upArrow || key.downArrow)) || jumpDown || jumpUp) {
        if ((key.downArrow || jumpDown) && currentState.focusedPane === 'included') {
          dispatch({ type: 'focus-pane', pane: 'available' });
        } else if ((key.upArrow || jumpUp) && currentState.focusedPane === 'available') {
          dispatch({ type: 'focus-pane', pane: 'included' });
        }
        return;
      }
      if (
        key.upArrow || key.downArrow || vimUp || vimDown
        || key.pageUp || key.pageDown || key.home || key.end
      ) {
        const pageSize = viewportRowsRef.current.included;
        const delta = key.pageDown
          ? pageSize
          : key.pageUp ? -pageSize : key.downArrow || vimDown ? 1 : -1;
        if (currentState.focusedPane === 'included') {
          const ids = currentSelectedProfile?.memberships.map((membership) => membership.id) ?? [];
          const atBottom = (key.downArrow || vimDown) && (
            ids.length === 0 || currentState.includedSkillId === ids[ids.length - 1]
          );
          if (atBottom) dispatch({ type: 'focus-pane', pane: 'available' });
          else {
            dispatch({
              type: 'select-included',
              id: key.home
                ? ids[0]
                : key.end
                  ? ids[ids.length - 1]
                  : moveSelection(ids, currentState.includedSkillId, delta),
              ids,
              viewportRows: viewportRowsRef.current.included
            });
          }
        } else {
          const ids = currentAvailableSkills.map(compositeSkillId);
          const atTop = (key.upArrow || vimUp) && (
            ids.length === 0 || currentState.availableSkillId === ids[0]
          );
          if (atTop) dispatch({ type: 'focus-pane', pane: 'included' });
          else {
            dispatch({
              type: 'select-available',
              id: key.home
                ? ids[0]
                : key.end
                  ? ids[ids.length - 1]
                  : moveSelection(ids, currentState.availableSkillId, delta),
              ids,
              viewportRows: viewportRowsRef.current.available
            });
          }
        }
        return;
      }
      if (input === 'e') {
        setMessage({
          tone: 'error',
          text: 'Instruction editor is unavailable pending the editor lifecycle review.'
        });
        return;
      }
      if (
        input === 'a'
        && currentSelectedProfile !== undefined
        && currentState.availableSkillId !== undefined
      ) {
        if (!currentSelectedProfile.membershipWritable) {
          setMessage({
            tone: 'error',
            text: currentSelectedProfile.membershipDiagnostic ?? 'Profile membership is unavailable.'
          });
          return;
        }
        const skill = currentAvailableSkills.find(
          (candidate) => compositeSkillId(candidate) === currentState.availableSkillId
        );
        if (skill !== undefined) {
          void mutate(
            'Add membership',
            () => service.addMembership(currentSelectedProfile.id, {
              sourceId: skill.sourceId,
              skillId: skill.id
            })
          );
        }
        return;
      }
      if (
        input === 'x'
        && currentSelectedProfile !== undefined
        && currentState.includedSkillId !== undefined
      ) {
        const membership = currentSelectedProfile.memberships.find(
          (candidate) => candidate.id === currentState.includedSkillId
        );
        if (membership?.manageable === true && membership.sourceId !== undefined) {
          void mutate(
            'Remove membership',
            () => service.removeMembership(currentSelectedProfile.id, {
              membershipId: membership.membershipId,
              sourceId: membership.sourceId!,
              skillId: membership.skillId
            })
          );
        } else if (membership !== undefined) {
          setMessage({
            tone: 'error',
            text: membership.diagnostic ?? 'Bazframe does not manage this profile entry.'
          });
        }
        return;
      }
      if (input === 'u' && currentSelectedProfile !== undefined) {
        void mutate('Activate profile', () => service.useProfile(currentSelectedProfile.id));
      }
      return;
    }

    if (currentState.activeTab === 'sources') {
      const ids = currentSnapshot.managedSources?.map((source) => source.id) ?? [];
      if (key.upArrow || key.downArrow || vimUp || vimDown || key.pageUp || key.pageDown || key.home || key.end) {
        const id = key.home ? ids[0] : key.end ? ids[ids.length - 1] : moveSelection(
          ids,
          currentState.selectedSourceId,
          key.pageDown ? viewportRowsRef.current.sources : key.pageUp ? -viewportRowsRef.current.sources : key.downArrow || vimDown ? 1 : -1
        );
        dispatch({ type: 'select-source', id, ids, viewportRows: viewportRowsRef.current.sources });
      }
      return;
    }

    if (currentState.activeTab === 'skills') {
      const ids = browserNodeIds(currentSnapshot, currentState.expandedSourceIds);
      if (
        key.upArrow || key.downArrow || vimUp || vimDown
        || key.pageUp || key.pageDown || key.home || key.end
      ) {
        const id = key.home
          ? ids[0]
          : key.end
            ? ids[ids.length - 1]
            : moveSelection(
                ids,
                currentState.browserSkillId,
                key.pageDown
                  ? Math.max(1, bodyRows - 4)
                  : key.pageUp
                    ? -Math.max(1, bodyRows - 4)
                    : key.downArrow || vimDown ? 1 : -1
              );
        dispatch({
          type: 'select-browser-skill',
          id,
          ids,
          viewportRows: viewportRowsRef.current.skillsBrowser
        });
        return;
      }
      const sourcePrefix = 'source:';
      if (currentState.browserSkillId?.startsWith(sourcePrefix)) {
        const sourceId = currentState.browserSkillId.slice(sourcePrefix.length);
        if (key.return) dispatch({ type: 'toggle-source', id: sourceId });
        else if (key.rightArrow || vimRight) {
          if (currentState.expandedSourceIds.includes(sourceId)) {
            const firstSkill = (currentSnapshot.skillRoots ?? currentSnapshot.sources ?? []).find(
              (source) => source.id === sourceId
            )?.skills[0];
            if (firstSkill !== undefined) {
              dispatch({
                type: 'select-browser-skill',
                id: compositeSkillId(firstSkill),
                ids,
                viewportRows: viewportRowsRef.current.skillsBrowser
              });
            }
          } else dispatch({ type: 'toggle-source', id: sourceId, expanded: true });
        } else if (key.leftArrow || vimLeft) {
          dispatch({ type: 'toggle-source', id: sourceId, expanded: false });
        }
        return;
      }
      if ((key.leftArrow || vimLeft) && currentState.browserSkillId !== undefined) {
        const sourceId = (currentSnapshot.skillRoots ?? currentSnapshot.sources ?? [])
          .find((source) => currentState.browserSkillId?.startsWith(`${source.id}:`))?.id;
        if (sourceId !== undefined) {
          dispatch({
            type: 'select-browser-skill',
            id: `source:${sourceId}`,
            ids,
            viewportRows: viewportRowsRef.current.skillsBrowser
          });
        }
      }
    }
  });

  if (tooSmall) {
    return (
      <BelowMinimumView
        columns={columns}
        rows={rows}
        modal={state.modal}
        busy={mutation !== undefined}
      />
    );
  }

  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      <TabBar
        active={state.activeTab}
        focused={state.focusedTab}
        hasFocus={state.focusedRegion === 'tabs'}
      />
      <Box flexGrow={1} height={bodyRows} overflow="hidden">
        {state.modal !== undefined
          ? <Modal modal={state.modal} busy={mutation !== undefined} />
          : state.activeTab === 'profiles'
            ? state.profileRoute === 'list'
              ? <ProfilesList
                  profiles={snapshot?.profiles ?? []}
                  selectedId={state.selectedProfileId}
                  offset={state.profileListOffset}
                  focused={state.focusedRegion === 'body'}
                  maxRows={bodyRows - 4}
                />
              : <ProfileEditor
                  profile={selectedProfile}
                  availableSkills={availableSkills}
                  focusedPane={state.focusedRegion === 'body' ? state.focusedPane : undefined}
                  includedSelectionId={state.includedSkillId}
                  availableSelectionId={state.availableSkillId}
                  includedOffset={state.includedOffset}
                  availableOffset={state.availableOffset}
                  maxRows={bodyRows}
                  compact={compact}
                />
            : state.activeTab === 'sources'
              ? <SourcesView
                  sources={snapshot?.managedSources ?? []}
                  selectedId={state.selectedSourceId}
                  offset={state.sourcesOffset}
                  focused={state.focusedRegion === 'body'}
                  maxRows={viewportRows.sources}
                />
              : state.activeTab === 'skills'
              ? <SkillsBrowser
                  snapshot={snapshot}
                  selectedId={state.browserSkillId}
                  offset={state.skillsBrowserOffset}
                  expandedSourceIds={state.expandedSourceIds}
                  focused={state.focusedRegion === 'body'}
                  maxRows={bodyRows - 4}
                  compact={compact}
                />
              : <Settings
                  status={snapshot?.status}
                  focused={state.focusedRegion === 'body'}
                  compact={compact}
                />}
      </Box>
      <StatusBar
        loading={loading}
        mutation={mutation}
        message={message}
        diagnostics={snapshot?.diagnostics ?? []}
        compact={compact}
      />
      <Text dimColor>
        {compact
          ? ' Tab focus  hjkl move  J/K panes  ? help  q quit'
          : ' Tab focus  hjkl/arrows move  J/K panes  Enter open  ? help  r refresh  q quit'}
      </Text>
    </Box>
  );
}

function BelowMinimumView({
  columns,
  rows,
  modal,
  busy
}: {
  columns: number;
  rows: number;
  modal: TuiModal | undefined;
  busy: boolean;
}) {
  const sizeLine = `Terminal too small (${columns}x${rows}); minimum ${MIN_COLUMNS}x${MIN_ROWS}.`;
  if (modal === undefined) {
    return (
      <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
        <Text bold>Bazframe</Text>
        <Text color="yellow" wrap="truncate-end">{sizeLine}</Text>
        <Text>Resize, or press q to quit. Press ? for help.</Text>
        <Text dimColor>Domain actions are disabled at this size. Ctrl+C exits.</Text>
      </Box>
    );
  }
  if (modal.kind === 'help') {
    return (
      <Box
        width={columns}
        height={rows}
        borderStyle="bold"
        borderColor={focusBorderColor(true)}
        flexDirection="column"
        overflow="hidden"
      >
        <Text bold>Bazframe - small-terminal help</Text>
        <Text color="yellow" wrap="truncate-end">{sizeLine}</Text>
        <Text>Ctrl+C exits from any state.</Text>
        <Text>q exits when no dialog is open.</Text>
        <Text>? opens this help when no dialog is open.</Text>
        <Text>Domain actions remain disabled at this size.</Text>
        <Text bold>Press Esc or Enter to close help.</Text>
      </Box>
    );
  }

  const removing = modal.kind === 'remove-confirm' || modal.kind === 'remove-recursive';
  const title = removing
    ? `Remove profile ${modal.targetId ?? ''}`
    : `${capitalize(modal.kind)} profile`;
  if (modal.kind === 'remove-confirm') {
    return (
      <Box
        width={columns}
        height={rows}
        borderStyle="bold"
        borderColor={focusBorderColor(true)}
        flexDirection="column"
        overflow="hidden"
      >
        <Text bold color="red" wrap="truncate-end">! Destructive action: {title}</Text>
        <Text wrap="truncate-middle">Physical profile path: {modal.directory ?? '(unknown)'}</Text>
        <Text wrap="truncate-end">Scope: Bazframe generated-empty profile content only.</Text>
        <Text wrap="truncate-end">Preserved membership targets: not followed or deleted.</Text>
        <Text bold>{busy ? 'Working...' : 'y confirm  n/Esc cancel'}</Text>
        <Text color="yellow" wrap="truncate-end">{sizeLine}</Text>
        <Text bold>Dialog remains active after resize.</Text>
      </Box>
    );
  }
  if (modal.kind === 'remove-recursive') {
    return (
      <Box
        width={columns}
        height={rows}
        borderStyle="bold"
        borderColor={focusBorderColor(true)}
        flexDirection="column"
        overflow="hidden"
      >
        <Text bold color="red" wrap="truncate-end">! Destructive action: {title}</Text>
        <Text wrap="truncate-middle">Physical profile path: {modal.directory ?? '(unknown)'}</Text>
        <Text wrap="truncate-end">Scope: recursively deletes all Bazframe profile content.</Text>
        <Text wrap="truncate-end">Preserved targets: symlinks are not followed or deleted.</Text>
        <Text wrap="truncate-end">Type exact profile ID: {modal.targetId}</Text>
        <Text inverse wrap="truncate-start">Input: {modal.value.length === 0 ? ' ' : modal.value}</Text>
        <Text bold>{busy ? 'Working...' : 'Enter submit  Esc cancel'}</Text>
        <Text color="yellow" wrap="truncate-end">{sizeLine}</Text>
        <Text bold>Dialog remains active after resize.</Text>
      </Box>
    );
  }
  const prompt = modal.kind === 'duplicate'
    ? `New ID for copy of ${modal.targetId ?? ''}`
    : modal.kind === 'rename'
      ? `New ID for ${modal.targetId ?? ''}`
      : 'New profile ID';
  return (
    <Box
      width={columns}
      height={rows}
      borderStyle="bold"
      borderColor={focusBorderColor(true)}
      flexDirection="column"
      overflow="hidden"
    >
      <Text bold>{title}</Text>
      <Text bold>{busy ? 'Working...' : 'Enter submit  Esc cancel'}</Text>
      <Text wrap="truncate-end">{prompt}</Text>
      <Text inverse wrap="truncate-start">Input: {modal.value.length === 0 ? ' ' : modal.value}</Text>
      <Text color="yellow" wrap="truncate-end">{sizeLine}</Text>
      <Text bold>Dialog remains active after resize.</Text>
    </Box>
  );
}

function TabBar({
  active,
  focused,
  hasFocus
}: {
  active: TuiTab;
  focused: TuiTab;
  hasFocus: boolean;
}) {
  return (
    <Box
      borderStyle={hasFocus ? 'bold' : 'classic'}
      borderColor={focusBorderColor(hasFocus)}
      borderDimColor={!hasFocus}
    >
      {TABS.map((tab, index) => {
        const selected = active === tab;
        const tabFocused = hasFocus && focused === tab;
        return (
          <Text
            key={tab}
            inverse={selected || tabFocused}
            bold={selected || tabFocused}
            aria-label={`${capitalize(tab)} tab${selected ? ', selected' : ''}${tabFocused ? ', focused' : ''}`}
          >
            {`${selected ? '*' : ' '} ${index + 1} ${capitalize(tab)} `}
          </Text>
        );
      })}
    </Box>
  );
}

function ProfilesList({
  profiles,
  selectedId,
  offset,
  focused,
  maxRows
}: {
  profiles: readonly ProfileSummary[];
  selectedId: string | undefined;
  offset: number;
  focused: boolean;
  maxRows: number;
}) {
  const rows: readonly (ProfileSummary | { id: typeof PROFILE_CREATE_ROW_ID })[] = [
    ...profiles,
    { id: PROFILE_CREATE_ROW_ID }
  ];
  const visible = visibleRows(rows, offset, Math.max(1, maxRows));
  return (
    <Box
      borderStyle={focused ? 'bold' : 'classic'}
      borderColor={focusBorderColor(focused)}
      borderDimColor={!focused}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold aria-label={`Profiles list${focused ? ', focused' : ''}`}>
        Profiles
      </Text>
      {visible.map((profile) => !('active' in profile)
        ? <Text
            key={profile.id}
            inverse={focused && profile.id === selectedId}
            bold={profile.id === selectedId}
            aria-label={`Create new profile${profile.id === selectedId ? ', selected' : ''}`}
          >
              + Create New Profile
          </Text>
        : <Text
            key={profile.id}
            inverse={focused && profile.id === selectedId}
            bold={profile.id === selectedId}
            aria-label={`Profile ${profile.id}${profile.active ? ', active' : ''}${profile.id === selectedId ? ', selected' : ''}, ${profile.memberships.length} skills`}
          >
              {profile.active ? '*' : ' '} {profile.id}
            {'  '}{profile.memberships.length} skill{profile.memberships.length === 1 ? '' : 's'}
          </Text>)}
      <Text dimColor>c create  D duplicate  u activate  R rename  d remove</Text>
    </Box>
  );
}

function ProfileEditor({
  profile,
  availableSkills,
  focusedPane,
  includedSelectionId,
  availableSelectionId,
  includedOffset,
  availableOffset,
  maxRows,
  compact
}: {
  profile: ProfileSummary | undefined;
  availableSkills: readonly SkillSummary[];
  focusedPane: 'included' | 'available' | undefined;
  includedSelectionId: string | undefined;
  availableSelectionId: string | undefined;
  includedOffset: number;
  availableOffset: number;
  maxRows: number;
  compact: boolean;
}) {
  if (profile === undefined) return <Text>No selected profile.</Text>;
  const paneRows = profilePaneRows(maxRows, compact);
  return (
    <Box flexDirection="column" width="100%">
      <Text
        bold
        aria-label={`Profile ${profile.id}${profile.active ? ', active' : ''}, editor`}
      >
        {profile.active ? '* ' : '  '}{profile.id}{profile.active ? ' [active]' : ''}
      </Text>
      {compact
        ? null
        : <Text dimColor wrap="truncate-end">
            {profile.membershipDiagnostic ?? profile.directory}
          </Text>}
      <Text wrap="truncate-end">
        Source references: {profile.sourceReferences?.length
          ? profile.sourceReferences.map((reference) => reference.availability === 'available'
            ? `${reference.provider}/${reference.source}`
            : `${reference.provider}/${reference.source} [unavailable: ${reference.diagnostic ?? 'unknown failure'}]`).join(', ')
          : '(none)'} (read-only)
      </Text>
      <MembershipPane
        title="Included skills"
        memberships={profile.memberships}
        selectedId={includedSelectionId}
        offset={includedOffset}
        focused={focusedPane === 'included'}
        maxRows={paneRows}
      />
      <SkillPane
        title="Available skills"
        skills={availableSkills}
        selectedId={availableSelectionId}
        offset={availableOffset}
        focused={focusedPane === 'available'}
        maxRows={paneRows}
      />
      <Text dimColor>
        {compact
          ? 'Tab focus  J/K panes  a add  x remove  Esc back'
          : 'Tab focus  J/K or Shift+arrows panes  a add  x remove  Esc back'}
      </Text>
    </Box>
  );
}

function MembershipPane({
  title,
  memberships,
  selectedId,
  offset,
  focused,
  maxRows
}: {
  title: string;
  memberships: readonly DirectMembership[];
  selectedId: string | undefined;
  offset: number;
  focused: boolean;
  maxRows: number;
}) {
  return (
    <Box
      borderStyle={focused ? 'bold' : 'classic'}
      borderColor={focusBorderColor(focused)}
      borderDimColor={!focused}
      flexDirection="column"
      height={maxRows + 3}
    >
      <Text
        bold
        aria-label={`${title} pane${focused ? ', focused' : ''}, ${memberships.length} items`}
      >
        {title}
      </Text>
      {memberships.length === 0
        ? <Text dimColor aria-label={`${title} pane is empty`}>(empty - use Tab to change panes)</Text>
        : visibleRows(memberships, offset, maxRows).map((membership) => (
            <Text
              key={membership.id}
              inverse={focused && membership.id === selectedId}
              bold={membership.id === selectedId}
              aria-label={`${membership.skillId}, ${membership.manageable ? 'managed' : 'unmanaged'}${membership.id === selectedId ? ', selected' : ''}`}
            >
                {membership.manageable ? '+' : '!'} {membership.skillId}
              {membership.manageable ? '' : ' (unmanaged)'}
            </Text>
          ))}
    </Box>
  );
}

function SkillPane({
  title,
  skills,
  selectedId,
  offset,
  focused,
  maxRows
}: {
  title: string;
  skills: readonly SkillSummary[];
  selectedId: string | undefined;
  offset: number;
  focused: boolean;
  maxRows: number;
}) {
  return (
    <Box
      borderStyle={focused ? 'bold' : 'classic'}
      borderColor={focusBorderColor(focused)}
      borderDimColor={!focused}
      flexDirection="column"
      height={maxRows + 3}
    >
      <Text
        bold
        aria-label={`${title} pane${focused ? ', focused' : ''}, ${skills.length} items`}
      >
        {title}
      </Text>
      {skills.length === 0
        ? <Text dimColor aria-label={`${title} pane is empty`}>(empty - use Tab to change panes)</Text>
        : visibleRows(skills, offset, maxRows).map((skill) => {
            const id = compositeSkillId(skill);
            return (
              <Text
                key={id}
                inverse={focused && id === selectedId}
                bold={id === selectedId}
                aria-label={`Available skill ${skill.id}, source ${skill.sourceId}${id === selectedId ? ', selected' : ''}`}
              >
                  {skill.sourceId}/{skill.id}
              </Text>
            );
          })}
    </Box>
  );
}

function SourcesView({
  sources,
  selectedId,
  offset,
  focused,
  maxRows
}: {
  sources: readonly ManagedSourceSummary[];
  selectedId: string | undefined;
  offset: number;
  focused: boolean;
  maxRows: number;
}) {
  return (
    <Box borderStyle={focused ? 'bold' : 'classic'} borderColor={focusBorderColor(focused)} borderDimColor={!focused} flexDirection="column" paddingX={1}>
      <Text bold aria-label={`Managed sources${focused ? ', focused' : ''}`}>Managed sources (read-only)</Text>
      {sources.length === 0
        ? <Text dimColor>No global managed sources.</Text>
        : visibleRows(sources, offset, Math.max(1, maxRows)).map((source) => (
            <Box key={source.id} flexDirection="column">
              <Text inverse={focused && source.id === selectedId} bold={source.id === selectedId} aria-label={managedSourceAccessibilityLabel(source, source.id === selectedId)}>
                {source.provider}/{source.source} [{source.health}] refs:{source.referenceCount}
              </Text>
              {source.id === selectedId
                ? <Text dimColor wrap="truncate-end">  sha256:{source.digest} root:{source.sourceUnitRoot} rebuild:{source.rebuildAvailability} input:{source.root}{source.diagnostics.length ? `; ${source.diagnostics.join('; ')}` : ''}</Text>
                : null}
            </Box>
          ))}
      <Text dimColor>Source mutations are available only through `bazframe sources`.</Text>
    </Box>
  );
}

function SkillsBrowser({
  snapshot,
  selectedId,
  offset,
  expandedSourceIds,
  focused,
  maxRows,
  compact
}: {
  snapshot: DashboardSnapshot | undefined;
  selectedId: string | undefined;
  offset: number;
  expandedSourceIds: readonly string[];
  focused: boolean;
  maxRows: number;
  compact: boolean;
}) {
  if (snapshot === undefined) {
    return (
      <Box
        borderStyle={focused ? 'bold' : 'classic'}
        borderColor={focusBorderColor(focused)}
        borderDimColor={!focused}
        flexDirection="column"
        paddingX={1}
      >
        <Text bold aria-label={`Skill sources browser${focused ? ', focused' : ''}`}>
          Skill sources
        </Text>
        <Text>Loading skills...</Text>
      </Box>
    );
  }
  const rows = sourceBrowserRows(snapshot, expandedSourceIds);
  const visible = visibleRows(rows, offset, Math.max(1, maxRows));
  return (
    <Box
      borderStyle={focused ? 'bold' : 'classic'}
      borderColor={focusBorderColor(focused)}
      borderDimColor={!focused}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold aria-label={`Skill sources browser${focused ? ', focused' : ''}`}>
        Skill sources
      </Text>
      {(snapshot.skillRoots ?? snapshot.sources ?? []).length === 0
        ? <Text dimColor>No configured source is available.</Text>
        : visible.map((row) => row.kind === 'source'
          ? <Text
              key={row.id}
              inverse={focused && row.id === selectedId}
              bold
              wrap="truncate-end"
              aria-label={`${row.label} source, ${row.expanded ? 'expanded' : 'collapsed'}${row.id === selectedId ? ', selected' : ''}, ${row.root}`}
            >
              {row.expanded ? '[-]' : '[+]'}{' '}{row.label} - {row.root}
            </Text>
          : <Text
              key={row.id}
              inverse={focused && row.id === selectedId}
              bold={row.id === selectedId}
              aria-label={`Skill ${row.skillId}, source ${row.sourceId}${row.id === selectedId ? ', selected' : ''}`}
            >
                {'  '}{row.skillId}
            </Text>)}
      <Text dimColor>
        {compact
          ? 'Provider-owned: move/rename unavailable.'
          : 'Skill artifacts are provider-owned; move and rename are unavailable.'}
      </Text>
    </Box>
  );
}

export function managedSourceAccessibilityLabel(source: ManagedSourceSummary, selected: boolean): string {
  const references = source.referenceCount === 'unknown'
    ? 'profile reference count unknown'
    : `${source.referenceCount} profile references`;
  return `Source ${source.provider}/${source.source}, ${source.health}, ${references}${selected ? ', selected' : ''}`;
}

function Settings({
  status,
  focused,
  compact
}: {
  status: DashboardSnapshot['status'] | undefined;
  focused: boolean;
  compact: boolean;
}) {
  const heading = (
    <Text bold aria-label={`Settings view${focused ? ', focused' : ''}`}>
      Settings
    </Text>
  );
  const boxProps = {
    borderStyle: focused ? 'bold' as const : 'classic' as const,
    borderColor: focusBorderColor(focused),
    borderDimColor: !focused,
    flexDirection: 'column' as const,
    paddingX: 1
  };
  if (status === undefined) {
    return (
      <Box {...boxProps}>
        {heading}
        <Text>Loading read-only setup status...</Text>
      </Box>
    );
  }
  if (status.state === 'unavailable') {
    return (
      <Box {...boxProps}>
        {heading}
        <Text bold>Setup (read-only)</Text>
        <Text color="red">Setup status unavailable: {status.diagnostic.message}</Text>
        <Text>No writable settings are defined in this slice.</Text>
      </Box>
    );
  }

  const setup = status.value;
  const behavior = `${setup.effectiveBehavior.enabled ? 'enabled' : 'disabled'} (${setup.effectiveBehavior.reason})`;
  const profile = setup.profile.state === 'ready'
    ? `${setup.profile.id} (ready; ${setup.profile.skillCount} skills)`
    : setup.profile.state === 'missing'
      ? `${setup.profile.id} (missing)`
      : setup.profile.state === 'unselected'
        ? '(none selected)'
        : '(not used)';
  return (
    <Box {...boxProps}>
      {heading}
      <Text bold>Setup (read-only)</Text>
      <Text>Pi adapter: {setup.adapter.state}{setup.adapter.installedBazframeVersion === undefined
        ? ''
        : ` (${setup.adapter.installedBazframeVersion})`}</Text>
      <Text>Global policy: {setup.globalPolicy.policy}</Text>
      <Text>Current behavior: {behavior}</Text>
      <Text>Active profile: {profile}</Text>
      <Text>Cached collision aliases: {setup.cachedCollisionAliasCount}</Text>
      {compact
        ? <Text color={setup.correctiveActions.length === 0 ? undefined : 'yellow'} wrap="truncate-end">
            Corrective actions: {setup.correctiveActions.length === 0
              ? '(none)'
              : setup.correctiveActions.map((action) => action.message).join('; ')}
          </Text>
        : <>
            <Text bold>Corrective actions:</Text>
            {setup.correctiveActions.length === 0
              ? <Text dimColor>  (none)</Text>
              : setup.correctiveActions.map((action) => (
                  <Text key={action.id} color="yellow" wrap="wrap">  - {action.message}</Text>
                ))}
          </>}
      <Text dimColor>No writable settings are defined in this slice.</Text>
    </Box>
  );
}

function Modal({
  modal,
  busy
}: {
  modal: TuiModal;
  busy: boolean;
}) {
  if (modal.kind === 'help') {
    return (
      <FocusedOverlay>
        <Text bold>Keyboard help</Text>
        <Text wrap="truncate-end">1/2/3/4 and [/] open tabs directly. Tab/Shift+Tab cycle focus.</Text>
        <Text wrap="truncate-end">Focused tabs: Left/Right or h/l moves focus; Enter activates.</Text>
        <Text wrap="truncate-end">Body: arrows or j/k move; PageUp/PageDown and Home/End jump.</Text>
        <Text wrap="truncate-end">Tree: Left/h collapses or selects parent; Right/l expands or selects first child.</Text>
        <Text wrap="truncate-end">Profiles: c create, D duplicate, u activate, R rename, d remove.</Text>
        <Text wrap="truncate-end">Editor: J/K jumps to Available/Included; a adds, x removes; Esc returns.</Text>
        <Text wrap="truncate-end">r refreshes; q exits. Press Esc or Enter to close.</Text>
      </FocusedOverlay>
    );
  }
  const removing = modal.kind === 'remove-confirm' || modal.kind === 'remove-recursive';
  const title = removing
    ? `Remove profile ${modal.targetId ?? ''}`
    : `${capitalize(modal.kind)} profile`;
  const prompt = modal.kind === 'duplicate'
    ? `New ID for copy of ${modal.targetId ?? ''}`
    : modal.kind === 'rename'
      ? `New ID for ${modal.targetId ?? ''}`
      : 'New profile ID';
  if (removing) {
    const targetSummary = preservedTargetSummary(modal.preservedTargets ?? []);
    return (
      <FocusedOverlay>
        <Text bold color="red" wrap="truncate-end">
          ! Destructive action: {title}
        </Text>
        <Text wrap="truncate-middle">Physical profile path: {modal.directory ?? '(unknown)'}</Text>
        <Text wrap="truncate-end">
          {modal.kind === 'remove-recursive'
            ? 'Scope: recursively deletes all Bazframe profile content.'
            : 'Scope: Bazframe generated-empty profile content only.'}
        </Text>
        <Text wrap="truncate-end">Preserved membership targets (not followed): {targetSummary}</Text>
        {modal.kind === 'remove-recursive'
          ? <Text wrap="truncate-end">Type exact profile ID: {modal.targetId}</Text>
          : null}
        {modal.kind === 'remove-recursive'
          ? <Text inverse wrap="truncate-start">Input: {modal.value.length === 0 ? ' ' : modal.value}</Text>
          : null}
        <Text bold>
          {busy
            ? 'Working...'
            : modal.kind === 'remove-confirm'
              ? 'y confirm generated-empty removal  n/Esc cancel'
              : 'Enter submit  Esc cancel'}
        </Text>
      </FocusedOverlay>
    );
  }
  return (
    <FocusedOverlay>
      <Text bold>{title}</Text>
      <Text wrap="truncate-end">{prompt}</Text>
      <Text inverse wrap="truncate-start">Input: {modal.value.length === 0 ? ' ' : modal.value}</Text>
      <Text bold>{busy ? 'Working...' : 'Enter submit  Esc cancel'}</Text>
    </FocusedOverlay>
  );
}

function FocusedOverlay({ children }: { children: ReactNode }) {
  return (
    <Box
      borderStyle="bold"
      borderColor={focusBorderColor(true)}
      flexDirection="column"
      width="100%"
      overflow="hidden"
    >
      {children}
    </Box>
  );
}

function preservedTargetSummary(targets: readonly string[]): string {
  if (targets.length === 0) return '(none detected)';
  return `${targets.length} known; examples: ${targets.slice(0, 2).join(', ')}`;
}

function StatusBar({
  loading,
  mutation,
  message,
  diagnostics,
  compact
}: {
  loading: boolean;
  mutation: string | undefined;
  message: UiMessage | undefined;
  diagnostics: readonly DashboardDiagnostic[];
  compact: boolean;
}) {
  const diagnostic = message === undefined && mutation === undefined && !loading
    ? diagnostics[0]
    : undefined;
  const text = message?.text ?? (mutation !== undefined
    ? `${mutation}...`
    : loading
      ? 'Loading...'
      : diagnostic?.message ?? 'Ready');
  const tone = message?.tone === 'error'
    ? 'Error'
    : message?.tone === 'success'
      ? 'Success'
      : mutation !== undefined
        ? 'Working'
        : diagnostic?.severity === 'error'
          ? 'Error'
          : diagnostic?.severity === 'warning'
            ? 'Warning'
            : 'Status';
  const color = tone === 'Error'
    ? 'red'
    : tone === 'Success'
      ? 'green'
      : tone === 'Warning'
        ? 'yellow'
        : undefined;
  const diagnosticCount = diagnostic !== undefined && diagnostics.length > 1
    ? ` [1/${diagnostics.length}]`
    : '';
  const line = (
    <Text
      color={color}
      wrap="truncate-end"
      aria-label={`${tone}: ${text}${diagnosticCount}`}
    >
      {' '}{tone}: {text}{diagnosticCount}
    </Text>
  );
  return compact
    ? <Box height={1}>{line}</Box>
    : <Box borderStyle="classic" borderLeft={false} borderRight={false}>{line}</Box>;
}

function availableForProfile(
  snapshot: DashboardSnapshot | undefined,
  profile: ProfileSummary | undefined
): SkillSummary[] {
  if (snapshot === undefined) return [];
  const included = new Set(profile?.memberships.map((membership) => membership.skillId) ?? []);
  return (snapshot.availableSkillSources ?? snapshot.sources ?? []).flatMap((source) => source.skills)
    .filter((skill) => !included.has(skill.id));
}

function profilePaneRows(maxRows: number, compact: boolean): number {
  return compact ? 1 : Math.max(3, Math.floor((maxRows - 9) / 2));
}

function profileSnapshotSelection(
  snapshot: DashboardSnapshot,
  profile: ProfileSummary,
  viewportRows: ViewportRows,
  openEditor = false
): TuiAction {
  return {
    type: 'select-profile-snapshot',
    id: profile.id,
    profileIds: snapshot.profiles.map((candidate) => candidate.id),
    includedIds: profile.memberships.map((membership) => membership.id),
    availableIds: availableForProfile(snapshot, profile).map(compositeSkillId),
    viewportRows,
    openEditor
  };
}

function visibleRows<T>(
  values: readonly T[],
  offset: number,
  maximum: number
): readonly T[] {
  const rows = Math.max(1, maximum);
  const start = Math.max(0, Math.min(Math.max(0, values.length - rows), offset));
  return values.slice(start, start + rows);
}

function compositeSkillId(skill: SkillSummary): string {
  return `${skill.sourceId}:${skill.id}`;
}

type SourceBrowserRow =
  | {
      id: string;
      kind: 'source';
      sourceId: string;
      label: string;
      root: string;
      expanded: boolean;
    }
  | { id: string; kind: 'skill'; sourceId: string; skillId: string };

function sourceBrowserRows(
  snapshot: DashboardSnapshot,
  expandedSourceIds: readonly string[]
): SourceBrowserRow[] {
  return (snapshot.skillRoots ?? snapshot.sources ?? []).flatMap((source): SourceBrowserRow[] => {
    const expanded = expandedSourceIds.includes(source.id);
    return [{
      id: `source:${source.id}`,
      kind: 'source',
      sourceId: source.id,
      label: source.label,
      root: source.canonicalRoot !== undefined && source.canonicalRoot !== source.root
        ? `${source.root} (canonical: ${source.canonicalRoot})`
        : source.root,
      expanded
    }, ...(expanded
      ? source.skills.map((skill) => ({
          id: compositeSkillId(skill),
          kind: 'skill' as const,
          sourceId: source.id,
          skillId: skill.id
        }))
      : [])];
  });
}

function browserNodeIds(
  snapshot: DashboardSnapshot,
  expandedSourceIds: readonly string[]
): string[] {
  return (snapshot.skillRoots ?? snapshot.sources ?? []).flatMap((source) => [
    `source:${source.id}`,
    ...(expandedSourceIds.includes(source.id)
      ? source.skills.map(compositeSkillId)
      : [])
  ]);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function focusBorderColor(focused: boolean): 'cyan' | undefined {
  return focused && process.env.NO_COLOR === undefined ? 'cyan' : undefined;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
