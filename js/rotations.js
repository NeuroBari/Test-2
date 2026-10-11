// Lettura dell'Excel dei turni (rotazioni nei reparti) caricato dal rappresentante.
//
// Formato atteso (come il file dei turni della scuola): una riga per specializzando,
// una colonna per mese, nella cella il reparto o la rotazione.
//
//             NOV      DIC      GEN   ...
//   MYRI      STROKE   STROKE   OSP
//   PAULO     NFP      DIS MOV  ...
//
// I mesi possono essere abbreviati o per esteso, in italiano o in inglese, oppure date.

const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

let xlsxLoading = null;
function loadXlsx() {
  xlsxLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = XLSX_URL;
    s.onload = resolve;
    s.onerror = () => {
      xlsxLoading = null;
      reject(new Error("Impossibile caricare il lettore Excel (connessione assente?)"));
    };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

/** Testo in maiuscolo, senza accenti né punteggiatura. */
export const normName = (s) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const MONTHS = {
  1: ["GEN", "GENNAIO", "JAN", "JANUARY"],
  2: ["FEB", "FEBBRAIO", "FEBRUARY"],
  3: ["MAR", "MARZO", "MARCH"],
  4: ["APR", "APRILE", "APRIL"],
  5: ["MAG", "MAGGIO", "MAY"],
  6: ["GIU", "GIUGNO", "JUN", "JUNE"],
  7: ["LUG", "LUGLIO", "JUL", "JULY"],
  8: ["AGO", "AGOSTO", "AUG", "AUGUST"],
  9: ["SET", "SETTEMBRE", "SEP", "SEPT", "SEPTEMBER"],
  10: ["OTT", "OTTOBRE", "OCT", "OCTOBER"],
  11: ["NOV", "NOVEMBRE", "NOVEMBER"],
  12: ["DIC", "DICEMBRE", "DEC", "DECEMBER"],
};
const MONTH_BY_TOKEN = new Map(Object.entries(MONTHS).flatMap(([m, tokens]) => tokens.map((t) => [t, Number(m)])));

function monthOfCell(v) {
  if (v instanceof Date && !isNaN(v)) return v.getMonth() + 1;
  if (typeof v !== "string") return null;
  return MONTH_BY_TOKEN.get(normName(v).replace(/ /g, "")) ?? null;
}

const cellText = (v) => (v == null ? "" : String(v).trim());
const isEmptyRotation = (s) => !s || /^[-–—/.x]+$/i.test(s);

/**
 * Legge il file e restituisce { sheet, months: [numeri dei mesi], rows: [{ name, byMonth: { mese: reparto } }] }.
 * Usa il primo foglio che contiene una riga di intestazione con almeno tre mesi.
 */
export async function parseRotationsFile(file) {
  await loadXlsx();
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  for (const sheetName of wb.SheetNames) {
    const grid = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    for (let h = 0; h < grid.length; h++) {
      const cols = new Map();
      (grid[h] || []).forEach((v, c) => {
        const m = monthOfCell(v);
        if (m && ![...cols.values()].includes(m)) cols.set(c, m);
      });
      if (cols.size < 3) continue;

      const firstMonthCol = Math.min(...cols.keys());
      const rows = [];
      for (const row of grid.slice(h + 1)) {
        if (!row) continue;
        const name = row.slice(0, firstMonthCol).map(cellText).find(Boolean);
        if (!name) continue;
        const byMonth = {};
        for (const [c, m] of cols) {
          const val = cellText(row[c]);
          if (!isEmptyRotation(val)) byMonth[m] = val.replace(/\s+/g, " ");
        }
        if (Object.keys(byMonth).length) rows.push({ name, byMonth });
      }
      if (rows.length) return { sheet: sheetName, months: [...cols.values()], rows };
    }
  }
  throw new Error("Nel file non ho trovato una riga con i mesi (es. NOV, DIC, GEN…) e sotto i nomi con i reparti.");
}

/** Prova ad associare un nome del file (es. "MYRI") a uno specializzando del sito (es. "Rossi Myriam"). */
export function guessResident(fileName, residents, aliases = {}) {
  const n = normName(fileName);
  if (aliases[n] && residents.some((r) => r.id === aliases[n])) return aliases[n];
  const exact = residents.filter((r) => normName(r.name) === n);
  if (exact.length === 1) return exact[0].id;
  const words = residents.map((r) => ({ id: r.id, words: normName(r.name).split(" ") }));
  const byWord = words.filter((r) => r.words.includes(n));
  if (byWord.length === 1) return byWord[0].id;
  if (n.length >= 3) {
    const byPrefix = words.filter((r) => r.words.some((w) => w.startsWith(n)));
    if (byPrefix.length === 1) return byPrefix[0].id;
  }
  return "";
}

/** Chiave "YYYY-MM" del mese m (1-12) nell'anno accademico che inizia in startYear. */
export function monthKey(startYear, m, startMonth) {
  const y = m >= startMonth ? startYear : startYear + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}
