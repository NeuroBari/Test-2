// Utility per le date. Le date sono sempre stringhe "YYYY-MM-DD" (ora locale).

import { ACADEMIC_YEAR_START_MONTH } from "./config.js";

export const MONTHS = [
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
];
export const MON3 = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
export const WD3 = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
export const WD1 = ["D", "L", "M", "M", "G", "V", "S"];

const pad = (n) => String(n).padStart(2, "0");

/** m è 0-based */
export const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const parse = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const toIso = (dt) => iso(dt.getFullYear(), dt.getMonth(), dt.getDate());
export const todayIso = () => toIso(new Date());
export const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const monthLabel = (y, m) => `${capitalize(MONTHS[m])} ${y}`;

export function addDays(s, n) {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return toIso(d);
}

export function monthDates(y, m) {
  const n = daysInMonth(y, m);
  return Array.from({ length: n }, (_, i) => iso(y, m, i + 1));
}

export function rangeDates(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const weekday = (s) => parse(s).getDay();
export const isWeekend = (s) => {
  const w = weekday(s);
  return w === 0 || w === 6;
};

/** "lun 12 ott" */
export function fmtDay(s) {
  const d = parse(s);
  return `${WD3[d.getDay()]} ${d.getDate()} ${MON3[d.getMonth()]}`;
}

/** "12/10/2026" */
export function fmtNumeric(s) {
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
}

// Domenica di Pasqua (algoritmo di Meeus/Jones/Butcher)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month - 1, day);
}

const holidayCache = new Map();

/** Festività nazionali italiane: Map data → nome */
export function holidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const e = easter(y);
  const map = new Map([
    [iso(y, 0, 1), "Capodanno"],
    [iso(y, 0, 6), "Epifania"],
    [e, "Pasqua"],
    [addDays(e, 1), "Pasquetta"],
    [iso(y, 3, 25), "Liberazione"],
    [iso(y, 4, 1), "Festa del Lavoro"],
    [iso(y, 5, 2), "Festa della Repubblica"],
    [iso(y, 7, 15), "Ferragosto"],
    [iso(y, 10, 1), "Ognissanti"],
    [iso(y, 11, 8), "Immacolata"],
    [iso(y, 11, 25), "Natale"],
    [iso(y, 11, 26), "S. Stefano"],
  ]);
  holidayCache.set(y, map);
  return map;
}

export const holidayName = (s) => holidays(Number(s.slice(0, 4))).get(s);

/**
 * Raggruppa elementi {date, ...} in intervalli di giorni consecutivi.
 * keyFn permette di separare gli intervalli (es. per nota o stato).
 */
export function groupRanges(items, keyFn = () => "") {
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
  const groups = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    const key = keyFn(it);
    if (g && g.key === key && addDays(g.to, 1) === it.date) {
      g.to = it.date;
      g.items.push(it);
    } else {
      groups.push({ from: it.date, to: it.date, key, items: [it] });
    }
  }
  return groups;
}

/** "3–7 ott", "30 set – 2 ott", "12 ago" */
export function fmtRange(from, to) {
  const a = parse(from), b = parse(to);
  if (from === to) return `${a.getDate()} ${MON3[a.getMonth()]}`;
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear())
    return `${a.getDate()}–${b.getDate()} ${MON3[b.getMonth()]}`;
  return `${a.getDate()} ${MON3[a.getMonth()]} – ${b.getDate()} ${MON3[b.getMonth()]}`;
}

/**
 * Anno accademico che contiene la data (es. 1 nov 2025 – 31 ott 2026).
 * Restituisce { from, to, label } con label "2025/26".
 */
export function academicYear(date) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const sm = ACADEMIC_YEAR_START_MONTH;
  const start = m >= sm ? y : y - 1;
  if (sm === 1) return { from: `${start}-01-01`, to: `${start}-12-31`, label: String(start) };
  return {
    from: iso(start, sm - 1, 1),
    to: addDays(iso(start + 1, sm - 1, 1), -1),
    label: `${start}/${String((start + 1) % 100).padStart(2, "0")}`,
  };
}
