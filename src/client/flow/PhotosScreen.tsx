import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import {
  analyze,
  createSession,
  DemoRequestError,
  loadResults,
  loadSession,
  openPersona,
  removePhoto,
  uploadPhoto,
} from "../api.js";
import { Button } from "../design/index.js";
import { FlowLayout } from "./FlowLayout.js";
import { canProceedFromServerPhotos } from "./flow-logic.js";
import { photoRoleForSlot, slotForPhotoRole } from "./flow-mappers.js";
import { useFlow } from "./flow-state.js";
import { useFlowRouteGuard, useFlowSessionLoader } from "./use-flow-route.js";
import { E12Analyzing } from "./states/E12Analyzing.js";
import { E12CameraCapture } from "./states/E12CameraCapture.js";
import type { EdgeStateKind } from "./states/edge-state.js";
import { edgeStateFromAnalysisNotice, edgeStateFromDemoError } from "./states/edge-state.js";
import { FlowEdgeState } from "./states/FlowEdgeState.js";

const CAPTURE_SLOTS = [
  {
    key: "front" as const,
    label: "Front",
    hint: "Face the camera directly",
    why: "Reads your face shape and hair type.",
    required: true,
    example: "/demo-media/sample-front.jpg",
  },
  {
    key: "left" as const,
    label: "Turn head left",
    hint: "Turn about 45° toward your left shoulder",
    why: "Reads curl pattern from the side.",
    required: true,
    example: "/demo-media/sample-left.jpg",
  },
  {
    key: "right" as const,
    label: "Turn head right",
    hint: "Turn about 45° toward your right shoulder",
    why: "Confirms the pattern on the other side.",
    required: true,
    example: "/demo-media/sample-right.jpg",
  },
  {
    key: "down" as const,
    label: "Top of head",
    hint: "Tilt your chin down so your hairline and crown show",
    why: "Reads hair density, which decides which cuts are realistic.",
    required: true,
    example: "/demo-media/sample-down.jpg",
  },
] as const;

type SlotKey = (typeof CAPTURE_SLOTS)[number]["key"];
type PhotosPhase = "photos" | "camera" | "analyzing" | "edge";

