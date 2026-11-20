import { Fragment, useState } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
import { formatParamValue, isParamTuned, visibleParamValuesOf } from "../lib/engineSurfaces";
import SegmentSwitch from "./SegmentSwitch";
import SliderParam from "./SliderParam";
import { MoeCacheTune } from "./MoeCacheTune";

/** The expert offload/cache knobs, promoted to their own cockpit instrument. */
const EXPERT_KEYS = ["cpu_moe", "moe_cache_mib", "moe_cache_cpu_share"] as const;



interface ExpertCachePanelProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
  modelPath: string | null;
  modelIsMoe: boolean;
  providerId: string;
}

/**
 * EXPERT CACHE - where the expert working set lives and how much of it is cached in VRAM.
 *
 * A dense model has nothing to tune here, so the instrument hides itself instead of showing dead
 * knobs. TUNE measures; the two knobs stay staged until APPLY.
 */
export default function ExpertCachePanel({
  defs,
  config,
  onChange,
  modelPath,
  modelIsMoe,
  providerId,
}: ExpertCachePanelProps) {
  // Open by default: TUNE is the point of this instrument, not a hidden extra.
  const [open, setOpen] = useState(true);
  const byKey = new Map(defs.map((def) => [def.key, def]));
  const rows = EXPERT_KEYS.map((key) => byKey.get(key)).filter(
    (def): def is UserEditedTemplateParam => !!def && !def.hidden,
  );
  if (rows.length === 0 || !modelIsMoe) return null;

  const tuned = rows.some((def) => isParamTuned(def, config));

  return (
    <div
      className={`cockpit-instrument cockpit-instrument--experts${
        open ? "" : " cockpit-instrument--experts--collapsed"
      }`}
    >
      <button
        type="button"
        className="cockpit-instrument__head cockpit-instrument__head--toggle"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        title={open ? "Hide EXPERT CACHE" : "Show EXPERT CACHE"}
      >
        <span className="cockpit-instrument__label">EXPERT CACHE</span>
        <span className="cockpit-instrument__head-right">
          <span className="cockpit-instrument__state" title="Expert knobs that differ from the template">
            {tuned ? "customized" : "template"}
          </span>
          <span
            className={`cockpit-instrument__chevron${
              open ? " cockpit-instrument__chevron--open" : ""
            }`}
            aria-hidden
          >
            ▶
          </span>
        </span>
      </button>
      {open ? (
        <div className="cockpit-expert-rows">
          {rows.map((def) => {
            const values = visibleParamValuesOf(def);
            const current = String(config[def.key] ?? def.defaultValue ?? "");
            const cacheRow = def.key === "moe_cache_mib";
            return (
              <Fragment key={def.key}>
                <span
                  className={`cockpit-tweak-label${isParamTuned(def, config) ? "cockpit-tweak-label--tuned" : ""}`}
                  title={def.note ?? def.label}
                >
                  {def.label}
                </span>
                {cacheRow ? (
                  // Granular by hand: a slider with a typed MiB field, not a handful of presets.
                  // Finding the edge of the cache is the whole point (it is a cliff, not a curve).
                  <span className="cockpit-expert-slider">
                    <SliderParam
                      paramKey={def.key}
                      currentValue={Number(config[def.key] ?? def.defaultValue ?? 0)}
                      defaultValue={def.defaultValue}
                      onChange={(value) => onChange(def.key, value)}
                      step={def.step ?? 256}
                      values={values}
                      fieldFormat="grouped"
                    />
                    <span className="cockpit-expert-unit type-micro font-mono">MiB</span>
                  </span>
                ) : (
                  <SegmentSwitch
                    ariaLabel={def.label}
                    options={values.map((value) => ({
                      id: String(value),
                      label: formatParamValue(value).toUpperCase(),
                    }))}
                    selectedId={current}
                    onSelect={(id) => {
                      const value = values.find((item) => String(item) === id);
                      if (value !== undefined) onChange(def.key, value);
                    }}
                    size="compact"
                    tone="accent"
                    className="segment-switch--gpu-bezel segment-switch--cockpit-flag"
                  />
                )}
              </Fragment>
            );
          })}
          <span className="cockpit-tweak-label">MEASURE</span>
          <MoeCacheTune
            config={config}
            modelPath={modelPath}
            modelIsMoe={modelIsMoe}
            providerId={providerId}
            updateParam={onChange}
          />
        </div>
      ) : null}
    </div>
  );
}
