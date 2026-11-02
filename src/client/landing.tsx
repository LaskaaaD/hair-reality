import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  AppHeader,
  Button,
  PictureImg,
} from "./design/index.js";
import { useReveal } from "./design/reveal.js";
import { rankedStyleById, type RankedStyle } from "./flow/fixtures.js";
import { buildSalonLink, DEFAULT_SALON_COLOR, normaliseSalon } from "./salon.js";

const SALON_COLORS = [
  { value: DEFAULT_SALON_COLOR, label: "Forest", tone: "forest" },
  { value: "#b4532a", label: "Terracotta", tone: "terracotta" },
  { value: "#2f4a7a", label: "Navy", tone: "navy" },
  { value: "#7a2f4a", label: "Plum", tone: "plum" },
  { value: "#3b3b3b", label: "Graphite", tone: "graphite" },
] as const;

function SalonLinkGenerator() {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_SALON_COLOR);
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");

  const salon = normaliseSalon(name, color);
  const link = salon && origin ? buildSalonLink(origin, salon) : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("done");
    } catch {
      setCopied("manual");
    }
  };

  return (
    <div className="landing-pilot__card">
      <label className="landing-pilot__label" htmlFor="salon-name">
        Salon or barbershop name
      </label>
      <input
        id="salon-name"
        className="landing-pilot__input"
        type="text"
        maxLength={40}
        autoComplete="organization"
        placeholder="e.g. Studio Aria"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setCopied("idle");
        }}
      />
      <fieldset className="landing-pilot__colors">
        <legend className="landing-pilot__label">Accent colour</legend>
        {SALON_COLORS.map((option) => (
          <label key={option.value} className="landing-pilot__swatch">
            <input
              type="radio"
              name="salon-color"
              value={option.value}
              checked={color === option.value}
              onChange={() => setColor(option.value)}
            />
            <span className={`landing-pilot__dot landing-pilot__dot--${option.tone}`} aria-hidden="true" />
            <span className="visually-hidden">{option.label}</span>
          </label>
        ))}
      </fieldset>
      <label className="landing-pilot__label" htmlFor="salon-link">
        Your link
      </label>
      <input
        id="salon-link"
        className="landing-pilot__input landing-pilot__link"
        type="text"
        readOnly
        value={link}
        placeholder="Type your salon name to create the link"
        onFocus={(event) => event.target.select()}
      />
      <div className="landing-pilot__actions">
        <Button type="button" disabled={!link} onClick={() => void copy()}>
          Copy link
        </Button>
        {link ? (
          <Button as="a" variant="secondary" href={link} target="_blank" rel="noreferrer">
            Open as a client
          </Button>
        ) : null}
      </div>
      <output className="landing-pilot__hint">
        {copied === "done" ? "Link copied." : copied === "manual" ? "Select the link above and copy it." : "No account needed. Nothing is saved on our side."}
      </output>
    </div>
  );
}

const media = (file: string) => `/demo-media/${file}`;

const NAV_LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#salons", label: "For salons" },
  { href: "#pilot", label: "Salon pilot" },
];


const PHOTO_ANGLES = [
  { src: media("sample-front.jpg"), label: "Front" },
  { src: media("sample-left.jpg"), label: "Turn left" },
  { src: media("sample-right.jpg"), label: "Turn right" },
  { src: media("sample-down.jpg"), label: "Top of head" },
] as const;

const FLOW_STEPS = [
  {
    id: "photos",
    title: "Take four photos",
    copy: "Front, turn head left, turn head right and top of head. About a minute with your phone.",
    notes: ["Even daylight, no harsh shadows", "Hair dry and worn naturally", "Face and hairline fully visible"],
  },
  {
    id: "goal",
    title: "Say what you want",
    copy: "A few quick questions about your hair and your routine, plus an optional note in your own words.",
    notes: ["Length: shorter, similar or growing out", "Morning time and overall vibe", "Beard: keep it or show it"],
  },
  {
    id: "pick",
    title: "Pick three cuts",
    copy: "Real styles matched to your hair, grouped by what it can hold today, with small changes or after growth.",
    notes: ["Fit score on every style", "Shortlist up to three", "Your own idea counts too"],
  },
  {
    id: "tryon",
    title: "See them on you",
    copy: "Realistic previews of each pick on your own photo.",
    notes: ["Before / after on your face", "Compare your picks side by side", "Send a brief to your stylist"],
  },
] as const;

