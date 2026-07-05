import { useState, useEffect } from "react";
import type { StackEntry, ModelEntry } from "../lib/types";
import { loadExtrasSubTab, saveExtrasSubTab, type ExtrasSubTab } from "../lib/storage";
import { consumePendingExtrasSubTab, EVENTS, type NavigateExtrasDetail } from "../lib/events";
import ModelHub from "./ModelHub";
import Playground from "./Playground";
import TabPageHeader from "./TabPageHeader";

interface ExtrasPageProps {
  stack: StackEntry[];
  models: ModelEntry[];
}

const SUB_TABS: { id: ExtrasSubTab; label: string }[] = [
  { id: "modelhub", label: "MODEL HUB" },
  { id: "playground", label: "PLAYGROUND" },
];

export default function ExtrasPage({ stack, models }: ExtrasPageProps) {
  const [subTab, setSubTab] = useState<ExtrasSubTab>(
    () => consumePendingExtrasSubTab() ?? loadExtrasSubTab(),
  );

  useEffect(() => {
    saveExtrasSubTab(subTab);
  }, [subTab]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NavigateExtrasDetail>).detail;
      if (detail?.subTab) setSubTab(detail.subTab);
    };
    window.addEventListener(EVENTS.navigateExtras, handler);
    return () => window.removeEventListener(EVENTS.navigateExtras, handler);
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden" data-extras-page>
      <TabPageHeader
        title="EXTRAS"
        meta={
          <span className="text-[8px] font-mono opacity-50 tracking-[1px]">
            MODEL HUB, PLAYGROUND &amp; OTHER OPTIONAL TOOLS
          </span>
        }
      />
      <div className="px-4 py-1 config-section-bar flex items-center gap-1 border-b border-stealth-border/50">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setSubTab(tab.id)}
            className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${
              subTab === tab.id ? "app-nav-tab-active" : ""
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {subTab === "modelhub" && <ModelHub embedded />}
        {subTab === "playground" && <Playground stack={stack} models={models} embedded />}
      </div>
    </div>
  );
}