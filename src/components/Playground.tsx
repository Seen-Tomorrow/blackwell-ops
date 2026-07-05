import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StackEntry, ModelEntry } from "../lib/types";
import {
  loadPlaygroundState,
  savePlaygroundState,
  getActivePlaygroundSession,
  updateActiveSession,
  createPlaygroundSession,
  exportPlaygroundBundle,
  importPlaygroundBundle,
  PLAYGROUND_MAX_SESSIONS,
  type PlaygroundChatTurn,
  type PlaygroundState,
} from "../lib/storage";
import {
  extractCode,
  wrapIfNeeded,
  looksLikeHtml,
  validateExtractedCode,
  estimatePromptChars,
  buildFixErrorsPrompt,
  hasPreviewIssues,
  STARTER_TEMPLATE,
  PLAYGROUND_PRESETS,
} from "../lib/playgroundCodegen";
import { streamEngineGeneration } from "../lib/playgroundEngine";
import {
  renderPreviewInFrame,
  revokePreviewBlobUrl,
  isPreviewConsoleMessage,
  type PreviewConsoleLine,
} from "../lib/playgroundPreview";
import { dispatchNavigateCatalog } from "../lib/events";
import { usePlaygroundSplitResize } from "../hooks/useCatalogSplitResize";
import TabPageHeader from "./TabPageHeader";

interface PlaygroundProps {
  stack: StackEntry[];
  models: ModelEntry[];
  /** When true, parent ExtrasPage owns the page chrome. */
  embedded?: boolean;
}

