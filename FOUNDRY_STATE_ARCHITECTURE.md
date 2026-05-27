# Foundry Build State Management — Architecture Proposal

**Date:** April 2026  
**Status:** Proposed  
**Related:** `src/hooks/useBuildDock.tsx`, `FoundryModal.tsx`, `FoundryPage.tsx`, `AGENTS.md` (React setState anti-pattern + previous cleanup fixes)

---

## 1. Current Problems (As of the 2026 Minimize + Visibility Fixes)

The Foundry build UI state has become increasingly difficult to maintain:

- **Too many imperative refs** for coordination (`lastBuildIdRef`, `closedRef`, `rehydratingRef`, `hasRehydratedRef`, `openingBuildRef`).
- **Race-prone effect interactions**: `openBuildModal` deliberately calls `setBuildProgress(null)`, which triggers the dock sync effect, which then calls the async `rehydrateFromStatus()`, which can immediately undo the modal the user just opened.
- **Implicit state machine**: Backend phases (`Configuring`, `WaitingForConfirm`, `Building`, ...) are turned into ad-hoc frontend strings and flags.
- **Split sources of truth**: `FoundryPage` polls `foundry_status` into `activeBuild`, while `FoundryProvider` maintains `buildProgress` + `foundryModal` mostly via events + opportunistic rehydration.
- **Recovery logic is scattered**: Rehydration is called from mount effects, visibility listeners, `restoreBuildModal`, the dock sync effect, and `attachToActiveBuild`.
- **Dock registration is imperative**: `updateDock()` / `clearSlot()` calls are spread across multiple paths with special-case conditions.
- History of similar issues (see AGENTS.md: nested setState during render in `openBuildModal`).

The current solution works for the reported scenarios but is the result of accumulating guards. It is fragile to future changes (new phases, HMR, window focus changes, multiple simultaneous builds, etc.).

---

## 2. Design Goals

A better architecture should achieve:

1. **Single source of truth** for "is there an active build session and what is its phase?"
2. **Explicit state machine** so invalid transitions are impossible (or at least obvious).
3. **Clear reconciliation strategy** between live events (`foundry-progress`) and authoritative polling (`foundry_status`).
4. **Minimize / visibility / recovery** should be first-class and simple, not special cases that require ref guards.
5. **Dock, Modal, and Page** should be mostly **consumers** of derived state, not drivers of complex logic.
6. **Fewer refs**, more declarative React patterns.
7. **Testability**: The core logic should be unit-testable without a full Tauri + React render.

---

## 3. Recommended Architecture (Moderate Refactor)

### 3.1 Core Model

Introduce the concept of a **BuildSession** as the central unit:

```ts
type BuildPhase =
  | 'idle'
  | 'configuring'
  | 'waiting-confirm'
  | 'building'
  | 'validating'
  | 'complete'
  | 'error'
  | 'cancelled';

interface BuildSession {
  id: number;                    // build_id from backend
  providerId: string;
  environment: Env;
  phase: BuildPhase;
  lastLogLine?: string;
  startedAt: number;
  // Optional: accumulated log lines if we want richer state
}
```

The provider owns **one active `BuildSession | null`**.

All UI (modal visibility, dock widget, "BUILDING..." disabled state, PAUSED banner) is **derived** from this session + a small amount of UI intent (`userWantsModalVisible`).

### 3.2 State Shape (inside FoundryProvider)

```ts
interface FoundryState {
  session: BuildSession | null;
  userWantsModalVisible: boolean;   // user's explicit minimize/restore intent
  lastError?: string;
}

type FoundryAction =
  | { type: 'OPEN_BUILD'; providerId: string; environment: Env }
  | { type: 'CLOSE_BUILD' }
  | { type: 'MINIMIZE_MODAL' }
  | { type: 'RESTORE_MODAL' }
  | { type: 'PROGRESS_EVENT'; payload: BuildProgressEvent }
  | { type: 'RECONCILE_FROM_STATUS'; session: BuildSession | null }
  | { type: 'BUILD_CANCELLED' }
  | { type: 'BUILD_FAILED'; error?: string };
```

A single `useReducer` (or a small custom state machine hook) handles transitions.

### 3.3 Reconciliation Rules (Important)

- **Events are deltas** — They update the current session if the `build_id` matches or is newer.
- **Status is truth** — On mount, visibility restore, or explicit "sync" actions, we call `foundry_status()` and treat the result as authoritative.
- When opening a **new** build (`OPEN_BUILD` action):
  - We immediately create a local optimistic session in `configuring` phase.
  - We do **not** call rehydrate until the user either confirms the build or we receive the first real progress event.
- `WaitingForConfirm` is just another phase. No special "force visible" logic scattered around.

### 3.4 Derived Values (what UI actually consumes)

```ts
const isBuildActive = !!state.session && !['complete', 'error', 'cancelled', 'idle'].includes(state.session.phase);

const shouldShowModal = isBuildActive && state.userWantsModalVisible;

const dockWidget = isBuildActive ? {
  title: `${state.session.providerId} ${state.session.environment}`,
  content: getStepLabel(state.session.phase),
} : null;
```

