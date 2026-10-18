import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  FULL_AUTO_GOALS,
  FULL_AUTO_WORKLOADS,
  type FullAutoGoal,
  type FullAutoWorkload,
} from "../lib/fullAutoGoals";

interface MissionStripProps {
  goal: FullAutoGoal | null;
  workload: FullAutoWorkload | null;
  onGoal: (goal: FullAutoGoal) => void;
  onWorkload: (workload: FullAutoWorkload) => void;
}

const GOALS = FULL_AUTO_GOALS;
const TASKS = FULL_AUTO_WORKLOADS;

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

/**
 * One control, two axes: horizontal goal rail + a task spool on the puck.
 * Drag the puck for GOAL; wheel / click / vertical-flick the spool for TASK.
 * Kept inline-style on purpose — the hero CSS budget is already tight.
 */
export default function MissionStrip({
  goal,
  workload,
  onGoal,
  onWorkload,
}: MissionStripProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const taskDragRef = useRef<{ y: number; moved: boolean } | null>(null);
  const taskMovedRef = useRef(false);

  const goalIndex = clampIndex(
    Math.max(0, GOALS.findIndex((option) => option.id === goal)),
    GOALS.length,
  );
  const taskIndex = clampIndex(
    Math.max(0, TASKS.findIndex((option) => option.id === workload)),
    TASKS.length,
  );
  const activeGoal = GOALS[goalIndex]!;
  const activeTask = TASKS[taskIndex]!;
  const goalPct = (goalIndex / (GOALS.length - 1)) * 100;

  const setGoalAt = useCallback(
    (index: number) => {
      const next = GOALS[clampIndex(index, GOALS.length)]!;
      if (next.id !== activeGoal.id) onGoal(next.id);
    },
    [activeGoal.id, onGoal],
  );

  const setTaskAt = useCallback(
    (index: number) => {
      const next = TASKS[clampIndex(index, TASKS.length)]!;
      if (next.id !== activeTask.id) onWorkload(next.id);
    },
    [activeTask.id, onWorkload],
  );

  const cycleTask = useCallback(
    (delta: number) => {
      setTaskAt(taskIndex + delta);
    },
    [setTaskAt, taskIndex],
  );

  const selectFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setGoalAt(Math.round(ratio * (GOALS.length - 1)));
    },
    [setGoalAt],
  );

  const beginGoalDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    selectFromClientX(event.clientX);
  };

  const moveGoalDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    selectFromClientX(event.clientX);
  };

  const endGoalDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const taskKeyDown = (event: ReactKeyboardEvent) => {
    const step =
      event.key === "ArrowUp" || event.key === "ArrowRight"
        ? -1
        : event.key === "ArrowDown" || event.key === "ArrowLeft"
          ? 1
          : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    cycleTask(step);
  };

  const rootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setGoalAt(goalIndex + (event.key === "ArrowRight" ? 1 : -1));
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      cycleTask(event.key === "ArrowUp" ? -1 : 1);
    }
  };

  const taskPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    taskDragRef.current = { y: event.clientY, moved: false };
    taskMovedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const taskPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = taskDragRef.current;
    if (!drag) return;
    const dy = event.clientY - drag.y;
    if (Math.abs(dy) >= 14) {
      cycleTask(dy > 0 ? 1 : -1);
      drag.y = event.clientY;
      drag.moved = true;
      taskMovedRef.current = true;
    }
  };

  const taskPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    taskDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const taskClick = () => {
    if (taskMovedRef.current) {
      taskMovedRef.current = false;
      return;
    }
    cycleTask(1);
  };

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-3 font-mono"
      style={{ flex: "1 1 520px", minWidth: 360 }}
      role="group"
      aria-label="FULL AUTO mission — goal and task"
      tabIndex={0}
      onKeyDown={rootKeyDown}
      onWheel={(event) => {
        // Shift+wheel drives the goal; plain wheel rolls the task spool.
        if (event.shiftKey) {
          event.preventDefault();
          setGoalAt(goalIndex + (event.deltaY > 0 ? 1 : -1));
        } else if (Math.abs(event.deltaY) > 0) {
          event.preventDefault();
          cycleTask(event.deltaY > 0 ? 1 : -1);
        }
      }}
    >
      <span className="shrink-0 type-micro uppercase tracking-widest" style={{ color: "var(--theme-text-muted)" }}>
        GOAL
      </span>
      <div
        ref={trackRef}
        className="relative min-w-0 flex-1 select-none"
        style={{ height: 54, touchAction: "none" }}
        onPointerDown={beginGoalDrag}
        onPointerMove={moveGoalDrag}
        onPointerUp={endGoalDrag}
        onPointerCancel={endGoalDrag}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 24,
            height: 2,
            borderRadius: 2,
            background: "var(--theme-border)",
          }}
        />
        {GOALS.map((option, index) => {
          const pct = (index / (GOALS.length - 1)) * 100;
          const active = index === goalIndex;
          const edge = index === 0 ? "translateX(0)" : index === GOALS.length - 1 ? "translateX(-100%)" : "translateX(-50%)";
          return (
            <button
              key={option.id}
              type="button"
              className="absolute type-micro uppercase tracking-wider"
              title={option.note}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setGoalAt(index);
              }}
              style={{
                left: `${pct}%`,
                top: 0,
                transform: edge,
                border: 0,
                background: "transparent",
                padding: 0,
                color: active ? "var(--theme-accent-bright)" : "var(--theme-text-muted)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {option.label}
            </button>
          );
        })}
        {GOALS.map((option, index) => {
          const pct = (index / (GOALS.length - 1)) * 100;
          const active = index === goalIndex;
          return (
            <span
              key={`${option.id}-notch`}
              aria-hidden
              style={{
                position: "absolute",
                left: `${pct}%`,
                top: 21,
                width: active ? 7 : 5,
                height: active ? 7 : 5,
                marginLeft: active ? -3.5 : -2.5,
                borderRadius: 99,
                background: active ? "var(--theme-accent-bright)" : "var(--theme-border)",
                boxShadow: active ? "0 0 8px var(--theme-accent-glow)" : "none",
              }}
            />
          );
        })}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 24,
            width: `${goalPct}%`,
            height: 2,
            borderRadius: 2,
            background: "var(--theme-accent)",
            opacity: 0.8,
          }}
        />
        <div
          role="slider"
          aria-label="FULL AUTO goal"
          aria-valuemin={1}
          aria-valuemax={GOALS.length}
          aria-valuenow={goalIndex + 1}
          aria-valuetext={activeGoal.label}
          tabIndex={-1}
          style={{
            position: "absolute",
            left: `${goalPct}%`,
            top: 14,
            width: 22,
            height: 22,
            marginLeft: goalIndex === 0 ? 0 : goalIndex === GOALS.length - 1 ? -22 : -11,
            borderRadius: 99,
            background: "var(--theme-panel-accent)",
            border: "2px solid var(--theme-accent-bright)",
            boxShadow: "0 0 12px var(--theme-accent-glow)",
            transition: "left 180ms cubic-bezier(.2,.8,.2,1)",
            cursor: "grab",
          }}
        />
        <button
          type="button"
          className="absolute type-micro uppercase tracking-wider"
          title="Task — click, scroll, or flick up/down to change"
          aria-label={`Task ${activeTask.label}. Click, scroll, or flick to change.`}
          onClick={taskClick}
          onKeyDown={taskKeyDown}
          onWheel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            cycleTask(event.deltaY > 0 ? 1 : -1);
          }}
          onPointerDown={taskPointerDown}
          onPointerMove={taskPointerMove}
          onPointerUp={taskPointerUp}
          onPointerCancel={taskPointerUp}
          style={{
            position: "absolute",
            left: `${goalPct}%`,
            top: 34,
            transform: goalIndex === 0 ? "translateX(0)" : goalIndex === GOALS.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            padding: "2px 8px",
            borderRadius: 3,
            border: "1px solid var(--theme-accent-soft)",
            background: "var(--theme-panel)",
            color: "var(--theme-accent-bright)",
            cursor: "ns-resize",
            textShadow: "0 0 10px var(--theme-accent-glow)",
            transition: "left 180ms cubic-bezier(.2,.8,.2,1)",
            whiteSpace: "nowrap",
          }}
        >
          {activeTask.label}
        </button>
      </div>
      <span className="shrink-0 type-micro uppercase tracking-widest" style={{ color: "var(--theme-text-muted)" }}>
        TASK
      </span>
    </div>
  );
}