interface RunningTarget {
  slotIdx: number;
  port: number;
  alias: string;
  model: string;
  modelPath?: string;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function Playground({ stack, models, embedded = false }: PlaygroundProps) {
  const [state, setState] = useState<PlaygroundState>(() => loadPlaygroundState());
  const [isGenerating, setIsGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [genStartedAt, setGenStartedAt] = useState<number | null>(null);
  const [codeValidation, setCodeValidation] = useState<ReturnType<typeof validateExtractedCode> | null>(null);
  const [consoleLines, setConsoleLines] = useState<PreviewConsoleLine[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewMode, setViewMode] = useState<"split" | "preview" | "code">("split");

  const abortRef = useRef<AbortController | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const fullscreenFrameRef = useRef<HTMLIFrameElement | null>(null);

  const session = getActivePlaygroundSession(state);

  const activeTargets: RunningTarget[] = useMemo(
    () =>
      stack
        .filter((s) => s.status === "RUNNING" && s.port > 0)
        .map((s) => ({
          slotIdx: s.idx,
          port: s.port,
          alias: s.alias,
          model: s.model_name || s.alias,
          modelPath: s.model_path,
        })),
    [stack],
  );

  const currentTarget =
    activeTargets.find((t) => t.slotIdx === state.selectedSlotIdx) || activeTargets[0] || null;

  const currentEntry = stack.find((s) => s.idx === state.selectedSlotIdx);
  const engineCtx = currentEntry?.n_ctx ?? 32768;
  const maxGenTokens = Math.min(65536, Math.max(4096, engineCtx - 1024));

  const modelLabel = useMemo(() => {
    if (!currentTarget?.modelPath) return currentTarget?.model ?? null;
    const m = models.find((x) => x.path === currentTarget.modelPath);
    if (!m) return currentTarget.model;
    return `${m.name} (${m.quant})`;
  }, [currentTarget, models]);

  const patchSession = useCallback(
    (patch: Parameters<typeof updateActiveSession>[1]) => {
      setState((prev) => updateActiveSession(prev, patch));
    },
    [],
  );

  const patchSettings = useCallback((patch: Partial<PlaygroundState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const onSplitRatioChange = useCallback((ratio: number) => {
    setState((prev) => ({ ...prev, splitRatio: ratio }));
  }, []);

  const split = usePlaygroundSplitResize(state.splitRatio, onSplitRatioChange);

  useEffect(() => {
    const t = setTimeout(() => savePlaygroundState(state), 120);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    if (!state.selectedSlotIdx && activeTargets.length > 0) {
      patchSettings({ selectedSlotIdx: activeTargets[0].slotIdx });
    }
  }, [activeTargets.length, state.selectedSlotIdx, patchSettings]);

  useEffect(() => {
    if (
      state.selectedSlotIdx != null &&
      !activeTargets.some((t) => t.slotIdx === state.selectedSlotIdx)
    ) {
      const next = activeTargets[0]?.slotIdx ?? null;
      patchSettings({ selectedSlotIdx: next });
      if (state.selectedSlotIdx != null) {
        window.__blackopsToasts?.addToast(
          `Engine slot ${state.selectedSlotIdx} stopped — switched target`,
          "error",
          5000,
        );
      }
    }
  }, [activeTargets, state.selectedSlotIdx, patchSettings]);

  useEffect(() => {
    if (state.maxTokens > maxGenTokens) {
      patchSettings({ maxTokens: Math.max(1024, maxGenTokens) });
    }
  }, [maxGenTokens, state.maxTokens, patchSettings]);

  const renderPreview = useCallback(
    (code: string, clearConsole = true) => {
      const iframe = previewFrameRef.current;
      if (!iframe || !code.trim()) return;
      const safe = state.wrapOutput ? wrapIfNeeded(code) : code;
      renderPreviewInFrame(iframe, safe, true);
      setCodeValidation(validateExtractedCode(safe));
      if (clearConsole) setConsoleLines([]);
    },
    [state.wrapOutput],
  );

  const debouncedPreview = useCallback(
    (code: string) => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      previewTimerRef.current = setTimeout(() => renderPreview(code), 40);
    },
    [renderPreview],
  );

  useEffect(
    () => () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      revokePreviewBlobUrl();
    },
    [],
  );

  const updateCode = (code: string) => {
    patchSession({ currentCode: code });
    if (state.autoPreview) debouncedPreview(code);
  };

  const loadIntoEditor = (code: string, alsoPreview = true) => {
    const final = state.wrapOutput ? wrapIfNeeded(code) : code;
    patchSession({ currentCode: final });
    if (alsoPreview) renderPreview(final);
  };

  const clearSession = () => {
    patchSession({ history: [], currentCode: "", lastPrompt: "" });
    const iframe = previewFrameRef.current;
    if (iframe) iframe.srcdoc = "";
    revokePreviewBlobUrl();
    setGenError(null);
    setConsoleLines([]);
    setCodeValidation(null);
  };

  const loadStarter = () => loadIntoEditor(STARTER_TEMPLATE, true);

  const cancelGeneration = () => {
    abortRef.current?.abort();
    setIsGenerating(false);
    setGenStartedAt(null);
  };

  const pushTurn = useCallback((turn: PlaygroundChatTurn) => {
    setState((prev) => {
      const active = getActivePlaygroundSession(prev);
      return updateActiveSession(prev, { history: [...active.history, turn] });
    });
  }, []);

  const sendToModel = async (userPrompt: string, autoLoadPreview: boolean) => {
    if (!currentTarget) {
      setGenError("No running engine selected. Launch a model from the OPERATIONS tab first.");
      return;
    }
    if (!userPrompt.trim()) return;

    setGenError(null);
    setIsGenerating(true);
    setStreamingText("");
    setGenStartedAt(Date.now());

    const controller = new AbortController();
    abortRef.current = controller;

    const userTurn: PlaygroundChatTurn = { role: "user", content: userPrompt.trim() };
    pushTurn(userTurn);

    const maxCtxChars = Math.max(2048, (engineCtx - state.maxTokens) * 3);
    const codeBefore = session.currentCode;
    const historyBefore = [...session.history, userTurn];

    try {
      const raw = await streamEngineGeneration({
        port: currentTarget.port,
        userText: userPrompt.trim(),
        previousCode: codeBefore,
        history: historyBefore,
        temperature: state.temp,
        nPredict: state.maxTokens,
        maxPredict: maxGenTokens,
        useChatApi: state.useChatApi,
        maxCtxChars,
        signal: controller.signal,
        onChunk: (partial) => setStreamingText(partial),
      });

      const extracted = extractCode(raw);
      const finalCode = state.wrapOutput ? wrapIfNeeded(extracted) : extracted;
      const validation = validateExtractedCode(finalCode);

      pushTurn({ role: "assistant", content: raw });
      patchSession({ currentCode: finalCode, lastPrompt: userPrompt.trim() });
      setCodeValidation(validation);

      if (autoLoadPreview || state.autoPreview) renderPreview(finalCode);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setGenError(msg);
      pushTurn({ role: "assistant", content: `[ERROR] ${msg}` });
    } finally {
      setIsGenerating(false);
      setGenStartedAt(null);
      setStreamingText("");
      abortRef.current = null;
    }
  };

  const handleSend = (withPreview = true) => {
    const p = draftPrompt.trim();
    if (!p) return;
    if (!state.hasSeenGuide) patchSettings({ hasSeenGuide: true });
    void sendToModel(p, withPreview);
    setDraftPrompt("");
  };

  const handleFixErrors = (userNote?: string) => {
    const prompt = buildFixErrorsPrompt(
      consoleLines,
      codeValidation?.warnings ?? [],
      userNote ?? (draftPrompt.trim() || undefined),
    );
    if (!state.hasSeenGuide) patchSettings({ hasSeenGuide: true });
    setConsoleLines([]);
    void sendToModel(prompt, true);
    setDraftPrompt("");
  };

  const fillFixPrompt = () => {
    setDraftPrompt(
      buildFixErrorsPrompt(consoleLines, codeValidation?.warnings ?? []),
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend(true);
    }
    if (e.key === "Escape" && isGenerating) cancelGeneration();
  };

  const applyCodeFromHistory = (turn: PlaygroundChatTurn) => {
    if (turn.role !== "assistant") return;
    loadIntoEditor(extractCode(turn.content), true);
  };

  const loadRawFromHistory = (turn: PlaygroundChatTurn) => {
    if (turn.role !== "assistant") return;
    patchSession({ currentCode: turn.content });
    const iframe = previewFrameRef.current;
    if (iframe) renderPreviewInFrame(iframe, turn.content, true);
  };

  const downloadHtml = () => {
    if (!session.currentCode) return;
    const blob = new Blob([session.currentCode], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "playground-demo.html";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  const copyCode = async () => {
    if (!session.currentCode) return;
    await navigator.clipboard.writeText(session.currentCode).catch(() => {});
    window.__blackopsToasts?.addToast("Code copied", "success", 2000);
  };

  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (fullscreen) setFullscreen(false);
        if (isGenerating) cancelGeneration();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!session.currentCode) return;
        const blob = new Blob([session.currentCode], { type: "text/html" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "playground-demo.html";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        if (session.currentCode) renderPreview(session.currentCode);
      }
    };
    window.addEventListener("keydown", onGlobalKey);
    return () => window.removeEventListener("keydown", onGlobalKey);
  }, [fullscreen, isGenerating, session.currentCode, renderPreview]);

  const openInBrowser = async () => {
    if (!session.currentCode) return;
    try {
      const path = await invoke<string>("playground_open_html_in_browser", {
        html: state.wrapOutput ? wrapIfNeeded(session.currentCode) : session.currentCode,
      });
      window.__blackopsToasts?.addToast(`Opened in browser (${path})`, "success", 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.__blackopsToasts?.addToast(msg, "error", 6000);
    }
  };

  const newSession = () => {
    if (state.sessions.length >= PLAYGROUND_MAX_SESSIONS) {
      window.__blackopsToasts?.addToast(`Max ${PLAYGROUND_MAX_SESSIONS} sessions`, "error");
      return;
    }
    const s = createPlaygroundSession(`Session ${state.sessions.length + 1}`);
    setState((prev) => ({
      ...prev,
      sessions: [...prev.sessions, s],
      activeSessionId: s.id,
    }));
  };

  const deleteSession = () => {
    if (state.sessions.length <= 1) return;
    setState((prev) => {
      const sessions = prev.sessions.filter((s) => s.id !== prev.activeSessionId);
      return { ...prev, sessions, activeSessionId: sessions[0].id };
    });
  };

  const exportSession = () => {
    const blob = new Blob([exportPlaygroundBundle(state)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "playground-session.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  const importSession = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const next = importPlaygroundBundle(String(reader.result ?? ""));
      if (next) {
        setState(next);
        window.__blackopsToasts?.addToast("Session imported", "success");
      } else {
        window.__blackopsToasts?.addToast("Invalid session file", "error");
      }
    };
    reader.readAsText(file);
  };

  useEffect(() => {
    if (session.currentCode) renderPreview(session.currentCode);
  }, [state.wrapOutput]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (session.currentCode && previewFrameRef.current) {
      const id = setTimeout(() => renderPreview(session.currentCode), 60);
      return () => clearTimeout(id);
    }
  }, []); // mount only

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isPreviewConsoleMessage(e.data)) return;
      setConsoleLines((prev) =>
        [...prev, { level: e.data.level, msg: e.data.msg, ts: Date.now() }].slice(-80),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!fullscreen || !session.currentCode) return;
    const iframe = fullscreenFrameRef.current;
    if (!iframe) return;
    const safe = state.wrapOutput ? wrapIfNeeded(session.currentCode) : session.currentCode;
    renderPreviewInFrame(iframe, safe, false);
  }, [fullscreen, session.currentCode, state.wrapOutput]);

  const hasCode = session.currentCode.trim().length > 0;
  const currentLooksGood = hasCode && looksLikeHtml(session.currentCode);
  const showFixActions = hasPreviewIssues(consoleLines, codeValidation, currentLooksGood);
  const runtimeErrorCount = consoleLines.filter((l) => l.level === "error").length;
  const promptEstimate = estimatePromptChars(draftPrompt, session.currentCode, session.history);
  const ctxWarn = promptEstimate > (engineCtx - state.maxTokens) * 3;

  const elapsed = genStartedAt ? Date.now() - genStartedAt : 0;

  const chipBtn = "value-chip text-[8px] font-mono px-1.5 py-0.5 rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed";
  const toolbarChip = "value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed";

  return (
    <div className="h-full flex flex-col font-mono overflow-hidden" data-playground>
      {!embedded && (
        <TabPageHeader
          title="PLAYGROUND"
          meta={
            <span className="text-[8px] font-mono opacity-50 tracking-[1px]">
              ISOLATED AGENT SANDBOX — code &amp; previews live only in this tab
            </span>
          }
        />
      )}

      <div className="px-4 py-1.5 text-[9px] theme-surface-header flex items-center gap-2 flex-wrap border-b">
        <span className="value-chip-active text-[8px] font-mono px-1.5 py-px rounded-sm">SAFE</span>
        <span>Generated artifacts never touch app source, config, or other tabs.</span>
        <select
          value={state.activeSessionId}
          onChange={(e) => patchSettings({ activeSessionId: e.target.value })}
          className="ml-2 theme-input text-[9px] font-mono px-1 py-0.5 rounded-sm"
        >
          {state.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={newSession} className={chipBtn}>
          + SESSION
        </button>
        <button type="button" onClick={deleteSession} disabled={state.sessions.length <= 1} className={chipBtn}>
          DELETE
        </button>
        <button type="button" onClick={exportSession} className={chipBtn}>
          EXPORT
        </button>
        <button type="button" onClick={() => importInputRef.current?.click()} className={chipBtn}>
          IMPORT
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importSession(f);
            e.target.value = "";
          }}
        />
        <button type="button" onClick={clearSession} className={`${chipBtn} ml-auto playground-clear-session`}>
          CLEAR SESSION
        </button>
      </div>

      {!state.hasSeenGuide && session.history.length === 0 && (
        <div className="px-4 py-2 playground-guide-banner text-[10px] flex flex-wrap gap-x-4 gap-y-1">
          <span>
            <strong className="theme-accent-text">1.</strong> Launch a model on the{" "}
            <button type="button" className="underline theme-accent-text" onClick={dispatchNavigateCatalog}>
              OPERATIONS
            </button>{" "}
            tab
          </span>
          <span>
            <strong className="theme-accent-text">2.</strong> Pick a preset or describe your demo
          </span>
          <span>
            <strong className="theme-accent-text">3.</strong> Ctrl+Enter to generate — edit code live in the split pane
          </span>
          <button
            type="button"
            className={`${chipBtn} ml-auto opacity-80 hover:opacity-100`}
            onClick={() => patchSettings({ hasSeenGuide: true })}
          >
            DISMISS
          </button>
        </div>
      )}

      <div className="px-4 py-2 theme-surface-header flex items-center gap-3 flex-wrap border-b">
        <div className="text-[9px] uppercase tracking-widest theme-accent-text mr-1">ENGINE</div>

        {activeTargets.length === 0 ? (
          <div className="text-[10px] text-telemetry-amber">
            No running engines.{" "}
            <button type="button" className="underline hover:opacity-80" onClick={dispatchNavigateCatalog}>
              Open OPERATIONS tab
            </button>
          </div>
        ) : (
          activeTargets.map((t) => (
            <button
              key={t.slotIdx}
              type="button"
              onClick={() => patchSettings({ selectedSlotIdx: t.slotIdx })}
              className={`engine-logs-slot-chip${currentTarget?.slotIdx === t.slotIdx ? " engine-logs-slot-chip--active" : ""}`}
            >
              <span className="engine-logs-slot-chip__label">
                SLOT {t.slotIdx} • {t.alias}
              </span>
              <span className="engine-logs-slot-chip__meta">:{t.port}</span>
            </button>
          ))
        )}

        <div className="ml-auto flex items-center gap-2 text-[9px] flex-wrap justify-end">
          {modelLabel && (
            <span className="opacity-50 max-w-[200px] truncate" title={modelLabel}>
              {modelLabel}
            </span>
          )}
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={state.autoPreview}
              onChange={(e) => patchSettings({ autoPreview: e.target.checked })}
            />
            <span>AUTO PREVIEW</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={state.wrapOutput}
              onChange={(e) => patchSettings({ wrapOutput: e.target.checked })}
            />
            <span>WRAP</span>
          </label>
          <label
            className="flex items-center gap-1 cursor-pointer select-none"
            title="Use /v1/chat/completions when available"
          >
            <input
              type="checkbox"
              checked={state.useChatApi}
              onChange={(e) => patchSettings({ useChatApi: e.target.checked })}
            />
            <span>CHAT API</span>
          </label>
          <button type="button" onClick={loadStarter} className={`${chipBtn} text-[9px]`}>
            STARTER
          </button>
        </div>
      </div>

      <div className="p-3 theme-surface-inset border-b">
        <div className="flex gap-2 mb-2 flex-wrap">
          {PLAYGROUND_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setDraftPrompt(preset.prompt)}
              className={`${chipBtn} text-[8px] px-2 py-1`}
              title={preset.prompt}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <textarea
            value={draftPrompt}
            onChange={(e) => setDraftPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the demo… (Ctrl/Cmd+Enter send, Esc cancel)"
            className="flex-1 min-h-[64px] resize-y theme-input p-2 text-[11px] font-mono rounded-sm"
            disabled={isGenerating}
          />
          <div className="flex flex-col gap-1 w-40">
            <button
              type="button"
              onClick={() => handleSend(true)}
              disabled={isGenerating || !currentTarget || !draftPrompt.trim()}
              className="flex-1 value-chip-active text-[10px] font-mono tracking-wider rounded-sm disabled:opacity-40"
            >
              {isGenerating ? `STREAMING ${formatElapsed(elapsed)}` : "SEND + PREVIEW"}
            </button>
            <button
              type="button"
              onClick={() => handleSend(false)}
              disabled={isGenerating || !currentTarget || !draftPrompt.trim()}
              className="flex-1 value-chip text-[10px] font-mono rounded-sm disabled:opacity-40"
            >
              SEND ONLY
            </button>
            <button
              type="button"
              onClick={() => handleFixErrors()}
              disabled={isGenerating || !currentTarget || !hasCode || !showFixActions}
              className={`${chipBtn} playground-warn-btn text-[9px]`}
              title="Send captured preview errors to the model and regenerate"
            >
              FIX ERRORS
            </button>
            <button
              type="button"
              onClick={cancelGeneration}
              disabled={!isGenerating}
              className={`${chipBtn} playground-danger-btn text-[9px]`}
            >
              CANCEL
            </button>
          </div>
        </div>

        {isGenerating && streamingText && (
          <div className="mt-2 p-2 theme-surface text-[9px] max-h-24 overflow-auto whitespace-pre-wrap opacity-80 rounded-sm">
            {streamingText.slice(-1200)}
          </div>
        )}

        <div className="mt-2 flex items-center gap-4 text-[9px] opacity-70 flex-wrap">
          <label>
            temp{" "}
            <input
              type="range"
              min={0}
              max={1.2}
              step={0.05}
              value={state.temp}
              onChange={(e) => patchSettings({ temp: parseFloat(e.target.value) })}
              className="align-middle w-24"
            />{" "}
            {state.temp.toFixed(2)}
          </label>
          <label>
            max tokens
            <input
              type="range"
              min={256}
              max={maxGenTokens}
              step={256}
              value={Math.min(state.maxTokens, maxGenTokens)}
              onChange={(e) => patchSettings({ maxTokens: parseInt(e.target.value, 10) })}
              className="align-middle w-28 ml-1"
            />
            <span className="tabular-nums ml-1">{state.maxTokens}</span>
            <span className="opacity-40 ml-1">
              / {maxGenTokens} (ctx {engineCtx})
            </span>
          </label>
          {ctxWarn && <span className="text-telemetry-amber">prompt may exceed ctx — history/code will trim</span>}
          {genError && <span className="text-telemetry-amber">{genError}</span>}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="w-72 theme-surface flex flex-col shrink-0 border-r">
          <div className="px-3 py-1.5 text-[9px] theme-surface-header flex justify-between items-center border-b">
            <span>CONVERSATION</span>
            <span className="opacity-40">{session.history.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2 text-[10px] eink-scrollbar">
            {session.history.length === 0 && (
              <div className="opacity-40 p-3 text-center">Send a prompt to start an isolated session.</div>
            )}
            {session.history.map((turn, idx) => (
              <div
                key={idx}
                className={`p-2 ${turn.role === "user" ? "playground-turn--user" : "playground-turn--assistant"}`}
              >
                <div className="uppercase tracking-[1px] text-[8px] opacity-50 mb-0.5">{turn.role}</div>
                <div className="whitespace-pre-wrap break-words leading-snug max-h-40 overflow-auto">
                  {turn.content.length > 1800 ? turn.content.slice(0, 1800) + "…" : turn.content}
                </div>
                {turn.role === "assistant" && (
                  <div className="mt-1 flex gap-1 flex-wrap">
                    <button type="button" onClick={() => applyCodeFromHistory(turn)} className={`${chipBtn} value-chip-active`}>
                      LOAD CODE
                    </button>
                    <button type="button" onClick={() => loadRawFromHistory(turn)} className={chipBtn}>
                      RAW
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="playground-view-toolbar flex text-[9px] items-center theme-surface-header border-b shrink-0">
            {(["split", "preview", "code"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`app-nav-tab uppercase ${viewMode === mode ? "app-nav-tab-active" : ""}`}
              >
                {mode}
              </button>
            ))}
            <div className="flex-1" />
            <div className="flex items-center gap-1 px-2 py-1">
              <button type="button" onClick={copyCode} disabled={!hasCode} className={toolbarChip}>
                COPY
              </button>
              <button type="button" onClick={downloadHtml} disabled={!hasCode} className={toolbarChip}>
                .HTML
              </button>
              <button type="button" onClick={openInBrowser} disabled={!hasCode} className={toolbarChip}>
                BROWSER
              </button>
              <button
                type="button"
                onClick={() => setFullscreen(true)}
                disabled={!hasCode}
                className={toolbarChip}
              >
                FULLSCREEN
              </button>
              <button
                type="button"
                onClick={() => renderPreview(session.currentCode)}
                disabled={!hasCode}
                className={toolbarChip}
              >
                REFRESH
              </button>
              {showFixActions && (
                <button
                  type="button"
                  onClick={() => handleFixErrors()}
                  disabled={isGenerating || !currentTarget || !hasCode}
                  className={`${toolbarChip} playground-warn-btn`}
                  title="Ask the model to fix preview errors"
                >
                  FIX{runtimeErrorCount > 0 ? ` (${runtimeErrorCount})` : ""}
                </button>
              )}
              {hasCode && !currentLooksGood && (
                <span className="text-[8px] text-telemetry-amber px-1">output may not be clean HTML</span>
              )}
              {codeValidation && codeValidation.warnings.length > 0 && (
                <span
                  className="text-[8px] text-telemetry-amber/80 px-1"
                  title={codeValidation.warnings.join("; ")}
                >
                  {codeValidation.warnings[0]}
                </span>
              )}
            </div>
          </div>

          <div ref={split.containerRef} className="flex-1 min-h-0 flex overflow-hidden relative">
            {(viewMode === "split" || viewMode === "code") && (
              <div
                className="flex flex-col min-h-0 theme-surface-inset border-r"
                style={{
                  width: viewMode === "code" ? "100%" : split.panelWidth || "45%",
                  flexShrink: 0,
                }}
              >
                <textarea
                  value={session.currentCode}
                  onChange={(e) => updateCode(e.target.value)}
                  className="playground-code-editor flex-1 w-full resize-none border-0 p-3 font-mono text-[11px] leading-relaxed outline-none"
                  spellCheck={false}
                />
                <div className="text-[8px] opacity-40 px-2 py-1 border-t theme-surface-header">
                  Live edit • Ctrl+S download • Ctrl+Shift+P refresh
                </div>
              </div>
            )}

            {viewMode === "split" && (
              <button
                type="button"
                aria-label="Resize code and preview panes"
                onMouseDown={split.startDrag}
                className={`catalog-split-handle${split.isDragging ? " is-dragging" : ""}`}
              />
            )}

            {(viewMode === "split" || viewMode === "preview") && (
              <div className="flex-1 min-w-0 flex flex-col playground-preview-canvas">
                <div className="flex-1 relative overflow-hidden">
                  {!hasCode && (
                    <div className="absolute inset-0 flex items-center justify-center text-center text-[10px] opacity-40 p-8 z-10 pointer-events-none">
                      Send a prompt or load the starter template.
                    </div>
                  )}
                  <iframe
                    ref={previewFrameRef}
                    title="playground-preview"
                    className="absolute inset-0 w-full h-full border-0 playground-preview-canvas"
                    sandbox="allow-scripts allow-pointer-lock allow-modals"
                  />
                </div>
                {(consoleLines.length > 0 || showFixActions) && (
                  <div className="theme-surface-inset flex flex-col max-h-28 border-t">
                    <div className="flex items-center gap-2 px-2 py-0.5 text-[8px] theme-surface-header border-b shrink-0">
                      <span className="opacity-50 uppercase tracking-wider">Preview console</span>
                      {showFixActions && (
                        <button
                          type="button"
                          onClick={() => handleFixErrors()}
                          disabled={isGenerating || !currentTarget || !hasCode}
                          className={`${chipBtn} playground-warn-btn`}
                        >
                          FIX WITH MODEL
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={fillFixPrompt}
                        disabled={!showFixActions}
                        className={chipBtn}
                        title="Load error details into the prompt box so you can edit before sending"
                      >
                        EDIT PROMPT
                      </button>
                      <button
                        type="button"
                        onClick={() => setConsoleLines([])}
                        disabled={consoleLines.length === 0}
                        className={`${chipBtn} ml-auto`}
                      >
                        CLEAR
                      </button>
                    </div>
                    <div className="overflow-y-auto p-1 text-[8px] min-h-0 flex-1 eink-scrollbar">
                      {consoleLines.length === 0 ? (
                        <div className="opacity-40 px-1">No runtime logs yet — static warnings may still apply.</div>
                      ) : (
                        consoleLines.slice(-12).map((line, i) => (
                          <div
                            key={i}
                            className={
                              line.level === "error"
                                ? "text-telemetry-red"
                                : line.level === "warn"
                                  ? "text-telemetry-amber/80"
                                  : "opacity-60"
                            }
                          >
                            [{line.level}] {line.msg}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="h-6 px-3 text-[8px] theme-surface-header flex items-center gap-3 border-t shrink-0">
        <span>PLAYGROUND — isolated</span>
        <span className="opacity-40">•</span>
        <span>
          {activeTargets.length} engine{activeTargets.length === 1 ? "" : "s"}
        </span>
        {currentTarget && (
          <span className="opacity-60">
            • {currentTarget.alias} :{currentTarget.port}
          </span>
        )}
        <span className="flex-1" />
        <span className="opacity-40">streaming on • three.js r134</span>
      </div>

      {fullscreen && (
        <div className="fixed inset-0 z-[200] playground-fullscreen-overlay flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 theme-surface-header text-[9px] border-b">
            <span className="theme-accent-text">FULLSCREEN PREVIEW</span>
            <span className="opacity-40">Esc to exit</span>
            <button type="button" className={`${chipBtn} ml-auto text-[9px]`} onClick={() => setFullscreen(false)}>
              CLOSE
            </button>
          </div>
          <iframe
            ref={fullscreenFrameRef}
            title="playground-fullscreen"
            className="flex-1 w-full border-0 playground-preview-canvas"
            sandbox="allow-scripts allow-pointer-lock allow-modals"
          />
        </div>
      )}
    </div>
  );
}