The dock effect and modal rendering become trivial consumers.

### 3.5 Handling Minimize + Visibility

- `minimizeBuildModal()` → dispatch `{ type: 'MINIMIZE_MODAL' }` (sets `userWantsModalVisible = false`)
- `restoreBuildModal()` → dispatch `{ type: 'RESTORE_MODAL' }` + optional lightweight reconcile
- Visibility "visible" → dispatch a `RECONCILE_FROM_STATUS` action (or a dedicated `syncWithBackend()`)

No more "if waiting-confirm then force true" sprinkled in rehydrate functions.

### 3.6 Implementation Sketch

```ts
// hooks/useFoundrySession.ts (new file, or inside the provider)
function useFoundrySession() {
  const [state, dispatch] = useReducer(foundryReducer, initialState);

  // Event listener — one place
  useEffect(() => {
    const unlisten = listen('foundry-progress', (e) => {
      dispatch({ type: 'PROGRESS_EVENT', payload: e.payload });
    });
    return () => unlisten.then(f => f());
  }, []);

  // Visibility reconciliation
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        // fire-and-forget or await + dispatch
        invoke('foundry_status').then(status => {
          dispatch({ type: 'RECONCILE_FROM_STATUS', session: mapStatusToSession(status) });
        });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Expose clean commands
  const openBuild = (providerId, environment) => dispatch({ type: 'OPEN_BUILD', providerId, environment });
  const minimize = () => dispatch({ type: 'MINIMIZE_MODAL' });
  const restore = () => dispatch({ type: 'RESTORE_MODAL' });
  // ...

  return {
    session: state.session,
    isModalVisible: shouldShowModal(state),
    dockWidget: deriveDockWidget(state.session),
    openBuild,
    minimize,
    restore,
    // ...
  };
}
```

The reducer becomes the place where you encode rules such as:
- You cannot open a new build while another is active (or you can, and it cancels the previous — explicit decision).
- Receiving a progress event for a different `build_id` replaces the session.

---

## 4. Alternative: Incremental Cleanup (Lower Risk)

If a full reducer refactor feels too large right now, apply these targeted improvements to the existing code:

1. **Collapse the ref guards** into one `buildSessionState` ref or a small internal enum (`'idle' | 'opening' | 'reconciling'`).
2. **Stop calling rehydrate from the dock sync effect**. The dock effect should only be responsible for `registerWidget` / `clearSlot` based on current `buildProgress` + `foundryModal`. Recovery should be driven only from mount + visibility + explicit user actions (`restoreBuildModal`, `attachToActiveBuild`).
3. **Make `openBuildModal` not set `buildProgress` to null** until we are ready to start the actual backend build (or keep a separate "pendingOpen" state).
4. Add a single well-documented `reconcileWithBackend(force?: boolean)` function instead of the current `rehydrateFromStatus`.
5. Move the dock registration logic into one `useEffect` that depends on `[session, userWantsDockVisible]`.

This path reduces the number of refs and the surprise interactions without changing the overall shape much.

---

## 5. Migration Path (Recommended Order)

1. Introduce the `BuildSession` type and a small reducer that currently just wraps the existing fields (no behavior change).
2. Move the progress event listener to dispatch actions into the reducer.
3. Replace the various `setBuildProgress` / `setFoundryModal` calls with dispatches.
4. Centralize the `foundry_status` call into one `reconcile` action.
5. Simplify the dock and modal consumers to read from the new derived state.
6. Delete the now-unnecessary ref guards one by one as the reducer takes over the rules.
7. (Optional) Extract `useFoundrySession` into its own file.

This can be done incrementally while keeping the app working.

---

## 6. Open Questions / Trade-offs

- Should we support multiple concurrent build sessions in the future? (Currently the backend only supports one via `CURRENT_BUILD`.)
- How much log history should live in the session vs. being purely ephemeral in the modal?
- Do we want to persist the last build session across app restarts (for recovery after crash)?
- Should the "minimized" state be stored in the session or as separate UI preference?
- React 19 `useEffectEvent` or a stable event handler pattern could clean up the visibility listener.

---

## 7. Why This Is Better

- The race between `openBuildModal` and rehydration disappears because opening a build is an explicit action that the reducer understands.
- Minimize / restore / visibility become simple intent updates + optional reconciliation.
- Adding a new phase or a new UI surface (e.g., a build history list) becomes a matter of extending the session shape and derived selectors.
- Far fewer "why is this ref here?" moments for future developers.

---

This document can serve as the target design for future work on the Foundry feature. When someone next touches `useBuildDock.tsx` / `FoundryModal.tsx` for anything beyond a trivial bugfix, they should consider moving toward the reducer + explicit session model described above.

**Next concrete step suggestion**: Create a small spike branch that implements just the reducer + `BuildSession` type while keeping the rest of the UI calling the same public API (`useFoundry()`). This proves the approach with minimal risk.