const TRYON_PAIR = [
  { src: media("tryon-textured-crop.jpg"), label: "Textured crop" },
  { src: media("tryon-side-part.jpg"), label: "Classic side part" },
] as const;

const GOAL_CHIPS = [
  { question: "Length", answer: "Similar" },
  { question: "Morning time", answer: "5 min" },
  { question: "Beard", answer: "Keep" },
] as const;

function requireRanked(id: string): RankedStyle {
  const style = rankedStyleById(id);
  if (!style) throw new Error(`Missing ranked style fixture: ${id}`);
  return style;
}

const HERO_SPLIT_STYLE = requireRanked("caesar-short");
const RANKING_STYLE_IDS = [
  "textured-crop",
  "curtain-medium",
  "mullet-modern",
  "man-bun-grow",
  "slick-back",
] as const;
const SCORE_STYLE_IDS = ["textured-crop", "curtain-medium", "mullet-modern", "slick-back"] as const;

function landingStyle(style: RankedStyle) {
  return {
    id: style.id,
    name: style.name,
    score: style.fit,
    src: media(style.imageFilename),
    outcome: style.realismLabel,
    why: style.why,
  };
}

/** Stylist-style "why it suits you" lines for the sample profile (2B wavy, medium–high density). */
const RANKING_SUMMARIES: Record<(typeof RANKING_STYLE_IDS)[number], string> = {
  "textured-crop":
    "A textured fringe softens a longer face, and a low taper keeps width at the temples. Easy to style.",
  "curtain-medium":
    "Curtains open the centre of your forehead but still frame your face. Your natural movement does the work.",
  "man-bun-grow":
    "Pulling the length back shows off your cheekbones. Keep the sides soft so the face doesn't look longer.",
  "mullet-modern": "Soft layers suit your hair's texture. Keep the back moderate, not a hard burst fade.",
  "slick-back": "An open forehead plus height on top lengthens the face. It works, but a fringe flatters you more.",
};

const RANKED_VARIANTS = RANKING_STYLE_IDS.map((id) => ({
  ...landingStyle(requireRanked(id)),
  summary: RANKING_SUMMARIES[id],
})).sort((a, b) => b.score - a.score);
const AUDIENCE = [
  {
    id: "clients",
    heading: "For clients.",
    items: [
      { title: "See yourself first", line: "Realistic previews of cuts matched to your face and hair." },
      { title: "Expectation meets reality", line: "Know what your hair can hold before the first snip." },
      { title: "No more explaining", line: "Show your stylist the look instead of trying to describe it." },
      { title: "Honest options", line: "Cuts that work today, plus the ones worth growing into." },
    ],
  },
  {
    id: "salons",
    heading: "For salon owners.",
    items: [
      { title: "Happier clients", line: "The result matches what they saw, so fewer disappointments." },
      { title: "Quicker consultations", line: "Clients sit down with a look already chosen." },
      { title: "Natural upsell", line: "Clients see new cuts and services on themselves before they book." },
      { title: "Clients who come back", line: "A cut that matches the preview builds trust and repeat visits." },
    ],
  },
] as const;

const STYLE_EXAMPLES = SCORE_STYLE_IDS.map((id) => landingStyle(requireRanked(id)));

const STEP_THUMB_WIDTHS = [240, 280] as const;
const FOOTER_YEAR = 2026;

function Section({ id, className, children }: { id?: string; className: string; children: ReactNode }) {
  return (
    <section className={className} {...(id ? { id } : {})}>
      {children}
    </section>
  );
}

function HeroChip({ children }: { children: ReactNode }) {
  return <span className="hero__chip">{children}</span>;
}

