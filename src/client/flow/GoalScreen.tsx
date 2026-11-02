import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import {
  createSession,
  loadQuestions,
  saveAnswers,
  type InterviewQuestion,
} from "../api.js";
import { PRESENTATION_QUESTION } from "../../domain/interview.js";
import { emptyAnswers, type Answers } from "../../domain/scoring.js";
import { FlowLayout } from "./FlowLayout.js";
import { confidenceDots } from "./flow-logic.js";
import { mapAnalysisToProfileFields, type ProfileField } from "./flow-mappers.js";
import { useFlow } from "./flow-state.js";
import { useFlowRouteGuard, useFlowSessionLoader } from "./use-flow-route.js";

type LengthChoice = "shorter" | "similar" | "growing";
type MorningChoice = "2" | "5" | "10plus";
type BeardChoice = "keep" | "show" | "clean";

const PRIMARY_QUESTION_IDS = new Set(["stylingMinutes", "facialHair", "presentation", "canGrow", "glassesDaily"]);

/** Haircuts are ranked from one catalogue, so the client picks it. Nothing is preselected and nothing is guessed from the photos. */
const PRESENTATION_OPTIONS = PRESENTATION_QUESTION.options;

const PROFILE_FIX_OPTIONS: Record<string, readonly string[]> = {
  hairType: ["Straight", "Wavy", "Curly", "Coily", "Not sure"],
  density: ["Low", "Medium-light", "Medium", "High", "Not sure"],
  length: ["Short", "Medium", "Long", "Not sure"],
  frizz: ["None", "Light", "Moderate", "High", "Not sure"],
  faceShape: ["Oval", "Round", "Square", "Heart", "Not sure"],
  beard: ["Clean shaven", "Stubble", "Short beard", "Medium beard", "Long beard", "Not sure"],
};

function ConfidenceDots({ confidence }: { confidence: number }) {
  const filled = confidenceDots(confidence);
  return (
    <span className="flow-confidence" aria-label={`Confidence ${filled} of 3`}>
      {[1, 2, 3].map((dot) => (
        <span key={dot} data-on={dot <= filled} />
      ))}
    </span>
  );
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = options[(index + delta + options.length) % options.length];
    if (next) onChange(next.value);
  };

  return (
    <fieldset className="hr-segmented-field">
      <div className="hr-segmented-field__card">
        <legend className="hr-segmented-field__label">{label}</legend>
        <div className="hr-segmented" role="radiogroup" aria-label={label}>
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- styled segmented control with aria-checked
              role="radio"
              aria-checked={value === option.value}
              className="hr-segmented__option"
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

function TextSegmentedQuestion({
  question,
  value,
  onChange,
}: {
  question: InterviewQuestion;
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <SegmentedControl
      label={question.legend}
      value={value ?? question.options[0]?.value ?? ""}
      options={question.options.map((option) => ({ value: option.value, label: option.label }))}
      onChange={onChange}
    />
  );
}

function ProfileAttribute({
  field,
  override,
  editing,
  onFix,
  onSaveFix,
  onCancelFix,
}: {
  field: ProfileField;
  override?: string;
  editing: boolean;
  onFix: () => void;
  onSaveFix: (value: string) => void;
  onCancelFix: () => void;
}) {
  const displayValue = override ?? field.value;
  const options = PROFILE_FIX_OPTIONS[field.id] ?? [field.value, "Not sure"];
  const fixRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const wasEditingRef = useRef(false);

  useEffect(() => {
    if (editing) {
      selectRef.current?.focus();
    } else if (wasEditingRef.current) {
      fixRef.current?.focus();
    }
    wasEditingRef.current = editing;
  }, [editing]);

  const closeFix = () => {
    onCancelFix();
  };

  return (
    <div className="hr-goal__attribute">
      <div className="hr-goal__attribute-head">
        <span className="hr-goal__attribute-label">{field.label}</span>
        {editing ? (
          <button type="button" className="hr-goal__attribute-fix" onClick={closeFix}>
            Done
          </button>
        ) : (
          <button
            ref={fixRef}
            type="button"
            className="hr-goal__attribute-fix"
            onClick={() => onFix()}
          >
            Fix
          </button>
        )}
      </div>
      {editing ? (
        <select
          ref={selectRef}
          className="hr-goal__attribute-select"
          defaultValue={displayValue}
          aria-label={`Correct ${field.label}`}
          onChange={(event) => onSaveFix(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeFix();
            }
          }}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <>
          <span className="hr-goal__attribute-value">{displayValue}</span>
          <ConfidenceDots confidence={field.confidence} />
          {field.source && !override ? <span className="hr-goal__attribute-source">{field.source}</span> : null}
        </>
      )}
    </div>
  );
}

