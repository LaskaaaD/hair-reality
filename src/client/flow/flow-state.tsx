import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type FlowUiState = {
  briefToken: string | null;
  selectedStyleKeys: string[];
  goalText: string;
  moreQuestionsOpen: boolean;
  tryOnNotice: string | null;
  profileOverrides: Record<string, string>;
};

const defaultUi: FlowUiState = {
  briefToken: null,
  selectedStyleKeys: [],
  goalText: "",
  moreQuestionsOpen: false,
  tryOnNotice: null,
  profileOverrides: {},
};

type FlowContextValue = {
  ui: FlowUiState;
  patchUi: (partial: Partial<FlowUiState>) => void;
  resetUi: () => void;
};

const FlowContext = createContext<FlowContextValue | null>(null);

export function FlowProvider({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<FlowUiState>(defaultUi);

  const patchUi = useCallback((partial: Partial<FlowUiState>) => {
    setUi((current) => ({ ...current, ...partial }));
  }, []);

  const resetUi = useCallback(() => {
    setUi(defaultUi);
  }, []);

  const value = useMemo(() => ({ ui, patchUi, resetUi }), [patchUi, resetUi, ui]);

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}

export function useFlow(): FlowContextValue {
  const ctx = useContext(FlowContext);
  if (!ctx) throw new Error("useFlow must be used within FlowProvider");
  return ctx;
}

/** @deprecated sessionStorage flow state removed in HR-087 */
export function resetFlowSession(): void {
  // no-op kept for any stale imports during transition
}
