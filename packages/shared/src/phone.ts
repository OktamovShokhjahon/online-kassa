/**
 * Normalises Uzbek phone numbers to E.164 (`+998XXXXXXXXX`).
 * Accepts `+998 90 123 45 67`, `998901234567`, `90 123 45 67`, `(90) 123-45-67`.
 * Returns null when the number is not a valid Uzbek number.
 */
export function normalizePhone(input: string): string | null {
  const digits = (input ?? '').replace(/\D/g, '');
  let national: string;
  if (digits.length === 12 && digits.startsWith('998')) national = digits.slice(3);
  else if (digits.length === 9) national = digits;
  else return null;
  if (!/^\d{9}$/.test(national)) return null;
  return `+998${national}`;
}

/** `+998 90 123 45 67` for display. */
export function formatPhone(e164: string): string {
  const m = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(e164);
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164;
}
