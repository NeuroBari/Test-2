// Logica delle notifiche (senza accesso alla rete): dalle modifiche lette da Firestore
// ricava, per ogni destinatario, il testo della notifica da inviare.
//
// Destinatari (come in js/push.js):
//   "res:<yearId>:<residentId>"  lo specializzando: richieste approvate/rifiutate, annullamento
//                                 non accettato, nuovi messaggi del rappresentante
//   "rep:<yearId>:"               il rappresentante: nuove richieste e richieste di annullamento

export const SITE_URL = "https://neurobari.github.io/Test-2/";
// Tolleranza sugli orari scritti dai dispositivi (orologi non perfettamente allineati):
// si rileggono gli ultimi 15 minuti e i duplicati si scartano con l'elenco "recent".
export const MARGIN_MS = 15 * 60 * 1000;

const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI"];
const TYPE = { ferie: "Ferie", congresso: "Congresso" };

export const targetKey = (kind, yearId, residentId = "") => `${kind}:${yearId}:${residentId}`;

const parse = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
const nextDay = (iso) => new Date(parse(iso).getTime() + 86400000).toISOString().slice(0, 10);

export function fmtRange(from, to) {
  const a = parse(from), b = parse(to);
  const d = (x) => x.getUTCDate(), m = (x) => MONTHS[x.getUTCMonth()];
  if (from === to) return `${d(a)} ${m(a)}`;
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) return `${d(a)}–${d(b)} ${m(a)}`;
  return `${d(a)} ${m(a)} – ${d(b)} ${m(b)}`;
}

/** Raggruppa giorni consecutivi con la stessa chiave: [{ from, to, items }]. */
export function groupRanges(items, keyFn) {
  const sorted = [...items].sort((x, y) => keyFn(x).localeCompare(keyFn(y)) || x.date.localeCompare(y.date));
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && keyFn(last.items[0]) === keyFn(it) && nextDay(last.to) === it.date) {
      last.to = it.date;
      last.items.push(it);
    } else out.push({ from: it.date, to: it.date, items: [it] });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** Etichetta dell'anno di corso ("III anno") di un gruppo nell'anno accademico in corso. */
