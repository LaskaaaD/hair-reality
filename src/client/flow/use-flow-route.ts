import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { DemoRequestError, loadResults, loadSession, type SessionView } from "../api.js";
import { routeForSessionState, type FlowRoute } from "./flow-mappers.js";

export type FlowSessionState = {
  session: SessionView | null;
  loading: boolean;
  /** False until the first session fetch settles; route guards must wait for it. */
  settled: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

function demoShellSkipsSessionSkeleton(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.getElementById("root")?.dataset.hrDemoShell === "1";
}

export function useFlowSessionLoader(): FlowSessionState {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(() => !demoShellSkipsSessionSkeleton());
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadSession();
      setSession(next);
    } catch (caught) {
      if (caught instanceof DemoRequestError && (caught.code === "unauthenticated" || caught.status === 401)) {
        setSession(null);
      } else {
        setError(caught instanceof Error ? caught.message : "Could not load your session.");
      }
    } finally {
      setLoading(false);
      setSettled(true);
    }
  };

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- syncs with session/external source
    void refresh();
  }, []);

  return { session, loading, settled, error, refresh };
}

export function useFlowRouteGuard(
  target: FlowRoute,
  session: SessionView | null,
  loading: boolean,
  options?: { hasRecommendations?: boolean; hasPreviews?: boolean },
): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    const hasFrontPhoto = Boolean(session?.photos.some((photo) => photo.role === "front"));
    const analysisStatus = session?.analysisStatus ?? "idle";
    const redirect = routeForSessionState({
      hasFrontPhoto,
      analysisStatus,
      hasRecommendations: options?.hasRecommendations ?? false,
      hasPreviews: options?.hasPreviews ?? false,
      target,
    });
    if (redirect && redirect !== target) {
      navigate(redirect, { replace: true });
    }
  }, [loading, navigate, options?.hasPreviews, options?.hasRecommendations, session, target]);
}

export async function sessionHasPreviews(): Promise<boolean> {
  try {
    const results = await loadResults();
    return results.looks.length > 0;
  } catch {
    return false;
  }
}
