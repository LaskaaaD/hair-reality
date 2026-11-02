import type { ReactNode } from "react";
import { Button } from "./Button.js";

export type PricingCardProps = {
  title: string;
  priceAmount: string;
  pricePeriod?: string;
  /** Strong line under the price (e.g. render allowance). */
  renderAllowance?: string;
  description: string;
  featured?: boolean;
  badgeLabel?: string;
  ctaLabel?: string;
  ctaTo?: string;
  children?: ReactNode;
};

export function PricingCard({
  title,
  priceAmount,
  pricePeriod,
  renderAllowance,
  description,
  featured = false,
  badgeLabel = "Most popular",
  ctaLabel = "Get started",
  ctaTo = "/demo",
}: PricingCardProps) {
  return (
    <article className={["hr-pricing-card", featured ? "hr-pricing-card--featured" : ""].filter(Boolean).join(" ")}>
      {featured ? <span className="hr-pricing-card__badge">{badgeLabel}</span> : null}
      <h3>{title}</h3>
      <p className="hr-pricing-card__price">
        <span className="hr-pricing-card__amount">{priceAmount}</span>
        {pricePeriod ? <span className="hr-pricing-card__period">{pricePeriod}</span> : null}
      </p>
      {renderAllowance ? (
        <p className="hr-pricing-card__allowance">
          <strong>{renderAllowance}</strong>
        </p>
      ) : null}
      <p className="hr-pricing-card__description">{description}</p>
      {featured ? (
        <Button as="link" to={ctaTo} variant="primary">
          {ctaLabel}
        </Button>
      ) : null}
    </article>
  );
}
