import { Fragment, useState } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
import { formatParamValue, isParamTuned, visibleParamValuesOf } from "../lib/engineSurfaces";
import SegmentSwitch from "./SegmentSwitch";
import SliderParam from "./SliderParam";

/** The expert offload/cache knobs, promoted to their own cockpit instrument. */
const EXPERT_KEYS = ["cpu_moe", "moe_cache_mib", "moe_cache_cpu_share"] as const;



interface ExpertCachePanelProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
  modelIsMoe: boolean;
  effectiveCacheMib?: number;
}

/**
 * EXPERT CACHE - where the expert working set lives and how much of it is cached in VRAM.
 *
 * A dense model has nothing to tune here, so the instrument hides itself instead of showing dead
 * knobs. When `cpu_moe` is on, `AUTO` sizes the cache from live free VRAM across active GPUs.
 */
export default function ExpertCachePanel({
  defs,
  config,
  onChange,
  modelIsMoe,
  effectiveCacheMib,
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
            const cpuMoeOn = String(config.cpu_moe ?? "off").trim().toLowerCase() === "on";
            const cacheAuto = cpuMoeOn && String(config.moe_cache_auto ?? "on").trim().toLowerCase() !== "off";
            return (
              <Fragment key={def.key}>
                <span
                  className={`cockpit-tweak-label${isParamTuned(def, config) ? "cockpit-tweak-label--tuned" : ""}`}
                  title={def.note ?? def.label}
                >
                  {def.label}
                </span>
                {cacheRow ? (
                  <span className="cockpit-expert-slider">
                    {cpuMoeOn && (
                      <SegmentSwitch
                        ariaLabel="Expert cache mode"
                        options={[
                          { id: "on", label: "AUTO" },
                          { id: "off", label: "MANUAL" },
                        ]}
                        selectedId={cacheAuto ? "on" : "off"}
                        onSelect={(id) => {
                          onChange("moe_cache_auto", id);
                          if (id === "off" && effectiveCacheMib != null && effectiveCacheMib > 0) {
                            onChange("moe_cache_mib", effectiveCacheMib);
                          }
                        }}
                        size="compact"
                        tone="accent"
                        className="segment-switch--gpu-bezel segment-switch--cockpit-flag"
                      />
                    )}
                    {cacheAuto ? (
                      <span className="cockpit-expert-unit type-micro font-mono">
                        {effectiveCacheMib != null
                          ? `${Math.round(effectiveCacheMib).toLocaleString("en-US")} MiB (auto)`
                          : "auto"}
                      </span>
                    ) : (
                      <>
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
                      </>
                    )}
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
        </div>
      ) : null}
    </div>
  );
}
