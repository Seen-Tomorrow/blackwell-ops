import { createContext, useContext } from "react";

export interface StatusBarCtx {
  totalParams: number;
  hiddenCount: number;
  onShowAll?: () => void;
}

const StatusContext = createContext<StatusBarCtx>({ totalParams: 0, hiddenCount: 0 });

export const StatusProvider = StatusContext.Provider;

export function useStatus() {
  return useContext(StatusContext);
}
