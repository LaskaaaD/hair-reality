import { useEffect, useState } from "react";
import { demoMediaUrl } from "./fixtures.js";
import { FlowEmptyTile } from "./FlowEmptyTile.js";

type DemoMediaProps = {
  filename: string;
  alt: string;
  className?: string;
  emptyCaption?: string;
  showEmptyCaption?: boolean;
  /** When false, probe the file but render nothing until the image is ready. */
  renderEmpty?: boolean;
  onAvailableChange?: (available: boolean) => void;
};

type LoadState = "loading" | "ready" | "missing";

function DemoMediaProbe({
  filename,
  alt,
  className,
  emptyCaption = "Preview coming soon",
  showEmptyCaption = true,
  renderEmpty = true,
  onAvailableChange,
}: DemoMediaProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const src = demoMediaUrl(filename);

  useEffect(() => {
    const probe = new Image();
    probe.onload = () => {
      setLoadState("ready");
      onAvailableChange?.(true);
    };
    probe.onerror = () => {
      setLoadState("missing");
      onAvailableChange?.(false);
    };
    probe.src = src;
    return () => {
      probe.onload = null;
      probe.onerror = null;
    };
  }, [filename, src, onAvailableChange]);

  const caption = showEmptyCaption ? emptyCaption : "";

  if (loadState !== "ready") {
    if (!renderEmpty) {
      return null;
    }
    return (
      <FlowEmptyTile
        caption={caption}
        {...(className ? { className } : {})}
      />
    );
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      onError={() => {
        setLoadState("missing");
        onAvailableChange?.(false);
      }}
    />
  );
}

export function DemoMedia(props: DemoMediaProps) {
  return <DemoMediaProbe key={props.filename} {...props} />;
}
