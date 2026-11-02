import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  createSession,
  DemoRequestError,
  loadPalette,
  loadReferences,
  loadResults,
  recommend,
  renderLooks,
  uploadReference,
  type PaletteItem,
  type RecommendationCard,
  type ReferenceView,
} from "../api.js";
import { FeasibilityBadge, GrowthTimeline, ScoreRing } from "../design/index.js";
import { FlowLayout } from "./FlowLayout.js";
import { StyleCardImage } from "./StyleCardImage.js";
import {
  deduplicateRankingCardImages,
  feasibilityTierForCard,
  FEMININE_YOU_INSET_FILENAME,
  fitScoreForCard,
  isFeminineStyleCard,
  rankingGroupFor,
  rankingGroupLabel,
  whyTextForCard,
  type ResolvedRankingCardImage,
} from "./flow-mappers.js";
import { mergeRankingCards } from "./ranking-groups.js";
import { demoMediaPath } from "./states/question-media.js";
import { MAX_SELECTED_STYLES, toggleStyleSelection, defaultSelectedStyleKeys, sharedReferenceNotice } from "./flow-logic.js";
import { useFlow } from "./flow-state.js";
import { useFlowRouteGuard, useFlowSessionLoader } from "./use-flow-route.js";

type RankCard = RecommendationCard | PaletteItem;

function paletteFields(card: RankCard): Pick<PaletteItem, "feasible" | "targetLengthCm" | "criteria"> {
  if ("feasible" in card) {
    return {
      feasible: card.feasible ?? null,
      targetLengthCm: card.targetLengthCm ?? null,
      criteria: card.criteria,
    };
  }
  return { feasible: null, targetLengthCm: null, criteria: undefined };
}

const MAX_REFERENCES = 3;

const TOP_PICKS = 3;
const TOP_LIST = 10;
const TOP_TOTAL = 50;

const MATCHING_STEPS = [
  "Reading your hair and face",
  "Matching real cuts to your profile",
  "Ranking the best fits",
];

function growthStageImage(card: RankCard): string {
  return demoMediaPath(isFeminineStyleCard(card) ? FEMININE_YOU_INSET_FILENAME : "style-textured-crop.jpg");
}

function FitScore({ value, size }: { value: number; size: "lg" | "sm" }) {
  const clamped = Math.max(0, Math.min(100, value));
  const shown = `${Math.round(clamped)}%`;
  return (
    <div className={`flow-fit flow-fit--${size}`}>
      <span className="flow-fit-value">{shown}</span>
      <span className="flow-fit-label">fit</span>
      <meter className="visually-hidden" value={clamped} min={0} max={100} aria-label="Fit score">
        {shown}
      </meter>
      <div className="flow-score-bar" aria-hidden="true">
        <svg className="flow-score-bar-svg" viewBox="0 0 100 6" preserveAspectRatio="none">
          <rect className="flow-score-bar-fill" x="0" y="0" width={clamped} height="6" rx="3" />
        </svg>
      </div>
    </div>
  );
}

function GrowthPanel({
  card,
  currentTopCm,
}: {
  card: RankCard;
  currentTopCm: number | null;
}) {
  const missing = card.missingCm ?? 0;
  const current = currentTopCm ?? 0;
  const target = paletteFields(card).targetLengthCm ?? current + missing;
  const progress = target > 0 ? Math.min(100, (current / target) * 100) : 0;
  const stageSrc = growthStageImage(card);
  const midLabel =
    card.months != null
      ? `In ~${Math.max(1, Math.round(card.months * 4))} weeks`
      : "Mid growth";
  const targetLabel =
    card.months != null
      ? `In ~${card.months} ${card.months === 1 ? "month" : "months"}`
      : "Target look";
  return (
    <section className="e34-detail-section" aria-labelledby="e34-growth-title">
      <h3 id="e34-growth-title">Your growth plan</h3>
      <dl className="e34-growth-metrics">
        <div>
          <dt>You are here</dt>
          <dd>{current > 0 ? `${current} cm` : "Confirm length"}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{target > 0 ? `${target} cm` : "—"}</dd>
        </div>
        <div>
          <dt>Missing</dt>
          <dd data-missing={missing > 0 ? "true" : undefined}>
            {missing > 0 ? `${missing} cm` : "None"}
          </dd>
        </div>
      </dl>
      <div className="e34-growth-bar" aria-hidden="true">
        <svg className="flow-score-bar-svg" viewBox="0 0 100 6" preserveAspectRatio="none">
          <rect className="flow-score-bar-fill" x="0" y="0" width={Math.max(0, Math.min(100, progress))} height="6" rx="3" />
        </svg>
      </div>
      {card.months != null ? (
        <p className="flow-page-subtitle">
          Estimated time ~ {card.months} {card.months === 1 ? "month" : "months"} at average growth.
        </p>
      ) : null}
      <GrowthTimeline
        className="e34-growth-timeline"
        stages={[
          { label: "Today", imageSrc: stageSrc, imageAlt: `${card.title} at current length` },
          { label: midLabel, imageSrc: stageSrc, imageAlt: `${card.title} mid growth` },
          { label: targetLabel, imageSrc: stageSrc, imageAlt: `${card.title} target length` },
        ]}
      />
    </section>
  );
}

