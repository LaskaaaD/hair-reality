import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  createSession,
  loadBriefLink,
  loadCompareNotes,
  loadPalette,
  saveSalon,
  loadResults,
  retryPreview,
  type CompareNotes,
  type Look,
  type PaletteItem,
  type Results,
} from "../api.js";
import { FeasibilityBadge, ScoreRing } from "../design/index.js";
import { FlowLayout } from "./FlowLayout.js";
import { CompareBoard } from "./CompareBoard.js";
import { TryonPreview } from "./TryonPreview.js";
import { feasibilityTierForCard, fitScoreForCard, previewSourceBadgeLabel } from "./flow-mappers.js";
import { readSalon, type Salon } from "../salon.js";
import { useFlow } from "./flow-state.js";
import { useFlowRouteGuard, useFlowSessionLoader } from "./use-flow-route.js";

type TryonScreenProps = {
  forceLoading?: boolean;
};

type TryonViewMode = "preview" | "compare";

const POLL_MS = 2500;
const TRYON_VIEW_TABS: TryonViewMode[] = ["preview", "compare"];

const TRYON_TAB_IDS: Record<TryonViewMode, { tab: string; panel: string; label: string }> = {
  preview: { tab: "tryon-tab-preview", panel: "tryon-panel-preview", label: "Preview" },
  compare: { tab: "tryon-tab-compare", panel: "tryon-panel-compare", label: "Compare" },
};

function focusTryonViewTab(mode: TryonViewMode) {
  document.getElementById(TRYON_TAB_IDS[mode].tab)?.focus();
}

function onTryonViewTabKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  activeMode: TryonViewMode,
  select: (mode: TryonViewMode) => void,
) {
  const index = TRYON_VIEW_TABS.indexOf(activeMode);
  if (index < 0) return;
  let next: TryonViewMode | null = null;
  if (event.key === "ArrowRight") next = TRYON_VIEW_TABS[(index + 1) % TRYON_VIEW_TABS.length]!;
  if (event.key === "ArrowLeft") next = TRYON_VIEW_TABS[(index - 1 + TRYON_VIEW_TABS.length) % TRYON_VIEW_TABS.length]!;
  if (event.key === "Home") next = "preview";
  if (event.key === "End") next = "compare";
  if (!next) return;
  event.preventDefault();
  select(next);
  focusTryonViewTab(next);
}

