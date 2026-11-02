import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "./Button.js";

export type AppHeaderProps = {
  brandTo?: string;
  links?: { href: string; label: string }[];
  cta?: { to: string; label: string };
  menuExtra?: ReactNode;
  className?: string;
};

export function AppHeader({
  brandTo = "/",
  links = [],
  cta = { to: "/demo", label: "Try the demo" },
  menuExtra,
  className,
}: AppHeaderProps) {
  return (
    <header className={["hr-app-header", "marketing-nav", "landing-nav", className].filter(Boolean).join(" ")}>
      <Link className="brand" to={brandTo}>
        Hair Reality
      </Link>
      <nav aria-label="Primary">
        {links.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
      <Button as="link" to={cta.to} reloadDocument className="landing-nav-cta">
        {cta.label}
      </Button>
      <details className="marketing-menu landing-menu">
        <summary aria-label="Menu">Menu</summary>
        <nav aria-label="Mobile">
          {links.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
          <Button as="link" to={cta.to} reloadDocument className="landing-nav-cta">
            {cta.label}
          </Button>
          {menuExtra}
        </nav>
      </details>
    </header>
  );
}
