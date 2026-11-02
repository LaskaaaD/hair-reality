import type { Look, PaletteItem } from "../api.js";
import { fitScoreForCard } from "./flow-mappers.js";

type CompareBoardProps = {
  beforeSrc: string | undefined;
  looks: Look[];
  cardsByKey: Map<string, PaletteItem>;
  onOpen: (index: number) => void;
};

function shortReason(look: Look, card: PaletteItem | undefined): string {
  const line = (card?.reasons ?? look.reasons).find((reason) => reason.trim().length > 0) ?? "";
  return line.length > 110 ? `${line.slice(0, 107).trimEnd()}…` : line;
}

export function CompareBoard({ beforeSrc, looks, cardsByKey, onOpen }: CompareBoardProps) {
  return (
    <section className="compare-board" aria-label="Your picks side by side">
      <ul className="compare-board__row">
        {beforeSrc ? (
          <li className="compare-board__tile compare-board__tile--you">
            <img src={beforeSrc} alt="You, current hair" width={320} height={400} />
            <div className="compare-board__caption">
              <p className="compare-board__name">You today</p>
              <p className="compare-board__reason">Your current hair, for comparison.</p>
            </div>
          </li>
        ) : null}
        {looks.map((look, index) => {
          const card = look.key ? cardsByKey.get(look.key) : undefined;
          const score = Math.round(card ? fitScoreForCard(card) : look.score);
          const ready = look.status === "ready" && look.imageUrl;
          return (
            <li key={look.id} className="compare-board__tile">
              {ready ? (
                <button type="button" className="compare-board__open" onClick={() => onOpen(index)}>
                  <img src={look.imageUrl ?? ""} alt={`You with ${look.title}`} width={320} height={400} />
                  <span className="compare-board__hint">See before / after</span>
                </button>
              ) : (
                <div className="compare-board__pending">
                  {look.status === "failed" ? "This preview could not be created." : "Still creating this preview…"}
                </div>
              )}
              <div className="compare-board__caption">
                <p className="compare-board__name">{look.title}</p>
                <p className="compare-board__score">{score}% fit</p>
                <p className="compare-board__reason">{shortReason(look, card)}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
