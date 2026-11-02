import { useEffect, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router";
import { loadBrief, type Brief } from "./api.js";
import { mapAnalysisToProfileFields } from "./flow/flow-mappers.js";
import { salonStyleVars } from "./salon.js";

type BriefState = { status: "loading" } | { status: "missing" } | { status: "ready"; brief: Brief };

function expiryLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "soon" : date.toLocaleDateString("en", { day: "numeric", month: "long" });
}

function upkeepLabel(weeks: number | null): string | null {
  return weeks ? `Visit every ${weeks} weeks` : null;
}

export function BriefPage() {
  const { token = "" } = useParams();
  const [state, setState] = useState<BriefState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadBrief(token)
      .then((brief) => {
        if (!cancelled) setState({ status: "ready", brief });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === "loading") {
    return (
      <main id="main" className="brief-page">
        <p className="flow-inline-notice">Opening the consultation brief…</p>
      </main>
    );
  }

  if (state.status === "missing") {
    return (
      <main id="main" className="brief-page">
        <div className="brief-empty">
          <h1>This brief is no longer available</h1>
          <p>Briefs expire after 7 days. Ask your client to send a fresh link from their try-on.</p>
          <Link className="button" to="/" reloadDocument>
            About Hair Reality
          </Link>
        </div>
      </main>
    );
  }

  const { brief } = state;
  const fields = mapAnalysisToProfileFields(brief.analysis).filter((field) => field.value !== "Not sure");
  const wish = brief.answers.wish?.trim();
  const styling = brief.answers.stylingMinutes;
  const glasses = brief.answers.glassesDaily;

  return (
    <main
      id="main"
      className="brief-page"
      style={brief.salon ? (salonStyleVars(brief.salon) as CSSProperties) : undefined}
    >
      <header className="brief-head">
        <div>
          <p className="brief-eyebrow">{brief.salon ? brief.salon.name : "Hair Reality"} · Consultation brief</p>
          <h1>Before the cut: what your client wants, and what their hair can do</h1>
        </div>
        <button type="button" className="button secondary brief-print" onClick={() => window.print()}>
          Print
        </button>
      </header>

      <section className="brief-card brief-client" aria-labelledby="brief-client-title">
        {brief.photoUrl ? <img src={brief.photoUrl} alt="Client, front view" width={240} height={300} /> : null}
        <div className="brief-client-body">
          <h2 id="brief-client-title">Hair and face reading</h2>
          <dl className="brief-facts">
            {fields.map((field) => (
              <div key={field.id}>
                <dt>{field.label}</dt>
                <dd>
                  {field.value}
                  {field.source ? <span className="brief-source">{field.source}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          {wish || styling || glasses ? (
            <ul className="brief-notes">
              {wish ? <li>Client says: “{wish}”</li> : null}
              {styling ? <li>Time they will spend styling: about {styling} min a day</li> : null}
              {glasses === "yes" ? <li>Wears glasses most days</li> : null}
            </ul>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="brief-looks-title">
        <h2 id="brief-looks-title" className="brief-section-title">
          The {brief.looks.length === 1 ? "cut" : `${brief.looks.length} cuts`} they picked
        </h2>
        {brief.looks.length === 0 ? (
          <p className="brief-empty-note">No previews were created yet. Ask your client to finish the try-on step.</p>
        ) : (
          <ol className="brief-looks">
            {brief.looks.map((look, index) => (
              <li key={look.id} className="brief-card brief-look">
                <img src={look.imageUrl} alt={`Client wearing ${look.title}`} width={240} height={300} loading="lazy" />
                <div className="brief-look-body">
                  <p className="brief-rank">Pick {index + 1}</p>
                  <h3>{look.title}</h3>
                  <p className="brief-score">{Math.round(look.score)}% fit for this hair</p>
                  <ul>
                    {look.reasons.slice(0, 2).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  {look.tellYourBarber ? <p className="brief-barber">For the stylist: {look.tellYourBarber}</p> : null}
                  <p className="brief-meta">
                    {[
                      look.stylingMinutes ? `${look.stylingMinutes} min to style` : null,
                      upkeepLabel(look.maintenanceWeeks),
                      look.missingCm && look.missingCm > 0 ? `Needs about ${look.missingCm} cm more length` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="brief-foot">
        <p>
          Hair, face and density readings come from the YouCam API; previews are YouCam AI try-ons. They are a guide for
          the consultation, not a promise of the final result.
        </p>
        <p>Anyone with this link can see the client’s photo and previews. It stops working on {expiryLabel(brief.expiresAt)}.</p>
      </footer>
    </main>
  );
}
