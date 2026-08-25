import { useEffect } from "react";
import type { StackEntry, ModelEntry } from "../lib/types";
import { saveExtrasSubTab, type ExtrasSubTab } from "../lib/storage";
import IntelPage from "./IntelPage";
import Playground from "./Playground";
import TabPageHeader from "./TabPageHeader";

interface ExtrasPageProps {
  stack: StackEntry[];
  models: ModelEntry[];
  /** Controlled — header EXTRAS sub-rail owns selection. */
  subTab: ExtrasSubTab;
}

export default function ExtrasPage({
  stack,
  models,
  subTab,
}: ExtrasPageProps) {
  useEffect(() => {
    saveExtrasSubTab(subTab);
  }, [subTab]);

  return (
    <div className="h-full flex flex-col overflow-hidden" data-extras-page>
      <TabPageHeader title="EXTRAS" showIcon={false} />
      <div className="flex-1 min-h-0 overflow-hidden">
        {subTab === "intel" && <IntelPage embedded />}
        {subTab === "playground" && <Playground stack={stack} models={models} embedded />}
      </div>
    </div>
  );
}
