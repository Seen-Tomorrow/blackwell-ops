/**
 * PRE-FLIGHT — one line that replaces the parameter wall.
 *
 * Shows the resolved machine state (not editable knobs) and how far the panel
 * has drifted from template. Amber = tuned, red = tweak changed. The USER'S EXTRA
 * opener lives on the right edge.
 */

import type { ReactNode } from "react";

interface PreflightStripProps {
  templateVersion?: number;
  ctxLabel: string;
  slots: number;
  kvQuant?: string;
  unifiedKv: boolean;
  flashOn: boolean;
  gpuCount: number;
  splitLabel?: string;
  batch?: string | number;
  ubatch?: string | number;
  tunedCount: number;
  tweaksCount: number;
  serviceCount: number;
  serviceOpen: boolean;
  onToggleService: () => void;
  /** Live engine catalog — the app's escape hatch for any param. */
  onAddParam?: () => void;
}

function Token({
  children,
  tone = "muted",
  title,
  onClick,
}: {
  children: ReactNode;
  tone?: "muted" | "text" | "tuned" | "compat";
  title?: string;
  onClick?: () => void;
}) {
  const className = `preflight-strip__token preflight-strip__token--${tone}${
    onClick ? " preflight-strip__token--action" : ""
  }`;
  if (onClick) {
    return (
      <button type="button" className={className} title={title} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

export default function PreflightStrip(props: PreflightStripProps) {
  const {
    templateVersion,
    ctxLabel,
    slots,
    kvQuant,
    unifiedKv,
    flashOn,
    gpuCount,
    splitLabel,
    batch,
    ubatch,
    tunedCount,
    tweaksCount,
    serviceCount,
    serviceOpen,
    onToggleService,
    onAddParam,
  } = props;

  return (
    <div className="preflight-strip" role="status" aria-label="Pre-flight configuration">
      <span className="preflight-strip__brand">PRE-FLIGHT</span>
      {templateVersion ? (
        <Token tone="muted" title="Provider template version">
          TEMPLATE v{templateVersion}
        </Token>
      ) : null}
      <Token
        tone={tunedCount > 0 ? "tuned" : "muted"}
        title={tunedCount > 0 ? "Params changed from template" : "Everything at template defaults"}
      >
        {tunedCount > 0 ? `${tunedCount} TUNED` : "0 TUNED"}
      </Token>
      {tweaksCount > 0 ? (
        <Token tone="compat" title="Compatibility tweaks changed">
          {tweaksCount} TWEAKS
        </Token>
      ) : null}
      <span className="preflight-strip__sep" aria-hidden />
      <Token tone="text" title="Context length">
        {ctxLabel} CTX
      </Token>
      <Token tone="muted" title="Parallel slots">
        {slots} SLOTS
      </Token>
      {kvQuant ? (
        <Token tone="muted" title="KV cache quantisation">
          {kvQuant} KV
        </Token>
      ) : null}
      {unifiedKv ? (
        <Token tone="muted" title="Unified KV — one cache pool across slots">
          UNIFIED
        </Token>
      ) : null}
      {flashOn ? (
        <Token tone="muted" title="Flash attention on">
          FLASH
        </Token>
      ) : null}
      {gpuCount > 0 ? (
        <Token tone="muted" title="GPU assignment">
          {gpuCount} GPU{splitLabel && splitLabel !== "none" ? ` ${splitLabel}` : ""}
        </Token>
      ) : null}
      {batch !== undefined || ubatch !== undefined ? (
        <Token tone="muted" title="Batch / ubatch">
          Batch {batch ?? "—"} // uBatch {ubatch ?? "—"}
        </Token>
      ) : null}

      <span className="preflight-strip__actions">
        {onAddParam ? (
          <button
            type="button"
            className="preflight-strip__add"
            onClick={onAddParam}
            title="Add any parameter from the live engine catalog — always read from the running engine"
          >
            + PARAM
          </button>
        ) : null}
        <button
          type="button"
          className={`preflight-strip__service${serviceOpen ? " preflight-strip__service--open" : ""}`}
          onClick={onToggleService}
          aria-expanded={serviceOpen}
          title={
            serviceOpen
              ? "Close USER'S EXTRA"
              : "Open USER'S EXTRA — every remaining engine param, including catalog additions"
          }
        >
          <span className="preflight-strip__service-label">USER'S EXTRA</span>
          <span className="preflight-strip__service-count">{serviceCount}</span>
          <span className="preflight-strip__service-action">{serviceOpen ? "CLOSE" : "OPEN"}</span>
        </button>
      </span>
    </div>
  );
}
