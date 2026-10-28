/** Guatemala: eight local digits, optionally prefixed by +502. */
export function normalizeClientPhone(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[\d ()-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 8) return `+502${digits}`;
  if (digits.length === 11 && digits.startsWith("502")) return `+${digits}`;
  return null;
}