/** Score bar drawn with SVG attributes: the page CSP blocks inline style attributes. */
function ScoreTrack({ value, compact }: { value: number; compact?: boolean }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <svg
      className={`landing-fit-score__track${compact ? " landing-fit-score__track--compact" : ""}`}
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="landing-fit-score__fill" x="0" y="0" width={clamped} height="6" />
    </svg>
  );
}

function TrustDotIcon() {
  return (
    <svg className="landing-hero__trust-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 7.2 6.2 9 9.8 5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function FlowStepVisual({ id }: { id: (typeof FLOW_STEPS)[number]["id"] }) {
  if (id === "photos") {
    return (
      <div className="landing-flow__visual landing-flow-photos">
        {PHOTO_ANGLES.map((angle) => (
          <figure key={angle.label} className="landing-flow-photos__item">
            <PictureImg
              src={angle.src}
              alt=""
              width={512}
              height={640}
              loading="lazy"
              decoding="async"
              responsiveWidths={STEP_THUMB_WIDTHS}
              sizes="(min-width: 1024px) 10vw, 25vw"
            />
            <figcaption>{angle.label}</figcaption>
          </figure>
        ))}
      </div>
    );
  }
  if (id === "goal") {
    return (
      <div className="landing-flow__visual landing-flow-goal">
        {GOAL_CHIPS.map((chip) => (
          <div key={chip.question} className="landing-flow-goal__row">
            <span className="landing-flow-goal__question">{chip.question}</span>
            <span className="landing-flow-goal__answer">{chip.answer}</span>
          </div>
        ))}
      </div>
    );
  }
  if (id === "pick") {
    return (
      <div className="landing-flow__visual landing-flow-pick">
        {STYLE_EXAMPLES.slice(0, 3).map((style) => (
          <figure key={style.id} className="landing-flow-pick__item">
            <PictureImg
              src={style.src}
              alt=""
              width={512}
              height={640}
              loading="lazy"
              decoding="async"
              responsiveWidths={STEP_THUMB_WIDTHS}
              sizes="(min-width: 1024px) 10vw, 25vw"
            />
            <figcaption>
              <span className="landing-flow-pick__score">{style.score}%</span> fit
            </figcaption>
          </figure>
        ))}
        <div className="landing-flow-pick__item landing-flow-pick__ref">
          <span className="landing-flow-pick__plus" aria-hidden="true">
            +
          </span>
          <span>Your idea</span>
        </div>
      </div>
    );
  }
  return (
    <div className="landing-flow__visual landing-flow-tryon">
      {TRYON_PAIR.map((item) => (
        <figure key={item.src} className="landing-flow-tryon__item">
          <PictureImg
            src={item.src}
            alt=""
            width={512}
            height={640}
            loading="lazy"
            decoding="async"
            responsiveWidths={STEP_THUMB_WIDTHS}
            sizes="(min-width: 1024px) 14vw, 45vw"
          />
          <figcaption>{item.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function LandingPage() {
  useReveal();

  return (
    <div className="marketing-page landing-page">
      <AppHeader links={NAV_LINKS} cta={{ to: "/demo", label: "Try the demo" }} />

      <main id="main" role="main">
        <div data-marketing-screen="hero">
          <section className="marketing-section landing-hero">
            <div className="landing-hero__inner">
              <div className="landing-hero__copy">
                <p className="landing-hero__eyebrow">For salons &amp; barbershops</p>
                <h1>Show clients what their hair can hold.</h1>
                <p className="landing-hero__lede">
                  Clients try three cuts on themselves, and your stylist gets a consultation brief before the visit.
                </p>
                <div className="landing-hero__actions">
                  <Button as="link" to="/demo" reloadDocument>
                    Try the client demo
                  </Button>
                  <Button as="a" href="#pilot" variant="secondary">
                    Get your salon link
                  </Button>
                </div>
                <p className="landing-hero__trust">
                  <span>
                    <TrustDotIcon />
                    No client signup
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    <TrustDotIcon />
                    Powered by YouCam AI
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    <TrustDotIcon />
                    Sample output shown
                  </span>
                </p>
              </div>

              <div className="landing-hero__visual">
              <figure className="landing-hero__split" data-reveal>
                <picture>
                  <source srcSet={media("hero-split.webp")} type="image/webp" />
                  <img
                    className="landing-hero__split-img"
                    src={media("hero-split.jpg")}
                    alt={`The same man shown half and half: his current medium-length curtain hair on the left, and a ${HERO_SPLIT_STYLE.name.toLowerCase()} preview on the right.`}
                    width={820}
                    height={1024}
                    loading="eager"
                    fetchPriority="high"
                    decoding="async"
                  />
                </picture>
                <span className="landing-hero__split-divider" aria-hidden="true" />
                <figcaption className="landing-hero__split-labels">
                  <span className="landing-hero__split-label">Current hair</span>
                  <span className="landing-hero__split-label landing-hero__split-label--preview">
                    Preview · {HERO_SPLIT_STYLE.name}
                  </span>
                </figcaption>
              </figure>
              <aside className="landing-hero__note" aria-label="Why Hair Reality">
                <p className="landing-hero__note-eyebrow">Why Hair Reality</p>
                <p className="landing-hero__note-title">Not every cut fits every head of hair.</p>
                <p className="landing-hero__note-copy">
                  Fewer “that’s not what I showed you” moments, and a stylist who knows what the client wants.
                </p>
              </aside>
              </div>
            </div>
          </section>

          <Section className="marketing-section landing-rank" id="problem">
            <div className="landing-rank__inner">
              <figure className="landing-rank__input" data-reveal>
                <PictureImg
                  src={media("sample-front.jpg")}
                  alt="Sample input photo: a man with medium-length wavy hair, front view"
                  width={640}
                  height={800}
                  loading="lazy"
                  decoding="async"
                  responsiveWidths={[480, 640, 960]}
                  sizes="(min-width: 960px) 34vw, 100vw"
                />
                <HeroChip>Your photo</HeroChip>
              </figure>
              <div className="landing-rank__text">
                <p className="landing-rank__eyebrow">Sample ranking</p>
                <h2>Cuts ranked for your face and your hair.</h2>
                <p className="landing-rank__lede">
                  Our algorithm matches every style to your face shape, features and hair type, then ranks the cuts
                  that will actually work for you.
                </p>
              </div>
              <ol
                className="landing-rank__list"
                // Scrollable on mobile: must be keyboard-focusable (WCAG 2.1.1).
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                aria-label="Sample style ranking for this profile"
              >
                {RANKED_VARIANTS.map((tile, index) => (
                  <li
                    key={tile.id}
                    className={`landing-rank__card${index === 0 ? " landing-rank__card--top" : ""}`}
                    data-reveal
                  >
                    <div className="landing-rank__media">
                      <img src={tile.src} alt={`${tile.name} on the sample face`} width={240} height={320} loading="lazy" decoding="async" />
                      <span className="landing-rank__pos" aria-label={`Rank ${index + 1}`}>
                        #{index + 1}
                      </span>
                      {index === 0 ? <span className="landing-rank__best">Best match</span> : null}
                    </div>
                    <div className="landing-rank__body">
                      <p className="landing-rank__name">{tile.name}</p>
                      <p className="landing-rank__summary">{tile.summary}</p>
                      <div className="landing-rank__score">
                        <ScoreTrack value={tile.score} />
                        <span className="landing-rank__value">{tile.score}%</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </Section>
        </div>

        <div data-marketing-screen="product">
          <Section className="marketing-section landing-flow" id="how-it-works">
            <div className="landing-flow__inner">
              <header className="landing-flow__head">
                <p className="landing-flow__eyebrow">How it works</p>
                <h2>From four photos to cuts you&apos;ll actually wear.</h2>
                <p className="landing-flow__lede">
                  Hair Reality reads hair type, density, frizz and face shape from four quick photos with the YouCam
                  API, ranks real cuts by what that hair can hold, and shows your favourites on you with YouCam
                  hair try-on before anyone picks up the scissors.
                </p>
              </header>
              <ol className="landing-flow__list">
                {FLOW_STEPS.map((step, index) => (
                  <li key={step.id} className={`landing-flow__step landing-flow__step--${step.id}`} data-reveal>
                    <span className="landing-flow__num" aria-hidden="true">
                      {index + 1}
                    </span>
                    <article className="landing-flow__card">
                      <div className="landing-flow__text">
                        <h3>{step.title}</h3>
                        <p className="landing-flow__copy">{step.copy}</p>
                        <ul className="landing-flow__notes">
                          {step.notes.map((note) => (
                            <li key={note}>{note}</li>
                          ))}
                        </ul>
                      </div>
                      <FlowStepVisual id={step.id} />
                    </article>
                  </li>
                ))}
              </ol>
            </div>
          </Section>

          <Section className="marketing-section landing-lower landing-band-surface" id="stylist-salons">
            <div className="landing-audience">
              <header className="landing-audience__head">
                <p className="landing-audience__eyebrow">Who it&apos;s for</p>
                <h2>Better cuts for clients. Better days for salons.</h2>
              </header>
              <div className="landing-audience__cols">
                {AUDIENCE.map((group) => (
                  <div
                    key={group.id}
                    id={group.id === "clients" ? "stylist" : "salons"}
                    className={`landing-audience__col landing-audience__col--${group.id}`}
                    data-reveal
                  >
                    <h3>{group.heading}</h3>
                    <ul className="landing-audience__list">
                      {group.items.map((item) => (
                        <li key={item.title} className="landing-audience__item">
                          <p className="landing-audience__title">{item.title}</p>
                          <p className="landing-audience__line">{item.line}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </Section>
        </div>

        <div data-marketing-screen="salons-pricing">
          <Section className="marketing-section landing-pilot landing-lower landing-band-raised" id="pilot">
            <div className="landing-pilot__inner">
              <div className="landing-pilot__head">
                <p className="landing-audience__eyebrow">Pilot with your salon</p>
                <h2>Your salon link, ready in ten seconds.</h2>
                <p>
                  Share it by message, QR or on your website. Clients do the hair analysis and try-on at home, then send
                  your stylist a consultation brief that opens on any device.
                </p>
                <ol className="landing-pilot__steps">
                  <li>Create your link below. It carries your salon’s name and colour.</li>
                  <li>Your client takes four photos, picks three cuts and sees them on themselves.</li>
                  <li>They tap “Send to my stylist”. You open the brief before the appointment.</li>
                </ol>
              </div>
              <SalonLinkGenerator />
            </div>
          </Section>

          <section className="marketing-closer landing-closer landing-lower">
            <div className="landing-closer-shell">
              <div className="landing-closer-split">
                <div className="landing-closer-ink">
                  <div className="marketing-closer-content landing-closer-inner">
                    <h2>Stop guessing in the chair.</h2>
                    <p className="landing-closer-sub">Real hair. Real analysis. Real results.</p>
                    <div className="marketing-closer-actions">
                      <Button as="link" to="/demo" reloadDocument>
                        Open the demo
                      </Button>
                      <Button as="a" href="#how-it-works" variant="secondary" className="landing-closer-secondary">
                        How it works
                      </Button>
                    </div>
                    <p className="landing-closer-caption">Four photos. No account for your clients.</p>
                  </div>
                </div>
                <PictureImg
                  className="landing-closer-photo"
                  src={media("tryon-side-part.jpg")}
                  alt=""
                  width={1024}
                  height={1024}
                  loading="lazy"
                  decoding="async"
                  responsiveWidths={[640, 960, 1024]}
                  sizes="(min-width: 960px) 50vw, 100vw"
                />
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="marketing-footer landing-footer">
        <Link className="brand" to="/">
          Hair Reality
        </Link>
        <nav className="marketing-footer-links" aria-label="Footer">
          <a href="#how-it-works">How it works</a>
          <a href="#salons">For salons</a>
          <a href="#pilot">Salon pilot</a>
        </nav>
        <span className="landing-footer-copy">© {FOOTER_YEAR} Hair Reality. All rights reserved.</span>
      </footer>
    </div>
  );
}
