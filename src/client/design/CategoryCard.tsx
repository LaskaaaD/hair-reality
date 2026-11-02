export type CategoryCardProps = {
  title: string;
  description?: string;
  imageSrc: string;
  imageAlt: string;
  selected?: boolean;
  onSelect?: () => void;
};

export function CategoryCard({
  title,
  description,
  imageSrc,
  imageAlt,
  selected = false,
  onSelect,
}: CategoryCardProps) {
  return (
    <button
      type="button"
      className={["hr-category-card", selected ? "hr-category-card--selected" : ""].filter(Boolean).join(" ")}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <img src={imageSrc} alt={imageAlt} width={400} height={480} loading="lazy" decoding="async" />
      <div className="hr-category-card__body">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      {selected ? <span className="hr-category-card__check" aria-hidden="true">✓</span> : null}
    </button>
  );
}
