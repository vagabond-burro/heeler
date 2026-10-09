// The shot-date filter's arithmetic (2026-09-23, brainstormed and
// settled): YYYY-MM-DD as the canonical form, a partial value as a
// span, two fields From and To, inclusive, empty meaning unbounded.
//
// YYYY-MM-DD because it is the order the data is already in (EXIF
// writes "2025:08:23 13:39:13"), because it sorts as text, so the whole
// range mechanism is two string comparisons, and because it means one
// day everywhere ("03/04/2025" is two different days in two countries).
// Typing is forgiven: any separator or none, single-digit month and
// day, a trailing separator while typing, and the US order MM/DD/YYYY
// when it is unmistakable (two digits or fewer first, a four-digit year
// last), shown back normalized so the field teaches the form by
// example. Four-digit years only, and no relative words: both are room
// for a wrong guess.

/** A parsed field: the canonical text, or why it is not a date. */
export type ParsedDate = { canon: string; precision: "year" | "month" | "day" } | { error: string };

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysIn(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return MONTH_DAYS[month - 1];
}

/** Reads what was typed as a year, a month or a day. Empty is not an
 * error: it is "no bound", and the caller reads it as such. */
export function parseDateInput(text: string): ParsedDate {
  const raw = text.trim();
  if (!raw) return { error: "" };
  if (/^[+-]/.test(raw)) return { error: "Use an unsigned four-digit year: YYYY-MM-DD" };
  // A run of digits, or digits split by one of the separators people
  // use; a trailing separator is what the field looks like mid-typing.
  const parts = raw.split(/[-/.:\s]+/).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) {
    return { error: "Type a date as YYYY-MM-DD, or just a year or a month" };
  }
  let year: number;
  let month: number | null = null;
  let day: number | null = null;
  if (parts.length === 1) {
    const p = parts[0];
    if (p.length === 4) {
      year = Number(p);
    } else if (p.length === 6) {
      year = Number(p.slice(0, 4));
      month = Number(p.slice(4, 6));
    } else if (p.length === 8) {
      year = Number(p.slice(0, 4));
      month = Number(p.slice(4, 6));
      day = Number(p.slice(6, 8));
    } else {
      return { error: "A year has four digits" };
    }
  } else if (parts[0].length === 4) {
    year = Number(parts[0]);
    month = Number(parts[1]);
    if (parts.length === 3) day = Number(parts[2]);
  } else if (parts.length === 3 && parts[2].length === 4 && parts[0].length <= 2 && parts[1].length <= 2) {
    // The US order, unmistakable: a four-digit year last.
    year = Number(parts[2]);
    month = Number(parts[0]);
    day = Number(parts[1]);
  } else {
    return { error: "A year has four digits: YYYY-MM-DD" };
  }
  if (!(year >= 1000 && year <= 9999)) return { error: "A year has four digits" };
  if (month !== null && !(month >= 1 && month <= 12)) return { error: "The month is 1 to 12" };
  if (day !== null && month !== null && !(day >= 1 && day <= daysIn(year, month))) {
    return { error: `That month has ${daysIn(year, month)} days` };
  }
  const yy = String(year).padStart(4, "0");
  if (month === null) return { canon: yy, precision: "year" };
  const mm = String(month).padStart(2, "0");
  if (day === null) return { canon: `${yy}-${mm}`, precision: "month" };
  return { canon: `${yy}-${mm}-${String(day).padStart(2, "0")}`, precision: "day" };
}

/** The first day a canonical value covers, as YYYY-MM-DD. */
export function spanStart(canon: string): string {
  const [y, m, d] = canon.split("-");
  return `${y}-${m ?? "01"}-${d ?? "01"}`;
}

/** The last day a canonical value covers, as YYYY-MM-DD: a month's
 * last day, a year's December 31st. */
export function spanEnd(canon: string): string {
  const [y, m, d] = canon.split("-");
  if (d) return canon;
  if (m) return `${y}-${m}-${String(daysIn(Number(y), Number(m))).padStart(2, "0")}`;
  return `${y}-12-31`;
}

/** The day a photograph was taken, as YYYY-MM-DD, from the EXIF text
 * the catalog stores ("2025:08:23 13:39:13", or an XMP-style
 * "2025-08-23T13:39:13"); null when the file said nothing. The local
 * date as the camera wrote it, offsets ignored: the photographer
 * remembers the morning of the 23rd, whatever the time zone tag says. */
export function shotDay(shotAt: string | null | undefined): string | null {
  if (!shotAt) return null;
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})/.exec(shotAt.trim());
  if (!m) return null;
  const parsed = parseDateInput(`${m[1]}-${m[2]}-${m[3]}`);
  return "canon" in parsed ? parsed.canon : null;
}

/** Whether a day falls within the two canonical bounds, either of which
 * may be empty for "no bound". Inclusive at both ends: "2025-05" to
 * "2026-03" is May 2025 through March 2026. */
export function dayInRange(day: string, from: string, to: string): boolean {
  if (from && day < spanStart(from)) return false;
  if (to && day > spanEnd(to)) return false;
  return true;
}
