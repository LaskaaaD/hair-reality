import { useCallback, useEffect, useRef, useState } from "react";
import type { EdgeStateKind } from "./edge-state.js";
import { FlowEdgeState } from "./FlowEdgeState.js";
import { judgePose, measurePose, type PoseTarget } from "./capture-pose.js";

type Slot = { key: string; label: string; optional?: boolean };

type E12CameraCaptureProps = {
  slots: Slot[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  previews: Partial<Record<string, string>>;
  busy: boolean;
  onCapture: (file: File) => Promise<void>;
  onClose: () => void;
};

const HOLD_MS = 1100;
const SETTLE_MS = 1000;
const DETECT_EVERY_MS = 90;
const MODEL_URL = "/demo-media/mediapipe/face_landmarker.task";
const WASM_URL = "/demo-media/mediapipe/wasm";

type Landmarker = {
  detectForVideo: (
    video: HTMLVideoElement,
    timestamp: number,
  ) => { faceLandmarks: { x: number; y: number; z: number }[][]; facialTransformationMatrixes?: { data: ArrayLike<number> }[] };
  close: () => void;
};

function isTarget(key: string): key is PoseTarget {
  return key === "front" || key === "left" || key === "right" || key === "down";
}

async function createLandmarker(): Promise<Landmarker> {
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const make = (delegate: "GPU" | "CPU") =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 2,
      outputFacialTransformationMatrixes: true,
    });
  try {
    return await make("GPU");
  } catch {
    return await make("CPU");
  }
}

function frameBrightness(video: HTMLVideoElement, canvas: HTMLCanvasElement): number {
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 128;
  ctx.drawImage(video, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) total += 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
  return total / (data.length / 4);
}

