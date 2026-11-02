import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router";

type CommonProps = {
  variant?: "primary" | "secondary";
  children: ReactNode;
  className?: string;
};

type ButtonAsButton = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { as?: "button" };

type ButtonAsLink = CommonProps &
  LinkProps & { as: "link" };

type ButtonAsAnchor = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & { as: "a" };

export type ButtonProps = ButtonAsButton | ButtonAsLink | ButtonAsAnchor;

function classes(variant: "primary" | "secondary", className?: string) {
  return ["hr-btn", variant === "secondary" ? "hr-btn--secondary" : "hr-btn--primary", className]
    .filter(Boolean)
    .join(" ");
}

export function Button(props: ButtonProps) {
  const { variant = "primary", children, className } = props;
  const cls = classes(variant, className);

  if (props.as === "link") {
    const { as: _as, variant: _v, className: _c, style, ...rest } = props;
    const linkStyle = rest["aria-disabled"] ? undefined : style;
    return (
      <Link className={cls} {...rest} {...(linkStyle ? { style: linkStyle } : {})}>
        {children}
      </Link>
    );
  }
  if (props.as === "a") {
    const { as: _as, variant: _v, className: _c, ...rest } = props;
    return (
      <a className={cls} {...rest}>
        {children}
      </a>
    );
  }
  const { as: _as, variant: _v, className: _c, ...rest } = props;
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}