export function PhotosScreen() {
  const { session, loading, settled, error, refresh } = useFlowSessionLoader();
  const { resetUi } = useFlow();
  const navigate = useNavigate();
  const bulkUploadRef = useRef<HTMLInputElement>(null);
  const slotUploadRefs = useRef<Partial<Record<SlotKey, HTMLInputElement>>>({});
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<PhotosPhase>("photos");
  const [cameraIndex, setCameraIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [edgeKind, setEdgeKind] = useState<EdgeStateKind | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<SlotKey | null>(null);
  const [justFilledSlot, setJustFilledSlot] = useState<SlotKey | null>(null);
  const [uploadingSlot, setUploadingSlot] = useState<SlotKey | null>(null);
  const [slotErrors, setSlotErrors] = useState<Partial<Record<SlotKey, string>>>({});

  useFlowRouteGuard("/demo", session, loading || !settled);

  useEffect(() => {
    if (session?.analysisStatus !== "ready") return;
    // A finished session resumes at its furthest screen: try-on when previews exist, otherwise the goal.
    let cancelled = false;
    loadResults()
      .then((results) => (results.looks.length > 0 ? "/demo/tryon" : "/demo/goal"))
      .catch(() => "/demo/goal")
      .then((target) => {
        if (!cancelled) navigate(target, { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, session?.analysisStatus]);

  useEffect(() => {
    if (session?.analysisStatus === "running") {
      // oxlint-disable-next-line react/set-state-in-effect -- syncs with session/external source
      setPhase("analyzing");
    }
  }, [session?.analysisStatus]);

  useEffect(() => {
    if (!justFilledSlot) return;
    const timer = window.setTimeout(() => setJustFilledSlot(null), 220);
    return () => window.clearTimeout(timer);
  }, [justFilledSlot]);

  const photosBySlot = useMemo(() => {
    const map: Partial<Record<SlotKey, { id: string; url: string }>> = {};
    for (const photo of session?.photos ?? []) {
      const slot = slotForPhotoRole(photo.role);
      if (slot) map[slot] = { id: photo.id, url: photo.url };
    }
    return map;
  }, [session?.photos]);

  const previewUrls = useMemo(() => {
    const out: Partial<Record<string, string>> = {};
    for (const [key, value] of Object.entries(photosBySlot)) {
      if (value?.url) out[key] = value.url;
    }
    return out;
  }, [photosBySlot]);

  const canNext = canProceedFromServerPhotos(session?.photos ?? [], consent);
  const photoCount = CAPTURE_SLOTS.filter((slot) => photosBySlot[slot.key]).length;
  const isPersona = Boolean(session?.personaId);

  const ensureSession = useCallback(async () => {
    if (session) return;
    await createSession("haircut");
    await refresh();
  }, [refresh, session]);

  const pollAnalysis = useCallback(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const next = await loadSession();
      if (!next) {
        throw new DemoRequestError("Your demo session expired. Start again from the photos step.", "unauthenticated");
      }
      if (next.analysisStatus === "ready") return next;
      if (next.analysisStatus === "failed") {
        const kind = edgeStateFromAnalysisNotice(next.analysisNotice) ?? "failed-analysis";
        setEdgeKind(kind);
        setPhase("edge");
        throw new DemoRequestError(next.analysisNotice ?? "Photo reading failed.", "analysis_failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("Photo reading is taking longer than expected. Try again.");
  }, []);

  const uploadSlot = async (slot: SlotKey, file: File) => {
    setActionError(null);
    setSlotErrors((current) => {
      const next = { ...current };
      delete next[slot];
      return next;
    });
    setUploadingSlot(slot);
    try {
      await ensureSession();
      await uploadPhoto(photoRoleForSlot(slot), file);
      setJustFilledSlot(slot);
      await refresh();
      setPhase("photos");
    } catch (caught) {
      const kind = caught instanceof DemoRequestError ? edgeStateFromDemoError(caught) : null;
      if (kind === "unsupported-image") {
        setEdgeKind(kind);
        setPhase("edge");
      } else {
        const detail =
          caught instanceof DemoRequestError && caught.message
            ? caught.message
            : "Upload failed. Try again or choose another photo.";
        setSlotErrors((current) => ({ ...current, [slot]: detail }));
      }
    } finally {
      setUploadingSlot((current) => (current === slot ? null : current));
    }
  };

  const processBulkFilesRef = useRef<(files: File[]) => void>(() => undefined);
  // oxlint-disable-next-line react/refs -- latest-callback ref, read only from event handlers
  processBulkFilesRef.current = (picked) => {
    if (!picked.length) return;
    const ordered: SlotKey[] = ["front", "left", "right", "down"];
    void (async () => {
      setBusy(true);
      try {
        const count = Math.min(picked.length, ordered.length);
        for (let i = 0; i < count; i += 1) {
          const slot = ordered[i];
          if (slot) await uploadSlot(slot, picked[i]!);
        }
      } finally {
        setBusy(false);
      }
    })();
  };

  const absorbBulkInput = (input: HTMLInputElement) => {
    const files = input.files;
    if (!files?.length) return;
    const picked = Array.from(files);
    input.value = "";
    processBulkFilesRef.current(picked);
  };

  const absorbSlotInput = (slot: SlotKey, input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void (async () => {
      setBusy(true);
      try {
        await uploadSlot(slot, file);
      } finally {
        setBusy(false);
      }
    })();
  };

  const clearSlot = async (slot: SlotKey) => {
    if (isPersona || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await removePhoto(photoRoleForSlot(slot));
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not remove this photo.");
    } finally {
      setBusy(false);
    }
  };

  const droppedImages = (event: DragEvent): File[] => Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
  const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer.types).includes("Files");

  const onSlotDragOver = (slot: SlotKey) => (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    setDragOverSlot(slot);
  };

  const onSlotDrop = (slot: SlotKey) => (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragOverSlot(null);
    if (busy) return;
    const [file] = droppedImages(event);
    if (!file) {
      setSlotErrors((current) => ({ ...current, [slot]: "Drop a photo file (JPG, PNG or WebP)." }));
      return;
    }
    void (async () => {
      setBusy(true);
      try {
        await uploadSlot(slot, file);
      } finally {
        setBusy(false);
      }
    })();
  };

  /** Files dropped beside the slots fill them in order, like choosing several photos at once; the browser must not open them. */
  const onGridDragOver = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
  };

  const onGridDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragOverSlot(null);
    if (busy) return;
    processBulkFilesRef.current(droppedImages(event));
  };

  const openCameraForSlot = (slot: SlotKey) => {
    const index = CAPTURE_SLOTS.findIndex((entry) => entry.key === slot);
    setCameraIndex(index >= 0 ? index : 0);
    setPhase("camera");
  };

  const fillSample = async () => {
    setBusy(true);
    setActionError(null);
    try {
      resetUi();
      await openPersona("sample");
      const next = await loadSession();
      await refresh();
      setConsent(true);
      if (next?.analysisStatus === "ready") {
        navigate("/demo/goal", { replace: true });
      } else {
        setPhase("photos");
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not open the sample person.");
    } finally {
      setBusy(false);
    }
  };

  const startOver = async () => {
    setBusy(true);
    setActionError(null);
    try {
      resetUi();
      await createSession("haircut");
      setConsent(false);
      setPhase("photos");
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not start a new session.");
    } finally {
      setBusy(false);
    }
  };

  const onContinue = async () => {
    if (!canNext || busy) return;
    setBusy(true);
    setActionError(null);
    setPhase("analyzing");
    try {
      await analyze();
      await pollAnalysis();
      navigate("/demo/goal");
    } catch (caught) {
        if (phase !== "edge") {
          const message = caught instanceof Error ? caught.message : "Analysis failed.";
          if (caught instanceof DemoRequestError) {
            const kind = edgeStateFromDemoError(caught);
            if (kind) {
              setEdgeKind(kind);
              setPhase("edge");
            } else {
              setActionError(message);
              setPhase("photos");
            }
          } else {
            setActionError(message);
            setPhase("photos");
          }
        }
    } finally {
      setBusy(false);
    }
  };

  const activeCameraSlot = CAPTURE_SLOTS[cameraIndex]?.key ?? "front";
  const showFooter = phase === "photos";
  const pageTitle = phase === "analyzing" ? "Analysing your photos" : "Your photos";
  const photosSubtitle =
    phase === "photos"
      ? "All four photos are needed. Each one tells the analysis something different, and it takes about a minute."
      : undefined;
  const livePhotoStatus = uploadingSlot
    ? `Uploading ${CAPTURE_SLOTS.find((s) => s.key === uploadingSlot)?.label ?? "photo"}…`
    : Object.entries(slotErrors)
        .map(([key, message]) => `${CAPTURE_SLOTS.find((s) => s.key === key)?.label ?? key}: ${message}`)
        .join(". ");

  if (loading && !session) {
    return (
      <FlowLayout
        step={0}
        title="Your photos"
        pageClass="flow-page-photos"
        backTo="/"
        backLabel="Home"
        nextLabel="Next"
        nextDisabled
      >
        <div className="hr-photos__skeleton" aria-busy="true" aria-label="Loading your session">
          <div className="hr-photos__grid" aria-hidden="true">
            {CAPTURE_SLOTS.map((slot) => (
              <div key={slot.key} className="hr-photos__slot hr-photos__slot--empty">
                <div className="hr-photos__frame" />
              </div>
            ))}
          </div>
        </div>
      </FlowLayout>
    );
  }

  return (
    <FlowLayout
      step={0}
      title={pageTitle}
      {...(photosSubtitle ? { subtitle: photosSubtitle } : {})}
      pageClass="flow-page-photos"
      {...(phase === "camera" ? {} : { backTo: "/" })}
      backLabel="Home"
      nextLabel={busy ? "Working…" : "Next"}
      nextDisabled={!canNext || busy || phase !== "photos"}
      {...(phase === "photos" ? { onNext: () => void onContinue() } : {})}
      hideFooter={!showFooter}
      onStartOver={() => void startOver()}
      {...(phase === "photos"
        ? {
            headActions: (
              <Button
                variant="secondary"
                className="button secondary flow-sample-btn"
                data-testid="flow-sample-person"
                disabled={busy}
                onClick={() => void fillSample()}
              >
                Try a sample person
              </Button>
            ),
          }
        : phase === "camera"
          ? {
              headActions: (
                <Button
                  variant="secondary"
                  className="button secondary flow-camera-back"
                  aria-label="Back to photos"
                  onClick={() => setPhase("photos")}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M19 12H5" />
                    <path d="m12 19-7-7 7-7" />
                  </svg>
                </Button>
              ),
            }
          : {})}
    >
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {livePhotoStatus}
      </p>
      {error ? (
        <p className="flow-inline-notice" role="alert">
          {error}
        </p>
      ) : null}
      {phase === "photos" ? (
        <ul className="hr-photos__rules" aria-label="Before you take the photos" data-testid="photo-rules">
          <li><strong>Take off your glasses.</strong> The face scan and the try-on both need your eyes and temples clear.</li>
          <li><strong>Even, bright light.</strong> Face a window or stand in daylight; no lamp from one side.</li>
          <li><strong>No shadows on your face</strong> from a hat, a fringe, or a ceiling light above you.</li>
        </ul>
      ) : null}
      {session?.analysisStatus === "running" && phase !== "analyzing" ? (
        <p className="flow-inline-notice" data-testid="analysis-status">
          Reading your photos…
        </p>
      ) : null}

      {phase === "edge" && edgeKind ? (
        <FlowEdgeState
          kind={edgeKind}
          onPrimary={() => {
            setEdgeKind(null);
            setPhase("photos");
            if (edgeKind === "failed-analysis" || edgeKind === "api-unavailable") void onContinue();
            else setPhase("camera");
          }}
          onSecondary={() => {
            setEdgeKind(null);
            setPhase("photos");
          }}
        />
      ) : null}

      {phase === "analyzing" ? (
        <E12Analyzing {...(photosBySlot.front?.url ? { frontPhotoUrl: photosBySlot.front.url } : {})} />
      ) : null}

      {phase === "camera" ? (
        <E12CameraCapture
          slots={CAPTURE_SLOTS.map(({ key, label, required }) => ({
            key,
            label,
            optional: !required,
          }))}
          activeIndex={cameraIndex}
          onActiveIndexChange={setCameraIndex}
          previews={previewUrls}
          busy={busy}
          onClose={() => setPhase("photos")}
          onCapture={async (file) => {
            setBusy(true);
            try {
              await uploadSlot(activeCameraSlot, file);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {phase === "photos" ? (
        <>
          <div className="hr-photos__grid" data-testid="photo-slot-actions" onDragOver={onGridDragOver} onDrop={onGridDrop}>
            {CAPTURE_SLOTS.map((slot) => {
              const preview = photosBySlot[slot.key];
              const filled = Boolean(preview?.url);
              const slotBusy = uploadingSlot === slot.key;
              const slotError = slotErrors[slot.key];
              return (
                // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drop target only: the Upload and Take photo buttons stay the keyboard path
                <article
                  key={slot.key}
                  className={[
                    "hr-photos__slot",
                    filled ? "hr-photos__slot--filled" : "hr-photos__slot--empty",
                    justFilledSlot === slot.key ? "hr-photos__slot--animate" : "",
                    slotBusy ? "hr-photos__slot--uploading" : "",
                    slotError ? "hr-photos__slot--error" : "",
                    dragOverSlot === slot.key ? "hr-photos__slot--drop" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-busy={slotBusy || undefined}
                  data-testid={`photo-slot-${slot.key}`}
                  onDragOver={onSlotDragOver(slot.key)}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverSlot((current) => (current === slot.key ? null : current));
                  }}
                  onDrop={onSlotDrop(slot.key)}
                >
                  <p className="hr-photos__slot-label">{slot.label}</p>
                  <p className="hr-photos__slot-why">{slot.why}</p>
                  {filled && preview ? (
                    <>
                      <div className="hr-photos__frame">
                        <img src={preview.url} alt={`${slot.label} uploaded`} width={240} height={320} decoding="async" />
                        {slotBusy ? (
                          <div className="hr-photos__upload-overlay">
                            <span className="hr-photos__upload-spinner" aria-hidden="true" />
                            <span>Uploading…</span>
                          </div>
                        ) : null}
                      </div>
                      {slotError ? (
                        <div className="hr-photos__slot-error" role="alert">
                          <p>{slotError}</p>
                          <button
                            type="button"
                            className="hr-photos__slot-retry"
                            disabled={busy}
                            onClick={() => slotUploadRefs.current[slot.key]?.click()}
                          >
                            Upload
                          </button>
                        </div>
                      ) : (
                        <p className="hr-photos__slot-hint">{slot.hint}</p>
                      )}
                      <div className="hr-photos__slot-actions">
                        <button
                          type="button"
                          className="hr-photos__slot-btn"
                          disabled={busy}
                          onClick={() => slotUploadRefs.current[slot.key]?.click()}
                        >
                          Replace
                        </button>
                        {!isPersona ? (
                          <button
                            type="button"
                            className="hr-photos__slot-btn"
                            disabled={busy}
                            onClick={() => void clearSlot(slot.key)}
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="hr-photos__frame hr-photos__frame--placeholder">
                        <span className="hr-photos__example-chip">Example</span>
                        <img
                          className="hr-photos__example-img"
                          src={slot.example}
                          alt=""
                          aria-hidden="true"
                          width={240}
                          height={320}
                          decoding="async"
                        />
                        {slotBusy ? (
                          <div className="hr-photos__upload-overlay">
                            <span className="hr-photos__upload-spinner" aria-hidden="true" />
                            <span>Uploading…</span>
                          </div>
                        ) : slotError ? (
                          <div className="hr-photos__slot-error hr-photos__slot-error--in-frame" role="alert">
                            <p>{slotError}</p>
                            <button
                              type="button"
                              className="hr-photos__slot-retry"
                              disabled={busy}
                              onClick={() => slotUploadRefs.current[slot.key]?.click()}
                            >
                              Upload
                            </button>
                          </div>
                        ) : (
                          <div className="hr-photos__empty-actions">
                            <button
                              type="button"
                              className="hr-photos__empty-take"
                              disabled={busy}
                              onClick={() => openCameraForSlot(slot.key)}
                            >
                              Take photo
                            </button>
                            <button
                              type="button"
                              className="hr-photos__empty-upload"
                              disabled={busy}
                              onClick={() => slotUploadRefs.current[slot.key]?.click()}
                            >
                              Upload
                            </button>
                          </div>
                        )}
                      </div>
                      <p className="hr-photos__slot-hint">{slotBusy ? "Uploading…" : slot.hint}</p>
                    </>
                  )}
                  {dragOverSlot === slot.key ? (
                    <div className="hr-photos__drop-hint" aria-hidden="true">
                      {filled ? "Drop to replace" : "Drop to upload"}
                    </div>
                  ) : null}
                  <input
                    ref={(node) => {
                      if (node) slotUploadRefs.current[slot.key] = node;
                    }}
                    className="e12-bulk-photo-upload"
                    type="file"
                    accept="image/*"
                    tabIndex={-1}
                    aria-label={`Upload ${slot.label}`}
                    onChange={(event) => absorbSlotInput(slot.key, event.currentTarget)}
                  />
                </article>
              );
            })}
          </div>

          {actionError ? (
            <p className="hr-photos__page-error" role="alert">
              {actionError}
            </p>
          ) : null}

          <p className="hr-photos__progress" aria-live="polite">
            {photoCount} of {CAPTURE_SLOTS.length} photos added
            {photoCount < CAPTURE_SLOTS.length ? ". Add all four to continue." : "."}
          </p>

          <label className="flow-consent">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>
              I agree to my photos being processed to build my analysis, previews and stylist brief. They are stored
              on our server for up to 7 days, and anyone I send my brief link to can see them until it expires.
            </span>
          </label>

          <input
            ref={bulkUploadRef}
            id="e12-bulk-photo-upload"
            data-testid="e12-bulk-photo-upload"
            className="e12-bulk-photo-upload"
            type="file"
            accept="image/*"
            multiple
            tabIndex={-1}
            aria-label="Upload photos"
            onChange={(event) => absorbBulkInput(event.currentTarget)}
          />
        </>
      ) : null}
    </FlowLayout>
  );
}
