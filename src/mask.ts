/**
 * Phone numbers out of a scraped text, before it is written down.
 *
 * A listing's own description is full of them — a number, a Zalo, a Viber, sometimes the same one
 * three times. Storing that is collecting personal data whether or not anyone meant to: it is a
 * database of contacts the moment it exists, and "we only show a button" is not a property of a
 * database, it is a property of one view of it.
 *
 * So the number never lands. Masking at the point of writing, rather than at the point of showing,
 * is the difference between a system that cannot leak them and one that merely does not today.
 *
 * What this deliberately does NOT do is guess. A flat is described with numbers — 12.000.000 ₫, 45m²,
 * 2 phòng, floor 12 — and a greedy pattern eats them and leaves a listing nobody can read. Vietnamese
 * mobile numbers have a shape, and only that shape goes.
 */

/**
 * A Vietnamese mobile number as people write it: ten digits from a leading zero, or the same with the
 * country code, in any of the spacings and separators real adverts use. Also the international form
 * without the zero, which is what gets pasted from a phone.
 */
const NUMBER = /(?:\+?84|0)(?:[\s.\-()]*\d){9}(?!\d)/g;

/** What replaces it: visible, so a reader understands the number is withheld rather than missing. */
export const WITHHELD = '[скрыто]';

/**
 * Enough digits close together to be a phone and not a price.
 *
 * A price is written with separators in threes — 12.000.000 — and a number is not. This counts the
 * digits and refuses anything that reads as money with a currency mark beside it.
 */
function looksLikeMoney(said: string, whole: string, at: number): boolean {
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(said.replace(/[\s()-]/g, ''))) {
    const after = whole.slice(at + said.length, at + said.length + 12);
    if (/^\s*(?:₫|đ|vnd|triệu|tr\b|k\b|\/)/i.test(after)) return true;
  }
  return false;
}

/** The text with every phone number taken out of it. */
export function mask(said: string | null | undefined): string | null {
  const text = said === null || said === undefined ? '' : String(said);
  if (!text) return said === undefined ? null : said === null ? null : text;

  return text.replace(NUMBER, (found, at: number) => {
    const digits = found.replace(/\D/g, '');
    // Ten digits from a zero, eleven or twelve with the country code. Anything else is not a number.
    if (digits.length < 9 || digits.length > 12) return found;
    if (looksLikeMoney(found, text, at)) return found;
    return WITHHELD;
  });
}

/** Every text column of a row, masked. Numbers and addresses are left alone. */
export function maskRow(row: Record<string, string | null>): Record<string, string | null> {
  const clean: Record<string, string | null> = {};
  for (const [column, value] of Object.entries(row)) {
    clean[column] = typeof value === 'string' ? mask(value) : value;
  }
  return clean;
}
