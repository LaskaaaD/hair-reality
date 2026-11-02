import { isBlockedAddress, type ResolvedAddress } from "../../assets/download.js";

const MAX_REDIRECTS = 3;

export type TransferRejection =
  | "url_rejected"
  | "allowlist_empty"
  | "redirect_limit"
  | "address_rejected";

export function validateTransferUrl(
  value: string,
  allowlist: readonly string[],
): { ok: true; url: URL } | { ok: false; reason: TransferRejection } {
  if (allowlist.length === 0) return { ok: false, reason: "allowlist_empty" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "url_rejected" };
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return { ok: false, reason: "url_rejected" };
  }
  const host = url.hostname.toLowerCase();
  if (!allowlist.some((allowed) => allowed.toLowerCase() === host)) {
    return { ok: false, reason: "url_rejected" };
  }
  if (host.includes("*")) return { ok: false, reason: "url_rejected" };
  return { ok: true, url };
}

export function addressesAllowed(records: readonly ResolvedAddress[]): boolean {
  return records.length > 0 && records.every((record) => !isBlockedAddress(record.address));
}

export function nextRedirect(status: number, location: string | undefined, current: URL, hops: number): URL | "limit" | null {
  if (![301, 302, 303, 307, 308].includes(status)) return null;
  if (hops >= MAX_REDIRECTS) return "limit";
  if (!location) return "limit";
  try {
    return new URL(location, current);
  } catch {
    return "limit";
  }
}
