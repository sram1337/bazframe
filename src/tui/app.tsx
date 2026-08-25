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
  SkillCollectionSummary,
  ProfileSummary,
  SkillGroupSummary,
  SkillSummary,
  SkillPreview,
  LibraryCandidateSummary,
  LibraryInputInspection
} from '../application/tui-service.js';
import type { ChildResult } from '../core/child-process.js';
import { BazframeError } from '../core/errors.js';
import {
  availableRowsFor,
  availableGroupsForProfile,
  availableGroupIdForRow,
  availableGroupRowId,
  initialTuiState,
  isDirectMembershipGroup,
  moveAvailableSelectionByRows,
  moveSelection,
  PROFILE_CREATE_ROW_ID,
  profileRowIds,
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

type LibraryInputState =
  | { state: 'loading' }
  | { state: 'available'; value: LibraryInputInspection }
  | { state: 'error'; message: string };

const MIN_COLUMNS = 60;
const MIN_ROWS = 16;
const TABS: readonly TuiTab[] = ['skills', 'profiles', 'adapters', 'settings'];

export function TuiApp({ service, onExitCode, onForceExit, dimensions }: TuiAppProps) {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp();
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
    | { state: 'loading'; originId: string; skillId: string }
    | { state: 'available'; value: SkillPreview }
    | { state: 'error'; originId: string; skillId: string; message: string }
  >();
  const [libraryInput, setLibraryInput] = useState<LibraryInputState>();
  const [browserChoice, setBrowserChoice] = useState(-1);
  const [browserOffset, setBrowserOffset] = useState(0);
  const [libraryCandidate, setLibraryCandidate] = useState<LibraryCandidateSummary>();
  const snapshotRef = useRef<DashboardSnapshot | undefined>(undefined);
  const previewGeneration = useRef(0);
  const browserGeneration = useRef(0);
  const libraryInspectionGeneration = useRef(0);
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
    setPreview({ state: 'loading', originId: selected.originId, skillId: selected.id });
    void service.loadSkillPreview({ originId: selected.originId, skillId: selected.id })
      .then((value) => {
        if (generation === previewGeneration.current) setPreview({ state: 'available', value });
      })
      .catch((error: unknown) => {
        if (generation === previewGeneration.current) {
          setPreview({
            state: 'error',
            originId: selected.originId,
            skillId: selected.id,
            message: messageFor(error)
          });
        }
      });
  }, [service, snapshot?.revision, state.browserSkillId]);

  useEffect(() => {
    const modal = state.modal;
    const generation = ++browserGeneration.current;
    ++libraryInspectionGeneration.current;
    if (modal?.kind !== 'library-root') {
      setLibraryInput(undefined);
      setBrowserChoice(-1);
      setBrowserOffset(0);
      if (modal?.kind !== 'library-confirm') setLibraryCandidate(undefined);
      return;
    }
    setLibraryInput({ state: 'loading' });
    setBrowserChoice(-1);
    setBrowserOffset(0);
    setLibraryCandidate(undefined);
    void service.inspectLibraryInput(modal.value)
      .then((value) => {
        if (generation === browserGeneration.current) {
          const currentModal = stateRef.current.modal;
          if (
            currentModal?.kind !== 'library-root'
            || currentModal.value !== value.input
          ) return;
          setLibraryInput({ state: 'available', value });
          setBrowserChoice(-1);
          setBrowserOffset(0);
        }
      })
      .catch((error: unknown) => {
        if (generation !== browserGeneration.current) return;
        const currentModal = stateRef.current.modal;
        if (currentModal?.kind !== 'library-root' || currentModal.value !== modal.value) return;
        const text = messageFor(error);
        setLibraryInput({ state: 'error', message: text });
        setMessage({ tone: 'error', text });
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

  const editInExternalEditor = useCallback(async (
    label: string,
    operation: () => Promise<ChildResult>
  ) => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    setMutation(label);
    setMessage({ tone: 'info', text: 'Opening external editor...' });
    try {
      await waitUntilRenderFlush();
      let result: ChildResult | undefined;
      await suspendTerminal(async () => {
        result = await operation();
      });
      if (result === undefined) {
        setMessage({ tone: 'error', text: 'Editor did not report an outcome.' });
      } else if (result.signal !== null) {
        setMessage({ tone: 'error', text: `Editor terminated by ${result.signal}.` });
      } else if (result.exitCode !== 0) {
        setMessage({ tone: 'error', text: `Editor exited with status ${result.exitCode ?? 1}.` });
      } else {
        setMessage({
          tone: 'success',
          text: 'Editor exited successfully. Run `/bazframe reload` in an existing Pi session.'
        });
      }
    } catch (error) {
      setMessage({ tone: 'error', text: messageFor(error) });
    } finally {
      await load();
      mutationActive.current = false;
      setMutation(undefined);
    }
    if (exitRequested.current) finishExit(exitRequestedCode.current);
  }, [finishExit, load, suspendTerminal, waitUntilRenderFlush]);

  const selectedProfile = snapshot?.profiles.find(
    (profile) => profile.id === state.selectedProfileId
  );
  const availableGroups = useMemo(
    () => availableGroupsForProfile(snapshot, selectedProfile),
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
    if (modal.kind === 'library-root') {
      const inspectedInput = libraryInput?.state === 'available'
        ? libraryInput.value
        : undefined;
      const directoryBrowser = inspectedInput?.kind === 'directory'
        ? inspectedInput.browser
        : undefined;
      const selectedEntry = browserChoice < 0
        ? undefined
        : directoryBrowser?.entries[browserChoice];
      if (selectedEntry !== undefined) {
        ++libraryInspectionGeneration.current;
        setLibraryCandidate(undefined);
        setLibraryInput(undefined);
        setBrowserChoice(-1);
        setBrowserOffset(0);
        dispatch({
          type: 'open-modal',
          modal: { ...modal, value: selectedEntry.path }
        });
        return;
      }
      const source = inspectedInput?.kind === 'managed-git'
        ? inspectedInput.input
        : directoryBrowser?.selectablePath;
      if (source === undefined) {
        setMessage({
          tone: 'error',
          text: libraryInput?.state === 'error'
            ? libraryInput.message
            : 'Select an existing physical directory or enter a valid managed Git source.'
        });
        return;
      }
      const generation = ++libraryInspectionGeneration.current;
      setLibraryCandidate(undefined);
      void service.inspectLibraryCandidate({ source }).then((candidate) => {
        const currentModal = stateRef.current.modal;
        if (
          generation !== libraryInspectionGeneration.current
          || currentModal?.kind !== 'library-root'
          || currentModal.value !== modal.value
        ) return;
        setLibraryCandidate(candidate);
        dispatch({
          type: 'open-modal',
          modal: {
            kind: 'library-confirm',
            value: '',
            originId: candidate.libraryId,
            root: libraryCandidateAddSource(candidate),
            enteredRoot: libraryCandidateEnteredSource(candidate),
            ...(candidate.kind === 'directory'
              ? { canonicalRoot: candidate.canonicalRoot }
              : {})
          }
        });
      }).catch((error: unknown) => {
        if (generation === libraryInspectionGeneration.current) {
          setMessage({ tone: 'error', text: messageFor(error) });
        }
      });
      return;
    }
    if (modal.kind === 'library-confirm') return;
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
  }, [browserChoice, libraryInput, load, mutation, mutate, service]);

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
    if (modal.kind === 'library-confirm') {
      if (key.escape || key.backspace || input === 'n') {
        clearTransientMessage();
        ++libraryInspectionGeneration.current;
        setLibraryCandidate(undefined);
        dispatch({
          type: 'open-modal',
          modal: {
            kind: 'library-root',
            value: modal.enteredRoot ?? modal.root ?? ''
          }
        });
        return;
      }
      if (input === 'y') {
        clearTransientMessage();
        if (tooSmall) {
          setMessage({ tone: 'error', text: 'Resize to review the full library authorization.' });
          return;
        }
        if (
          libraryCandidate === undefined
          || modal.originId !== libraryCandidate.libraryId
          || modal.root !== libraryCandidateAddSource(libraryCandidate)
          || modal.enteredRoot !== libraryCandidateEnteredSource(libraryCandidate)
          || modal.canonicalRoot !== (libraryCandidate.kind === 'directory'
            ? libraryCandidate.canonicalRoot
            : undefined)
        ) {
          setMessage({ tone: 'error', text: 'Library authorization changed; review it again.' });
          return;
        }
        if (libraryCandidateBlocked(libraryCandidate)) {
          setMessage({
            tone: 'error',
            text: 'Directories with a package manifest must be added with `bazframe packages add`.'
          });
          return;
        }
        void mutate(
          'Add library',
          async () => {
            await service.addLibrary({ source: libraryCandidateAddSource(libraryCandidate) });
          },
          () => {
            setLibraryCandidate(undefined);
            dispatch({ type: 'close-modal' });
          }
        );
      }
      return;
    }
    if (modal.kind === 'library-root' && (key.upArrow || key.downArrow)) {
      const directoryBrowser = libraryInput?.state === 'available'
        && libraryInput.value.kind === 'directory'
        ? libraryInput.value.browser
        : undefined;
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
      if (modal.kind === 'library-root') {
        ++libraryInspectionGeneration.current;
        setLibraryCandidate(undefined);
        setLibraryInput(undefined);
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
      if (modal.kind === 'library-root') {
        ++libraryInspectionGeneration.current;
        setLibraryCandidate(undefined);
        setLibraryInput(undefined);
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
        if (modal.kind === 'library-root') {
          ++libraryInspectionGeneration.current;
          setLibraryCandidate(undefined);
          setLibraryInput(undefined);
          setBrowserChoice(-1);
          setBrowserOffset(0);
        }
        dispatch({ type: 'set-modal-value', value: modal.value + printable });
      }
    }
  }, [clearTransientMessage, libraryInput, mutate, service, libraryCandidate, submitModal, tooSmall]);

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
    const vimLeft = !key.ctrl && !key.meta && input === 'h';
    const vimRight = !key.ctrl && !key.meta && input === 'l';
    const vimUp = !key.ctrl && !key.meta && input === 'k';
    const vimDown = !key.ctrl && !key.meta && input === 'j';
    const skillDetailBack = currentState.focusedRegion === 'body'
      && currentState.activeTab === 'skills'
      && currentState.skillRoute !== 'browser'
      && (key.leftArrow || vimLeft);
    const routeBack = key.escape || key.backspace || input === 'H' || skillDetailBack;
    const routeForward = key.return || input === 'L';
    if (routeBack) {
      if (currentState.activeTab === 'profiles' && currentState.profileRoute === 'editor') {
        clearTransientMessage();
        dispatch({ type: 'profile-route', route: 'list' });
        return;
      }
      if (currentState.activeTab === 'skills' && currentState.skillRoute !== 'browser') {
        clearTransientMessage();
        dispatch({ type: 'skill-route', route: 'browser' });
        return;
      }
    }
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
    const currentAvailableGroups = availableGroupsForProfile(currentSnapshot, currentSelectedProfile);
    const currentAvailableRows = availableRowsFor(
      currentAvailableGroups,
      new Set<string>(),
      currentState.expandedAvailableGroupIds
    );
    const currentAvailableRowIds = currentAvailableRows.map((row) => row.id);
    const setAvailableGroupExpansion = (originId: string, expanded: boolean): string[] => {
      const nextExpanded = new Set(currentState.expandedAvailableGroupIds);
      if (expanded) nextExpanded.add(originId);
      else nextExpanded.delete(originId);
      const rowIds = availableRowsFor(
        currentAvailableGroups,
        new Set<string>(),
        [...nextExpanded]
      ).map((row) => row.id);
      dispatch({
        type: 'toggle-available-group',
        id: originId,
        expanded,
        rowIds,
        viewportRows: viewportRowsRef.current.available
      });
      return rowIds;
    };

    if (currentState.activeTab === 'profiles') {
      if (currentState.profileRoute === 'list') {
        const ids = profileRowIds(currentSnapshot.profiles);
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
                currentState.expandedAvailableGroupIds,
                viewportRowsRef.current
              ));
          return;
        }
        const profileListForward = routeForward || key.rightArrow || vimRight;
        if (profileListForward && currentState.selectedProfileId === PROFILE_CREATE_ROW_ID) {
          clearTransientMessage();
          dispatch({ type: 'open-modal', modal: { kind: 'create', value: '' } });
          return;
        }
        if (profileListForward && currentSelectedProfile !== undefined) {
          clearTransientMessage();
          dispatch(profileSnapshotSelection(
            currentSnapshot,
            currentSelectedProfile,
            currentState.expandedAvailableGroupIds,
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
        if (input === 'x' && currentSelectedProfile !== undefined) {
          clearTransientMessage();
          openRemoveConfirmation(currentSelectedProfile);
          return;
        }
        if (input === 'f' && currentSelectedProfile !== undefined) {
          clearTransientMessage();
          void mutate(
            currentSelectedProfile.favorite ? 'Unfavorite profile' : 'Favorite profile',
            () => service.toggleProfileFavorite(currentSelectedProfile.id)
          );
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
        const selectedGroupId = availableGroupIdForRow(
          currentAvailableRowIds,
          currentState.availableSkillId
        );
        if (selectedAvailableRow?.kind === 'group' && routeForward) {
          clearTransientMessage();
          setAvailableGroupExpansion(selectedAvailableRow.originId, !selectedAvailableRow.expanded);
          return;
        }
        if (selectedAvailableRow?.kind === 'group' && (key.rightArrow || vimRight)) {
          clearTransientMessage();
          if (!selectedAvailableRow.expanded) {
            setAvailableGroupExpansion(selectedAvailableRow.originId, true);
          } else {
            const firstChild = currentAvailableRows.find(
              (row) => row.kind === 'skill' && row.originId === selectedAvailableRow.originId
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
        if ((key.leftArrow || vimLeft) && selectedGroupId !== undefined) {
          clearTransientMessage();
          if (selectedAvailableRow?.kind === 'skill') {
            dispatch({
              type: 'select-available',
              id: availableGroupRowId(selectedGroupId),
              ids: currentAvailableRowIds,
              viewportRows: viewportRowsRef.current.available
            });
            return;
          }
          if (selectedAvailableRow?.kind === 'group' && selectedAvailableRow.expanded) {
            setAvailableGroupExpansion(selectedGroupId, false);
            return;
          }
        }
        if (input === 'o' && selectedGroupId !== undefined) {
          clearTransientMessage();
          setAvailableGroupExpansion(selectedGroupId, true);
          return;
        }
        if (input === 'c' && selectedGroupId !== undefined) {
          clearTransientMessage();
          setAvailableGroupExpansion(selectedGroupId, false);
          return;
        }
      }
      if (key.leftArrow || vimLeft) {
        clearTransientMessage();
        dispatch({ type: 'profile-route', route: 'list' });
        return;
      }
      if (input === 'e' && currentSelectedProfile !== undefined) {
        clearTransientMessage();
        void editInExternalEditor(
          'Edit profile instructions',
          () => service.editProfileInstructions(currentSelectedProfile.id)
        );
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
        const selectedGroupId = selectedRow?.originId;
        if (
          selectedGroupId !== undefined
          && !isDirectMembershipGroup(currentSnapshot, selectedGroupId)
        ) {
          const collection = currentSnapshot.collections?.find((item) => item.key === selectedGroupId);
          setMessage(collection === undefined
            ? { tone: 'info', text: 'This group is browse-only in the TUI.' }
            : { tone: 'info', text: `Attach the whole ${collection.kind} with \`bazframe profile ${collection.kind === 'library' ? 'libraries' : 'packages'} add ${collection.id} --profile ${currentSelectedProfile.id}\`.` });
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
              originId: selectedRow.skill.originId,
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
        if (membership?.manageable === true && membership.originId !== undefined) {
          void mutate(
            'Remove membership',
            () => service.removeMembership(currentSelectedProfile.id, {
              membershipId: membership.membershipId,
              originId: membership.originId!,
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
      if (input === 'e' && (!compact || currentState.skillRoute === 'preview')) {
        const selectedSkill = findBrowserSkill(currentSnapshot, currentState.browserSkillId);
        if (selectedSkill !== undefined) {
          clearTransientMessage();
          if (selectedSkill.originId === 'default') {
            void editInExternalEditor(
              'Edit skill definition',
              () => service.editSkillDefinition({
                originId: selectedSkill.originId,
                skillId: selectedSkill.id
              })
            );
          } else if (selectedSkill.originId.startsWith('library:') || selectedSkill.originId.startsWith('package:')) {
            const [kind, id] = selectedSkill.originId.split(':');
            setMessage({ tone: 'info', text: `Edit provider input, then run \`bazframe ${kind === 'library' ? 'libraries update' : 'packages build'} ${id}\`. This Skill is from an immutable snapshot.` });
          }
          return;
        }
      }
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
      if (currentState.skillRoute === 'object-details') return;
      if (input === 'a') {
        clearTransientMessage();
        setLibraryCandidate(undefined);
        dispatch({ type: 'open-modal', modal: { kind: 'library-root', value: '' } });
        return;
      }
      const rows = skillBrowserRows(currentSnapshot, currentState.expandedSkillGroupIds);
      const ids = rows.map((row) => row.id);
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
      const owner = owningSkillGroupId(currentSnapshot, currentState.browserSkillId);
      if (input === 'o' && owner !== undefined) {
        clearTransientMessage();
        dispatch({ type: 'toggle-skill-group', id: owner, expanded: true });
        return;
      }
      if (input === 'c' && owner !== undefined) {
        clearTransientMessage();
        if (!currentState.browserSkillId?.startsWith('collection:')) {
          dispatch({
            type: 'select-browser-skill',
            id: `collection:${owner}`,
            ids,
            viewportRows: viewportRowsRef.current.skillsBrowser
          });
        }
        dispatch({ type: 'toggle-skill-group', id: owner, expanded: false });
        return;
      }
      const groupPrefix = 'collection:';
      if (currentState.browserSkillId?.startsWith(groupPrefix)) {
        const originId = currentState.browserSkillId.slice(groupPrefix.length);
        if (routeForward) {
          clearTransientMessage();
          if ((currentSnapshot.collections ?? []).some((item) => item.key === originId)) {
            dispatch({ type: 'skill-route', route: 'object-details' });
          } else {
            dispatch({ type: 'toggle-skill-group', id: originId });
          }
        } else if (key.rightArrow || vimRight) {
          clearTransientMessage();
          if (currentState.expandedSkillGroupIds.includes(originId)) {
            const firstSkill = (currentSnapshot.skillGroups ?? []).find(
              (group) => group.id === originId
            )?.skills[0];
            if (firstSkill !== undefined) {
              dispatch({
                type: 'select-browser-skill',
                id: compositeSkillId(firstSkill),
                ids,
                viewportRows: viewportRowsRef.current.skillsBrowser
              });
            }
          } else dispatch({ type: 'toggle-skill-group', id: originId, expanded: true });
        } else if (key.leftArrow || vimLeft) {
          clearTransientMessage();
          dispatch({ type: 'toggle-skill-group', id: originId, expanded: false });
        }
        return;
      }
      if (
        (routeForward || key.rightArrow || vimRight)
        && currentState.browserSkillId !== undefined
      ) {
        clearTransientMessage();
        dispatch({ type: 'skill-route', route: 'preview' });
        return;
      }
      if ((key.leftArrow || vimLeft) && owner !== undefined) {
        clearTransientMessage();
        dispatch({
          type: 'select-browser-skill',
          id: `collection:${owner}`,
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
        libraryCandidate={libraryCandidate}
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
              libraryInput={libraryInput}
              browserChoice={browserChoice}
              browserOffset={browserOffset}
              libraryCandidate={libraryCandidate}
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
              : compact && state.skillRoute === 'object-details' && state.browserSkillId?.startsWith('collection:')
                ? <CollectionDetails
                    snapshot={snapshot}
                    originId={state.browserSkillId.slice('collection:'.length)}
                    breadcrumb
                    compact
                    focused={state.focusedRegion === 'body'}
                  />
              : <SkillsMasterDetail
                  snapshot={snapshot}
                  selectedId={state.browserSkillId}
                  offset={state.skillsBrowserOffset}
                  expandedSkillGroupIds={state.expandedSkillGroupIds}
                  preview={preview}
                  previewOffset={state.skillPreviewOffset}
                  focused={state.focusedRegion === 'body'}
                  previewFocused={state.skillRoute !== 'browser'}
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
                        focus={state.focusedRegion === 'body' ? 'active' : 'inactive'}
                        maxRows={bodyRows - 4}
                        createAlignment="left"
                      />
                    : <ProfileEditor
                        profile={selectedProfile}
                        availableGroups={availableGroups}
                        expandedAvailableGroupIds={state.expandedAvailableGroupIds}
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
                      availableGroups={availableGroups}
                      expandedAvailableGroupIds={state.expandedAvailableGroupIds}
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
                ? <Adapters status={snapshot?.adapterStatus} focused={state.focusedRegion === 'body'} />
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
  libraryCandidate
}: {
  columns: number;
  rows: number;
  modal: TuiModal | undefined;
  busy: boolean;
  libraryCandidate: LibraryCandidateSummary | undefined;
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

  if (modal.kind.startsWith('library-')) {
    const blocked = libraryCandidateBlocked(libraryCandidate);
    const step = modal.kind === 'library-root'
      ? 'Physical library root or managed Git source'
      : `Review ${modal.originId ?? '(unknown library)'}`;
    return (
      <Box
        width={columns}
        height={rows}
        borderStyle="bold"
        borderColor={focusBorderColor(true)}
        flexDirection="column"
        overflow="hidden"
      >
        <Text bold>Add library</Text>
        <Text wrap="truncate-end">{step}</Text>
        {modal.kind === 'library-confirm'
          ? <>
              <Text wrap="truncate-end">
                {libraryCandidate?.kind === 'managed-git'
                  ? `Source: ${libraryCandidate.enteredSource}`
                  : `Entered: ${modal.enteredRoot ?? modal.root}`}
              </Text>
              <Text wrap="truncate-end">
                {libraryCandidate?.kind === 'managed-git'
                  ? `Remote: ${libraryCandidate.remote}`
                  : `Canonical: ${modal.canonicalRoot ?? '(unavailable)'}`}
              </Text>
              <Text color={blocked ? 'red' : 'yellow'} wrap="truncate-end">
                {blocked ? 'Package manifest present; use `bazframe packages add`.' : 'Resize to authorize; y is disabled here.'}
              </Text>
              <Text bold>n/Esc/Backspace back</Text>
            </>
          : <>
              <Text inverse wrap="truncate-start">Input: {modal.value.length === 0 ? ' ' : modal.value}</Text>
              <Text bold>Enter next  Esc back/cancel</Text>
            </>}
        <Text color="yellow" wrap="truncate-end">{sizeLine}</Text>
        <Text bold>Final library authorization is disabled at this size.</Text>
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

type MasterPaneFocus = 'active' | 'parent' | 'inactive';

function formatProfileReferences(references: ProfileSummary['libraryReferences']): string {
  if (references === undefined || references.length === 0) return '(none)';
  return references.map((reference) => reference.availability === 'available' ? reference.id : `${reference.id} [unavailable: ${reference.diagnostic ?? 'unknown failure'}]`).join(', ');
}

function ProfilesList({
  profiles,
  selectedId,
  offset,
  focus,
  maxRows,
  createAlignment
}: {
  profiles: readonly ProfileSummary[];
  selectedId: string | undefined;
  offset: number;
  focus: MasterPaneFocus;
  maxRows: number;
  createAlignment: 'left' | 'right';
}) {
  const active = focus === 'active';
  const parent = focus === 'parent';
  const selectionVisible = active || parent;
  const contextLabel = active ? ', active and focused' : parent ? ', parent context' : '';
  const rows: readonly (ProfileSummary | { id: typeof PROFILE_CREATE_ROW_ID })[] = [
    { id: PROFILE_CREATE_ROW_ID },
    ...profiles
  ];
  return (
    <Box
      borderStyle={selectionVisible ? 'bold' : 'classic'}
      borderColor={focusBorderColor(active)}
      borderDimColor={!active}
      flexDirection="column"
      width="100%"
      paddingX={1}
    >
      <Text bold aria-label={`Profiles list${contextLabel}`}>
        Profiles
      </Text>
      <ScrollableRows
        rows={rows}
        offset={offset}
        maxRows={maxRows}
        renderRow={(profile) => !('active' in profile)
          ? <Box key={profile.id} width="100%" justifyContent={createAlignment === 'right' ? 'flex-end' : 'flex-start'}>
              <Text
                inverse={active && profile.id === selectedId}
                bold={selectionVisible && profile.id === selectedId}
                dimColor={parent && profile.id === selectedId}
                wrap="truncate-end"
                aria-label={`Create new profile${profile.id === selectedId && selectionVisible ? active ? ', active selection' : ', parent selection' : ''}`}
              >
                + Create New Profile
              </Text>
            </Box>
          : <Box key={profile.id} width="100%" justifyContent="space-between">
              <Text
                inverse={active && profile.id === selectedId}
                bold={selectionVisible && profile.id === selectedId}
                dimColor={parent && profile.id === selectedId}
                wrap="truncate-end"
                aria-label={`Profile ${profile.id}${profile.active ? ', current' : ''}${profile.favorite ? ', favorite' : ''}${profile.id === selectedId && selectionVisible ? active ? ', active selection' : ', parent selection' : ''}, ${profile.memberships.length} skills`}
              >
                {profile.active ? '▶' : profile.favorite ? '★' : ' '} {profile.id}
              </Text>
              <Text
                inverse={active && profile.id === selectedId}
                bold={selectionVisible && profile.id === selectedId}
                dimColor={parent && profile.id === selectedId}
              >
                {profile.memberships.length}
              </Text>
            </Box>}
      />
    </Box>
  );
}

function ProfileEditor({
  profile,
  availableGroups,
  expandedAvailableGroupIds,
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
  availableGroups: readonly SkillGroupSummary[];
  expandedAvailableGroupIds: readonly string[];
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
        aria-label={`${breadcrumb ? 'Back to Profiles list, ' : ''}Profile ${profile.id}${profile.active ? ', current' : ''}${profile.favorite ? ', favorite' : ''}, editor`}
      >
        {breadcrumb ? '<- Profiles / ' : 'Profiles / '}{profile.active ? '▶ ' : profile.favorite ? '★ ' : ''}{profile.id}{profile.active ? ' [active]' : ''}
      </Text>
      {compact
        ? null
        : <Text dimColor wrap="truncate-end">
            {profile.membershipDiagnostic ?? profile.directory}
          </Text>}
      {compact ? null : <Text wrap="truncate-end">Referenced Libraries: {formatProfileReferences(profile.libraryReferences)} (read-only)</Text>}
      {compact ? null : <Text wrap="truncate-end">Referenced Packages: {formatProfileReferences(profile.packageReferences)} (read-only)</Text>}
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
        groups={availableGroups}
        expandedSkillGroupIds={expandedAvailableGroupIds}
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
            bold={focused && membership.id === selectedId}
            wrap="truncate-end"
            aria-label={`${membership.skillId}, ${membership.manageable ? 'managed' : 'unmanaged'}${focused && membership.id === selectedId ? ', active selection' : ''}`}
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
  groups,
  expandedSkillGroupIds,
  selectedId,
  offset,
  focused,
  maxRows
}: {
  title: string;
  groups: readonly SkillGroupSummary[];
  expandedSkillGroupIds: readonly string[];
  selectedId: string | undefined;
  offset: number;
  focused: boolean;
  maxRows: number;
}) {
  const rows = availableRowsFor(groups, new Set<string>(), expandedSkillGroupIds);
  const skillCount = groups.reduce((count, group) => count + group.skills.length, 0);
  const labels = new Map(groups.map((group) => [group.id, group.label]));
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
        renderRow={(row) => row.kind === 'group'
          ? <Text
              key={row.id}
              inverse={focused && row.id === selectedId}
              bold
              wrap="truncate-end"
              aria-label={`Available group ${row.label}, ${row.expanded ? 'expanded' : 'collapsed'}${focused && row.id === selectedId ? ', active selection' : ''}, ${row.root}`}
            >
              {row.expanded ? '[-]' : '[+]'}{' '}{row.label}
            </Text>
          : <Text
              key={row.id}
              inverse={focused && row.id === selectedId}
              bold={focused && row.id === selectedId}
              wrap="truncate-end"
              aria-label={`Available skill ${row.skill.id}, origin ${row.skill.originId}${focused && row.id === selectedId ? ', active selection' : ''}`}
            >
              {maxRows === 1 ? `[${labels.get(row.originId) ?? row.originId}] ` : '  '}{row.skill.id}
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
  availableGroups,
  expandedAvailableGroupIds,
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
  availableGroups: readonly SkillGroupSummary[];
  expandedAvailableGroupIds: readonly string[];
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
          focus={focused ? editing ? 'parent' : 'active' : 'inactive'}
          maxRows={maxRows - 4}
          createAlignment="right"
        />
      </Box>
      <Box width="64%" paddingLeft={1} overflow="hidden">
        <ProfileEditor
          profile={profile}
          availableGroups={availableGroups}
          expandedAvailableGroupIds={expandedAvailableGroupIds}
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
  expandedSkillGroupIds,
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
  expandedSkillGroupIds: readonly string[];
  preview: { state: 'loading'; originId: string; skillId: string }
    | { state: 'available'; value: SkillPreview }
    | { state: 'error'; originId: string; skillId: string; message: string }
    | undefined;
  previewOffset: number;
  focused: boolean;
  previewFocused: boolean;
  maxRows: number;
  previewContentRows: number;
  compact: boolean;
}) {
  if (compact) {
    return <SkillsBrowser snapshot={snapshot} selectedId={selectedId} offset={offset} expandedSkillGroupIds={expandedSkillGroupIds} focus={focused ? 'active' : 'inactive'} maxRows={maxRows} />;
  }
  return (
    <Box flexDirection="row" width="100%" height="100%">
      <Box width="46%" overflow="hidden">
        <SkillsBrowser
          snapshot={snapshot}
          selectedId={selectedId}
          offset={offset}
          expandedSkillGroupIds={expandedSkillGroupIds}
          focus={focused ? previewFocused ? 'parent' : 'active' : 'inactive'}
          maxRows={maxRows}
        />
      </Box>
      <Box width="54%" paddingLeft={1} overflow="hidden">
        {selectedId?.startsWith('collection:')
          ? <CollectionDetails snapshot={snapshot} originId={selectedId.slice('collection:'.length)} focused={focused && previewFocused} />
          : <SkillPreviewPane preview={preview} offset={previewOffset} contentRows={previewContentRows} focused={focused && previewFocused} />}
      </Box>
    </Box>
  );
}

function CollectionDetails({
  snapshot,
  originId,
  breadcrumb = false,
  compact = false,
  focused = false
}: {
  snapshot: DashboardSnapshot | undefined;
  originId: string;
  breadcrumb?: boolean;
  compact?: boolean;
  focused?: boolean;
}) {
  if (snapshot === undefined) return <LoadingView title="Library/package details" message="Loading object details..." />;
  const managed = snapshot.collections?.find((item) => item.key === originId);
  const root = (snapshot.skillGroups ?? []).find((group) => group.id === originId);
  if (managed !== undefined) {
    return (
      <Box borderStyle={focused ? 'bold' : 'classic'} borderColor={focusBorderColor(focused)} borderDimColor={!focused} flexDirection="column" paddingX={1}>
        <Text bold aria-label={`${breadcrumb ? 'Back to Skills browser, ' : ''}${collectionAccessibilityLabel(managed, true)}${focused ? ', active and focused' : ''}`}>{breadcrumb ? '<- Skills / ' : ''}{managed.kind === 'library' ? 'Library' : 'Package'}: {managed.id}</Text>
        {compact
          ? <>
              <Text>Health: {managed.health}; {managed.skillCount} Skills; references: {managed.referenceCount}</Text>
              <Text wrap="truncate-end">Provider input: {managed.root}</Text>
              <Text wrap="truncate-end">Activated digest: sha256:{managed.digest}</Text>
              <Text>Artifact root: {managed.artifactRoot ?? '.'}; Skills root: {managed.skillsRoot}</Text>
              <Text>{managed.kind === 'library' ? 'Update' : 'Build'}: {managed.refreshAvailability} (CLI only)</Text>
            </>
          : <>
              <Text>Health: {managed.health}</Text>
              <Text>{managed.skillCount} Skills</Text>
              <Text>Profile references: {managed.referenceCount}</Text>
              <Text wrap="truncate-end">Provider input: {managed.root}</Text>
              <Text wrap="truncate-end">Activated digest: sha256:{managed.digest}</Text>
              <Text>Artifact root: {managed.artifactRoot ?? '.'}</Text>
              <Text>Skills root: {managed.skillsRoot}</Text>
              <Text>{managed.kind === 'library' ? 'Update' : 'Build'}: {managed.refreshAvailability} (CLI only)</Text>
              {managed.diagnostics.length === 0
                ? <Text dimColor>Diagnostics: (none)</Text>
                : managed.diagnostics.map((item, index) => <Text key={index} color="red" wrap="truncate-end">! {item}</Text>)}
            </>}
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
        <Text dimColor>Provider-owned; Bazframe artifact lifecycle is unavailable. Skill e hands off to your editor.</Text>
      </Box>
    );
  }
  return <Text>Library/package object unavailable.</Text>;
}

function SkillPreviewPane({
  preview,
  offset,
  contentRows,
  focused,
  breadcrumb = false
}: {
  preview: { state: 'loading'; originId: string; skillId: string }
    | { state: 'available'; value: SkillPreview }
    | { state: 'error'; originId: string; skillId: string; message: string }
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
      <Text bold aria-label={`${breadcrumb ? 'Back to Skills browser, ' : ''}${title}${focused ? ', active and focused' : ''}`}>{title}</Text>
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
  expandedSkillGroupIds,
  focus,
  maxRows
}: {
  snapshot: DashboardSnapshot | undefined;
  selectedId: string | undefined;
  offset: number;
  expandedSkillGroupIds: readonly string[];
  focus: MasterPaneFocus;
  maxRows: number;
}) {
  const active = focus === 'active';
  const parent = focus === 'parent';
  const selectionVisible = active || parent;
  const contextLabel = active ? ', active and focused' : parent ? ', parent context' : '';
  if (snapshot === undefined) {
    return (
      <Box
        borderStyle={selectionVisible ? 'bold' : 'classic'}
        borderColor={focusBorderColor(active)}
        borderDimColor={!active}
        flexDirection="column"
        paddingX={1}
        width="100%"
      >
        <Text bold aria-label={`Skills browser${contextLabel}`}>
          Skills
        </Text>
        <Text>Loading skills...</Text>
      </Box>
    );
  }
  const rows = skillBrowserRows(snapshot, expandedSkillGroupIds);
  return (
    <Box
      borderStyle={selectionVisible ? 'bold' : 'classic'}
      borderColor={focusBorderColor(active)}
      borderDimColor={!active}
      flexDirection="column"
      paddingX={1}
      width="100%"
    >
      <Text bold aria-label={`Skills browser${contextLabel}`}>
        Skills
      </Text>
      <ScrollableRows
        rows={rows}
        offset={offset}
        maxRows={maxRows}
        empty={<Text dimColor>No added Skills, libraries, or packages are available.</Text>}
        renderRow={(row) => row.kind === 'object'
          ? <Text
              key={row.id}
              inverse={active && row.id === selectedId}
              bold
              dimColor={parent && row.id === selectedId}
              wrap="truncate-end"
              aria-label={`${row.objectKindLabel === 'Added Skills' ? row.label : `${row.objectKindLabel} ${row.label}`}, ${row.health}, ${row.skillCount} Skills, ${row.references}, ${row.digest}, root ${row.root}, ${row.expanded ? 'expanded' : 'collapsed'}${row.id === selectedId && selectionVisible ? active ? ', active selection' : ', parent selection' : ''}`}
            >
              {row.expanded ? '[-]' : '[+]'}{' '}{row.objectKindLabel === 'Added Skills'
                ? `${row.label} — ${row.skillCount} Skills; ${row.root}`
                : `${row.objectKindLabel} ${row.label} — ${row.health}; ${row.skillCount} Skills; ${row.references}; ${row.digest}; ${row.root}`}
            </Text>
          : <Text
              key={row.id}
              inverse={active && row.id === selectedId}
              bold={selectionVisible && row.id === selectedId}
              dimColor={parent && row.id === selectedId}
              wrap="truncate-end"
              aria-label={`Skill ${row.skillId}, ${row.ownerLabel}${row.id === selectedId && selectionVisible ? active ? ', active selection' : ', parent selection' : ''}`}
            >
                {'  '}{row.skillId}
            </Text>}
      />
    </Box>
  );
}

export function collectionAccessibilityLabel(collection: SkillCollectionSummary, selected: boolean): string {
  const references = collection.referenceCount === 'unknown' ? 'profile reference count unknown' : `${collection.referenceCount} profile references`;
  return `${collection.kind === 'library' ? 'Library' : 'Package'} ${collection.id}, ${collection.health}, ${collection.skillCount} Skills, ${references}, digest sha256:${collection.digest}, root ${collection.root}${selected ? ', selected' : ''}`;
}

function Adapters({
  status,
  focused
}: {
  status: DashboardSnapshot['adapterStatus'] | undefined;
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
  const actions = setup.correctiveActions;
  return (
    <Box {...boxProps}>
      <Text bold aria-label={`Adapters view${focused ? ', focused' : ''}`}>Adapters</Text>
      <Text bold>Pi (read-only)</Text>
      <Text>State: {setup.adapter.state}</Text>
      <Text>Installed Bazframe: {setup.adapter.installedBazframeVersion ?? '(none)'}</Text>
      <Text wrap="truncate-end">Target: {setup.adapter.targetPath}</Text>
      {setup.setupDiagnostic === undefined
        ? null
        : <Text color="yellow" wrap="truncate-end">Setup status unavailable; adapter state shown independently.</Text>}
      <Text bold>Attention needed:</Text>
      {setup.setupDiagnostic !== undefined
        ? <Text color="yellow">  (requires setup status)</Text>
        : actions.length === 0
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
    ? `${setup.profile.id} (ready; ${setup.profile.skillCount} Skills)`
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
  libraryInput,
  browserChoice,
  browserOffset,
  libraryCandidate
}: {
  modal: TuiModal;
  busy: boolean;
  libraryInput: LibraryInputState | undefined;
  browserChoice: number;
  browserOffset: number;
  libraryCandidate: LibraryCandidateSummary | undefined;
}) {
  if (modal.kind === 'help') {
    return (
      <FocusedOverlay>
        <Text bold>Keyboard help</Text>
        <Text wrap="truncate-end">1/2/3/4 and [/] open tabs directly. Tab/Shift+Tab cycle focus.</Text>
        <Text wrap="truncate-end">Focused tabs: Left/Right or h/l moves focus; Enter or uppercase L activates.</Text>
        <Text wrap="truncate-end">Body/tree: arrows or hjkl move; PageUp/PageDown/Home/End jump.</Text>
        <Text wrap="truncate-end">Skills: Right/l/Enter preview; Left/h back; o/c group; e edits live Added Skills; a adds library.</Text>
        <Text wrap="truncate-end">Profiles: list f favorite, x remove, d inert; details x removes membership; Right/l/Enter opens.</Text>
        <Text wrap="truncate-end">Managed snapshots are immutable. Uppercase H/L remain Backspace/Enter aliases; J/K jumps profile panes.</Text>
        <Text wrap="truncate-end">r refreshes; q exits. Press Esc or Enter to close.</Text>
      </FocusedOverlay>
    );
  }
  if (modal.kind === 'library-root') {
    const directoryBrowser = libraryInput?.state === 'available'
      && libraryInput.value.kind === 'directory'
      ? libraryInput.value.browser
      : undefined;
    const managedGit = libraryInput?.state === 'available'
      && libraryInput.value.kind === 'managed-git'
      ? libraryInput.value
      : undefined;
    return (
      <FocusedOverlay>
        <Text bold wrap="truncate-end">Add library - Absolute path, ~/ path, or managed Git source</Text>
        <Text inverse wrap="truncate-start">Source: {modal.value.length === 0 ? ' ' : modal.value}</Text>
        {libraryInput === undefined || libraryInput.state === 'loading'
          ? <Text dimColor>Inspecting source...</Text>
          : libraryInput.state === 'error'
            ? <Text color="red" wrap="truncate-end">Source unavailable: {libraryInput.message}</Text>
            : managedGit !== undefined
              ? <>
                  <Text wrap="truncate-end">Managed Git library: {managedGit.libraryId}</Text>
                  <Text dimColor wrap="truncate-end">Remote: {managedGit.remote}</Text>
                </>
              : directoryBrowser === undefined
                ? <Text color="red">Source inspection returned no usable input.</Text>
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
        <Text bold>Up/Down choose  Enter review  Esc back</Text>
      </FocusedOverlay>
    );
  }
  if (modal.kind === 'library-confirm') {
    const blocked = libraryCandidateBlocked(libraryCandidate);
    const managedGit = libraryCandidate?.kind === 'managed-git' ? libraryCandidate : undefined;
    return (
      <FocusedOverlay>
        <Text bold color={blocked ? 'red' : 'yellow'}>Add library {modal.originId}</Text>
        {managedGit === undefined
          ? <>
              <Text wrap="truncate-end">Entered library root: {modal.enteredRoot ?? modal.root}</Text>
              <Text wrap="truncate-end">Canonical library root: {modal.canonicalRoot}</Text>
              <Text wrap="truncate-end">Scope: snapshot the complete selected tree; no profile reference is added.</Text>
              <Text wrap="truncate-end">Provider input remains provider-owned; snapshots are retained.</Text>
            </>
          : <>
              <Text wrap="truncate-end">Managed Git source: {managedGit.enteredSource}</Text>
              <Text wrap="truncate-end">Remote: {managedGit.remote}</Text>
              <Text wrap="truncate-end">Scope: acquire, validate, and snapshot this library; no profile reference is added.</Text>
              <Text wrap="truncate-end">Network access may use configured Git or GitHub authentication.</Text>
            </>}
        <Text wrap="truncate-end">No provider code runs; package builds remain CLI-only.</Text>
        {blocked
          ? <>
              <Text color="red" wrap="truncate-end">Blocked: package manifest present. Use `bazframe packages add {modal.enteredRoot ?? modal.root}`.</Text>
              <Text bold>n/Esc/Backspace back  y/Enter cannot confirm</Text>
            </>
          : <Text bold>{busy ? 'Working...' : 'y add library  n/Esc/Backspace back  Enter does not confirm'}</Text>}
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
      ? 'Left/h back  e edit live skill  Up/Down/Page scroll  Esc/Backspace/H back  ? help  q quit'
      : state.skillRoute === 'object-details'
        ? 'Left/h/H/Esc/Backspace back  ? help  q quit'
        : `Enter/L object details  Right/l hierarchy  o open  c collapse${compact ? '' : '  e edit live skill'}  a add library${compact ? '' : '  r refresh'}  ? help  q quit`;
  }
  if (state.activeTab === 'profiles') {
    return state.profileRoute === 'editor'
      ? 'Left/h/H/Esc/Backspace back/parent  e instructions  J/K panes  Available Right/l/Enter  a add  x remove  ? help  q quit'
      : `Right/l/Enter/L edit  c create  D duplicate  f favorite  u activate  R rename  x remove${compact ? '' : '  r refresh'}  ? help  q quit`;
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
  expandedAvailableGroupIds: readonly string[],
  viewportRows: ViewportRows,
  openEditor = false
): TuiAction {
  const groups = availableGroupsForProfile(snapshot, profile);
  const availableRowIds = availableRowsFor(
    groups,
    new Set<string>(),
    expandedAvailableGroupIds
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
  return `${skill.originId}:${skill.id}`;
}

type SkillBrowserRow =
  | {
      id: string;
      kind: 'object';
      originId: string;
      objectKindLabel: 'Added Skills' | 'Library' | 'Package';
      label: string;
      root: string;
      health: 'ready' | 'failed';
      skillCount: number;
      references: string;
      digest: string;
      expanded: boolean;
    }
  | { id: string; kind: 'skill'; originId: string; ownerLabel: string; skillId: string };

function skillBrowserRows(
  snapshot: DashboardSnapshot,
  expandedGroupIds: readonly string[]
): SkillBrowserRow[] {
  const roots = snapshot.skillGroups ?? [];
  const added = roots.filter((group) => group.id === 'default');
  const libraries = (snapshot.collections ?? []).filter((item) => item.kind === 'library');
  const packages = (snapshot.collections ?? []).filter((item) => item.kind === 'package');
  const groupRows = (group: SkillGroupSummary, objectKindLabel: 'Added Skills' | 'Library' | 'Package', collection?: SkillCollectionSummary): SkillBrowserRow[] => {
    const expanded = expandedGroupIds.includes(group.id);
    const root = group.canonicalRoot !== undefined && group.canonicalRoot !== group.root
      ? `${group.root} (canonical: ${group.canonicalRoot})`
      : group.root;
    return [{
      id: `collection:${group.id}`, kind: 'object', originId: group.id, objectKindLabel,
      label: objectKindLabel === 'Added Skills' ? 'Added Skills' : collection!.id,
      root: collection?.root ?? root,
      health: collection?.health ?? 'ready',
      skillCount: collection?.skillCount ?? group.skills.length,
      references: collection === undefined
        ? 'live catalog'
        : collection.referenceCount === 'unknown' ? 'references unknown' : `${collection.referenceCount} references`,
      digest: collection === undefined ? 'live' : `sha256:${collection.digest}`,
      expanded
    }, ...(expanded ? group.skills.map((skill) => ({
      id: compositeSkillId(skill),
      kind: 'skill' as const,
      originId: group.id,
      ownerLabel: objectKindLabel === 'Added Skills' ? 'Added Skills' : `${objectKindLabel} ${collection!.id}`,
      skillId: skill.id
    })) : [])];
  };
  const collectionRows = (collection: SkillCollectionSummary): SkillBrowserRow[] => {
    const group = roots.find((item) => item.id === collection.key) ?? {
      id: collection.key, label: collection.id, root: collection.root,
      artifactWritesSupported: false as const, skills: []
    };
    return groupRows(group, collection.kind === 'library' ? 'Library' : 'Package', collection);
  };
  return [
    ...added.flatMap((group) => groupRows(group, 'Added Skills')),
    ...libraries.flatMap(collectionRows),
    ...packages.flatMap(collectionRows)
  ];
}

function owningSkillGroupId(
  snapshot: DashboardSnapshot,
  selectedId: string | undefined
): string | undefined {
  if (selectedId?.startsWith('collection:')) return selectedId.slice('collection:'.length);
  if (selectedId === undefined) return undefined;
  return (snapshot.skillGroups ?? [])
    .map((group) => group.id)
    .sort((left, right) => right.length - left.length)
    .find((originId) => selectedId.startsWith(`${originId}:`));
}

function findBrowserSkill(
  snapshot: DashboardSnapshot,
  selectedId: string | undefined
): SkillSummary | undefined {
  if (selectedId === undefined || selectedId.startsWith('collection:')) return undefined;
  return (snapshot.skillGroups ?? [])
    .flatMap((group) => group.skills)
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

function libraryCandidateAddSource(candidate: LibraryCandidateSummary): string {
  return candidate.kind === 'managed-git' ? candidate.enteredSource : candidate.canonicalRoot;
}

function libraryCandidateEnteredSource(candidate: LibraryCandidateSummary): string {
  return candidate.kind === 'managed-git' ? candidate.enteredSource : candidate.enteredRoot;
}

function libraryCandidateBlocked(candidate: LibraryCandidateSummary | undefined): boolean {
  return candidate === undefined
    || (candidate.kind === 'directory' && candidate.packageManifest.state !== 'absent');
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