function StyleDetailDrawer({
  card,
  index,
  total,
  currentTopCm,
  onClose,
  onTogglePick,
  isSelected,
  pickBlocked,
  resolvedImage,
}: {
  card: RankCard;
  index: number;
  total: number;
  currentTopCm: number | null;
  onClose: () => void;
  onTogglePick: () => void;
  isSelected: boolean;
  pickBlocked: boolean;
  resolvedImage?: ResolvedRankingCardImage;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needsGrowth = (card.missingCm ?? 0) > 0;
  const positives = card.reasons.slice(0, 4);
  const watches =
    paletteFields(card).criteria?.filter((item) => item.status !== "ok").map((item) => item.text) ?? [];

  return (
    <div className="e34-drawer-layer">
      <button type="button" className="e34-drawer-backdrop" aria-label="Close style details" onClick={onClose} />
      <dialog
        className="e34-drawer"
        open
        aria-labelledby="e34-detail-title"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <div className="e34-drawer-header">
          <div>
            <p className="flow-page-subtitle">
              Style {index + 1} of {total}
            </p>
            <h2 id="e34-detail-title" className="e34-display">
              {card.title}
            </h2>
            <FeasibilityBadge tier={feasibilityTierForCard(card)} />
          </div>
          <ScoreRing score={fitScoreForCard(card)} label="Score" size="sm" />
        </div>
        <div className="e34-drawer-grid">
          <div className="e34-style-card-media e34-drawer-card-media">
            <StyleCardImage card={card} alt={card.title} {...(resolvedImage ? { resolvedImage } : {})} />
          </div>
          <div>
            <section className="e34-detail-section">
              <h3>Why it works</h3>
              <ul className="e34-detail-list">
                {(positives.length ? positives : [whyTextForCard(card)]).map((line) => (
                  <li key={line} data-kind="ok">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
            {watches.length > 0 ? (
              <section className="e34-detail-section">
                <h3>What needs changing</h3>
                <ul className="e34-detail-list">
                  {watches.map((line: string) => (
                    <li key={line} data-kind="watch">
                      {line}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {!needsGrowth ? (
              <section className="e34-detail-section">
                <h3>You can do this today</h3>
                <p>{whyTextForCard(card)}</p>
              </section>
            ) : (
              <GrowthPanel card={card} currentTopCm={currentTopCm} />
            )}
          </div>
        </div>
        <div className="e34-style-card-actions e34-drawer-card-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Back to results
          </button>
          <button
            type="button"
            className={`button${isSelected ? " secondary" : ""}`}
            aria-pressed={isSelected}
            disabled={pickBlocked}
            onClick={onTogglePick}
          >
            {isSelected ? "Remove from shortlist" : "Add to shortlist"}
          </button>
        </div>
      </dialog>
    </div>
  );
}

function MatchingLoading({ thumbs }: { thumbs: ReactNode }) {
  return (
    <section className="e34-matching-loading" data-testid="ranking-loading" aria-busy="true" aria-live="polite">
      <h2>Finding your best matches…</h2>
      <p>We compare real styles with your hair type, face shape, texture and routine.</p>
      <ul className="e34-matching-checklist">
        {MATCHING_STEPS.map((step) => (
          <li key={step} data-active="true">
            {step}
          </li>
        ))}
      </ul>
      <div className="e34-matching-visual">{thumbs}</div>
    </section>
  );
}

function rankByFit(cards: RankCard[]): RankCard[] {
  return [...cards].sort((a, b) => fitScoreForCard(b) - fitScoreForCard(a) || b.score - a.score);
}

function RankedCard({
  card,
  rank,
  variant,
  isSelected,
  pickBlocked,
  userFrontUrl,
  youThumbFilename,
  resolvedImage,
  onOpen,
  onPick,
}: {
  card: RankCard;
  rank: number;
  variant: "best" | "compact";
  isSelected: boolean;
  pickBlocked: boolean;
  userFrontUrl: string | null;
  youThumbFilename: string;
  resolvedImage: ResolvedRankingCardImage | undefined;
  onOpen: () => void;
  onPick: () => void;
}) {
  return (
    <li>
      <article
        className={`flow-style-card flow-style-card--${variant}`}
        data-selected={isSelected ? "true" : undefined}
        data-pick-blocked={pickBlocked ? "true" : undefined}
      >
        <div className="flow-style-card-media">
          <span className="flow-style-rank">#{rank}</span>
          <StyleCardImage card={card} alt={`${card.title} reference photo`} {...(resolvedImage ? { resolvedImage } : {})} />
          {variant === "best" ? (
            <div className="flow-style-youcam-inset" aria-hidden="true">
              <div className="flow-style-youcam-inset-thumb e34-ranking-you-thumb">
                <img src={userFrontUrl ?? demoMediaPath(youThumbFilename)} alt="" />
              </div>
              <span className="flow-style-youcam-inset-chip">You</span>
            </div>
          ) : null}
        </div>
        <div className="flow-style-card-body">
          <span className="flow-style-group">{rankingGroupLabel(rankingGroupFor(card))}</span>
          <button type="button" className="flow-style-card-title" onClick={onOpen}>
            {card.title}
          </button>
          <FitScore value={fitScoreForCard(card)} size={variant === "best" ? "lg" : "sm"} />
          <p className="flow-style-realism">
            <span>{whyTextForCard(card)}</span>
          </p>
          <button
            type="button"
            className={`flow-pick-toggle flow-style-card-pick${isSelected ? " flow-pick-toggle--picked" : ""}`}
            aria-pressed={isSelected}
            aria-disabled={pickBlocked ? true : undefined}
            title={pickBlocked ? "Up to 3 styles" : undefined}
            aria-describedby={pickBlocked ? "flow-pick-limit-hint" : undefined}
            onClick={onPick}
          >
            {isSelected ? "Picked" : "Pick for try-on"}
          </button>
        </div>
      </article>
    </li>
  );
}

export function RankingScreen() {
  const { session, loading, settled, error, refresh } = useFlowSessionLoader();
  const { ui, patchUi, resetUi } = useFlow();
  const navigate = useNavigate();
  const [cards, setCards] = useState<RankCard[]>([]);
  const [paletteAll, setPaletteAll] = useState<PaletteItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recommendLoading, setRecommendLoading] = useState(true);
  const [recommendDone, setRecommendDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [limitMessage, setLimitMessage] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [references, setReferences] = useState<ReferenceView[]>([]);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const defaultsApplied = useRef(false);
  const tryOnInFlight = useRef(false);

  const selected = ui.selectedStyleKeys;

  useFlowRouteGuard("/demo/results", session, loading || !settled, {
    hasRecommendations: recommendLoading || cards.length > 0 || recommendDone,
  });

  useEffect(() => {
    if (!session || session.analysisStatus !== "ready") return;
    let cancelled = false;
    void (async () => {
      setRecommendLoading(true);
      setLoadError(null);
      try {
        const [rec, palette, refs] = await Promise.all([recommend(), loadPalette(), loadReferences()]);
        if (cancelled) return;
        const merged = mergeRankingCards(
          rec.recommendations ?? [],
          rec.goals ?? [],
          palette.top,
          palette.all,
        ).filter((card) => !card.key.startsWith("reference:"));
        setCards(merged);
        setPaletteAll(palette.all);
        setReferences(refs);
        if (rec.briefToken) patchUi({ briefToken: rec.briefToken });
        if (!defaultsApplied.current && merged.length > 0) {
          defaultsApplied.current = true;
          const orderedForDefaults = rankByFit(merged);
          patchUi({
            selectedStyleKeys: defaultSelectedStyleKeys(
              orderedForDefaults.map((card) => {
                const entry: { key: string; title: string; family?: string; referencePhoto?: string | null; renderable?: boolean } = { key: card.key, title: card.title, referencePhoto: card.referencePhoto ?? null };
                if (card.renderable === false) entry.renderable = false;
                if (card.family) entry.family = card.family;
                return entry;
              }),
            ),
          });
        }
      } catch (caught) {
        if (!cancelled) {
          setLoadError(caught instanceof Error ? caught.message : "Could not load recommendations.");
        }
      } finally {
        if (!cancelled) {
          setRecommendLoading(false);
          setRecommendDone(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patchUi, session]);

  const catalog = useMemo(() => (cards.length > 0 ? cards : paletteAll), [cards, paletteAll]);

  const flatCards = useMemo(() => rankByFit(catalog).slice(0, TOP_TOTAL), [catalog]);
  const bestCards = flatCards.slice(0, TOP_PICKS);
  const otherCards = flatCards.slice(TOP_PICKS, TOP_LIST);
  const moreCards = flatCards.slice(TOP_LIST);
  const moreOpen = showMore || moreCards.some((card) => selected.includes(card.key));
  const userFrontUrl = session?.photos.find((photo) => photo.role === "front")?.url ?? null;
  const cardImageByKey = useMemo(() => deduplicateRankingCardImages(flatCards), [flatCards]);
  const isFeminineRanking = useMemo(
    () =>
      session?.answers?.presentation === "feminine" ||
      flatCards.some((card) => isFeminineStyleCard(card)),
    [flatCards, session?.answers?.presentation],
  );
  const youThumbFilename = isFeminineRanking ? FEMININE_YOU_INSET_FILENAME : "sample-front.jpg";

  const detailCard = detailKey ? catalog.find((card) => card.key === detailKey) ?? null : null;
  const detailIndex = detailCard ? flatCards.findIndex((c) => c.key === detailCard.key) : -1;

  const currentTopCm =
    typeof session?.analysis?.hair?.topCm?.value === "number"
      ? session.analysis.hair.topCm.value
      : null;

  const tryToggle = (key: string) => {
    if (!selected.includes(key) && selected.length >= MAX_SELECTED_STYLES) {
      setLimitMessage("You can pick up to 3 styles. Deselect one to choose another.");
      return;
    }
    if (!selected.includes(key) && catalog.find((card) => card.key === key)?.renderable === false) {
      setLimitMessage("This style can't be previewed on you yet (no safe reference photo for it). Pick another one.");
      return;
    }
    const clash = selected.includes(key) ? null : sharedReferenceNotice(catalog, selected, key);
    if (clash) {
      setLimitMessage(clash);
      return;
    }
    setLimitMessage("");
    patchUi({ selectedStyleKeys: toggleStyleSelection(selected, key) });
  };

  const atPickLimit = selected.length >= MAX_SELECTED_STYLES;

  const addReference = (file: File) => {
    void (async () => {
      setReferenceBusy(true);
      setReferenceError(null);
      try {
        const { id } = await uploadReference(file);
        const refs = await loadReferences();
        setReferences(refs);
        await recommend(id, true);
        const refKey = `reference:${id}`;
        if (!selected.includes(refKey) && selected.length < MAX_SELECTED_STYLES) {
          patchUi({ selectedStyleKeys: [...selected, refKey] });
        }
      } catch (caught) {
        setReferenceError(
          caught instanceof DemoRequestError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : "Could not upload that reference.",
        );
      } finally {
        setReferenceBusy(false);
      }
    })();
  };

  const startOver = async () => {
    resetUi();
    await createSession("haircut");
    await refresh();
    navigate("/demo");
  };

  const onGeneratePreviews = async () => {
    if (selected.length === 0 || busy || tryOnInFlight.current) return;
    tryOnInFlight.current = true;
    setBusy(true);
    setLoadError(null);
    patchUi({ tryOnNotice: null });
    try {
      await renderLooks(selected);
      navigate("/demo/tryon");
    } catch (caught) {
      if (caught instanceof DemoRequestError && caught.code === "too_many") {
        const results = await loadResults();
        const existingKeys = new Set(
          results.looks.map((look) => look.key).filter((key): key is string => Boolean(key)),
        );
        const pickDiffers = selected.some((key) => !existingKeys.has(key));
        patchUi({
          tryOnNotice: pickDiffers
            ? "This session already has three try-ons. Showing your existing previews — start over to change picks."
            : null,
        });
        navigate("/demo/tryon");
        return;
      }
      setLoadError(caught instanceof Error ? caught.message : "Could not start try-on renders.");
    } finally {
      setBusy(false);
      tryOnInFlight.current = false;
    }
  };

  if (loading && !session) {
    return (
      <FlowLayout step={2} title="Ranking" pageClass="flow-page-ranking flow-page-e34" backTo="/demo/goal">
        <p className="flow-inline-notice">Loading…</p>
      </FlowLayout>
    );
  }

  return (
    <FlowLayout
      step={2}
      title="Ranking"
      subtitle="Ranked for your hair and face. Pick up to three to see on yourself."
      pageClass="flow-page-ranking flow-page-e34 e34-ranking-page"
      backTo="/demo/goal"
      selectionSummary={`${selected.length} of ${MAX_SELECTED_STYLES} selected`}
      nextLabel={busy ? "Starting…" : "Try on"}
      nextDisabled={selected.length === 0 || busy}
      onNext={() => void onGeneratePreviews()}
      onStartOver={() => void startOver()}
      footerStrip={
        limitMessage ? (
          <output className="flow-inline-notice" aria-live="polite">
            {limitMessage}
          </output>
        ) : null
      }
    >
      <p className="visually-hidden" aria-live="polite">
        {selected.length} of {MAX_SELECTED_STYLES} selected
      </p>
      <span id="flow-pick-limit-hint" className="visually-hidden">
        Up to 3 styles
      </span>
      {error ? (
        <p className="flow-inline-notice" role="alert">
          {error}
        </p>
      ) : null}
      {loadError ? (
        <p className="flow-inline-notice" role="alert">
          {loadError}
        </p>
      ) : null}

      {recommendLoading ? (
        <MatchingLoading
          thumbs={catalog.slice(0, 6).map((card) => {
            const resolvedImage = cardImageByKey.get(card.key);
            return (
              <StyleCardImage
                key={card.key}
                card={card}
                alt=""
                className="e34-matching-thumb"
                {...(resolvedImage ? { resolvedImage } : {})}
              />
            );
          })}
        />
      ) : catalog.length === 0 ? (
        <div className="e34-empty-state" data-testid="ranking-empty">
          <h2>We couldn&apos;t find strong matches yet</h2>
          <p>Review your photos and goals so we can rank styles that fit your hair today.</p>
          <button type="button" className="button secondary" onClick={() => navigate("/demo/goal")}>
            Review your goal
          </button>
        </div>
      ) : (
        <div className="e34-ranking-body flow-ranking-scroll">
          <section className="flow-ranking-group" aria-labelledby="rank-best-title">
            <div className="flow-ranking-group-heading">
              <h2 id="rank-best-title">Best matches</h2>
              <p className="flow-ranking-group-meta">Your top {bestCards.length}, ranked for your hair and face</p>
            </div>
            <ul className="flow-style-grid flow-style-grid--best">
              {bestCards.map((card, index) => (
                <RankedCard
                  key={card.key}
                  card={card}
                  rank={index + 1}
                  variant="best"
                  isSelected={selected.includes(card.key)}
                  pickBlocked={!selected.includes(card.key) && atPickLimit}
                  userFrontUrl={userFrontUrl}
                  youThumbFilename={youThumbFilename}
                  resolvedImage={cardImageByKey.get(card.key)}
                  onOpen={() => setDetailKey(card.key)}
                  onPick={() => tryToggle(card.key)}
                />
              ))}
              {references.map((ref) => {
                const refKey = `reference:${ref.id}`;
                const isSelected = selected.includes(refKey);
                const pickBlocked = !isSelected && atPickLimit;
                return (
                  <li key={ref.id}>
                    <article
                      className="flow-style-card flow-style-card--best flow-reference-card"
                      data-selected={isSelected ? "true" : undefined}
                      data-pick-blocked={pickBlocked ? "true" : undefined}
                    >
                      <div className="flow-style-card-media">
                        <img src={ref.url} alt="Your reference hairstyle" className="flow-reference-thumb" />
                      </div>
                      <div className="flow-style-card-body">
                        <span className="flow-style-group">Your reference</span>
                        <span className="flow-style-card-title">Your own photo</span>
                        <p className="flow-style-realism">Your choice, added by you. Shown as is, not scored.</p>
                        <button
                          type="button"
                          className={`flow-pick-toggle flow-style-card-pick${isSelected ? " flow-pick-toggle--picked" : ""}`}
                          aria-pressed={isSelected}
                          aria-disabled={pickBlocked ? true : undefined}
                          onClick={() => tryToggle(refKey)}
                        >
                          {isSelected ? "Picked" : "Pick for try-on"}
                        </button>
                      </div>
                    </article>
                  </li>
                );
              })}
              {references.length < MAX_REFERENCES ? (
                <li>
                  <label className="flow-style-card flow-style-card--best flow-reference-add">
                    <span className="flow-reference-add-plus" aria-hidden="true">{referenceBusy ? "…" : "+"}</span>
                    <span className="flow-reference-add-text">{referenceBusy ? "Uploading…" : "Add a photo of a cut you like"}</span>
                    {referenceError ? <span className="flow-reference-add-error" role="alert">{referenceError}</span> : null}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      data-testid="reference-upload"
                      className="visually-hidden"
                      disabled={referenceBusy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) addReference(file);
                      }}
                    />
                  </label>
                </li>
              ) : null}
            </ul>
          </section>

          {otherCards.length > 0 ? (
            <section className="flow-ranking-group" aria-labelledby="rank-other-title">
              <div className="flow-ranking-group-heading">
                <h2 id="rank-other-title">Other great matches</h2>
                <p className="flow-ranking-group-meta">#{TOP_PICKS + 1}–#{TOP_PICKS + otherCards.length}</p>
              </div>
              <ul className="flow-style-grid flow-style-grid--compact">
                {otherCards.map((card, index) => (
                  <RankedCard
                    key={card.key}
                    card={card}
                    rank={TOP_PICKS + index + 1}
                    variant="compact"
                    isSelected={selected.includes(card.key)}
                    pickBlocked={!selected.includes(card.key) && atPickLimit}
                    userFrontUrl={userFrontUrl}
                    youThumbFilename={youThumbFilename}
                    resolvedImage={cardImageByKey.get(card.key)}
                    onOpen={() => setDetailKey(card.key)}
                    onPick={() => tryToggle(card.key)}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {moreCards.length > 0 ? (
            <section className="flow-ranking-group" aria-labelledby="rank-more-title">
              <h2 id="rank-more-title" className="visually-hidden">More matches</h2>
              {moreOpen ? (
                <ul id="rank-more-grid" className="flow-style-grid flow-style-grid--compact">
                  {moreCards.map((card, index) => (
                    <RankedCard
                      key={card.key}
                      card={card}
                      rank={TOP_LIST + index + 1}
                      variant="compact"
                      isSelected={selected.includes(card.key)}
                      pickBlocked={!selected.includes(card.key) && atPickLimit}
                      userFrontUrl={userFrontUrl}
                      youThumbFilename={youThumbFilename}
                      resolvedImage={cardImageByKey.get(card.key)}
                      onOpen={() => setDetailKey(card.key)}
                      onPick={() => tryToggle(card.key)}
                    />
                  ))}
                </ul>
              ) : null}
              <button
                type="button"
                className="button secondary flow-ranking-show-more"
                aria-expanded={moreOpen}
                aria-controls="rank-more-grid"
                onClick={() => setShowMore(!moreOpen)}
              >
                {moreOpen ? "Show fewer" : `Explore ${moreCards.length} more`}
              </button>
            </section>
          ) : null}
        </div>
      )}

      {detailCard ? (
        <StyleDetailDrawer
          card={detailCard}
          index={detailIndex >= 0 ? detailIndex : 0}
          total={flatCards.length || catalog.length}
          currentTopCm={currentTopCm}
          onClose={() => setDetailKey(null)}
          onTogglePick={() => tryToggle(detailCard.key)}
          isSelected={selected.includes(detailCard.key)}
          pickBlocked={!selected.includes(detailCard.key) && atPickLimit}
          {...(cardImageByKey.get(detailCard.key) ? { resolvedImage: cardImageByKey.get(detailCard.key)! } : {})}
        />
      ) : null}
    </FlowLayout>
  );
}
