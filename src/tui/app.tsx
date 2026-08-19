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
  SkillSourceSummary,
  SkillSummary,
  DirectoryBrowserSnapshot,
  SkillPreview,
  SourceCandidateSummary
} from '../application/tui-service.js';
import { BazframeError } from '../core/errors.js';
import {
  availableRowsFor,
  availableSourcesForProfile,
  availableSourceIdForRow,
  availableSourceRowId,
  initialTuiState,
  isDirectMembershipSource,
  moveAvailableSelectionByRows,
  moveSelection,
  PROFILE_CREATE_ROW_ID,
  tuiReducer,
  type TuiAction,
  type TuiModal,
  type TuiState,
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
const TABS: readonly TuiTab[] = ['skills', 'profiles', 'adapters', 'settings'];

export function TuiApp({ service, onExitCode, onForceExit, dimensions }: TuiAppProps) {
  const { exit } = useApp();
  const windowSize = useWindowSize();
  const columns = dimensions?.columns ?? windowSize.columns;
  const rows = dimensions?.rows ?? windowSize.rows;
  const tooSmall = columns < MIN_COLUMNS || rows < MIN_ROWS;
  const compact = !tooSmall && (columns < 80 || rows < 24);
  const shellRows = compact ? 6 : 8;
  const bodyRows = Math.max(1, rows - shellRows);
  const paneRows = profilePaneRows(bodyRows, compact);
  const viewportRows: ViewportRows = {
    profileList: Math.max(1, bodyRows - 4),
    included: paneRows,
    available: paneRows,
    skillsBrowser: Math.max(1, bodyRows - 4),
    skillPreview: skillPreviewContentRows(Math.max(1, bodyRows - 4), compact)
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
  const [loadError, setLoadError] = useState<string>();
  const [mutation, setMutation] = useState<string>();
  const [message, setMessage] = useState<UiMessage>();
  const [warningsDismissed, setWarningsDismissed] = useState(false);
  const [preview, setPreview] = useState<
    | { state: 'loading'; sourceId: string; skillId: string }
    | { state: 'available'; value: SkillPreview }
    | { state: 'error'; sourceId: string; skillId: string; message: string }
  >();
  const [directoryBrowser, setDirectoryBrowser] = useState<DirectoryBrowserSnapshot>();
  const [browserChoice, setBrowserChoice] = useState(-1);
  const [browserOffset, setBrowserOffset] = useState(0);
  const [sourceCandidate, setSourceCandidate] = useState<SourceCandidateSummary>();
  const snapshotRef = useRef<DashboardSnapshot | undefined>(undefined);
  const previewGeneration = useRef(0);
  const browserGeneration = useRef(0);
  const sourceInspectionGeneration = useRef(0);
  const loadGeneration = useRef(0);
  const mutationActive = useRef(false);
  const exitRequested = useRef(false);
  const exitRequestedCode = useRef(0);
  const forceExitArmed = useRef(false);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    if (snapshotRef.current === undefined) setMessage(undefined);
    try {
      const next = await service.loadDashboard();
      if (generation !== loadGeneration.current) return;
      snapshotRef.current = next;
      setSnapshot(next);
      setWarningsDismissed(false);
      setLoadError(undefined);
      dispatch({
        type: 'reconcile',
        snapshot: next,
        viewportRows: viewportRowsRef.current
      });
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      const text = messageFor(error);
      setLoadError(text);
      setMessage({ tone: 'error', text });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const selected = snapshot === undefined
      ? undefined
      : findBrowserSkill(snapshot, state.browserSkillId);
    const generation = ++previewGeneration.current;
    dispatch({ type: 'set-skill-preview-offset', offset: 0 });
    if (selected === undefined) {
      setPreview(undefined);
      return;
    }
    setPreview({ state: 'loading', sourceId: selected.sourceId, skillId: selected.id });
    void service.loadSkillPreview({ sourceId: selected.sourceId, skillId: selected.id })
      .then((value) => {
        if (generation === previewGeneration.current) setPreview({ state: 'available', value });
      })
      .catch((error: unknown) => {
        if (generation === previewGeneration.current) {
          setPreview({
            state: 'error',
            sourceId: selected.sourceId,
            skillId: selected.id,
            message: messageFor(error)
          });
        }
      });
  }, [service, snapshot?.revision, state.browserSkillId]);

  useEffect(() => {
    const modal = state.modal;
    const generation = ++browserGeneration.current;
    ++sourceInspectionGeneration.current;
    if (modal?.kind !== 'source-root') {
      setDirectoryBrowser(undefined);
      setBrowserChoice(-1);
      setBrowserOffset(0);
      if (modal?.kind !== 'source-confirm') setSourceCandidate(undefined);
      return;
    }
    setDirectoryBrowser(undefined);
    setBrowserChoice(-1);
    setBrowserOffset(0);
    setSourceCandidate(undefined);
    void service.browseDirectories(modal.value)
      .then((value) => {
        if (generation === browserGeneration.current) {
          const currentModal = stateRef.current.modal;
          if (
            currentModal?.kind !== 'source-root'
            || currentModal.value !== value.input
          ) return;
          setDirectoryBrowser(value);
          setBrowserChoice(-1);
          setBrowserOffset(0);
        }
      })
      .catch((error: unknown) => {
        if (generation !== browserGeneration.current) return;
        const currentModal = stateRef.current.modal;
        if (currentModal?.kind !== 'source-root' || currentModal.value !== modal.value) return;
        setDirectoryBrowser(undefined);
        setMessage({ tone: 'error', text: messageFor(error) });
      });
  }, [service, state.modal?.kind, state.modal?.value]);

  useEffect(() => {
    const currentSnapshot = snapshotRef.current;
    if (tooSmall || currentSnapshot === undefined) return;
    dispatch({ type: 'clamp-viewports', snapshot: currentSnapshot, viewportRows });
  }, [
    tooSmall,
    viewportRows.profileList,
    viewportRows.included,
    viewportRows.available,
    viewportRows.skillsBrowser,
    viewportRows.skillPreview
  ]);

  useEffect(() => {
    const lineCount = preview?.state === 'available'
      ? previewLines(preview.value.contents).length
      : 0;
    const maximum = Math.max(0, lineCount - viewportRows.skillPreview);
    if (stateRef.current.skillPreviewOffset > maximum) {
      dispatch({ type: 'set-skill-preview-offset', offset: maximum });
    }
  }, [preview, viewportRows.skillPreview]);

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
  const availableSources = useMemo(
    () => availableSourcesForProfile(snapshot, selectedProfile),
    [snapshot, selectedProfile]
  );
  const submitModal = useCallback(() => {
    const modal = stateRef.current.modal;
    if (modal === undefined || mutation !== undefined) return;
    const rawValue = modal.value;
    const value = rawValue.trim();
    if (modal.kind === 'help') {
      dispatch({ type: 'close-modal' });
      return;
    }
    if (modal.kind === 'source-root') {
      const selectedEntry = browserChoice < 0
        ? undefined
        : directoryBrowser?.entries[browserChoice];
      if (selectedEntry !== undefined) {
        ++sourceInspectionGeneration.current;
        setSourceCandidate(undefined);
        setDirectoryBrowser(undefined);
        setBrowserChoice(-1);
        setBrowserOffset(0);
        dispatch({
          type: 'open-modal',
          modal: { ...modal, value: selectedEntry.path }
        });
        return;
      }
      const root = directoryBrowser?.selectablePath;
      if (root === undefined) {
        setMessage({ tone: 'error', text: 'Select an existing physical directory.' });
        return;
      }
      const generation = ++sourceInspectionGeneration.current;
      setSourceCandidate(undefined);
      void service.inspectSourceCandidate({ root }).then((candidate) => {
        const currentModal = stateRef.current.modal;
        if (
          generation !== sourceInspectionGeneration.current
          || currentModal?.kind !== 'source-root'
          || currentModal.value !== modal.value
        ) return;
        setSourceCandidate(candidate);
        dispatch({
          type: 'open-modal',
          modal: {
            kind: 'source-confirm',
            value: '',
            sourceId: candidate.sourceId,
            root: candidate.enteredRoot,
            enteredRoot: candidate.enteredRoot,
            canonicalRoot: candidate.canonicalRoot
          }
        });
      }).catch((error: unknown) => {
        if (generation === sourceInspectionGeneration.current) {
          setMessage({ tone: 'error', text: messageFor(error) });
        }
      });
      return;
    }
    if (modal.kind === 'source-confirm') return;
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
  }, [browserChoice, directoryBrowser, load, mutation, mutate, service]);

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

  const clearTransientMessage = useCallback(() => {
    if (forceExitArmed.current) return;
    if (message !== undefined) {
      setMessage(undefined);
      return;
    }
    if (
      !loading
      && mutation === undefined
      && snapshotRef.current?.diagnostics.some((item) => item.severity === 'warning') === true
    ) {
      setWarningsDismissed(true);
    }
  }, [loading, message, mutation]);

  const handleModalInput = useCallback((input: string, key: Key, modal: TuiModal) => {
    if (modal.kind === 'source-confirm') {
      if (key.escape || key.backspace || input === 'n') {
        clearTransientMessage();
        ++sourceInspectionGeneration.current;
        setSourceCandidate(undefined);
        dispatch({
          type: 'open-modal',
          modal: {
            kind: 'source-root',
            value: modal.enteredRoot ?? modal.root ?? ''
          }
        });
        return;
      }
      if (input === 'y') {
        clearTransientMessage();
        if (tooSmall) {
          setMessage({ tone: 'error', text: 'Resize to review the full source authorization.' });
          return;
        }
        if (
          sourceCandidate?.manifest.state !== 'absent'
          || modal.sourceId !== sourceCandidate.sourceId
          || modal.enteredRoot !== sourceCandidate.enteredRoot
          || modal.canonicalRoot !== sourceCandidate.canonicalRoot
        ) {
          setMessage({
            tone: 'error',
            text: 'Declared or invalid builds must be added with `bazframe sources add`.'
          });
          return;
        }
        void mutate(
          'Add source',
          async () => {
            await service.addSource({ root: sourceCandidate.canonicalRoot });
          },
          () => {
            setSourceCandidate(undefined);
            dispatch({ type: 'close-modal' });
          }
        );
      }
      return;
    }
    if (modal.kind === 'source-root' && (key.upArrow || key.downArrow)) {
      const count = directoryBrowser?.entries.length ?? 0;
      if (count > 0) {
        clearTransientMessage();
        setBrowserChoice((current) => {
          const next = key.downArrow
            ? Math.min(count - 1, current + 1)
            : Math.max(-1, current - 1);
          setBrowserOffset((offset) => directoryChoiceOffset(offset, next, count));
          return next;
        });
      }
      return;
    }
    if (key.escape) {
      clearTransientMessage();
      if (modal.kind === 'source-root') {
        ++sourceInspectionGeneration.current;
        setSourceCandidate(undefined);
        setDirectoryBrowser(undefined);
        setBrowserChoice(-1);
        setBrowserOffset(0);
      }
      dispatch({ type: 'close-modal' });
      return;
    }
    if (modal.kind === 'remove-confirm') {
      if (input === 'y') {
        clearTransientMessage();
        submitModal();
      } else if (input === 'n') {
        clearTransientMessage();
        dispatch({ type: 'close-modal' });
      }
      return;
    }
    if (key.return) {
      clearTransientMessage();
      submitModal();
      return;
    }
    if (modal.kind === 'help') return;
    if (key.backspace || key.delete) {
      clearTransientMessage();
      if (modal.kind === 'source-root') {
        ++sourceInspectionGeneration.current;
        setSourceCandidate(undefined);
        setDirectoryBrowser(undefined);
        setBrowserChoice(-1);
        setBrowserOffset(0);
      }
      dispatch({ type: 'set-modal-value', value: modal.value.slice(0, -1) });
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      const printable = input.replaceAll(/[\r\n\0]/gu, '');
      if (printable.length > 0) {
        clearTransientMessage();
        if (modal.kind === 'source-root') {
          ++sourceInspectionGeneration.current;
          setSourceCandidate(undefined);
          setDirectoryBrowser(undefined);
          setBrowserChoice(-1);
          setBrowserOffset(0);
        }
        dispatch({ type: 'set-modal-value', value: modal.value + printable });
      }
    }
  }, [clearTransientMessage, directoryBrowser, mutate, service, sourceCandidate, submitModal, tooSmall]);

  useInput((input, key) => {
    const currentState = stateRef.current;
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'c') {
      clearTransientMessage();
      requestExit(130, true);
      return;
    }
    if (currentState.modal !== undefined) {
      handleModalInput(input, key, currentState.modal);
      return;
    }
    if (tooSmall) {
      if (input === 'q') {
        clearTransientMessage();
        requestExit(0, false);
      } else if (input === '?') {
        clearTransientMessage();
        dispatch({ type: 'open-modal', modal: { kind: 'help', value: '' } });
      }
      return;
    }

    if (input === 'q') {
      clearTransientMessage();
      requestExit(0, false);
      return;
    }
    if (input === '?') {
      clearTransientMessage();
      dispatch({ type: 'open-modal', modal: { kind: 'help', value: '' } });
      return;
    }
    if (input === 'r') {
      if (!mutationActive.current) {
        clearTransientMessage();
        void load();
      }
      return;
    }
    if (input === '1' || input === '2' || input === '3' || input === '4') {
      clearTransientMessage();
      dispatch({ type: 'activate-tab', tab: TABS[Number(input) - 1]! });
      return;
    }
    if (input === '[' || input === ']') {
      clearTransientMessage();
      const current = TABS.indexOf(currentState.activeTab);
      const delta = input === ']' ? 1 : -1;
      dispatch({ type: 'activate-tab', tab: TABS[(current + delta + TABS.length) % TABS.length]! });
      return;
    }
    if (key.tab) {
      clearTransientMessage();
      dispatch({ type: 'cycle-focus', direction: key.shift ? -1 : 1 });
      return;
    }
    const routeBack = key.escape || key.backspace || input === 'H';
    const routeForward = key.return || input === 'L';
    if (routeBack) {
      if (currentState.activeTab === 'profiles' && currentState.profileRoute === 'editor') {
        clearTransientMessage();
        dispatch({ type: 'profile-route', route: 'list' });
        return;
      }
      if (currentState.activeTab === 'skills' && currentState.skillRoute === 'preview') {
        clearTransientMessage();
        dispatch({ type: 'skill-route', route: 'browser' });
        return;
      }
    }
    const vimLeft = !key.ctrl && !key.meta && input === 'h';
    const vimRight = !key.ctrl && !key.meta && input === 'l';
    const vimUp = !key.ctrl && !key.meta && input === 'k';
    const vimDown = !key.ctrl && !key.meta && input === 'j';

    if (currentState.focusedRegion === 'tabs') {
      if (key.leftArrow || key.rightArrow || vimLeft || vimRight) {
        clearTransientMessage();
        const current = TABS.indexOf(currentState.focusedTab);
        const delta = key.rightArrow || vimRight ? 1 : -1;
        dispatch({
          type: 'activate-tab',
          tab: TABS[(current + delta + TABS.length) % TABS.length]!
        });
      } else if (key.return || input === 'L') {
        clearTransientMessage();
        dispatch({ type: 'activate-tab', tab: currentState.focusedTab });
      }
      return;
    }
    const currentSnapshot = snapshotRef.current;
    if (currentSnapshot === undefined || mutationActive.current) return;
    const currentSelectedProfile = currentSnapshot.profiles.find(
      (profile) => profile.id === stateRef.current.selectedProfileId
    );
    const currentAvailableSources = availableSourcesForProfile(currentSnapshot, currentSelectedProfile);
    const currentAvailableRows = availableRowsFor(
      currentAvailableSources,
      new Set<string>(),
      currentState.expandedAvailableSourceIds
    );
    const currentAvailableRowIds = currentAvailableRows.map((row) => row.id);
    const setAvailableSourceExpansion = (sourceId: string, expanded: boolean): string[] => {
      const nextExpanded = new Set(currentState.expandedAvailableSourceIds);
      if (expanded) nextExpanded.add(sourceId);
      else nextExpanded.delete(sourceId);
      const rowIds = availableRowsFor(
        currentAvailableSources,
        new Set<string>(),
        [...nextExpanded]
      ).map((row) => row.id);
      dispatch({
        type: 'toggle-available-source',
        id: sourceId,
        expanded,
        rowIds,
        viewportRows: viewportRowsRef.current.available
      });
      return rowIds;
    };

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
          clearTransientMessage();
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
                currentState.expandedAvailableSourceIds,
                viewportRowsRef.current
              ));
          return;
        }
        if (routeForward && currentState.selectedProfileId === PROFILE_CREATE_ROW_ID) {
          clearTransientMessage();
          dispatch({ type: 'open-modal', modal: { kind: 'create', value: '' } });
          return;
        }
        if (routeForward && currentSelectedProfile !== undefined) {
          clearTransientMessage();
          dispatch(profileSnapshotSelection(
            currentSnapshot,
            currentSelectedProfile,
            currentState.expandedAvailableSourceIds,
            viewportRowsRef.current,
            true
          ));
          return;
        }
        if (input === 'c') {
          clearTransientMessage();
          dispatch({ type: 'open-modal', modal: { kind: 'create', value: '' } });
          return;
        }
        if (input === 'D' && currentSelectedProfile !== undefined) {
          clearTransientMessage();
          openProfileModal('duplicate', currentSelectedProfile);
          return;
        }
        if (input === 'R' && currentSelectedProfile !== undefined) {
          clearTransientMessage();
          openProfileModal('rename', currentSelectedProfile);
          return;
        }
        if (input === 'd' && currentSelectedProfile !== undefined) {
          clearTransientMessage();
          openRemoveConfirmation(currentSelectedProfile);
          return;
        }
        if (input === 'u' && currentSelectedProfile !== undefined) {
          clearTransientMessage();
          void mutate('Activate profile', () => service.useProfile(currentSelectedProfile.id));
          return;
        }
        return;
      }

      const jumpDown = !key.ctrl && !key.meta && input === 'J';
      const jumpUp = !key.ctrl && !key.meta && input === 'K';
      if ((key.shift && (key.upArrow || key.downArrow)) || jumpDown || jumpUp) {
        if ((key.downArrow || jumpDown) && currentState.focusedPane === 'included') {
          clearTransientMessage();
          dispatch({ type: 'focus-pane', pane: 'available' });
        } else if ((key.upArrow || jumpUp) && currentState.focusedPane === 'available') {
          clearTransientMessage();
          dispatch({ type: 'focus-pane', pane: 'included' });
        }
        return;
      }
      if (
        key.upArrow || key.downArrow || vimUp || vimDown
        || key.pageUp || key.pageDown || key.home || key.end
      ) {
        clearTransientMessage();
        const includedPageSize = viewportRowsRef.current.included;
        const delta = key.pageDown
          ? includedPageSize
          : key.pageUp ? -includedPageSize : key.downArrow || vimDown ? 1 : -1;
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
          const atTop = (key.upArrow || vimUp) && (
            currentAvailableRowIds.length === 0
            || currentState.availableSkillId === currentAvailableRowIds[0]
          );
          if (atTop) dispatch({ type: 'focus-pane', pane: 'included' });
          else {
            const availablePageSize = viewportRowsRef.current.available;
            dispatch({
              type: 'select-available',
              id: key.home
                ? currentAvailableRowIds[0]
                : key.end
                  ? currentAvailableRowIds[currentAvailableRowIds.length - 1]
                  : moveAvailableSelectionByRows(
                      currentAvailableRowIds,
                      currentState.availableSkillId,
                      key.pageDown
                        ? availablePageSize
                        : key.pageUp ? -availablePageSize : delta
                    ),
              ids: currentAvailableRowIds,
              viewportRows: availablePageSize
            });
          }
        }
        return;
      }
      if (currentState.focusedPane === 'available') {
        const selectedAvailableRow = currentAvailableRows.find(
          (row) => row.id === currentState.availableSkillId
        );
        const selectedSourceId = availableSourceIdForRow(
          currentAvailableRowIds,
          currentState.availableSkillId
        );
        if (selectedAvailableRow?.kind === 'source' && routeForward) {
          clearTransientMessage();
          setAvailableSourceExpansion(selectedAvailableRow.sourceId, !selectedAvailableRow.expanded);
          return;
        }
        if (selectedAvailableRow?.kind === 'source' && (key.rightArrow || vimRight)) {
          clearTransientMessage();
          if (!selectedAvailableRow.expanded) {
            setAvailableSourceExpansion(selectedAvailableRow.sourceId, true);
          } else {
            const firstChild = currentAvailableRows.find(
              (row) => row.kind === 'skill' && row.sourceId === selectedAvailableRow.sourceId
            );
            if (firstChild !== undefined) {
              dispatch({
                type: 'select-available',
                id: firstChild.id,
                ids: currentAvailableRowIds,
                viewportRows: viewportRowsRef.current.available
              });
            }
          }
          return;
        }
        if ((key.leftArrow || vimLeft) && selectedSourceId !== undefined) {
          clearTransientMessage();
          if (selectedAvailableRow?.kind === 'skill') {
            dispatch({
              type: 'select-available',
              id: availableSourceRowId(selectedSourceId),
              ids: currentAvailableRowIds,
              viewportRows: viewportRowsRef.current.available
            });
          } else {
            setAvailableSourceExpansion(selectedSourceId, false);
          }
          return;
        }
        if (input === 'o' && selectedSourceId !== undefined) {
          clearTransientMessage();
          setAvailableSourceExpansion(selectedSourceId, true);
          return;
        }
        if (input === 'c' && selectedSourceId !== undefined) {
          clearTransientMessage();
          setAvailableSourceExpansion(selectedSourceId, false);
          return;
        }
      }
      if (input === 'e') {
        clearTransientMessage();
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
        clearTransientMessage();
        const selectedRow = currentAvailableRows.find(
          (row) => row.id === currentState.availableSkillId
        );
        const selectedSourceId = selectedRow?.sourceId;
        if (
          selectedSourceId !== undefined
          && !isDirectMembershipSource(currentSnapshot, selectedSourceId)
        ) {
          const managed = currentSnapshot.managedSources?.find(
            (source) => source.id === selectedSourceId
          );
          setMessage(managed === undefined
            ? { tone: 'info', text: 'This source is browse-only in the TUI.' }
            : {
                tone: 'info',
                text: `Attach the whole source with \`bazframe profile sources add ${managed.source} --profile ${currentSelectedProfile.id}\`.`
              });
          return;
        }
        if (!currentSelectedProfile.membershipWritable) {
          setMessage({
            tone: 'error',
            text: currentSelectedProfile.membershipDiagnostic ?? 'Profile membership is unavailable.'
          });
          return;
        }
        if (selectedRow?.kind === 'skill') {
          void mutate(
            'Add membership',
            () => service.addMembership(currentSelectedProfile.id, {
              sourceId: selectedRow.skill.sourceId,
              skillId: selectedRow.skill.id
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
        clearTransientMessage();
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
        clearTransientMessage();
        void mutate('Activate profile', () => service.useProfile(currentSelectedProfile.id));
      }
      return;
    }

    if (currentState.activeTab === 'skills') {
      if (currentState.skillRoute === 'preview') {
        const lineCount = preview?.state === 'available'
          ? previewLines(preview.value.contents).length
          : 0;
        const page = viewportRowsRef.current.skillPreview;
        const maximum = Math.max(0, lineCount - page);
        if (key.home) {
          clearTransientMessage();
          dispatch({ type: 'set-skill-preview-offset', offset: 0 });
        } else if (key.end) {
          clearTransientMessage();
          dispatch({ type: 'set-skill-preview-offset', offset: maximum });
        } else if (key.upArrow || vimUp || key.pageUp) {
          clearTransientMessage();
          dispatch({
            type: 'set-skill-preview-offset',
            offset: Math.max(0, currentState.skillPreviewOffset - (key.pageUp ? page : 1))
          });
        } else if (key.downArrow || vimDown || key.pageDown) {
          clearTransientMessage();
          dispatch({
            type: 'set-skill-preview-offset',
            offset: Math.min(maximum, currentState.skillPreviewOffset + (key.pageDown ? page : 1))
          });
        }
        return;
      }
      if (input === 'a') {
        clearTransientMessage();
        setSourceCandidate(undefined);
        dispatch({ type: 'open-modal', modal: { kind: 'source-root', value: '' } });
        return;
      }
      const ids = browserNodeIds(currentSnapshot, currentState.expandedSourceIds);
      if (
        key.upArrow || key.downArrow || vimUp || vimDown
        || key.pageUp || key.pageDown || key.home || key.end
      ) {
        clearTransientMessage();
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
      const owner = owningSourceId(currentSnapshot, currentState.browserSkillId);
      if (input === 'o' && owner !== undefined) {
        clearTransientMessage();
        dispatch({ type: 'toggle-source', id: owner, expanded: true });
        return;
      }
      if (input === 'c' && owner !== undefined) {
        clearTransientMessage();
        if (!currentState.browserSkillId?.startsWith('source:')) {
          dispatch({
            type: 'select-browser-skill',
            id: `source:${owner}`,
            ids,
            viewportRows: viewportRowsRef.current.skillsBrowser
          });
        }
        dispatch({ type: 'toggle-source', id: owner, expanded: false });
        return;
      }
      const sourcePrefix = 'source:';
      if (currentState.browserSkillId?.startsWith(sourcePrefix)) {
        const sourceId = currentState.browserSkillId.slice(sourcePrefix.length);
        if (routeForward) {
          clearTransientMessage();
          dispatch({ type: 'toggle-source', id: sourceId });
        } else if (key.rightArrow || vimRight) {
          clearTransientMessage();
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
          clearTransientMessage();
          dispatch({ type: 'toggle-source', id: sourceId, expanded: false });
        }
        return;
      }
      if (routeForward && currentState.browserSkillId !== undefined) {
        clearTransientMessage();
        dispatch({ type: 'skill-route', route: 'preview' });
        return;
      }
      if ((key.leftArrow || vimLeft) && owner !== undefined) {
        clearTransientMessage();
        dispatch({
          type: 'select-browser-skill',
          id: `source:${owner}`,
          ids,
          viewportRows: viewportRowsRef.current.skillsBrowser
        });
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
        sourceCandidate={sourceCandidate}
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
          ? <Modal
              modal={state.modal}
              busy={mutation !== undefined}
              directoryBrowser={directoryBrowser}
              browserChoice={browserChoice}
              browserOffset={browserOffset}
              sourceCandidate={sourceCandidate}
            />
          : loadError !== undefined && snapshot === undefined
            ? <LoadFailureView message={loadError} />
          : state.activeTab === 'skills'
            ? compact && state.skillRoute === 'preview'
              ? <SkillPreviewPane
                  preview={preview}
                  offset={state.skillPreviewOffset}
                  contentRows={viewportRows.skillPreview}
                  breadcrumb
                  focused={state.focusedRegion === 'body'}
                />
              : <SkillsMasterDetail
                  snapshot={snapshot}
                  selectedId={state.browserSkillId}
                  offset={state.skillsBrowserOffset}
                  expandedSourceIds={state.expandedSourceIds}
                  preview={preview}
                  previewOffset={state.skillPreviewOffset}
                  focused={state.focusedRegion === 'body'}
                  previewFocused={state.skillRoute === 'preview'}
                  maxRows={bodyRows - 4}
                  previewContentRows={viewportRows.skillPreview}
                  compact={compact}
                />
            : state.activeTab === 'profiles'
              ? snapshot === undefined
                ? <LoadingView title="Profiles" message="Loading profiles..." />
                : compact
                  ? state.profileRoute === 'list'
                    ? <ProfilesList
                        profiles={snapshot.profiles}
                        selectedId={state.selectedProfileId}
                        offset={state.profileListOffset}
                        focused={state.focusedRegion === 'body'}
                        maxRows={bodyRows - 4}
                      />
                    : <ProfileEditor
                        profile={selectedProfile}
                        availableSources={availableSources}
                        expandedAvailableSourceIds={state.expandedAvailableSourceIds}
                        focusedPane={state.focusedRegion === 'body' ? state.focusedPane : undefined}
                        includedSelectionId={state.includedSkillId}
                        availableSelectionId={state.availableSkillId}
                        includedOffset={state.includedOffset}
                        availableOffset={state.availableOffset}
                        maxRows={bodyRows}
                        compact
                        breadcrumb
                      />
                  : <ProfilesMasterDetail
                      profiles={snapshot.profiles}
                      selectedId={state.selectedProfileId}
                      profileOffset={state.profileListOffset}
                      profile={selectedProfile}
                      availableSources={availableSources}
                      expandedAvailableSourceIds={state.expandedAvailableSourceIds}
                      editing={state.profileRoute === 'editor'}
                      focused={state.focusedRegion === 'body'}
                      focusedPane={state.focusedPane}
                      includedSelectionId={state.includedSkillId}
                      availableSelectionId={state.availableSkillId}
                      includedOffset={state.includedOffset}
                      availableOffset={state.availableOffset}
                      maxRows={bodyRows}
                    />
              : state.activeTab === 'adapters'
                ? <Adapters status={snapshot?.status} focused={state.focusedRegion === 'body'} />
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
        warningsDismissed={warningsDismissed}
        compact={compact}
      />
      <Text dimColor wrap="truncate-end"> {routeActionHint(state, compact)}</Text>
    </Box>
  );
}

function BelowMinimumView({
  columns,
  rows,
  modal,
  busy,
  sourceCandidate
}: {
  columns: number;
  rows: number;
  modal: TuiModal | undefined;
  busy: boolean;
  sourceCandidate: SourceCandidateSummary | undefined;
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

  if (modal.kind.startsWith('source-')) {
    const blocked = sourceCandidate?.manifest.state !== 'absent';
    const step = modal.kind === 'source-root'
      ? 'Physical source root'
      : `Review ${modal.sourceId ?? '(unknown source)'}`;
    return (
      <Box
        width={columns}
        height={rows}
        borderStyle="bold"
        borderColor={focusBorderColor(true)}
        flexDirection="column"
        overflow="hidden"
      >
        <Text bold>Add manifest-free managed source</Text>
        <Text wrap="truncate-end">{step}</Text>
        {modal.kind === 'source-confirm'
          ? <>
              <Text wrap="truncate-end">Entered: {modal.enteredRoot ?? modal.root}</Text>
              <Text wrap="truncate-end">Canonical: {modal.canonicalRoot ?? '(unavailable)'}</Text>
              <Text color={blocked ? 'red' : 'yellow'} wrap="truncate-end">
                {blocked ? 'Blocked manifest; use the CLI.' : 'Resize to authorize; y is disabled here.'}
              </Text>
              <Text bold>n/Esc/Backspace back</Text>
            </>
          : <>
              <Text inverse wrap="truncate-start">Input: {modal.value.length === 0 ? ' ' : modal.value}</Text>
              <Text bold>Enter next  Esc back/cancel</Text>
            </>}
        <Text color="yellow" wrap="truncate-end">{sizeLine}</Text>
        <Text bold>Final source authorization is disabled at this size.</Text>
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
    <Box flexDirection="column">
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
      <Text dimColor wrap="truncate-end"> Tabs: 1-4 or [/] open  Tab focus  h/l switch</Text>
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
  return (
    <Box
      borderStyle={focused ? 'bold' : 'classic'}
      borderColor={focusBorderColor(focused)}
      borderDimColor={!focused}
      flexDirection="column"
      width="100%"
      paddingX={1}
    >
      <Text bold aria-label={`Profiles list${focused ? ', focused' : ''}`}>
        Profiles
      </Text>
      <ScrollableRows
        rows={rows}
        offset={offset}
        maxRows={maxRows}
        renderRow={(profile) => !('active' in profile)
          ? <Text
              key={profile.id}
              inverse={focused && profile.id === selectedId}
              bold={profile.id === selectedId}
              wrap="truncate-end"
              aria-label={`Create new profile${profile.id === selectedId ? ', selected' : ''}`}
            >
                + Create New Profile
            </Text>
          : <Box key={profile.id} width="100%" justifyContent="space-between">
              <Text
                inverse={focused && profile.id === selectedId}
                bold={profile.id === selectedId}
                wrap="truncate-end"
                aria-label={`Profile ${profile.id}${profile.active ? ', active' : ''}${profile.id === selectedId ? ', selected' : ''}, ${profile.memberships.length} skills`}
              >
                {profile.active ? '*' : ' '} {profile.id}
              </Text>
              <Text inverse={focused && profile.id === selectedId} bold={profile.id === selectedId}>
                {profile.memberships.length}
              </Text>
            </Box>}
      />
    </Box>
  );
}

function ProfileEditor({
  profile,
  availableSources,
  expandedAvailableSourceIds,
  focusedPane,
  includedSelectionId,
  availableSelectionId,
  includedOffset,
  availableOffset,
  maxRows,
  compact,
  breadcrumb = false
}: {
  profile: ProfileSummary | undefined;
  availableSources: readonly SkillSourceSummary[];
  expandedAvailableSourceIds: readonly string[];
  focusedPane: 'included' | 'available' | undefined;
  includedSelectionId: string | undefined;
  availableSelectionId: string | undefined;
  includedOffset: number;
  availableOffset: number;
  maxRows: number;
  compact: boolean;
  breadcrumb?: boolean;
}) {
  if (profile === undefined) return <Text>No selected profile.</Text>;
  const paneRows = profilePaneRows(maxRows, compact);
  return (
    <Box flexDirection="column" width="100%">
      <Text
        bold
        aria-label={`${breadcrumb ? 'Back to Profiles list, ' : ''}Profile ${profile.id}${profile.active ? ', active' : ''}, editor`}
      >
        {breadcrumb ? '<- Profiles / ' : 'Profiles / '}{profile.active ? '* ' : ''}{profile.id}{profile.active ? ' [active]' : ''}
      </Text>
      {compact
        ? null
        : <Text dimColor wrap="truncate-end">
            {profile.membershipDiagnostic ?? profile.directory}
          </Text>}
      {compact
        ? null
        : <Text wrap="truncate-end">
            Source references: {profile.sourceReferences?.length
              ? profile.sourceReferences.map((reference) => reference.availability === 'available'
                ? reference.source
                : `${reference.source} [unavailable: ${reference.diagnostic ?? 'unknown failure'}]`).join(', ')
              : '(none)'} (read-only)
          </Text>}
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
        sources={availableSources}
        expandedSourceIds={expandedAvailableSourceIds}
        selectedId={availableSelectionId}
        offset={availableOffset}
        focused={focusedPane === 'available'}
        maxRows={paneRows}
      />
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
        wrap="truncate-end"
        aria-label={`${title} pane${focused ? ', focused' : ''}, ${memberships.length} items`}
      >
        {title}
      </Text>
      <ScrollableRows
        rows={memberships}
        offset={offset}
        maxRows={maxRows}
        empty={<Text dimColor aria-label={`${title} pane is empty`}>(empty)</Text>}
        renderRow={(membership) => (
          <Text
            key={membership.id}
            inverse={focused && membership.id === selectedId}
            bold={membership.id === selectedId}
            wrap="truncate-end"
            aria-label={`${membership.skillId}, ${membership.manageable ? 'managed' : 'unmanaged'}${membership.id === selectedId ? ', selected' : ''}`}
          >
              {membership.manageable ? '+' : '!'} {membership.skillId}
            {membership.manageable ? '' : ' (unmanaged)'}
          </Text>
        )}
      />
    </Box>
  );
}

function SkillPane({
  title,
  sources,
  expandedSourceIds,
  selectedId,
  offset,
  focused,
  maxRows
}: {
  title: string;
  sources: readonly SkillSourceSummary[];
  expandedSourceIds: readonly string[];
  selectedId: string | undefined;
  offset: number;
  focused: boolean;
  maxRows: number;
}) {
  const rows = availableRowsFor(sources, new Set<string>(), expandedSourceIds);
  const skillCount = sources.reduce((count, source) => count + source.skills.length, 0);
  const labels = new Map(sources.map((source) => [source.id, source.label]));
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
        wrap="truncate-end"
        aria-label={`${title} pane${focused ? ', focused' : ''}, ${skillCount} items`}
      >
        {title}
      </Text>
      <ScrollableRows
        rows={rows}
        offset={offset}
        maxRows={maxRows}
        empty={<Text dimColor aria-label={`${title} pane is empty`}>(empty)</Text>}
        renderRow={(row) => row.kind === 'source'
          ? <Text
              key={row.id}
              inverse={focused && row.id === selectedId}
              bold
              wrap="truncate-end"
              aria-label={`Available source ${row.label}, ${row.expanded ? 'expanded' : 'collapsed'}${row.id === selectedId ? ', selected' : ''}, ${row.root}`}
            >
              {row.expanded ? '[-]' : '[+]'}{' '}{row.label}
            </Text>
          : <Text
              key={row.id}
              inverse={focused && row.id === selectedId}
              bold={row.id === selectedId}
              wrap="truncate-end"
              aria-label={`Available skill ${row.skill.id}, source ${row.skill.sourceId}${row.id === selectedId ? ', selected' : ''}`}
            >
              {maxRows === 1 ? `[${labels.get(row.sourceId) ?? row.sourceId}] ` : '  '}{row.skill.id}
            </Text>}
      />
    </Box>
  );
}

function LoadFailureView({ message }: { message: string }) {
  return (
    <Box borderStyle="classic" flexDirection="column" paddingX={1}>
      <Text bold color="red">Dashboard unavailable</Text>
      <Text wrap="truncate-end">Failed to load: {message}</Text>
      <Text bold>Press r to retry.</Text>
    </Box>
  );
}

function LoadingView({ title, message }: { title: string; message: string }) {
  return (
    <Box borderStyle="classic" flexDirection="column" paddingX={1}>
      <Text bold>{title}</Text>
      <Text>{message}</Text>
    </Box>
  );
}

function ProfilesMasterDetail({
  profiles,
  selectedId,
  profileOffset,
  profile,
  availableSources,
  expandedAvailableSourceIds,
  editing,
  focused,
  focusedPane,
  includedSelectionId,
  availableSelectionId,
  includedOffset,
  availableOffset,
  maxRows
}: {
  profiles: readonly ProfileSummary[];
  selectedId: string | undefined;
  profileOffset: number;
  profile: ProfileSummary | undefined;
  availableSources: readonly SkillSourceSummary[];
  expandedAvailableSourceIds: readonly string[];
  editing: boolean;
  focused: boolean;
  focusedPane: 'included' | 'available';
  includedSelectionId: string | undefined;
  availableSelectionId: string | undefined;
  includedOffset: number;
  availableOffset: number;
  maxRows: number;
}) {
  return (
    <Box flexDirection="row" width="100%" height="100%">
      <Box width="36%" overflow="hidden">
        <ProfilesList
          profiles={profiles}
          selectedId={selectedId}
          offset={profileOffset}
          focused={focused && !editing}
          maxRows={maxRows - 4}
        />
      </Box>
      <Box width="64%" paddingLeft={1} overflow="hidden">
        <ProfileEditor
          profile={profile}
          availableSources={availableSources}
          expandedAvailableSourceIds={expandedAvailableSourceIds}
          focusedPane={focused && editing ? focusedPane : undefined}
          includedSelectionId={includedSelectionId}
          availableSelectionId={availableSelectionId}
          includedOffset={includedOffset}
          availableOffset={availableOffset}
          maxRows={maxRows}
          compact={false}
        />
      </Box>
    </Box>
  );
}

function SkillsMasterDetail({
  snapshot,
  selectedId,
  offset,
  expandedSourceIds,
  preview,
  previewOffset,
  focused,
  previewFocused,
  maxRows,
  previewContentRows,
  compact
}: {
  snapshot: DashboardSnapshot | undefined;
  selectedId: string | undefined;
  offset: number;
  expandedSourceIds: readonly string[];
  preview: { state: 'loading'; sourceId: string; skillId: string }
    | { state: 'available'; value: SkillPreview }
    | { state: 'error'; sourceId: string; skillId: string; message: string }
    | undefined;
  previewOffset: number;
  focused: boolean;
  previewFocused: boolean;
  maxRows: number;
  previewContentRows: number;
  compact: boolean;
}) {
  if (compact) {
    return <SkillsBrowser snapshot={snapshot} selectedId={selectedId} offset={offset} expandedSourceIds={expandedSourceIds} focused={focused} maxRows={maxRows} />;
  }
  return (
    <Box flexDirection="row" width="100%" height="100%">
      <Box width="46%" overflow="hidden">
        <SkillsBrowser snapshot={snapshot} selectedId={selectedId} offset={offset} expandedSourceIds={expandedSourceIds} focused={focused && !previewFocused} maxRows={maxRows} />
      </Box>
      <Box width="54%" paddingLeft={1} overflow="hidden">
        {selectedId?.startsWith('source:')
          ? <SourceDetails snapshot={snapshot} sourceId={selectedId.slice('source:'.length)} />
          : <SkillPreviewPane preview={preview} offset={previewOffset} contentRows={previewContentRows} focused={focused && previewFocused} />}
      </Box>
    </Box>
  );
}

function SourceDetails({
  snapshot,
  sourceId
}: {
  snapshot: DashboardSnapshot | undefined;
  sourceId: string;
}) {
  if (snapshot === undefined) return <LoadingView title="Source details" message="Loading source..." />;
  const managed = snapshot.managedSources?.find((source) => source.id === sourceId);
  const root = (snapshot.skillRoots ?? snapshot.sources ?? []).find((source) => source.id === sourceId);
  if (managed !== undefined) {
    return (
      <Box borderStyle="classic" flexDirection="column" paddingX={1}>
        <Text bold aria-label={managedSourceAccessibilityLabel(managed, true)}>{managed.source}</Text>
        <Text>Health: {managed.health}</Text>
        <Text>Profile references: {managed.referenceCount}</Text>
        <Text wrap="truncate-end">Provider input: {managed.root}</Text>
        <Text wrap="truncate-end">Activated digest: sha256:{managed.digest}</Text>
        <Text>Source-unit root: {managed.sourceUnitRoot}</Text>
        <Text>Rebuild: {managed.rebuildAvailability} (CLI only)</Text>
        {managed.diagnostics.length === 0
          ? <Text dimColor>Diagnostics: (none)</Text>
          : managed.diagnostics.map((item, index) => <Text key={index} color="red" wrap="truncate-end">! {item}</Text>)}
      </Box>
    );
  }
  if (root !== undefined) {
    return (
      <Box borderStyle="classic" flexDirection="column" paddingX={1}>
        <Text bold>{root.label}</Text>
        <Text wrap="truncate-end">Path: {root.root}</Text>
        {root.canonicalRoot === undefined || root.canonicalRoot === root.root
          ? null
          : <Text wrap="truncate-end">Canonical: {root.canonicalRoot}</Text>}
        <Text>Skills: {root.skills.length}</Text>
        <Text dimColor>Provider-owned; artifact writes are unavailable.</Text>
      </Box>
    );
  }
  return <Text>Source unavailable.</Text>;
}

function SkillPreviewPane({
  preview,
  offset,
  contentRows,
  focused,
  breadcrumb = false
}: {
  preview: { state: 'loading'; sourceId: string; skillId: string }
    | { state: 'available'; value: SkillPreview }
    | { state: 'error'; sourceId: string; skillId: string; message: string }
    | undefined;
  offset: number;
  contentRows: number;
  focused: boolean;
  breadcrumb?: boolean;
}) {
  const title = preview === undefined
    ? 'Skill preview'
    : `${breadcrumb ? '<- Skills / ' : 'Skills / '}${preview.state === 'available' ? preview.value.skillId : preview.skillId}`;
  return (
    <Box borderStyle={focused ? 'bold' : 'classic'} borderColor={focusBorderColor(focused)} borderDimColor={!focused} flexDirection="column" paddingX={1}>
      <Text bold aria-label={`${breadcrumb ? 'Back to Skills browser, ' : ''}${title}${focused ? ', focused' : ''}`}>{title}</Text>
      {preview === undefined
        ? <Text dimColor>Select a skill to view its SKILL.md.</Text>
        : preview.state === 'loading'
          ? <Text>Loading SKILL.md...</Text>
          : preview.state === 'error'
            ? <Text color="red" wrap="truncate-end">Preview unavailable: {preview.message}</Text>
            : <>
                <Text dimColor wrap="truncate-end">{preview.value.path}</Text>
                <ScrollableRows
                  rows={previewLines(preview.value.contents)}
                  offset={offset}
                  maxRows={contentRows}
                  renderRow={(line, index) => (
                    <Text key={`${index}:${line}`} wrap="truncate-end">{line.length === 0 ? ' ' : line}</Text>
                  )}
                />
              </>}
    </Box>
  );
}

function SkillsBrowser({
  snapshot,
  selectedId,
  offset,
  expandedSourceIds,
  focused,
  maxRows
}: {
  snapshot: DashboardSnapshot | undefined;
  selectedId: string | undefined;
  offset: number;
  expandedSourceIds: readonly string[];
  focused: boolean;
  maxRows: number;
}) {
  if (snapshot === undefined) {
    return (
      <Box
        borderStyle={focused ? 'bold' : 'classic'}
        borderColor={focusBorderColor(focused)}
        borderDimColor={!focused}
        flexDirection="column"
        paddingX={1}
        width="100%"
      >
        <Text bold aria-label={`Skill sources browser${focused ? ', focused' : ''}`}>
          Skill sources
        </Text>
        <Text>Loading skills...</Text>
      </Box>
    );
  }
  const rows = sourceBrowserRows(snapshot, expandedSourceIds);
  return (
    <Box
      borderStyle={focused ? 'bold' : 'classic'}
      borderColor={focusBorderColor(focused)}
      borderDimColor={!focused}
      flexDirection="column"
      paddingX={1}
      width="100%"
    >
      <Text bold aria-label={`Skill sources browser${focused ? ', focused' : ''}`}>
        Skill sources
      </Text>
      <ScrollableRows
        rows={rows}
        offset={offset}
        maxRows={maxRows}
        empty={<Text dimColor>No configured source is available.</Text>}
        renderRow={(row) => row.kind === 'source'
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
              wrap="truncate-end"
              aria-label={`Skill ${row.skillId}, source ${row.sourceId}${row.id === selectedId ? ', selected' : ''}`}
            >
                {'  '}{row.skillId}
            </Text>}
      />
    </Box>
  );
}

export function managedSourceAccessibilityLabel(source: ManagedSourceSummary, selected: boolean): string {
  const references = source.referenceCount === 'unknown'
    ? 'profile reference count unknown'
    : `${source.referenceCount} profile references`;
  return `Source ${source.source}, ${source.health}, ${references}${selected ? ', selected' : ''}`;
}

function Adapters({
  status,
  focused
}: {
  status: DashboardSnapshot['status'] | undefined;
  focused: boolean;
}) {
  const boxProps = {
    borderStyle: focused ? 'bold' as const : 'classic' as const,
    borderColor: focusBorderColor(focused),
    borderDimColor: !focused,
    flexDirection: 'column' as const,
    paddingX: 1
  };
  if (status === undefined) {
    return <Box {...boxProps}><Text bold>Adapters</Text><Text>Loading adapter status...</Text></Box>;
  }
  if (status.state === 'unavailable') {
    return <Box {...boxProps}><Text bold>Adapters</Text><Text color="red">Adapter status unavailable: {status.diagnostic.message}</Text></Box>;
  }
  const setup = status.value;
  const actions = setup.correctiveActions.filter((action) => action.id === 'adapter');
  return (
    <Box {...boxProps}>
      <Text bold aria-label={`Adapters view${focused ? ', focused' : ''}`}>Adapters</Text>
      <Text bold>Pi (read-only)</Text>
      <Text>State: {setup.adapter.state}</Text>
      <Text>Installed Bazframe: {setup.adapter.installedBazframeVersion ?? '(none)'}</Text>
      <Text wrap="truncate-end">Target: {setup.adapter.targetPath}</Text>
      <Text bold>Attention needed:</Text>
      {actions.length === 0
        ? <Text dimColor>  (none)</Text>
        : actions.map((action) => <Text key={action.id} color="yellow" wrap="truncate-end">  - {action.message}</Text>)}
      <Text dimColor>Adapter install, repair, and removal remain CLI-only.</Text>
    </Box>
  );
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
  const repository = setup.repository.kind === 'outside-git'
    ? 'outside Git (inherits global policy)'
    : `${setup.repository.root} (${setup.repository.projectState})`;
  const profile = setup.profile.state === 'ready'
    ? `${setup.profile.id} (ready; ${setup.profile.skillCount} direct skills)`
    : setup.profile.state === 'missing'
      ? `${setup.profile.id} (missing)`
      : setup.profile.state === 'unselected'
        ? '(none selected)'
        : `(not used: ${setup.profile.reason})`;
  const actions = setup.correctiveActions.filter((action) => action.id !== 'adapter');
  if (compact) {
    return (
      <Box {...boxProps}>
        {heading}
        <Text wrap="truncate-end">Policy/effective: {setup.globalPolicy.policy}; {behavior}</Text>
        <Text wrap="truncate-end">Current directory: {repository}</Text>
        <Text wrap="truncate-end">Active profile: {profile}</Text>
        <Text>Cache/aliases: {setup.cachedCollisionAliasCount} cached</Text>
        <Text color={actions.length === 0 ? undefined : 'yellow'} wrap="truncate-end">
          Attention: {actions.length === 0 ? '(none)' : actions.map((action) => action.message).join('; ')}
        </Text>
        <Text dimColor>Settings: read-only; no writable settings are defined.</Text>
      </Box>
    );
  }
  return (
    <Box {...boxProps}>
      {heading}
      <Text bold>Policy and current directory</Text>
      <Text>Global policy: {setup.globalPolicy.policy}</Text>
      <Text wrap="truncate-end">Current directory: {repository}</Text>
      <Text>Effective behavior: {behavior}</Text>
      <Text bold>Active profile</Text>
      <Text>{profile}</Text>
      <Text bold>Runtime cache</Text>
      <Text>Cached collision aliases: {setup.cachedCollisionAliasCount}</Text>
      <Text bold>Attention needed</Text>
      {actions.length === 0
        ? <Text dimColor>  (none)</Text>
        : actions.map((action) => <Text key={action.id} color="yellow" wrap="truncate-end">  - {action.message}</Text>)}
      <Text dimColor>Settings are read-only; no writable settings are defined.</Text>
    </Box>
  );
}

function Modal({
  modal,
  busy,
  directoryBrowser,
  browserChoice,
  browserOffset,
  sourceCandidate
}: {
  modal: TuiModal;
  busy: boolean;
  directoryBrowser: DirectoryBrowserSnapshot | undefined;
  browserChoice: number;
  browserOffset: number;
  sourceCandidate: SourceCandidateSummary | undefined;
}) {
  if (modal.kind === 'help') {
    return (
      <FocusedOverlay>
        <Text bold>Keyboard help</Text>
        <Text wrap="truncate-end">1/2/3/4 and [/] open tabs directly. Tab/Shift+Tab cycle focus.</Text>
        <Text wrap="truncate-end">Focused tabs: Left/Right or h/l moves focus; Enter or uppercase L activates.</Text>
        <Text wrap="truncate-end">Body/tree: arrows or hjkl move; PageUp/PageDown/Home/End jump.</Text>
        <Text wrap="truncate-end">Skills: o open, c collapse, Enter/L preview, a add manifest-free source.</Text>
        <Text wrap="truncate-end">Profiles: c create, D duplicate, u activate, R rename, d remove.</Text>
        <Text wrap="truncate-end">H/L mirror Backspace/Enter; editor J/K panes; Available o/c/Left/Right.</Text>
        <Text wrap="truncate-end">r refreshes; q exits. Press Esc or Enter to close.</Text>
      </FocusedOverlay>
    );
  }
  if (modal.kind === 'source-root') {
    return (
      <FocusedOverlay>
        <Text bold wrap="truncate-end">Add source - Absolute root or ~/ path</Text>
        <Text inverse wrap="truncate-start">Path: {modal.value.length === 0 ? ' ' : modal.value}</Text>
        {directoryBrowser === undefined
          ? <Text dimColor>Loading directories...</Text>
          : <>
              <Text dimColor wrap="truncate-end">Current: {directoryBrowser.selectablePath ?? directoryBrowser.resolvedPath}</Text>
              <ScrollableRows
                rows={directoryBrowser.entries}
                offset={browserOffset}
                maxRows={4}
                renderRow={(entry, index) => (
                  <Text key={entry.path} inverse={browserChoice === index} wrap="truncate-end">  {entry.path}</Text>
                )}
              />
            </>}
        <Text bold>Up/Down choose  Enter select/review  Esc back</Text>
      </FocusedOverlay>
    );
  }
  if (modal.kind === 'source-confirm') {
    const blocked = sourceCandidate?.manifest.state !== 'absent';
    return (
      <FocusedOverlay>
        <Text bold color={blocked ? 'red' : 'yellow'}>Add global source {modal.sourceId}</Text>
        <Text wrap="truncate-end">Entered source root: {modal.enteredRoot ?? modal.root}</Text>
        <Text wrap="truncate-end">Canonical source root: {modal.canonicalRoot ?? sourceCandidate?.canonicalRoot}</Text>
        <Text wrap="truncate-end">Scope: snapshot the complete selected tree; no profile reference is added.</Text>
        <Text wrap="truncate-end">Provider input remains provider-owned; snapshots are retained.</Text>
        <Text wrap="truncate-end">Declared builds are unsandboxed and cannot run from this TUI.</Text>
        {blocked
          ? <>
              <Text color="red" wrap="truncate-end">Blocked: {sourceCandidate?.manifest.state === 'invalid' ? sourceCandidate.manifest.diagnostic : 'declared build present'}. Use `bazframe sources add {modal.enteredRoot ?? modal.root}`.</Text>
              <Text bold>n/Esc/Backspace back  y/Enter cannot confirm</Text>
            </>
          : <Text bold>{busy ? 'Working...' : 'y add source  n/Esc/Backspace back  Enter does not confirm'}</Text>}
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
  warningsDismissed,
  compact
}: {
  loading: boolean;
  mutation: string | undefined;
  message: UiMessage | undefined;
  diagnostics: readonly DashboardDiagnostic[];
  warningsDismissed: boolean;
  compact: boolean;
}) {
  const visibleDiagnostics = warningsDismissed
    ? diagnostics.filter((item) => item.severity !== 'warning')
    : diagnostics;
  const diagnostic = message === undefined && mutation === undefined && !loading
    ? visibleDiagnostics[0]
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
  const diagnosticCount = diagnostic !== undefined && visibleDiagnostics.length > 1
    ? ` [1/${visibleDiagnostics.length}]`
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

function routeActionHint(state: TuiState, compact: boolean): string {
  if (state.activeTab === 'skills') {
    return state.skillRoute === 'preview'
      ? 'H or Esc/Backspace back  arrows/PageUp/PageDown scroll  ? help  q quit'
      : `o open  c collapse  Enter/L open or toggle  a add source${compact ? '' : '  r refresh'}  ? help  q quit`;
  }
  if (state.activeTab === 'profiles') {
    return state.profileRoute === 'editor'
      ? 'H/Esc/Backspace back  J/K panes  Available Enter/L/o/c/Left/Right  a add  x remove  ? help  q quit'
      : `L/Enter edit  c create  D duplicate  u activate  R rename  d remove${compact ? '' : '  r refresh'}  ? help  q quit`;
  }
  return `${compact ? '' : 'r refresh  '}? help  q quit`;
}

function profilePaneRows(maxRows: number, compact: boolean): number {
  return compact
    ? Math.max(1, Math.floor((maxRows - 7) / 2))
    : Math.max(3, Math.floor((maxRows - 9) / 2));
}

function skillPreviewContentRows(maxRows: number, breadcrumb: boolean): number {
  return Math.max(1, maxRows - (breadcrumb ? 3 : 2));
}

function directoryChoiceOffset(offset: number, choice: number, count: number): number {
  const maximum = Math.max(0, count - 4);
  let next = Math.max(0, Math.min(maximum, offset));
  if (choice < 0) return next;
  if (choice < next) next = choice;
  else if (choice >= next + 4) next = choice - 3;
  return next;
}

function profileSnapshotSelection(
  snapshot: DashboardSnapshot,
  profile: ProfileSummary,
  expandedAvailableSourceIds: readonly string[],
  viewportRows: ViewportRows,
  openEditor = false
): TuiAction {
  const sources = availableSourcesForProfile(snapshot, profile);
  const availableRowIds = availableRowsFor(
    sources,
    new Set<string>(),
    expandedAvailableSourceIds
  ).map((row) => row.id);
  return {
    type: 'select-profile-snapshot',
    id: profile.id,
    profileIds: snapshot.profiles.map((candidate) => candidate.id),
    includedIds: profile.memberships.map((membership) => membership.id),
    availableRowIds,
    viewportRows,
    openEditor
  };
}

function ScrollableRows<T>({
  rows,
  offset,
  maxRows,
  renderRow,
  empty
}: {
  rows: readonly T[];
  offset: number;
  maxRows: number;
  renderRow: (row: T, absoluteIndex: number) => ReactNode;
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;
  const viewportRows = Math.max(1, Math.floor(maxRows));
  const maximumOffset = Math.max(0, rows.length - viewportRows);
  const effectiveOffset = Math.max(0, Math.min(maximumOffset, Math.floor(offset)));
  const visible = rows.slice(effectiveOffset, effectiveOffset + viewportRows);
  const metrics = scrollbarMetrics(rows.length, viewportRows, effectiveOffset);
  return (
    <Box flexDirection="row" width="100%" overflow="hidden">
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {visible.map((row, index) => renderRow(row, effectiveOffset + index))}
      </Box>
      {metrics === undefined
        ? null
        : <Box width={1} flexShrink={0} flexDirection="column" aria-hidden>
            {Array.from({ length: viewportRows }, (_, index) => (
              <Text key={index}>{index >= metrics.start && index < metrics.start + metrics.size ? '█' : '░'}</Text>
            ))}
          </Box>}
    </Box>
  );
}

function scrollbarMetrics(
  totalRows: number,
  viewportRows: number,
  effectiveOffset: number
): { start: number; size: number } | undefined {
  if (totalRows <= viewportRows) return undefined;
  const size = Math.max(1, Math.min(
    viewportRows,
    Math.round((viewportRows * viewportRows) / totalRows)
  ));
  const travel = viewportRows - size;
  const maximumOffset = totalRows - viewportRows;
  const start = maximumOffset === 0
    ? 0
    : Math.round((effectiveOffset / maximumOffset) * travel);
  return { start, size };
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
  const roots = snapshot.skillRoots ?? snapshot.sources ?? [];
  const skillbook = roots.filter((source) => source.id === 'skillbook');
  const managed = (snapshot.managedSources ?? []).map((source) =>
    roots.find((root) => root.id === source.id) ?? {
      id: source.id,
      label: `${source.source} [${source.health}]`,
      root: source.root,
      artifactWritesSupported: false as const,
      skills: []
    });
  const managedIds = new Set(managed.map((source) => source.id));
  const remaining = roots.filter((source) => source.id !== 'skillbook' && !managedIds.has(source.id));
  return [...skillbook, ...managed, ...remaining].flatMap((source): SourceBrowserRow[] => {
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
  return sourceBrowserRows(snapshot, expandedSourceIds).map((row) => row.id);
}

function owningSourceId(
  snapshot: DashboardSnapshot,
  selectedId: string | undefined
): string | undefined {
  if (selectedId?.startsWith('source:')) return selectedId.slice('source:'.length);
  if (selectedId === undefined) return undefined;
  return (snapshot.skillRoots ?? snapshot.sources ?? [])
    .map((source) => source.id)
    .sort((left, right) => right.length - left.length)
    .find((sourceId) => selectedId.startsWith(`${sourceId}:`));
}

function findBrowserSkill(
  snapshot: DashboardSnapshot,
  selectedId: string | undefined
): SkillSummary | undefined {
  if (selectedId === undefined || selectedId.startsWith('source:')) return undefined;
  return (snapshot.skillRoots ?? snapshot.sources ?? [])
    .flatMap((source) => source.skills)
    .find((skill) => compositeSkillId(skill) === selectedId);
}

function previewLines(contents: string): string[] {
  return contents.split('\n').map((line) => Array.from(line, (character) => {
    if (character === '\t') return '  ';
    const code = character.codePointAt(0)!;
    return code <= 8 || (code >= 11 && code <= 31) || (code >= 127 && code <= 159)
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : character;
  }).join(''));
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
