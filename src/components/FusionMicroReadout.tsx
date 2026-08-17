interface FusionMicroReadoutProps {
  live: boolean;
  tokensText: string;
  prefillMs: string | null;
  decodeTtftMs: string | null;
  elapsedMs: string;
  mtpAcceptPct: string | null;
  mtpAcceptTitle?: string;
}

function Cell({
  label,
  value,
  live,
  className,
  title,
}: {
  label: string;
  value: string;
  live: boolean;
  className: string;
  title?: string;
}) {
  return (
    <div
      className={`fusion-micro-cell ${className}${live ? " fusion-micro-cell--live" : " fusion-micro-cell--idle"}`}
      title={title}
    >
      <span className="fusion-micro-cell__label">{label}</span>
      <span
        className={`fusion-micro-stat-cell fusion-micro-cell__value ${
          live ? "fusion-readout-emphasis" : "fusion-readout-idle"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/** Precision last-request strip — label over value, fixed cells, no jitter. */
export default function FusionMicroReadout({
  live,
  tokensText,
  prefillMs,
  decodeTtftMs,
  elapsedMs,
  mtpAcceptPct,
  mtpAcceptTitle,
}: FusionMicroReadoutProps) {
  const ruleClass = live ? "fusion-readout-divider" : "fusion-readout-divider-idle";
  return (
    <div className={`fusion-micro-readout fusion-micro-readout--instrument${live ? " is-live" : " is-idle"}`}>
      <Cell label="TOK" value={tokensText} live={live} className="fusion-micro-tokens" />
      <span className={`fusion-micro-rule ${ruleClass}`} aria-hidden>
        |
      </span>
      <Cell
        label="PP"
        value={prefillMs ?? "--"}
        live={live}
        className="fusion-micro-pp"
        title="Prompt prefill duration"
      />
      <span className={`fusion-micro-rule ${ruleClass}`} aria-hidden>
        |
      </span>
      <Cell
        label="+1ST"
        value={decodeTtftMs ?? "--"}
        live={live}
        className="fusion-micro-decode"
        title="First output token after prefill"
      />
      <span className={`fusion-micro-rule ${ruleClass}`} aria-hidden>
        |
      </span>
      <Cell label="TIME" value={elapsedMs} live={live} className="fusion-micro-elapsed" />
      {mtpAcceptPct != null && (
        <>
          <span className={`fusion-micro-rule ${ruleClass}`} aria-hidden>
            |
          </span>
          <Cell
            label="MTP"
            value={`${mtpAcceptPct}%`}
            live={live}
            className="fusion-micro-mtp"
            title={mtpAcceptTitle}
          />
        </>
      )}
    </div>
  );
}