function mapMorningToAnswers(choice: MorningChoice): Answers["stylingMinutes"] {
  if (choice === "10plus") return "30";
  return "5";
}

function mapLengthToAnswers(choice: LengthChoice): Pick<Answers, "canShorten" | "canGrow"> {
  if (choice === "shorter") return { canShorten: "yes", canGrow: "no" };
  if (choice === "growing") return { canShorten: "no", canGrow: "yes" };
  return { canShorten: "no", canGrow: "no" };
}

function mapBeardToAnswers(choice: BeardChoice, detected: string | undefined): Answers["facialHair"] {
  if (choice === "clean") return "none";
  if (choice === "show") {
    if (detected && detected !== "Not sure" && detected !== "Clean shaven") {
      const lower = detected.toLowerCase();
      if (lower.includes("stubble")) return "stubble";
      if (lower.includes("short")) return "short";
      if (lower.includes("medium")) return "medium";
      if (lower.includes("long")) return "long";
      if (lower.includes("moustache")) return "moustache";
    }
    return "stubble";
  }
  return "unknown";
}

function inferLengthChoice(answers: Record<string, string>): LengthChoice {
  if (answers.canGrow === "yes" || answers.canGrow === "a-little") return "growing";
  if (answers.canShorten === "yes") return "shorter";
  return "similar";
}

function inferMorningChoice(answers: Record<string, string>): MorningChoice {
  if (answers.stylingMinutes === "30") return "10plus";
  if (answers.stylingMinutes === "15") return "5";
  return "5";
}

