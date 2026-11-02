export function safeNextPath(value: string | null): string | null {
  if (value === null || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("\\") || value.includes("\0") || value.includes("://")) return null;
  try {
    const url = new URL(value, "http://127.0.0.1");
    if (url.origin !== "http://127.0.0.1") return null;
    const path = value.split("?")[0]?.split("#")[0];
    if (url.pathname !== path) return null;
  } catch {
    return null;
  }
  return value;
}