export function groupLabel(year, now = new Date()) {
  const ayStart = now.getUTCMonth() >= 10 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; // 1° novembre
  const n = ayStart - year.startYear + 1;
  return `${ROMAN[n] ?? n} anno`;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * absences: [{ id, yearId, residentId, days: { date: { type, status, reason, late, cancel, cancelDenied, updatedAt } } }]
 * comments: [{ id, yearId, residentId, text, createdAt }]
 * years:    { [yearId]: { startYear, residents: [{ id, name }], commentsEnabled } }
 * since:    ultima esecuzione (ms); recent: { chiave: ms } già notificate
 * Restituisce { messages: Map(target → { title, body, url, tag }), seen: [chiavi nuove] }.
 */
export function buildMessages({ absences, comments, years, since, recent = {}, now = new Date() }) {
  const from = since - MARGIN_MS;
  const seen = [];
  const fresh = (key, t) => {
    if (!(t > from) || recent[key]) return false;
    seen.push(key);
    return true;
  };
  const res = new Map(); // target → { yearId, residentId, decided: [], denied: [], comments: [] }
  const rep = new Map(); // yearId → { pending: [], cancel: [] }
  const resOf = (yearId, residentId) => {
    const k = targetKey("res", yearId, residentId);
    if (!res.has(k)) res.set(k, { yearId, residentId, decided: [], denied: [], comments: [] });
    return res.get(k);
  };
  const repOf = (yearId) => {
    if (!rep.has(yearId)) rep.set(yearId, { pending: [], cancel: [] });
    return rep.get(yearId);
  };

  for (const doc of absences) {
    if (!years[doc.yearId]) continue;
    for (const [date, v] of Object.entries(doc.days || {})) {
      const e = { ...v, date, residentId: doc.residentId };
      if (!fresh(`a|${doc.id}|${date}|${v.status}|${!!v.cancel}|${!!v.cancelDenied}|${v.updatedAt}`, v.updatedAt)) continue;
      if (v.status === "pending") repOf(doc.yearId).pending.push(e);
      else if (v.status === "approved" && v.cancel) repOf(doc.yearId).cancel.push(e);
      else if (v.cancelDenied) resOf(doc.yearId, doc.residentId).denied.push(e);
      else if (v.status === "approved" || v.status === "rejected") resOf(doc.yearId, doc.residentId).decided.push(e);
    }
  }
  for (const c of comments) {
    const y = years[c.yearId];
    if (!y || !y.commentsEnabled || !fresh(`c|${c.id}`, c.createdAt)) continue;
    const to = c.residentId ? [c.residentId] : (y.residents || []).map((r) => r.id);
    for (const rid of to) resOf(c.yearId, rid).comments.push(c);
  }

  const messages = new Map();
  const stamp = now.getTime();
  const monthOf = (list) => list.map((e) => e.date).sort()[0]?.slice(0, 7) || "";
  const link = (view, yearId, month) => `${SITE_URL}?view=${view}&year=${encodeURIComponent(yearId)}${month ? `&month=${month}` : ""}`;

  for (const [k, r] of res) {
    const lines = [];
    for (const g of groupRanges(r.decided, (e) => `${e.type}|${e.status}|${e.reason || ""}`)) {
      const e = g.items[0], ok = e.status === "approved";
      const verb = (ok ? "approvat" : "rifiutat") + (e.type === "ferie" ? "e" : "o"); // ferie approvate, congresso approvato
      lines.push(`${ok ? "✅" : "❌"} ${TYPE[e.type]} ${fmtRange(g.from, g.to)} ${verb}${!ok && e.reason ? ` · Motivo: ${e.reason}` : ""}`);
    }
    for (const g of groupRanges(r.denied, (e) => e.type))
      lines.push(`↩️ ${TYPE[g.items[0].type]} ${fmtRange(g.from, g.to)}: annullamento non accettato, ${g.items[0].type === "ferie" ? "restano approvate" : "resta approvato"}`);
    for (const c of r.comments) lines.push(`💬 Messaggio del rappresentante: «${clip(c.text, 90)}»`);
    if (!lines.length) continue;
    const title = r.decided.length && !r.comments.length && !r.denied.length
      ? (r.decided.every((e) => e.status === "approved") ? "Richiesta approvata" : r.decided.every((e) => e.status === "rejected") ? "Richiesta rifiutata" : "Richieste aggiornate")
      : r.comments.length && !r.decided.length && !r.denied.length ? "Nuovo messaggio del rappresentante" : "Ferie & Congressi";
    messages.set(k, { title, body: clip(lines.join("\n"), 600), url: link("resident", r.yearId, monthOf([...r.decided, ...r.denied])), tag: `${k}|${stamp}` });
  }

  for (const [yearId, r] of rep) {
    const y = years[yearId];
    const name = (rid) => (y.residents || []).find((x) => x.id === rid)?.name || "Specializzando";
    const lines = [];
    if (r.pending.length) {
      const byRes = new Map();
      for (const e of r.pending) byRes.set(e.residentId, [...(byRes.get(e.residentId) || []), e]);
      const who = [...byRes].map(([rid, list]) =>
        `${name(rid)} (${groupRanges(list, (e) => e.type).map((g) => `${TYPE[g.items[0].type]} ${fmtRange(g.from, g.to)}`).join(", ")})`);
      const late = r.pending.filter((e) => e.late).length;
      lines.push(`📥 ${r.pending.length === 1 ? "Nuova richiesta" : `${r.pending.length} giorni richiesti`}: ${who.join("; ")}`);
      if (late) lines.push(`⏰ ${late === 1 ? "1 giorno in ritardo" : `${late} giorni in ritardo`} rispetto alla scadenza`);
    }
    if (r.cancel.length) {
      const who = groupRanges(r.cancel, (e) => `${e.residentId}|${e.type}`)
        .map((g) => `${name(g.items[0].residentId)} (${TYPE[g.items[0].type]} ${fmtRange(g.from, g.to)})`);
      lines.push(`↩️ Richiesta di annullamento: ${who.join("; ")}`);
    }
    messages.set(targetKey("rep", yearId), {
      title: `Ferie & Congressi · ${groupLabel(y, now)}`,
      body: clip(lines.join("\n"), 600),
      url: link("rep", yearId, monthOf([...r.pending, ...r.cancel])),
      tag: `rep:${yearId}|${stamp}`,
    });
  }
  return { messages, seen };
}