export function E12CameraCapture({
  slots,
  activeIndex,
  onActiveIndexChange,
  previews,
  busy,
  onCapture,
  onClose,
}: E12CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [live, setLive] = useState(false);
  const [edge, setEdge] = useState<EdgeStateKind | null>(null);
  const [guided, setGuided] = useState<"loading" | "on" | "off">("loading");
  const [message, setMessage] = useState("");
  const [verdict, setVerdict] = useState<"none" | "warn" | "ok" | "done">("none");
  const holdBarRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef<Set<string>>(new Set());
  const latestRef = useRef({ activeIndex, busy, slots });
  const captureRef = useRef<() => Promise<boolean>>(async () => false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setLive(false);
  }, []);

  const enableCamera = useCallback(async () => {
    setEdge(null);
    stopStream();
    if (!navigator.mediaDevices?.getUserMedia) {
      setEdge("no-camera");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      setLive(true);
    } catch (caught) {
      const name = caught instanceof DOMException ? caught.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setEdge("camera-permission-denied");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setEdge("no-camera");
      } else {
        setEdge("no-camera");
      }
    }
  }, [stopStream]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- syncs with session/external source
    void enableCamera();
    return () => stopStream();
  }, [enableCamera, stopStream]);

  const captureFrame = async (): Promise<boolean> => {
    const video = videoRef.current;
    if (!video || !live || busy) return false;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 960;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    if (!blob) return false;
    const slotKey = slots[activeIndex]?.key;
    await onCapture(new File([blob], "capture.jpg", { type: "image/jpeg" }));
    if (slotKey) doneRef.current.add(slotKey);
    return true;
  };

  useEffect(() => {
    latestRef.current = { activeIndex, busy, slots };
    captureRef.current = captureFrame;
  });

  /** Moves to the next slot that still has no photo, or closes the camera when all are taken. */
  const advance = useCallback(() => {
    const { activeIndex: current, slots: all } = latestRef.current;
    const next = all.findIndex((slot, index) => index !== current && !doneRef.current.has(slot.key));
    if (next === -1) onClose();
    else onActiveIndexChange(next);
  }, [onActiveIndexChange, onClose]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let landmarker: Landmarker | null = null;
    let timer = 0;
    let holdSince = 0;
    let pausedUntil = 0;
    let lastSeen = 0;
    const scratch = document.createElement("canvas");

    const setHold = (share: number) => {
      holdBarRef.current?.style.setProperty("width", `${Math.round(share * 100)}%`);
    };

    const tick = () => {
      if (cancelled) return;
      timer = window.setTimeout(tick, DETECT_EVERY_MS);
      const video = videoRef.current;
      const { activeIndex: index, busy: uploading, slots: all } = latestRef.current;
      const slot = all[index];
      if (!landmarker || !video || video.readyState < 2 || !slot || !isTarget(slot.key)) return;
      const now = performance.now();
      if (uploading || now < pausedUntil) {
        holdSince = 0;
        setHold(0);
        return;
      }
      const detected = landmarker.detectForVideo(video, now);
      const faces = detected.faceLandmarks;
      let ok = false;
      let text = slot.key === "down" ? "Keep part of your face in view while you tip your head down" : "Look into the camera, I can't see your face";
      if (faces.length > 1) {
        text = "Only one person in the frame, please";
      } else if (faces[0]) {
        lastSeen = now;
        const metrics = measurePose(faces[0], video.videoWidth, video.videoHeight, detected.facialTransformationMatrixes?.[0]?.data);
        if (metrics) {
          const judged = judgePose(slot.key, metrics, frameBrightness(video, scratch));
          ok = judged.ok;
          text = judged.message;
        }
      }
      // A tipped head loses the face for a frame or two; keep the hold running through those gaps.
      const dropout = !faces[0] && holdSince !== 0 && now - lastSeen < 500;
      if (dropout) return;
      setMessage(text);
      setVerdict(ok ? "ok" : "warn");
      if (!ok) {
        holdSince = 0;
        setHold(0);
        return;
      }
      if (holdSince === 0) holdSince = now;
      const share = Math.min(1, (now - holdSince) / HOLD_MS);
      setHold(share);
      if (share < 1) return;
      holdSince = 0;
      setHold(0);
      pausedUntil = Number.POSITIVE_INFINITY;
      void captureRef.current().then((taken) => {
        if (cancelled) return;
        if (!taken) {
          pausedUntil = 0;
          return;
        }
        setVerdict("done");
        setMessage("Got it");
        pausedUntil = performance.now() + SETTLE_MS;
        window.setTimeout(() => {
          if (!cancelled) advance();
        }, SETTLE_MS);
      });
    };

    createLandmarker()
      .then((created) => {
        if (cancelled) {
          created.close();
          return;
        }
        landmarker = created;
        setGuided("on");
        timer = window.setTimeout(tick, DETECT_EVERY_MS);
      })
      .catch(() => {
        if (cancelled) return;
        setGuided("off");
        setVerdict("none");
        setMessage("Automatic guidance isn't available here. Frame yourself in the oval and press the shutter.");
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      landmarker?.close();
    };
  }, [live, advance]);

  if (edge) {
    return (
      <FlowEdgeState
        kind={edge}
        onPrimary={() => {
          if (edge === "unsupported-image" || edge === "no-camera") fileRef.current?.click();
          else void enableCamera();
        }}
        onSecondary={() => {
          if (edge === "camera-permission-denied" || edge === "no-camera") fileRef.current?.click();
          else onClose();
        }}
      />
    );
  }

  return (
    <section className="e12-camera" data-testid="e12-camera">
      <div className="e12-camera-stage">
        <video ref={videoRef} className="e12-camera-video e12-camera-video--mirrored" playsInline muted aria-label="Live camera preview" />
        {!live ? <p className="e12-camera-fallback">Starting camera…</p> : null}
        {live ? (
          <div className="e12-camera-coach" data-verdict={verdict}>
            <output aria-live="polite" data-testid="e12-camera-message">
              {guided === "loading" ? "Preparing guidance…" : message}
            </output>
            <span className="e12-camera-hold" aria-hidden="true">
              <span ref={holdBarRef} />
            </span>
          </div>
        ) : null}
      </div>
      <ol className="e12-camera-steps" aria-label={`Photo ${activeIndex + 1} of ${slots.length}`}>
        {slots.map((slot, index) => (
          <li key={slot.key} data-state={previews[slot.key] ? "done" : index === activeIndex ? "active" : "todo"} />
        ))}
      </ol>
      {guided === "off" ? (
        <div className="e12-camera-controls">
          <button
            type="button"
            className="e12-camera-shutter"
            aria-label="Take photo"
            disabled={busy || !live}
            onClick={() => void captureFrame().then((taken) => (taken ? advance() : undefined))}
          >
            <span />
          </button>
          <label className="e12-camera-upload">
            Upload instead
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void onCapture(file);
              }}
            />
          </label>
        </div>
      ) : null}
    </section>
  );
}