function CompareStylesTable({
  looks,
  cardsByKey,
  notes,
  notesLoading,
}: {
  looks: Look[];
  cardsByKey: Map<string, PaletteItem>;
  notes: CompareNotes | null;
  notesLoading: boolean;
}) {
  const ready = looks.filter((look) => look.status === "ready" && look.imageUrl);
  if (ready.length === 0) {
    return <p className="flow-page-subtitle">Compare appears when at least one preview is ready.</p>;
  }

  const noteFor = (look: Look) => notes?.notes.find((note) => note.key === look.key);
  const noteRows: { label: string; value: (look: Look) => ReactNode }[] = [
    { label: "In short", value: (look) => noteFor(look)?.summary ?? (notesLoading ? "Writing…" : "—") },
    {
      label: "Pros",
      value: (look) => {
        const note = noteFor(look);
        return note ? <ul className="e34-compare-list e34-compare-list--pros">{note.pros.map((line) => <li key={line}>{line}</li>)}</ul> : notesLoading ? "Writing…" : "—";
      },
    },
    {
      label: "Watch out for",
      value: (look) => {
        const note = noteFor(look);
        return note ? <ul className="e34-compare-list e34-compare-list--cons">{note.cons.map((line) => <li key={line}>{line}</li>)}</ul> : notesLoading ? "Writing…" : "—";
      },
    },
  ];

  const rows: { label: string; value: (look: Look, card: PaletteItem | undefined) => string }[] = [
    {
      label: "Can do today",
      value: (look, card) => {
        if ((card?.missingCm ?? 0) > 0) return `No (+${card?.missingCm} cm)`;
        return look.label === "realistic" || card?.label === "realistic" ? "Yes" : "Confirm";
      },
    },
    {
      label: "Required growth",
      value: (_look, card) => ((card?.missingCm ?? 0) > 0 ? `${card?.missingCm} cm` : "0 cm"),
    },
    {
      label: "Est. time",
      value: (_look, card) =>
        (card?.missingCm ?? 0) > 0 && card?.months ? `~${card.months} months` : "Now",
    },
    {
      label: "Maintenance",
      value: (_look, card) =>
        card?.maintenanceWeeks
          ? card.maintenanceWeeks >= 6
            ? "Low"
            : card.maintenanceWeeks >= 4
              ? "Medium"
              : "High"
          : "—",
    },
    {
      label: "Styling time",
      value: (_look, card) => (card ? `${card.stylingMinutes} min` : "—"),
    },
  ];

  return (
    <>
    <div className="e34-compare-cards" data-testid="tryon-compare-cards">
      {ready.map((look) => {
        const card = look.key ? cardsByKey.get(look.key) : undefined;
        const note = noteFor(look);
        return (
          <article key={look.id} className="e34-compare-card">
            <header className="e34-compare-card__head">
              {look.imageUrl ? <img src={look.imageUrl} alt="" width={56} height={70} loading="lazy" decoding="async" /> : null}
              <h3>{look.title}</h3>
              <ScoreRing score={card ? fitScoreForCard(card) : look.score} size="sm" />
            </header>
            <p className="e34-compare-card__summary">{note?.summary ?? (notesLoading ? "Writing…" : "")}</p>
            {note ? (
              <div className="e34-compare-card__notes">
                <ul className="e34-compare-list e34-compare-list--pros">{note.pros.map((line) => <li key={line}>{line}</li>)}</ul>
                <ul className="e34-compare-list e34-compare-list--cons">{note.cons.map((line) => <li key={line}>{line}</li>)}</ul>
              </div>
            ) : null}
            <dl className="e34-compare-card__facts">
              {rows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value(look, card)}</dd>
                </div>
              ))}
            </dl>
          </article>
        );
      })}
    </div>
    <div className="e34-compare-table-wrap" data-testid="tryon-compare-table">
      <table className="e34-compare-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Metric</span>
            </th>
            {ready.map((look) => {
              const card = look.key ? cardsByKey.get(look.key) : undefined;
              const score = card ? fitScoreForCard(card) : look.score;
              return (
                <th key={look.id} scope="col" className="e34-compare-col-head">
                  <div className="e34-compare-col-head-inner">
                    {look.imageUrl ? (
                      <img src={look.imageUrl} alt="" width={80} height={100} loading="lazy" decoding="async" />
                    ) : null}
                    <div className="e34-compare-col-title">{look.title}</div>
                    <ScoreRing score={score} size="sm" />
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {noteRows.map((row) => (
            <tr key={row.label} className="e34-compare-note-row">
              <th scope="row">{row.label}</th>
              {ready.map((look) => (
                <td key={look.id}>{row.value(look)}</td>
              ))}
            </tr>
          ))}
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {ready.map((look) => {
                const card = look.key ? cardsByKey.get(look.key) : undefined;
                return <td key={look.id}>{row.value(look, card)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

export function TryonScreen({ forceLoading = false }: TryonScreenProps) {
  const { session, loading, settled, error, refresh } = useFlowSessionLoader();
  const { ui, resetUi } = useFlow();
  const [results, setResults] = useState<Results | null>(null);
  const [paletteItems, setPaletteItems] = useState<PaletteItem[]>([]);
  const [paletteSettled, setPaletteSettled] = useState(false);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<TryonViewMode>("preview");
  const [activeIndex, setActiveIndex] = useState(0);
  const [retryBusy, setRetryBusy] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefLink, setBriefLink] = useState<string | null>(null);
  const [briefNotice, setBriefNotice] = useState<string | null>(null);
  const [compareNotes, setCompareNotes] = useState<CompareNotes | null>(null);
  const [compareNotesLoading, setCompareNotesLoading] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [salon, setSalon] = useState<Salon | null>(null);
  useEffect(() => {
    // sessionStorage only exists in the browser, so the salon is read after hydration
    // oxlint-disable-next-line react/set-state-in-effect -- syncs with external source
    setSalon(readSalon());
  }, []);

  const looks = results?.looks ?? [];
  const hasPreviews = looks.length > 0;

  // Wait for the first results fetch too, so a reload does not bounce back before previews arrive.
  const resultsPending = results === null && resultsError === null;
  useFlowRouteGuard("/demo/tryon", session, loading || !settled || resultsPending, { hasPreviews });

  const readyLooks = looks.filter((look) => look.status === "ready" && look.imageUrl).length;
  useEffect(() => {
    if (viewMode !== "compare" || readyLooks < 2 || compareNotes) return;
    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect -- syncs with external source
    setCompareNotesLoading(true);
    loadCompareNotes()
      .then((next) => {
        if (!cancelled) setCompareNotes(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCompareNotesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewMode, readyLooks, compareNotes]);

  const refreshResults = useCallback(async () => {
    try {
      const next = await loadResults();
      setResults(next);
      setResultsError(null);
    } catch (caught) {
      setResultsError(caught instanceof Error ? caught.message : "Could not load try-on results.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadResults()
      .then((next) => {
        if (cancelled) return;
        setResults(next);
        setResultsError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setResultsError(caught instanceof Error ? caught.message : "Could not load try-on results.");
      });
    loadPalette()
      .then((palette) => {
        if (!cancelled) setPaletteItems(palette.all);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setPaletteSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const pending = (results?.looks ?? []).some((look) => look.status === "pending");
    if (!pending) return;
    const timer = window.setInterval(() => {
      void refreshResults();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [results, refreshResults]);

  const cardsByKey = useMemo(() => {
    const map = new Map<string, PaletteItem>();
    for (const item of paletteItems) map.set(item.key, item);
    return map;
  }, [paletteItems]);

  const active = looks[activeIndex] ?? looks[0];
  const beforePhoto = session?.photos.find((photo) => photo.role === "front");

  const onSendToStylist = async () => {
    setBriefBusy(true);
    setBriefNotice(null);
    try {
      const salon = readSalon();
      if (salon) await saveSalon(salon);
      const token = (await loadBriefLink()) ?? ui.briefToken;
      if (!token) {
        setBriefNotice("We could not create your brief link. Go back to the ranking step and try again.");
        return;
      }
      const link = `${window.location.origin}/brief/${token}`;
      setBriefLink(link);
      try {
        if (navigator.share) {
          await navigator.share({ title: "My haircut consultation brief", url: link });
          setBriefNotice("Brief shared.");
          return;
        }
        await navigator.clipboard.writeText(link);
        setBriefNotice("Link copied. Send it to your stylist: it opens on any device.");
      } catch {
        setBriefNotice("Copy the link below and send it to your stylist.");
      }
    } catch (caught) {
      setBriefNotice(caught instanceof Error ? caught.message : "We could not create your brief link.");
    } finally {
      setBriefBusy(false);
    }
  };

  const onRetry = async (look: Look) => {
    setRetryBusy(true);
    try {
      const next = await retryPreview(look.id);
      setResults(next);
    } catch (caught) {
      setResultsError(caught instanceof Error ? caught.message : "Retry failed.");
    } finally {
      setRetryBusy(false);
    }
  };

  const startOver = async () => {
    resetUi();
    await createSession("haircut");
    await refresh();
    window.location.assign("/demo");
  };

  if (loading && !session) {
    return (
      <FlowLayout step={3} title="Try-on" pageClass="flow-page-e34 e34-tryon-page" backTo="/demo/results">
        <p className="flow-inline-notice">Loading…</p>
      </FlowLayout>
    );
  }

  if (!active) {
    return (
      <FlowLayout step={3} title="Try-on" pageClass="flow-page-e34 e34-tryon-page" backTo="/demo/results" onStartOver={() => void startOver()}>
        <p>Select up to three styles on the ranking screen.</p>
        {resultsError ? <p role="alert">{resultsError}</p> : null}
        <Link className="button" to="/demo/results">
          Back to ranking
        </Link>
      </FlowLayout>
    );
  }

  const sourceLabel = previewSourceBadgeLabel(active.source ?? null);
  const renderReady = active.status === "ready" && Boolean(active.imageUrl);
  const renderFailed = active.status === "failed";
  const anyPending = looks.some((look) => look.status === "pending");
  const anyReady = looks.some((look) => look.status === "ready" && look.imageUrl);

  const activeCard = active.key ? cardsByKey.get(active.key) ?? null : null;
  const sessionTopCm =
    typeof session?.analysis?.hair?.topCm?.value === "number" ? session.analysis.hair.topCm.value : null;

  const showRendering = forceLoading || (anyPending && !anyReady);
  const showForcedError = renderFailed && !showRendering;

  return (
    <FlowLayout
      step={3}
      title="Try-on"
      pageClass="flow-page-e34 e34-tryon-page"
      backTo="/demo/results"
      nextLabel="Done"
      nextTo="/"
      onStartOver={() => void startOver()}
    >
      <div className="e34-tryon-body">
      {error ? (
        <p className="flow-inline-notice" role="alert">
          {error}
        </p>
      ) : null}
      {ui.tryOnNotice ? <p className="flow-inline-notice">{ui.tryOnNotice}</p> : null}
      {resultsError ? (
        <p className="flow-inline-notice" role="alert">
          {resultsError}
        </p>
      ) : null}

      {!showRendering ? (
        <div className="flow-tryon-view-tabs" role="tablist" aria-label="Try-on view">
          {TRYON_VIEW_TABS.map((mode) => {
            const meta = TRYON_TAB_IDS[mode];
            const selected = viewMode === mode;
            return (
              <button
                key={mode}
                id={meta.tab}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={meta.panel}
                tabIndex={selected ? 0 : -1}
                data-active={selected ? "true" : undefined}
                onClick={() => setViewMode(mode)}
                onKeyDown={(event) => onTryonViewTabKeyDown(event, mode, setViewMode)}
              >
                {meta.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {viewMode === "preview" || showRendering ? (
        <div
          id="tryon-panel-preview"
          role="tabpanel"
          aria-labelledby="tryon-tab-preview"
          className="e34-tryon-tabpanel"
        >
          {!showRendering ? (
            <div className="e34-style-switch-wrap">
              <fieldset className="e34-style-switch" aria-label="Rendered styles">
                {looks.map((look, index) => (
                  <button
                    key={look.id}
                    type="button"
                    aria-pressed={index === activeIndex}
                    onClick={() => setActiveIndex(index)}
                  >
                    {look.status === "ready" && look.imageUrl ? (
                      <img
                        src={look.imageUrl}
                        alt=""
                        width={44}
                        height={55}
                        className="e34-style-switch-thumb"
                        loading="eager"
                        decoding="async"
                      />
                    ) : null}
                    <div className="e34-style-switch-copy">
                      <span>Style {index + 1}</span>
                      {look.title}
                    </div>
                  </button>
                ))}
              </fieldset>
            </div>
          ) : null}
          <div className="flow-tryon-layout flow-tryon-layout--looks">
            <TryonPreview
              key={`${active.id}-${active.status}-${showRendering}`}
              {...(beforePhoto?.url ? { beforeSrc: beforePhoto.url } : {})}
              renderUrl={active.imageUrl}
              lookName={active.title}
              forceLoading={showRendering}
              forceError={showForcedError}
              unavailable={active.status === "skipped"}
              errorMessage={resultsError ?? active.failureReason ?? "We could not finish this render."}
              onRetry={() => void onRetry(active)}
              retryBusy={retryBusy}
              sourceLabel={sourceLabel}
            />
            {(
              <div className="flow-tryon-sidebar">
                <div className="flow-tryon-sidebar-top">
                  <section className="flow-card flow-tryon-summary" aria-labelledby="tryon-summary-title">
                    <h2 id="tryon-summary-title" className="flow-card-heading">
                      {active.title}
                    </h2>
                    <div className="flow-tryon-summary__score">
                      <ScoreRing score={activeCard ? fitScoreForCard(activeCard) : active.score} label="Fit" size="md" />
                      {activeCard ? <FeasibilityBadge tier={feasibilityTierForCard(activeCard)} /> : null}
                    </div>
                    {paletteSettled && activeCard ? (
                      <dl className="flow-tryon-summary__facts">
                        <div>
                          <dt>Current top</dt>
                          <dd>{sessionTopCm != null ? `${sessionTopCm} cm` : "—"}</dd>
                        </div>
                        <div>
                          <dt>Styling time</dt>
                          <dd>{activeCard.stylingMinutes} min</dd>
                        </div>
                        <div>
                          <dt>Upkeep</dt>
                          <dd>Every {activeCard.maintenanceWeeks} weeks</dd>
                        </div>
                      </dl>
                    ) : null}
                    <h3 className="flow-tryon-summary__subhead">Why it works</h3>
                    <ul className="flow-tryon-summary__reasons">
                      {(activeCard?.reasons ?? active.reasons)
                        .filter((line) => !/finished for the client's texture|about\s+\d+(?:\.\d+)?\s*cm on top/i.test(line))
                        .slice(0, 3)
                        .map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                    </ul>
                  </section>
                  <div className="flow-tryon-actions">
                    <div className="flow-tryon-action-download">
                      {renderReady && active.imageUrl ? (
                        <a
                          className="button e34-tryon-download-btn"
                          href={active.imageUrl}
                          download={`hair-reality-${active.title}.jpg`}
                        >
                          Download
                        </a>
                      ) : (
                        <>
                          <button type="button" className="button secondary" aria-label="Download PNG" disabled>
                            Download
                          </button>
                          <p className="flow-download-hint" data-testid="download-pending">
                            Available after the render completes
                          </p>
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      className="button flow-tryon-share-btn"
                      aria-busy={briefBusy || undefined}
                      disabled={briefBusy || !anyReady}
                      onClick={() => void onSendToStylist()}
                    >
                      Send to my stylist
                    </button>
                  </div>
                  {salon ? (
                    <p className="flow-download-hint flow-brief-salon">
                      Your brief goes to {salon.name}: your three looks and what your photos showed, ready before the visit.
                    </p>
                  ) : null}
                  {briefNotice ? (
                    <output className="flow-download-hint">
                      {briefNotice}
                    </output>
                  ) : null}
                  {briefLink ? (
                    <div className="flow-brief-link">
                      <a className="flow-brief-link__url" href={briefLink} target="_blank" rel="noreferrer">
                        {briefLink.replace(/^https?:\/\//, "").replace(/(\/brief\/.{8}).*/, "$1…")}
                      </a>
                      <button
                        type="button"
                        className="button secondary flow-brief-link__copy"
                        onClick={() => {
                          void navigator.clipboard.writeText(briefLink).then(
                            () => {
                              setLinkCopied(true);
                              window.setTimeout(() => setLinkCopied(false), 1800);
                            },
                            () => undefined,
                          );
                        }}
                      >
                        {linkCopied ? "Copied" : "Copy link"}
                      </button>
                    </div>
                  ) : null}
                </div>
                <p className="flow-disclaimer">
                  Preview is an AI visualisation by YouCam.
                </p>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {viewMode === "compare" && !showRendering ? (
        <div
          id="tryon-panel-compare"
          role="tabpanel"
          aria-labelledby="tryon-tab-compare"
          className="e34-tryon-tabpanel"
        >
          <div className="flow-tryon-layout flow-tryon-layout--compare">
            <CompareBoard
              beforeSrc={beforePhoto?.url}
              looks={looks}
              cardsByKey={cardsByKey}
              onOpen={(index) => {
                setActiveIndex(index);
                setViewMode("preview");
              }}
            />
            <details className="compare-details" open>
              <summary>Details for each style</summary>
              <CompareStylesTable looks={looks} cardsByKey={cardsByKey} notes={compareNotes} notesLoading={compareNotesLoading} />
            </details>
          </div>
        </div>
      ) : null}

      </div>
    </FlowLayout>
  );
}