export function GoalScreen() {
  const { session, loading, settled, error, refresh } = useFlowSessionLoader();
  const { ui, patchUi, resetUi } = useFlow();
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [lengthChoice, setLengthChoice] = useState<LengthChoice>("similar");
  const [morningChoice, setMorningChoice] = useState<MorningChoice>("5");
  const [beardChoice, setBeardChoice] = useState<BeardChoice>("keep");
  const [editingField, setEditingField] = useState<string | null>(null);
  const [questionsError, setQuestionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitErrorRef = useRef<HTMLParagraphElement>(null);

  useFlowRouteGuard("/demo/goal", session, loading || !settled);

  useEffect(() => {
    if (submitError) {
      submitErrorRef.current?.focus({ preventScroll: true });
    }
  }, [submitError]);

  useEffect(() => {
    if (!session) return;
    const merged: Record<string, string> = { ...emptyAnswers(), ...session.answers };
    // oxlint-disable-next-line react/set-state-in-effect -- syncs with session/external source
    setAnswers(merged);
    setLengthChoice(inferLengthChoice(merged));
    setMorningChoice(inferMorningChoice(merged));
    // A note saved earlier in this session comes back into the textarea (the client state only lives until a reload).
    if (merged.wish && !ui.goalText) patchUi({ goalText: merged.wish });
    // oxlint-disable-next-line react/exhaustive-deps -- runs when the session loads, not on every keystroke
  }, [session]);

  useEffect(() => {
    if (!session) return;
    void loadQuestions()
      .then(setQuestions)
      .catch((caught: unknown) => {
        setQuestionsError(caught instanceof Error ? caught.message : "Could not load questions.");
      });
  }, [session]);

  useEffect(() => {
    if (!session || session.analysisStatus !== "running") return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refresh, session]);

  const profileFields = useMemo(() => mapAnalysisToProfileFields(session?.analysis ?? null), [session?.analysis]);
  const frontPhoto = session?.photos.find((photo) => photo.role === "front") ?? session?.photos[0];

  const moreQuestions = useMemo(
    () => questions.filter((question) => !PRIMARY_QUESTION_IDS.has(question.id)),
    [questions],
  );

  const setAnswer = (id: string, value: string) => {
    setAnswers((current) => ({ ...current, [id]: value }));
  };

  const buildSavePayload = (): Record<string, string> => {
    const base = { ...emptyAnswers(), ...session?.answers, ...answers };
    const lengthMapped = mapLengthToAnswers(lengthChoice);
    const detectedBeard = profileFields.find((field) => field.id === "beard")?.value;
    return {
      ...base,
      stylingMinutes: mapMorningToAnswers(morningChoice),
      // Morning time also says whether the client reaches for a dryer and products, so those are not asked separately.
      blowdryer: morningChoice === "10plus" ? "yes" : morningChoice === "2" ? "no" : "unknown",
      products: morningChoice === "10plus" ? "yes" : morningChoice === "2" ? "no" : "unknown",
      canShorten: lengthMapped.canShorten,
      canGrow: lengthMapped.canGrow,
      // The beard question is only shown for men's styles; anything else leaves the beard unspecified.
      facialHair: base.presentation === "masculine" ? mapBeardToAnswers(beardChoice, detectedBeard) : "unknown",
      wish: ui.goalText.trim().slice(0, 300),
    };
  };

  const startOver = async () => {
    resetUi();
    await createSession("haircut");
    await refresh();
    navigate("/demo");
  };

  const onContinue = async () => {
    if (!session || busy) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await saveAnswers(buildSavePayload(), ui.profileOverrides);
      // The ranking itself runs once on the results screen, which shows the processing state straight away.
      navigate("/demo/results");
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : "Could not save your answers.");
    } finally {
      setBusy(false);
    }
  };

  const analysisReady = session?.analysisStatus === "ready";
  const presentationMissing =
    session?.service === "haircut" && !PRESENTATION_OPTIONS.some((option) => option.value === answers.presentation);

  if (loading && !session) {
    return (
      <FlowLayout step={1} title="Your goal" pageClass="flow-page-goal" backTo="/demo">
        <p className="flow-inline-notice">Loading…</p>
      </FlowLayout>
    );
  }

  return (
    <FlowLayout
      step={1}
      title="Your goal"
      subtitle="Tell us what you want — we use it with your photo profile."
      pageClass={["flow-page-goal", busy ? "hr-goal--submitting" : ""].filter(Boolean).join(" ")}
      backTo="/demo"
      nextLabel={busy ? "Finding styles…" : "Show suggestions"}
      nextDisabled={busy || !analysisReady || presentationMissing}
      nextBusy={busy}
      onNext={() => void onContinue()}
      onStartOver={() => void startOver()}
      footerStrip={
        submitError ? (
          <p
            ref={submitErrorRef}
            className="hr-goal__submit-error"
            role="alert"
            tabIndex={-1}
          >
            {submitError}
          </p>
        ) : null
      }
    >
      {error ? (
        <p className="flow-inline-notice" role="alert">
          {error}
        </p>
      ) : null}
      {session?.analysisStatus === "running" ? (
        <p className="flow-inline-notice" data-testid="analysis-status">
          Still reading your photos…
        </p>
      ) : null}
      {session?.analysisStatus === "failed" ? (
        <p className="flow-inline-notice" role="alert" data-testid="analysis-status">
          {session.analysisNotice ?? "Photo reading failed. Go back and retake your photos."}
        </p>
      ) : null}

      <div className="hr-goal__layout">
        <section className="hr-goal__card hr-goal__see" aria-labelledby="see-heading">
          <div className="hr-goal__see-head">
            {frontPhoto ? (
              <img
                className="hr-goal__portrait hr-goal__portrait--mobile"
                src={frontPhoto.url}
                alt=""
                aria-hidden="true"
                width={48}
                height={64}
                decoding="async"
              />
            ) : null}
            <h2 id="see-heading" className="hr-goal__card-title">
              Big picture
            </h2>
          </div>
          <div className="hr-goal__see-body">
            {frontPhoto ? (
              <img
                className="hr-goal__portrait hr-goal__portrait--desktop"
                src={frontPhoto.url}
                alt="Your front view from this session"
                width={96}
                height={128}
                decoding="async"
              />
            ) : null}
            <div className="hr-goal__attributes e12-findings-metrics">
              {profileFields.map((field) => {
                const override = ui.profileOverrides[field.id];
                return (
                  <ProfileAttribute
                    key={field.id}
                    field={field}
                    {...(override ? { override } : {})}
                    editing={editingField === field.id}
                    onFix={() => setEditingField(field.id)}
                    onSaveFix={(value) => {
                      patchUi({ profileOverrides: { ...ui.profileOverrides, [field.id]: value } });
                      setEditingField(null);
                    }}
                    onCancelFix={() => setEditingField(null)}
                  />
                );
              })}
            </div>
          </div>
        </section>

        <div className="hr-goal__right">
          <label className="flow-card flow-goal-text hr-goal__textarea-card">
            <span className="hr-goal__textarea-label">Describe what you want (optional)</span>
            <textarea
              rows={2}
              placeholder="e.g. something shorter for work, low styling, cover temples"
              value={ui.goalText}
              onChange={(event) => patchUi({ goalText: event.target.value })}
            />
          </label>

          <div className="hr-goal__preferences">
            {session?.service === "haircut" ? (
              <SegmentedControl
                label="Styles for"
                value={answers.presentation ?? "auto"}
                options={PRESENTATION_OPTIONS}
                onChange={(value) => setAnswer("presentation", value)}
              />
            ) : null}
            {presentationMissing ? (
              <p className="flow-inline-notice" data-testid="presentation-required">
                Choose men&apos;s styles, women&apos;s styles or both to continue.
              </p>
            ) : null}
            <SegmentedControl
              label="Length"
              value={lengthChoice}
              options={[
                { value: "shorter", label: "Shorter" },
                { value: "similar", label: "Similar" },
                { value: "growing", label: "Growing out" },
              ]}
              onChange={setLengthChoice}
            />
            <SegmentedControl
              label="Morning time"
              value={morningChoice}
              options={[
                { value: "2", label: "2 min" },
                { value: "5", label: "5 min" },
                { value: "10plus", label: "10+ min" },
              ]}
              onChange={setMorningChoice}
            />
            {session?.service === "haircut" && answers.presentation === "masculine" ? (
              <SegmentedControl
                label="Beard"
                value={beardChoice}
                options={[
                  { value: "keep", label: "Keep" },
                  { value: "show", label: "Show beard" },
                  { value: "clean", label: "Clean shave" },
                ]}
                onChange={setBeardChoice}
              />
            ) : null}
            {session?.service === "haircut" ? (
              <SegmentedControl
                label="Glasses most days"
                value={answers.glassesDaily ?? "unknown"}
                options={[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ]}
                onChange={(value) => setAnswer("glassesDaily", value)}
              />
            ) : null}
          </div>
        </div>
      </div>

      <details
        className="flow-expander hr-goal__more"
        open={ui.moreQuestionsOpen}
        onToggle={(event) => patchUi({ moreQuestionsOpen: event.currentTarget.open })}
      >
        <summary>
          <span className="flow-expander-chevron hr-goal__more-chevron" aria-hidden="true" />
          More questions
        </summary>
        <div className="hr-goal__more-body">
          {questionsError ? <p role="alert">{questionsError}</p> : null}
          {moreQuestions.map((question) => (
            <TextSegmentedQuestion
              key={question.id}
              question={question}
              value={answers[question.id]}
              onChange={(value) => setAnswer(question.id, value)}
            />
          ))}
        </div>
      </details>
    </FlowLayout>
  );
}
