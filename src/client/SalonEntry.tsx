import { useEffect, useMemo } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import { normaliseSalon, writeSalon } from "./salon.js";

/** A salon link: remembers the salon for this browser tab, then opens the client demo. */
export function SalonEntry() {
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const fallbackName = slug.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const name = params.get("name") ?? fallbackName;
  const color = params.get("color");
  const salon = useMemo(() => normaliseSalon(name, color), [name, color]);

  useEffect(() => {
    if (salon) writeSalon(salon);
  }, [salon]);

  return <Navigate to="/demo" replace />;
}
