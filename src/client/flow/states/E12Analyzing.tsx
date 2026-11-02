type E12AnalyzingProps = {
  frontPhotoUrl?: string;
};

// The four YouCam reads that run for every client, plus the photo read that fills in what YouCam does not return.
const TASKS = [
  "Hair type from the front and side photos",
  "Hair density from the top of your head",
  "Frizz level",
  "Face shape and attributes",
];

export function E12Analyzing({ frontPhotoUrl }: E12AnalyzingProps) {
  return (
    <section className="e12-analyzing" data-testid="e12-analyzing" aria-live="polite">
      <div className="e12-analyzing-visual">
        {frontPhotoUrl ? (
          <img
            src={frontPhotoUrl}
            alt=""
            className="e12-analyzing-photo"
            width={320}
            height={400}
            decoding="async"
          />
        ) : (
          <div className="e12-analyzing-photo e12-analyzing-photo--empty" aria-hidden="true" />
        )}
        <div className="e12-analyzing-scan" aria-hidden="true" />
      </div>
      <div className="e12-analyzing-copy">
        <h2>Analyzing your hair</h2>
        <p>YouCam reads your hair type, density, frizz and face shape from your four photos. This can take up to a minute.</p>
        <ul className="e12-analyzing-tasks">
          {TASKS.map((task) => (
            <li key={task}>
              <span className="e12-analyzing-task-mark" aria-hidden="true" />
              {task}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
