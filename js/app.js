import { createStore } from "./store.js";
import { FERIE_LIMIT, COURSE_YEARS, ACADEMIC_YEAR_START_MONTH } from "./config.js";
import * as D from "./dates.js";
import { buildReport, exportPdf, exportCsv } from "./export.js";
import { parseRotationsFile, guessResident, monthKey, normName } from "./rotations.js";

const TYPE_LABEL = { ferie: "Ferie", congresso: "Congresso" };
const STATUS_LABEL = { pending: "In attesa", approved: "Approvato", rejected: "Rifiutato" };
const STATUS_ICON = { pending: "", approved: "✓", rejected: "✕" };
const NEXT_STATUS = { pending: "approved", approved: "rejected", rejected: "pending" };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const byName = (a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" });
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------------------
// Stato
// ---------------------------------------------------------------------------
const PREFS_KEY = "neuro-ferie-prefs";
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
})();
prefs.residents ??= {};
function savePrefs(patch = {}) {
  Object.assign(prefs, patch);
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignorato */ }
}

const now = new Date();
const ui = {
  yearId: prefs.yearId || null,
  y: now.getFullYear(),
  m: now.getMonth(),
  view: prefs.view === "rep" ? "rep" : "resident",
  brush: "ferie",
};
let state = { years: {}, entries: {}, comments: {} };
let store = null;

// Gruppi di specializzandi (coorti). Un gruppo è al I anno nell'anno accademico che
// inizia in startYear e avanza di un anno di corso a ogni nuovo anno accademico.
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI"];
const viewAyStart = () => Number(viewAcademicYear().from.slice(0, 4));
const courseYear = (group, ayStart = viewAyStart()) => ayStart - group.startYear + 1;
const groupLabel = (group, ayStart) => `${ROMAN[courseYear(group, ayStart)] ?? courseYear(group, ayStart)} anno`;
const ayLabelOf = (startYear) => `${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`;

/** Gruppi in corso nell'anno accademico visualizzato, dal I all'ultimo anno. */
const yearsSorted = () => {
  const s = viewAyStart();
  return Object.values(state.years)
    .filter((g) => Number.isFinite(g.startYear) && courseYear(g, s) >= 1 && courseYear(g, s) <= COURSE_YEARS)
    .sort((a, b) => b.startYear - a.startYear);
};
const currentYear = () => yearsSorted().find((g) => g.id === ui.yearId) || null;

/**
 * Crea i gruppi mancanti per l'anno accademico visualizzato (es. il nuovo I anno
 * dal 1° novembre) e converte i vecchi "anni di corso" fissi in gruppi.
 */
const ensuring = new Set();
function ensureGroups() {
  const s = viewAyStart();
  const todayAy = Number(D.academicYear(D.todayIso()).from.slice(0, 4));
  const missing = [];
  for (const g of Object.values(state.years))
    if (!Number.isFinite(g.startYear) && Number.isFinite(g.order) && !ensuring.has(g.id))
      missing.push({ id: g.id, startYear: todayAy - g.order + 1 });
  const starts = new Set([...Object.values(state.years).map((g) => g.startYear), ...missing.map((g) => g.startYear)]);
  // Negli anni accademici passati si mostrano solo i gruppi già esistenti
  for (let k = 1; s >= todayAy && k <= COURSE_YEARS; k++) {
    const startYear = s - k + 1;
    const id = `c${startYear}`;
    if (!starts.has(startYear) && !ensuring.has(id)) missing.push({ id, startYear });
  }
  if (!missing.length) return;
  missing.forEach((g) => ensuring.add(g.id));
  store.ensureYears(missing).catch((err) => {
    missing.forEach((g) => ensuring.delete(g.id));
    toast("Errore nella creazione degli anni di corso: " + err.message, "error");
  });
}
const entryId = (yearId, residentId, date) => `${yearId}__${residentId}__${date}`;
const residentsOf = (year) => [...(year.residents || [])].sort(byName);
const nameOf = (year, rid) => year.residents.find((r) => r.id === rid)?.name ?? "—";

function currentResidentId(year) {
  const rid = prefs.residents[year.id];
  return year.residents.some((r) => r.id === rid) ? rid : null;
}

/** Richieste dell'anno di corso (solo specializzandi esistenti) e indice per data delle assenze attive. */
function indexYear(year) {
  const valid = new Set(year.residents.map((r) => r.id));
  const all = [];
  const byDate = new Map();
  for (const e of Object.values(state.entries)) {
    if (e.yearId !== year.id || !valid.has(e.residentId)) continue;
    all.push(e);
    if (e.status === "rejected") continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  return { all, byDate };
}

/** Giorni di un tipo nell'anno accademico ay ({ from, to }). */
function countDays(yearId, residentId, type, ay, statuses) {
  let n = 0;
  for (const e of Object.values(state.entries))
    if (e.yearId === yearId && e.residentId === residentId && e.type === type &&
        statuses.includes(e.status) && e.date >= ay.from && e.date <= ay.to) n++;
  return n;
}

/** Commenti del rappresentante per un anno di corso e anno accademico, in ordine di data. */
function commentsOf(year, ay) {
  const start = (c) => c.from || D.toIso(new Date(c.createdAt));
  return Object.values(state.comments || {})
    .filter((c) => c.yearId === year.id && c.ay === ay.from)
    .sort((a, b) => start(a).localeCompare(start(b)) || a.createdAt - b.createdAt);
}

/** Reparto/rotazione dello specializzando nel mese della data, dall'Excel dei turni ("" se non caricato). */
function rotationOf(year, rid, date) {
  return year.rotations?.[D.academicYear(date).from]?.byResident?.[rid]?.[date.slice(0, 7)] || "";
}

/** Reparti in cui due o più degli assenti di quel giorno sono in turno insieme. */
function sharedRotations(year, list, date) {
  const by = new Map();
  for (const e of list) {
    const name = rotationOf(year, e.residentId, date);
    if (!name) continue;
    const k = normName(name);
    if (!by.has(k)) by.set(k, { name, list: [] });
    by.get(k).list.push(e);
  }
  return [...by.values()].filter((g) => g.list.length >= 2);
}

/** Periodo a cui si riferisce un commento ("" se generico). */
const commentWhen = (c) => (c.from ? D.fmtRange(c.from, c.to || c.from) : "");

/** Il commento riguarda il periodo? Senza date conta il giorno in cui è stato scritto. */
function commentInPeriod(c, from, to) {
  const f = c.from || D.toIso(new Date(c.createdAt));
  const t = c.to || f;
  return f <= to && t >= from;
}

/** Anno accademico del mese visualizzato. */
const viewAcademicYear = () => D.academicYear(D.iso(ui.y, ui.m, 1));

// Sblocco area rappresentante (per sessione del browser)
const unlockedMem = {};
function isUnlocked(year) {
  if (!year.pinHash) return false;
  let v = unlockedMem[year.id];
  try { v ||= sessionStorage.getItem("rep-" + year.id); } catch { /* ignorato */ }
  return v === year.pinHash;
}
function setUnlocked(year, hash) {
  unlockedMem[year.id] = hash;
  try {
    if (hash) sessionStorage.setItem("rep-" + year.id, hash);
    else sessionStorage.removeItem("rep-" + year.id);
  } catch { /* ignorato */ }
}
async function hashPin(yearId, pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`neuro-ferie:${yearId}:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Utility UI
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, kind = "info") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), kind === "info" ? 3000 : 6000);
}

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    console.error(err);
    toast("Errore: " + (err?.message || err), "error");
    return false;
  }
}

/** Sostituisce il contenuto mantenendo i valori dei campi marcati data-keep e il focus. */
function rerender(container, html) {
  const active = document.activeElement;
  const focusKey = container.contains(active) ? active?.dataset?.keep : null;
  const saved = {};
  container.querySelectorAll("[data-keep]").forEach((el) => {
    if (el.hasAttribute("data-keep-if-focused") && el !== active) return;
    saved[el.dataset.keep] = el.type === "checkbox" ? el.checked : el.value;
  });
  container.innerHTML = html;
  for (const [k, v] of Object.entries(saved)) {
    const el = container.querySelector(`[data-keep="${k}"]`);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
  }
  if (focusKey) container.querySelector(`[data-keep="${focusKey}"]`)?.focus();
}

const card = (html, cls = "") => `<section class="card ${cls}">${html}</section>`;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  // Con Firebase carica (una volta) le richieste dell'anno accademico visualizzato
  store.watchAcademicYear(viewAcademicYear().from).catch((err) => toast("Errore nel caricamento: " + err.message, "error"));
  ensureGroups();
  const groups = yearsSorted();
  // Il gruppo scelto resta lo stesso anche cambiando anno accademico (passa dal II al III anno)
  if (!groups.some((g) => g.id === ui.yearId))
    ui.yearId = groups.some((g) => g.id === prefs.yearId) ? prefs.yearId : groups[0]?.id ?? null;
  const year = currentYear();

  $("#year-select").innerHTML = groups
    .map((y) => `<option value="${esc(y.id)}" ${y.id === ui.yearId ? "selected" : ""}>${groupLabel(y)}</option>`)
    .join("");
  $("#month-label").textContent = D.monthLabel(ui.y, ui.m);
  document.querySelectorAll(".tabs [data-view]").forEach((b) => {
    const on = b.dataset.view === ui.view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on);
  });
  $("#view-resident").hidden = ui.view !== "resident";
  $("#view-rep").hidden = ui.view !== "rep";

  if (ui.view === "resident") renderResident(year);
  else renderRep(year);
}

// ----- Vista specializzando -------------------------------------------------
function renderResident(year) {
  const el = $("#view-resident");
  if (!year) return rerender(el, card(`<p class="muted">Nessun anno di corso configurato.</p>`));

  const residents = residentsOf(year);
  const rid = currentResidentId(year);
  const picker = card(`
    <label class="field">
      <span>Chi sei?</span>
      <select id="resident-select">
        <option value="">— Seleziona il tuo nome —</option>
        ${residents.map((r) => `<option value="${esc(r.id)}" ${r.id === rid ? "selected" : ""}>${esc(r.name)}</option>`).join("")}
      </select>
    </label>
    ${residents.length ? "" : `<p class="muted">Non ci sono ancora specializzandi nel ${groupLabel(year)}. Il rappresentante può aggiungerli dall'area <strong>Rappresentante</strong>.</p>`}
  `, "picker");

  if (!rid) {
    return rerender(el, picker + (residents.length
      ? card(`<p class="muted">Seleziona il tuo nome per segnare i giorni di ferie e di congresso.</p>`)
      : ""));
  }

  const idx = indexYear(year);
  const ay = viewAcademicYear();
  const fA = countDays(year.id, rid, "ferie", ay, ["approved"]);
  const fP = countDays(year.id, rid, "ferie", ay, ["pending"]);
  const cA = countDays(year.id, rid, "congresso", ay, ["approved"]);
  const cP = countDays(year.id, rid, "congresso", ay, ["pending"]);
  const fTot = fA + fP;
  const over = fTot > FERIE_LIMIT;

  const alert = over
    ? `<div class="alert danger" role="alert"><strong>Limite superato:</strong> hai ${fTot} giorni di ferie nell'a.a. ${ay.label} (approvati + in attesa), oltre il limite di ${FERIE_LIMIT}.</div>`
    : fTot >= FERIE_LIMIT - 5
      ? `<div class="alert warn">Ti restano ${FERIE_LIMIT - fTot} giorni di ferie per l'a.a. ${ay.label}.</div>`
      : "";

  const stats = `
    <div class="stats">
      <div class="stat ferie ${over ? "over" : ""}">
        <span class="stat-label">Ferie a.a. ${ay.label}</span>
        <span class="stat-value">${fTot}<small> / ${FERIE_LIMIT}</small></span>
        <div class="meter"><span style="width:${Math.min(100, (fTot / FERIE_LIMIT) * 100)}%"></span></div>
        <span class="stat-sub">${fA} approvati · ${fP} in attesa</span>
      </div>
      <div class="stat congresso">
        <span class="stat-label">Congressi a.a. ${ay.label}</span>
        <span class="stat-value">${cA + cP}<small> giorni</small></span>
        <div class="meter"><span style="width:0"></span></div>
        <span class="stat-sub">${cA} approvati · ${cP} in attesa · nessun limite</span>
      </div>
    </div>`;

  const brushes = [
    ["ferie", "Ferie"],
    ["congresso", "Congresso"],
    ["cancella", "Cancella"],
  ].map(([k, l]) => `<button type="button" class="brush-btn ${k} ${ui.brush === k ? "active" : ""}" data-brush="${k}" aria-pressed="${ui.brush === k}">${l}</button>`).join("");

  const myMonth = idx.all.filter((e) => e.residentId === rid && e.date.startsWith(`${ui.y}-${String(ui.m + 1).padStart(2, "0")}`));
  const groups = D.groupRanges(myMonth, (e) => `${e.type}|${e.status}|${e.note || ""}`);
  const list = groups.length
    ? `<ul class="req-list">${groups.map((g) => {
        const e = g.items[0];
        return `<li>
          <span class="dot ${e.type}"></span>
          <span class="req-main"><strong>${TYPE_LABEL[e.type]}</strong> · ${D.fmtRange(g.from, g.to)} <span class="muted">(${g.items.length} gg)</span>${e.note ? ` <span class="muted">— ${esc(e.note)}</span>` : ""}</span>
          <span class="status ${e.status}">${STATUS_LABEL[e.status]}</span>
          <button type="button" class="btn tiny ghost" data-action="cancel-group" data-ids="${esc(g.items.map((i) => i.id).join(","))}">Annulla</button>
        </li>`;
      }).join("")}</ul>`
    : `<p class="muted">Nessuna richiesta in questo mese.</p>`;

  rerender(el, `
    ${picker}
    ${alert}
    ${residentCommentsHtml(year, rid, ay)}
    ${stats}
    ${card(`
      <div class="cal-head">
        <div class="brush" role="group" aria-label="Cosa segnare">${brushes}</div>
        <p class="muted small">Tocca un giorno per segnarlo, toccalo di nuovo per toglierlo. 👥 = colleghi del tuo anno assenti quel giorno.</p>
      </div>
      ${calendarHtml(year, rid, idx)}
      ${legendHtml()}
    `)}
    ${card(`
      <form id="range-form" class="range-form">
        <h3>Segna un periodo</h3>
        <div class="form-row">
          <label class="field"><span>Dal</span><input type="date" name="from" data-keep="rf-from" required></label>
          <label class="field"><span>Al</span><input type="date" name="to" data-keep="rf-to" required></label>
          <label class="field"><span>Tipo</span>
            <select name="type" data-keep="rf-type"><option value="ferie">Ferie</option><option value="congresso">Congresso</option></select>
          </label>
          <label class="field grow"><span>Nota (es. nome del congresso)</span><input name="note" maxlength="120" data-keep="rf-note" placeholder="Facoltativa"></label>
        </div>
        <div class="form-row between">
          <label class="check"><input type="checkbox" name="skip" data-keep="rf-skip" checked> Escludi sabati, domeniche e festivi</label>
          <button class="btn primary">Aggiungi richiesta</button>
        </div>
      </form>
    `)}
    ${card(`<h3>Le mie richieste · ${D.monthLabel(ui.y, ui.m)}</h3>${list}`)}
  `);
}

function residentCommentsHtml(year, rid, ay) {
  if (!year.commentsEnabled) return "";
  const list = commentsOf(year, ay).filter((c) => !c.residentId || c.residentId === rid);
  if (!list.length) return "";
  return card(`
    <h3>Comunicazioni del rappresentante</h3>
    <ul class="comment-list">${list.map((c) => `<li>
      <div class="comment-head">${c.residentId ? "Per te" : "Per tutti"}${commentWhen(c) ? ` · ${commentWhen(c)}` : ""}</div>
      <p>${esc(c.text)}</p>
    </li>`).join("")}</ul>
  `, "comments");
}

function legendHtml() {
  return `<div class="legend">
    <span><i class="sw ferie approved"></i>Ferie</span>
    <span><i class="sw congresso approved"></i>Congresso</span>
    <span><i class="sw ferie pending"></i>In attesa</span>
    <span><i class="sw ferie rejected"></i>Rifiutato</span>
    <span><i class="sw holiday"></i>Festivo</span>
  </div>`;
}

function calendarHtml(year, rid, idx) {
  const offset = (new Date(ui.y, ui.m, 1).getDay() + 6) % 7;
  const today = D.todayIso();
  const head = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((d) => `<div class="cal-wd">${d}</div>`).join("");
  let cells = "";
  for (let i = 0; i < offset; i++) cells += `<div class="day blank" aria-hidden="true"></div>`;
  for (const date of D.monthDates(ui.y, ui.m)) {
    const d = Number(date.slice(8));
    const mine = state.entries[entryId(year.id, rid, date)];
    const others = (idx.byDate.get(date) || []).filter((e) => e.residentId !== rid);
    const myRot = normName(rotationOf(year, rid, date));
    const sameRot = myRot ? others.filter((e) => normName(rotationOf(year, e.residentId, date)) === myRot) : [];
    const hol = D.holidayName(date);
    const cls = [
      D.isWeekend(date) && "weekend",
      hol && "holiday",
      date === today && "today",
      mine && `has ${mine.type} ${mine.status}`,
    ].filter(Boolean).join(" ");
    const titleParts = [D.fmtDay(date)];
    if (hol) titleParts.push(hol);
    if (mine) titleParts.push(`${TYPE_LABEL[mine.type]} – ${STATUS_LABEL[mine.status]}${mine.note ? ` (${mine.note})` : ""}`);
    if (others.length) titleParts.push("Assenti: " + others.map((e) => `${nameOf(year, e.residentId)} (${TYPE_LABEL[e.type]})`).join(", "));
    if (sameRot.length) titleParts.push(`Nel tuo stesso reparto: ${sameRot.map((e) => nameOf(year, e.residentId)).join(", ")}`);
    cells += `<button type="button" class="day ${cls}" data-date="${date}" title="${esc(titleParts.join("\n"))}">
      <span class="day-num">${d}</span>
      ${hol ? `<span class="day-hol">${esc(hol)}</span>` : ""}
      ${mine ? `<span class="pill ${mine.type} ${mine.status}"><span class="long">${mine.type === "ferie" ? "Ferie" : "Congr."}</span><span class="short">${mine.type === "ferie" ? "F" : "C"}</span> ${STATUS_ICON[mine.status]}</span>` : ""}
      ${others.length ? `<span class="others ${sameRot.length ? "high" : ""}">👥 ${others.length}${sameRot.length ? " ⚠" : ""}</span>` : ""}
    </button>`;
  }
  const rot = rotationOf(year, rid, D.iso(ui.y, ui.m, 1));
  const rotLine = rot
    ? `<p class="rot-line">Il tuo reparto a ${D.MONTHS[ui.m]}: <strong>${esc(rot)}</strong>. ⚠ indica colleghi dello stesso reparto già assenti.</p>`
    : "";
  return `${rotLine}<div class="calendar"><div class="cal-grid">${head}${cells}</div></div>`;
}

// ----- Vista rappresentante -------------------------------------------------
function renderRep(year) {
  const el = $("#view-rep");
  if (!year) return rerender(el, card(`<p class="muted">Nessun anno di corso configurato.</p>`));

  if (!isUnlocked(year)) {
    const setup = !year.pinHash;
    return rerender(el, card(`
      <form id="${setup ? "pin-setup" : "pin-login"}" class="lock">
        <div class="lock-icon" aria-hidden="true">🔒</div>
        <h2>Area rappresentante · ${groupLabel(year)}</h2>
        ${setup
          ? `<p class="muted">Primo accesso: scegli un PIN (almeno 4 caratteri) per proteggere l'area rappresentante di questo anno di corso.</p>
             <div class="form-row center">
               <label class="field"><span>Nuovo PIN</span><input type="password" name="pin" minlength="4" required autocomplete="new-password"></label>
               <label class="field"><span>Conferma PIN</span><input type="password" name="pin2" minlength="4" required autocomplete="new-password"></label>
             </div>
             <button class="btn primary">Imposta PIN ed entra</button>`
          : `<p class="muted">Inserisci il PIN del rappresentante del ${groupLabel(year)}.</p>
             <div class="form-row center">
               <label class="field"><span>PIN</span><input type="password" name="pin" required autocomplete="current-password"></label>
             </div>
             <button class="btn primary">Entra</button>`}
      </form>
    `));
  }

  const idx = indexYear(year);
  const residents = residentsOf(year);
  const dates = D.monthDates(ui.y, ui.m);
  const monthPrefix = dates[0].slice(0, 7);
  const ay = viewAcademicYear();
  const overlapDates = dates.filter((d) => (idx.byDate.get(d) || []).length >= 2);
  const overlapSet = new Set(overlapDates);
  // Sovrapposizioni più gravi: assenti dello stesso reparto (dall'Excel dei turni)
  const shared = new Map(overlapDates.map((d) => [d, sharedRotations(year, idx.byDate.get(d), d)]).filter(([, s]) => s.length));
  const pendingMonth = idx.all.filter((e) => e.status === "pending" && e.date.startsWith(monthPrefix));
  const pendingClean = pendingMonth.filter((e) => !overlapSet.has(e.date));
  const overLimit = residents.filter((r) => countDays(year.id, r.id, "ferie", ay, ["approved", "pending"]) > FERIE_LIMIT);
  const today = D.todayIso();

  // Tabella mensile
  const colCls = (date) => [
    D.isWeekend(date) && "weekend",
    D.holidayName(date) && "holiday",
    overlapSet.has(date) && (shared.has(date) ? "overlap high" : "overlap"),
    date === today && "today",
  ].filter(Boolean).join(" ");

  const headCells = dates.map((date) => {
    const act = idx.byDate.get(date) || [];
    const title = [
      D.fmtDay(date),
      D.holidayName(date),
      overlapSet.has(date) && `Sovrapposizione: ${act.map((e) => nameOf(year, e.residentId)).join(", ")}`,
      ...(shared.get(date) || []).map((g) => `Stesso reparto (${g.name}): ${g.list.map((e) => nameOf(year, e.residentId)).join(", ")}`),
    ].filter(Boolean).join("\n");
    return `<th class="${colCls(date)}" title="${esc(title)}">${Number(date.slice(8))}<small>${D.WD1[D.weekday(date)]}</small></th>`;
  }).join("");

  // Filtro per reparto (dai turni del mese)
  const repOptions = new Map();
  for (const r of residents) {
    const rot = rotationOf(year, r.id, dates[0]);
    if (!rot) continue;
    const k = normName(rot);
    repOptions.set(k, { label: rot, n: (repOptions.get(k)?.n || 0) + 1 });
  }
  if (ui.repFilter && !repOptions.has(ui.repFilter)) ui.repFilter = "";
  const shownResidents = ui.repFilter ? residents.filter((r) => normName(rotationOf(year, r.id, dates[0])) === ui.repFilter) : residents;
  const filterChips = repOptions.size
    ? `<div class="chips" role="group" aria-label="Filtra per reparto">
        <button type="button" class="chip ${ui.repFilter ? "" : "active"}" data-action="rep-filter" data-key="" aria-pressed="${!ui.repFilter}">Tutti <span>${residents.length}</span></button>
        ${[...repOptions].sort((a, b) => a[1].label.localeCompare(b[1].label, "it")).map(([k, o]) => `<button type="button" class="chip ${ui.repFilter === k ? "active" : ""}" data-action="rep-filter" data-key="${esc(k)}" aria-pressed="${ui.repFilter === k}">${esc(o.label)} <span>${o.n}</span></button>`).join("")}
      </div>`
    : "";

  const bodyRows = shownResidents.map((r) => {
    const cells = dates.map((date) => {
      const e = state.entries[entryId(year.id, r.id, date)];
      if (!e) return `<td class="${colCls(date)}"></td>`;
      const title = `${r.name} · ${D.fmtDay(date)}\n${TYPE_LABEL[e.type]} – ${STATUS_LABEL[e.status]}${e.note ? `\n${e.note}` : ""}\nClic: ${STATUS_LABEL[NEXT_STATUS[e.status]].toLowerCase()}`;
      return `<td class="${colCls(date)}"><button type="button" class="cell ${e.type} ${e.status}" data-cell="${esc(e.id)}" title="${esc(title)}" aria-label="${esc(title)}">${e.type === "ferie" ? "F" : "C"}</button></td>`;
    }).join("");
    const fA = countDays(year.id, r.id, "ferie", ay, ["approved"]);
    const fP = countDays(year.id, r.id, "ferie", ay, ["pending"]);
    const cTot = countDays(year.id, r.id, "congresso", ay, ["approved", "pending"]);
    const rowPending = pendingMonth.filter((e) => e.residentId === r.id).length;
    const over = fA + fP > FERIE_LIMIT;
    return `<tr>
      <th class="sticky name" scope="row">${esc(r.name)}${rotationOf(year, r.id, dates[0]) ? `<small class="rot">${esc(rotationOf(year, r.id, dates[0]))}</small>` : ""}</th>
      ${cells}
      <td class="tot ${over ? "over" : ""}" title="Ferie a.a. ${ay.label}: ${fA} approvate, ${fP} in attesa">${fA}${fP ? `<small>+${fP}</small>` : ""}${over ? " ⚠" : ""}</td>
      <td class="tot">${cTot}</td>
      <td class="row-act">${rowPending ? `<button type="button" class="btn tiny" data-action="approve-row" data-rid="${esc(r.id)}" title="Approva le ${rowPending} richieste in attesa di questo mese">✓ ${rowPending}</button>` : ""}</td>
    </tr>`;
  }).join("");

  const countRow = `<tr class="count-row"><th class="sticky name" scope="row">Assenti</th>${dates.map((date) => {
    const n = (idx.byDate.get(date) || []).length;
    return `<td class="${colCls(date)}">${n || ""}</td>`;
  }).join("")}<td></td><td></td><td></td></tr>`;

  const table = residents.length
    ? `<div class="table-wrap"><table class="grid">
        <thead><tr><th class="sticky name">Specializzando</th>${headCells}<th class="tot" title="Ferie nell'anno accademico ${ay.label}: approvate (+ in attesa)">Ferie ${ay.label}</th><th class="tot" title="Giorni di congresso nell'anno accademico ${ay.label}">Congr.</th><th></th></tr></thead>
        <tbody>${bodyRows}${countRow}</tbody>
      </table></div>
      <p class="muted small">Clic su una cella per cambiare stato: in attesa → approvato → rifiutato. Le colonne arancioni indicano giorni in cui più colleghi sono assenti; quelle rosse, assenti dello stesso reparto (dall'Excel dei turni).</p>`
    : `<p class="muted">Aggiungi gli specializzandi del ${groupLabel(year)} nella sezione qui sotto.</p>`;

  // Sovrapposizioni
  const conflicts = overlapDates.length
    ? overlapDates.map((date) => {
        const list = idx.byDate.get(date);
        const groups = shared.get(date) || [];
        const sharedIds = new Set(groups.flatMap((g) => g.list.map((e) => e.id)));
        return `<div class="conflict ${groups.length ? "high" : ""}">
          <div class="conflict-date">${D.fmtDay(date)}<small>${list.length} assenti</small>
            ${groups.map((g) => `<span class="badge high">Stesso reparto: ${esc(g.name)}</span>`).join("")}</div>
          <ul>${list.sort((a, b) => nameOf(year, a.residentId).localeCompare(nameOf(year, b.residentId), "it")).map((e) => `<li>
            <span class="dot ${e.type}"></span>
            <span class="req-main"><strong>${esc(nameOf(year, e.residentId))}</strong> · ${TYPE_LABEL[e.type]}${e.note ? ` <span class="muted">— ${esc(e.note)}</span>` : ""}
              ${rotationOf(year, e.residentId, date) ? `<span class="rot-chip ${sharedIds.has(e.id) ? "high" : ""}">${esc(rotationOf(year, e.residentId, date))}</span>` : ""}</span>
            <span class="status ${e.status}">${STATUS_LABEL[e.status]}</span>
            <span class="actions">
              ${e.status !== "approved" ? `<button type="button" class="btn tiny ok" data-action="set-status" data-id="${esc(e.id)}" data-status="approved">Approva</button>` : ""}
              <button type="button" class="btn tiny danger" data-action="set-status" data-id="${esc(e.id)}" data-status="rejected">Rifiuta</button>
              ${year.commentsEnabled ? `<button type="button" class="btn tiny ghost" data-action="comment-prefill" data-rid="${esc(e.residentId)}" data-date="${date}">Commenta</button>` : ""}
            </span>
          </li>`).join("")}</ul>
        </div>`;
      }).join("")
    : `<p class="muted">Nessuna sovrapposizione in ${D.monthLabel(ui.y, ui.m)}.</p>`;

  const residentList = residents.map((r) => `<li>
      <input type="text" value="${esc(r.name)}" data-rename="${esc(r.id)}" data-keep="ren-${esc(r.id)}" data-keep-if-focused aria-label="Nome di ${esc(r.name)}">
      <button type="button" class="btn tiny ghost danger-text" data-action="remove-res" data-rid="${esc(r.id)}">Rimuovi</button>
    </li>`).join("");

  rerender(el, `
    ${card(`
      <div class="rep-head">
        <h2>Area rappresentante · ${groupLabel(year)}</h2>
        <button type="button" class="btn ghost" data-action="lock">Esci</button>
      </div>
      <div class="kpis">
        <div class="kpi"><span>${pendingMonth.length}</span>richieste in attesa nel mese</div>
        <div class="kpi ${shared.size ? "danger" : overlapDates.length ? "warn" : ""}"><span>${overlapDates.length}</span>giorni con sovrapposizioni${shared.size ? `, di cui <strong>${shared.size} nello stesso reparto</strong>` : ""}</div>
        <div class="kpi ${overLimit.length ? "danger" : ""}"><span>${overLimit.length}</span>oltre ${FERIE_LIMIT} gg di ferie (a.a. ${ay.label})</div>
        <div class="kpi"><span>${residents.length}</span>specializzandi</div>
      </div>
      ${overLimit.length ? `<div class="alert danger">Superano i ${FERIE_LIMIT} giorni di ferie nell'a.a. ${ay.label} (approvati + in attesa): ${overLimit.map((r) => `<strong>${esc(r.name)}</strong> (${countDays(year.id, r.id, "ferie", ay, ["approved", "pending"])})`).join(", ")}.</div>` : ""}
      <div class="bulk">
        <button type="button" class="btn primary" data-action="approve-clean" ${pendingClean.length ? "" : "disabled"}>Approva le richieste senza sovrapposizioni (${pendingClean.length})</button>
        <button type="button" class="btn" data-action="approve-month" ${pendingMonth.length ? "" : "disabled"}>Approva tutte le richieste del mese (${pendingMonth.length})</button>
      </div>
    `)}
    ${repNewsHtml(year, idx)}
    ${card(`<h3>${D.monthLabel(ui.y, ui.m)}</h3>${filterChips}${table}${legendHtml()}`)}
    ${card(`<h3>Sovrapposizioni · ${D.monthLabel(ui.y, ui.m)}</h3>${conflicts}`, "conflicts")}
    ${card(annualHtml(year, idx, residents, ay), "annual")}
    ${card(repRotationsHtml(year, residents, ay), "rotations")}
    ${year.commentsEnabled ? card(repCommentsHtml(year, residents, ay), "comments") : ""}
    ${card(`
      <h3>Scarica riepilogo</h3>
      <p class="muted">Documento con i soli giorni <strong>approvati</strong> per ogni specializzando del ${groupLabel(year)}, con il totale ferie dell'anno accademico e l'avviso di superamento dei ${FERIE_LIMIT} giorni.</p>
      <div class="form-row">
        <label class="field"><span>Periodo</span>
          <select id="export-period" data-keep="exp-period">
            <option value="month">${D.monthLabel(ui.y, ui.m)}</option>
            <option value="year">Anno accademico ${ay.label} (1 nov – 31 ott)</option>
          </select>
        </label>
        <button type="button" class="btn primary" data-action="export-pdf">Scarica PDF</button>
        <button type="button" class="btn" data-action="export-csv">Scarica CSV (Excel)</button>
      </div>
      ${year.commentsEnabled ? `<p class="muted small">Il PDF include i commenti del rappresentante relativi al periodo.</p>` : ""}
    `)}
    ${card(`
      <h3>Specializzandi del ${groupLabel(year)}</h3>
      ${residents.length ? `<ul class="res-list">${residentList}</ul>` : ""}
      <form id="add-res-form" class="form-row">
        <label class="field grow"><span>Nuovo specializzando</span><input name="name" data-keep="add-res" placeholder="Cognome Nome" maxlength="80" required></label>
        <button class="btn primary">Aggiungi</button>
      </form>
    `)}
    ${card(`
      <h3>Impostazioni</h3>
      <label class="check toggle-row">
        <input type="checkbox" id="comments-toggle" ${year.commentsEnabled ? "checked" : ""}>
        <span><strong>Commenti del rappresentante</strong><br><span class="muted small">Per segnalare problemi nell'approvazione. I commenti sono visibili agli specializzandi interessati e vengono riportati nel PDF.</span></span>
      </label>
      <div class="alert info">
        Questo gruppo ha iniziato il I anno nell'a.a. ${ayLabelOf(year.startYear)}.
        ${courseYear(year) < COURSE_YEARS
          ? `Dal 1° novembre ${viewAyStart() + 1} diventerà automaticamente <strong>${ROMAN[courseYear(year) + 1]} anno</strong>, con gli stessi nomi e lo stesso PIN.`
          : `È l'ultimo anno di corso: dal 1° novembre ${viewAyStart() + 1} il gruppo non comparirà più tra gli anni in corso, ma i suoi dati resteranno consultabili tornando agli anni passati.`}
      </div>
      <form id="change-pin-form" class="form-row">
        <label class="field"><span>Nuovo PIN</span><input type="password" name="pin" minlength="4" required autocomplete="new-password"></label>
        <label class="field"><span>Conferma</span><input type="password" name="pin2" minlength="4" required autocomplete="new-password"></label>
        <button class="btn">Cambia PIN</button>
      </form>
      <div class="form-row">
        <button type="button" class="btn ghost" data-action="backup-export">${store.mode === "local" ? "Backup dati (JSON)" : `Backup a.a. ${ay.label} (JSON)`}</button>
        ${store.mode === "local" ? `<label class="btn ghost">Ripristina backup<input type="file" id="import-file" accept="application/json" hidden></label>` : ""}
      </div>
    `)}
  `);
}

// Novità dall'ultimo accesso del rappresentante (memorizzato su questo dispositivo)
const seenKey = (year) => `rep-seen-${year.id}`;
function lastSeen(year) {
  try { return Number(localStorage.getItem(seenKey(year))) || 0; } catch { return 0; }
}

function repNewsHtml(year, idx) {
  const since = lastSeen(year);
  const fresh = idx.all.filter((e) => e.status === "pending" && (e.updatedAt || 0) > since);
  if (!fresh.length) return "";
  const byRes = new Map();
  for (const e of fresh) {
    if (!byRes.has(e.residentId)) byRes.set(e.residentId, []);
    byRes.get(e.residentId).push(e);
  }
  const sharedDays = new Set(fresh.filter((e) => sharedRotations(year, idx.byDate.get(e.date) || [], e.date).length).map((e) => e.date));
  const items = [...byRes].map(([rid, list]) => `<li><strong>${esc(nameOf(year, rid))}</strong> · ${
    D.groupRanges(list, (e) => e.type).map((g) => `${TYPE_LABEL[g.items[0].type]} ${D.fmtRange(g.from, g.to)}`).join(", ")}</li>`).join("");
  return card(`
    <div class="news-head">
      <h3>Novità ${since ? `dal tuo ultimo accesso <span class="muted small">(${new Date(since).toLocaleDateString("it-IT", { day: "numeric", month: "short" })})</span>` : "da approvare"}</h3>
      <button type="button" class="btn tiny ghost" data-action="news-seen">Segna come viste</button>
    </div>
    <p><strong>${fresh.length}</strong> ${fresh.length === 1 ? "nuovo giorno richiesto" : "nuovi giorni richiesti"} da <strong>${byRes.size}</strong> ${byRes.size === 1 ? "specializzando" : "specializzandi"}${sharedDays.size ? ` · <span class="danger-text"><strong>${sharedDays.size}</strong> ${sharedDays.size === 1 ? "giorno" : "giorni"} con colleghi dello stesso reparto</span>` : ""}</p>
    <ul class="news-list">${items}</ul>`, "news");
}

// Panoramica dell'anno accademico: giorni di assenza per specializzando e per mese
function annualHtml(year, idx, residents, ay) {
  const months = D.rangeDates(ay.from, ay.to).filter((d) => d.endsWith("-01")).map((d) => d.slice(0, 7));
  const viewed = `${ui.y}-${String(ui.m + 1).padStart(2, "0")}`;
  const count = new Map();
  for (const e of idx.all) {
    if (e.status === "rejected") continue;
    const k = `${e.residentId}|${e.date.slice(0, 7)}`;
    const c = count.get(k) || { f: 0, c: 0 };
    if (e.type === "ferie") c.f++; else c.c++;
    count.set(k, c);
  }
  const level = (n) => (n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 9 ? 3 : 4);
  const monthStats = months.map((m) => {
    let overlaps = 0, high = 0;
    for (const [date, list] of idx.byDate) {
      if (!date.startsWith(m) || list.length < 2) continue;
      overlaps++;
      if (sharedRotations(year, list, date).length) high++;
    }
    return { overlaps, high };
  });
  const monthName = (m) => D.capitalize(D.MONTHS[Number(m.slice(5)) - 1]);
  const rows = residents.map((r) => {
    const used = countDays(year.id, r.id, "ferie", ay, ["approved", "pending"]);
    return `<tr><th class="sticky name" scope="row">${esc(r.name)}</th>${months.map((m) => {
      const c = count.get(`${r.id}|${m}`) || { f: 0, c: 0 };
      const n = c.f + c.c;
      return `<td><span class="hm l${level(n)}" title="${esc(`${r.name} · ${monthName(m)}: ${c.f} ferie, ${c.c} congressi`)}">${n || ""}</span></td>`;
    }).join("")}<td class="use ${used > FERIE_LIMIT ? "over" : ""}" title="Ferie a.a. ${ay.label} (approvate + in attesa)"><span class="usebar"><span style="width:${Math.min(100, (used / FERIE_LIMIT) * 100)}%"></span></span>${used}/${FERIE_LIMIT}</td></tr>`;
  }).join("");
  return `
    <h3>Panoramica a.a. ${ay.label}</h3>
    <p class="muted small">Giorni di assenza per mese (ferie + congressi, esclusi i rifiutati). Tocca un mese per aprirlo.</p>
    ${residents.length ? `<div class="table-wrap"><table class="grid annual">
      <thead><tr><th class="sticky name">Specializzando</th>${months.map((m) => `<th><button type="button" class="month-link ${m === viewed ? "current" : ""}" data-action="goto-month" data-ym="${m}" title="Apri ${monthName(m)}">${D.MON3[Number(m.slice(5)) - 1]}</button></th>`).join("")}<th class="use-h">Ferie</th></tr></thead>
      <tbody>${rows}
        <tr class="count-row"><th class="sticky name" scope="row">Sovrapposizioni</th>${monthStats.map((s) => `<td>${s.overlaps ? `<span class="ov ${s.high ? "high" : ""}" title="${s.overlaps} giorni con più assenti${s.high ? `, ${s.high} nello stesso reparto` : ""}">${s.overlaps}</span>` : ""}</td>`).join("")}<td></td></tr>
      </tbody>
    </table></div>
    <div class="legend"><span><i class="hm l1"></i>1–2 gg</span><span><i class="hm l2"></i>3–5</span><span><i class="hm l3"></i>6–9</span><span><i class="hm l4"></i>10+</span><span><i class="ov">n</i>giorni sovrapposti</span><span><i class="ov high">n</i>stesso reparto</span></div>`
    : `<p class="muted">Nessuno specializzando inserito.</p>`}`;
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());

function repRotationsHtml(year, residents, ay) {
  const draft = ui.rotDraft?.yearId === year.id ? ui.rotDraft : null;
  if (draft) {
    const nextAy = D.academicYear(D.addDays(ay.to, 1));
    const monthNames = draft.months.map((m) => D.MON3[m - 1]).join(", ");
    return `
      <h3>Turni (reparti) · associa i nomi</h3>
      <p class="muted">Dal foglio «${esc(draft.sheet)}» ho letto ${draft.rows.length} righe con i mesi ${monthNames}. Controlla a chi corrisponde ogni nome del file.</p>
      <div class="form-row">
        <label class="field"><span>Anno accademico dei turni</span>
          <select id="rot-ay" data-keep="rot-ay">
            <option value="${ay.from}">${ay.label}</option>
            <option value="${nextAy.from}">${nextAy.label}</option>
          </select>
        </label>
      </div>
      <div class="table-wrap"><table class="map-table">
        <thead><tr><th>Nel file</th><th>Specializzando</th><th>Reparti</th></tr></thead>
        <tbody>${draft.rows.map((row, i) => `<tr>
          <th scope="row">${esc(row.name)}</th>
          <td><select data-map="${i}" data-keep="rot-map-${i}" aria-label="Specializzando per ${esc(row.name)}">
            <option value="">— ignora —</option>
            <option value="__new__" ${draft.guesses[i] === "__new__" ? "selected" : ""}>+ Aggiungi come «${esc(titleCase(row.name))}»</option>
            ${residents.map((r) => `<option value="${esc(r.id)}" ${draft.guesses[i] === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}
          </select></td>
          <td class="muted small">${esc(Object.values(row.byMonth).join(" · "))}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      <div class="form-row end">
        <button type="button" class="btn ghost" data-action="rot-cancel">Annulla</button>
        <button type="button" class="btn primary" data-action="rot-save">Salva turni</button>
      </div>`;
  }

  const loaded = year.rotations?.[ay.from];
  const months = D.rangeDates(ay.from, ay.to).filter((d) => d.endsWith("-01"));
  const grid = loaded
    ? `<details class="rot-details"><summary>Mostra i turni caricati</summary>
        <div class="table-wrap"><table class="grid rot-grid">
          <thead><tr><th class="sticky name">Specializzando</th>${months.map((d) => `<th>${D.MON3[Number(d.slice(5, 7)) - 1]}</th>`).join("")}</tr></thead>
          <tbody>${residents.map((r) => `<tr><th class="sticky name" scope="row">${esc(r.name)}</th>${months.map((d) => `<td>${esc(loaded.byResident?.[r.id]?.[d.slice(0, 7)] || "")}</td>`).join("")}</tr>`).join("")}</tbody>
        </table></div>
      </details>`
    : "";
  return `
    <h3>Turni (reparti) · a.a. ${ay.label}</h3>
    ${loaded
      ? `<p>Turni caricati per ${Object.keys(loaded.byResident || {}).length} specializzandi, aggiornati il ${new Date(loaded.updatedAt).toLocaleDateString("it-IT")}. Le sovrapposizioni tra colleghi dello stesso reparto sono segnate in rosso.</p>`
      : `<p class="muted">Carica l'Excel dei turni del ${groupLabel(year)} (una riga per specializzando, una colonna per mese con il reparto): le sovrapposizioni tra colleghi dello stesso reparto verranno segnalate come conflitto più grave.</p>`}
    <div class="form-row">
      <label class="btn ${loaded ? "" : "primary"}">${loaded ? "Ricarica Excel turni" : "Carica Excel turni"}<input type="file" id="rot-file" accept=".xlsx,.xls,.ods,.csv" hidden></label>
      ${loaded ? `<button type="button" class="btn ghost danger-text" data-action="rot-remove">Rimuovi turni a.a. ${ay.label}</button>` : ""}
    </div>
    ${grid}`;
}

function repCommentsHtml(year, residents, ay) {
  const list = commentsOf(year, ay);
  return `
    <h3>Commenti del rappresentante · a.a. ${ay.label}</h3>
    <form id="comment-form" class="comment-form">
      <div class="form-row">
        <label class="field"><span>Riferito a</span>
          <select name="residentId" id="cm-res" data-keep="cm-res">
            <option value="">Tutti (commento generale)</option>
            ${residents.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Dal (facoltativo)</span><input type="date" name="from" id="cm-from" data-keep="cm-from"></label>
        <label class="field"><span>Al (facoltativo)</span><input type="date" name="to" id="cm-to" data-keep="cm-to"></label>
      </div>
      <label class="field"><span>Commento</span>
        <textarea name="text" id="cm-text" data-keep="cm-text" rows="3" maxlength="500" required placeholder="Es. 13–14 ottobre non approvati: tre colleghi già assenti in reparto."></textarea>
      </label>
      <div class="form-row end"><button class="btn primary">Aggiungi commento</button></div>
    </form>
    ${list.length
      ? `<ul class="comment-list">${list.map((c) => `<li>
          <div class="comment-head">
            <strong>${c.residentId ? esc(nameOf(year, c.residentId)) : "Tutti"}</strong>${commentWhen(c) ? ` · ${commentWhen(c)}` : ""}
            <span class="muted small">scritto il ${new Date(c.createdAt).toLocaleDateString("it-IT")}</span>
            <button type="button" class="btn tiny ghost danger-text" data-action="delete-comment" data-id="${esc(c.id)}">Elimina</button>
          </div>
          <p>${esc(c.text)}</p>
        </li>`).join("")}</ul>`
      : `<p class="muted">Nessun commento nell'a.a. ${ay.label}.</p>`}`;
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------
async function toggleDay(date) {
  const year = currentYear();
  const rid = year && currentResidentId(year);
  if (!rid) return;
  const id = entryId(year.id, rid, date);
  const ex = state.entries[id];

  if (ui.brush === "cancella" || (ex && ex.type === ui.brush)) {
    if (!ex) return;
    if (ex.status === "approved" && !confirm(`${D.fmtDay(date)} è già approvato come ${TYPE_LABEL[ex.type]}. Vuoi annullarlo?`)) return;
    await act(() => store.deleteEntries([id]));
    return;
  }
  if (ex?.status === "approved" &&
      !confirm(`${D.fmtDay(date)} è già approvato come ${TYPE_LABEL[ex.type]}. Cambiandolo, la richiesta tornerà in attesa di approvazione. Continuare?`)) return;
  const entry = { id, yearId: year.id, residentId: rid, date, type: ui.brush, status: "pending", note: "", updatedAt: Date.now() };
  if (await act(() => store.saveEntries([entry]))) warnFerie(year, rid, date, entry.type);
}

function warnFerie(year, rid, date, type) {
  if (type !== "ferie") return;
  const ay = D.academicYear(date);
  const n = countDays(year.id, rid, "ferie", ay, ["approved", "pending"]);
  if (n > FERIE_LIMIT) toast(`Attenzione: ${n} giorni di ferie nell'a.a. ${ay.label}, oltre il limite di ${FERIE_LIMIT}.`, "warn");
}

async function submitRange(form) {
  const year = currentYear();
  const rid = year && currentResidentId(year);
  if (!rid) return;
  const fd = new FormData(form);
  let from = fd.get("from"), to = fd.get("to");
  const type = fd.get("type");
  const note = String(fd.get("note") || "").trim();
  if (!from || !to) return;
  if (to < from) [from, to] = [to, from];
  let dates = D.rangeDates(from, to);
  if (dates.length > 366) return toast("Periodo troppo lungo (massimo un anno).", "error");
  if (fd.get("skip")) dates = dates.filter((d) => !D.isWeekend(d) && !D.holidayName(d));
  if (!dates.length) return toast("Nessun giorno lavorativo nel periodo selezionato.", "warn");

  const list = [];
  let replacedApproved = 0;
  for (const date of dates) {
    const id = entryId(year.id, rid, date);
    const ex = state.entries[id];
    if (ex?.status === "approved" && ex.type === type && (ex.note || "") === note) continue;
    if (ex?.status === "approved") replacedApproved++;
    list.push({ id, yearId: year.id, residentId: rid, date, type, status: "pending", note, updatedAt: Date.now() });
  }
  if (!list.length) return toast("Questi giorni sono già approvati.");
  if (replacedApproved &&
      !confirm(`${replacedApproved} giorni del periodo sono già approvati con un altro tipo o nota: torneranno in attesa di approvazione. Continuare?`)) return;

  form.reset();
  ui.y = Number(from.slice(0, 4));
  ui.m = Number(from.slice(5, 7)) - 1;
  if (await act(() => store.saveEntries(list), `${list.length} ${list.length === 1 ? "giorno" : "giorni"} di ${TYPE_LABEL[type].toLowerCase()} ${list.length === 1 ? "richiesto" : "richiesti"}.`)) {
    warnFerie(year, rid, to, type);
    render();
  }
}

/** Cambia stato a più richieste, chiedendo conferma se si superano i giorni di ferie. */
async function setStatus(year, entries, status) {
  if (!entries.length) return;
  if (status === "approved") {
    const add = {};
    for (const e of entries)
      if (e.type === "ferie" && e.status !== "approved") {
        const k = `${e.residentId}|${D.academicYear(e.date).from}`;
        add[k] = (add[k] || 0) + 1;
      }
    const warnings = Object.entries(add).flatMap(([k, n]) => {
      const [rid, from] = k.split("|");
      const ay = D.academicYear(from);
      const tot = countDays(year.id, rid, "ferie", ay, ["approved"]) + n;
      return tot > FERIE_LIMIT ? [`• ${nameOf(year, rid)}: ${tot} giorni di ferie approvati nell'a.a. ${ay.label}`] : [];
    });
    if (warnings.length &&
        !confirm(`Attenzione: superamento del limite di ${FERIE_LIMIT} giorni di ferie.\n\n${warnings.join("\n")}\n\nApprovare comunque?`)) return;
  }
  const updated = entries.map((e) => ({ ...e, status, updatedAt: Date.now() }));
  await act(() => store.saveEntries(updated),
    entries.length > 1 ? `${entries.length} richieste: ${STATUS_LABEL[status].toLowerCase()}.` : null);
}

function exportPeriod() {
  const kind = $("#export-period")?.value || "month";
  if (kind === "year") {
    const ay = viewAcademicYear();
    return { from: ay.from, to: ay.to, label: `Anno accademico ${ay.label}` };
  }
  const dates = D.monthDates(ui.y, ui.m);
  return { from: dates[0], to: dates[dates.length - 1], label: D.monthLabel(ui.y, ui.m) };
}

function download(filename, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------------
function wire() {
  $("#year-select").addEventListener("change", (e) => {
    ui.yearId = e.target.value;
    savePrefs({ yearId: ui.yearId });
    render();
  });
  const shift = (n) => {
    const d = new Date(ui.y, ui.m + n, 1);
    ui.y = d.getFullYear();
    ui.m = d.getMonth();
    render();
  };
  $("#prev-month").addEventListener("click", () => shift(-1));
  $("#next-month").addEventListener("click", () => shift(1));
  $("#today-btn").addEventListener("click", () => {
    const t = new Date();
    ui.y = t.getFullYear();
    ui.m = t.getMonth();
    render();
  });
  document.querySelectorAll(".tabs [data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      ui.view = b.dataset.view;
      savePrefs({ view: ui.view });
      render();
    }));

  // Vista specializzando
  const res = $("#view-resident");
  res.addEventListener("change", (e) => {
    if (e.target.id !== "resident-select") return;
    prefs.residents[ui.yearId] = e.target.value;
    savePrefs();
    render();
  });
  res.addEventListener("click", async (e) => {
    const brush = e.target.closest("[data-brush]");
    if (brush) {
      ui.brush = brush.dataset.brush;
      return render();
    }
    const day = e.target.closest("button[data-date]");
    if (day) return toggleDay(day.dataset.date);
    const cancel = e.target.closest('[data-action="cancel-group"]');
    if (cancel) {
      const ids = cancel.dataset.ids.split(",");
      const approved = ids.some((id) => state.entries[id]?.status === "approved");
      if (!confirm(approved ? "Alcuni di questi giorni sono già approvati. Annullare comunque la richiesta?" : "Annullare questa richiesta?")) return;
      await act(() => store.deleteEntries(ids), "Richiesta annullata.");
    }
  });
  res.addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "range-form") submitRange(e.target);
  });

  // Vista rappresentante
  const rep = $("#view-rep");
  rep.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const year = currentYear();
    if (!year) return;
    const fd = new FormData(form);
    switch (form.id) {
      case "pin-setup":
      case "change-pin-form": {
        const pin = String(fd.get("pin")), pin2 = String(fd.get("pin2"));
        if (pin.length < 4) return toast("Il PIN deve avere almeno 4 caratteri.", "error");
        if (pin !== pin2) return toast("I due PIN non coincidono.", "error");
        const hash = await hashPin(year.id, pin);
        setUnlocked(year, hash);
        await act(() => store.saveYear({ ...year, pinHash: hash }), form.id === "pin-setup" ? "PIN impostato." : "PIN aggiornato.");
        return render();
      }
      case "pin-login": {
        const hash = await hashPin(year.id, String(fd.get("pin")));
        if (hash !== year.pinHash) return toast("PIN errato.", "error");
        setUnlocked(year, hash);
        return render();
      }
      case "add-res-form": {
        const name = String(fd.get("name") || "").trim().replace(/\s+/g, " ");
        if (!name) return;
        if (year.residents.some((r) => r.name.toLowerCase() === name.toLowerCase()))
          return toast(`${name} è già presente.`, "warn");
        form.reset();
        return act(() => store.saveYear({ ...year, residents: [...year.residents, { id: newId("r"), name }] }), `${name} aggiunto/a.`);
      }
      case "comment-form": {
        const text = String(fd.get("text") || "").trim();
        if (!text) return;
        let from = fd.get("from") || "", to = fd.get("to") || "";
        if (!from && to) [from, to] = [to, ""];
        if (from && to && to < from) [from, to] = [to, from];
        if (from && !to) to = from;
        const ay = from ? D.academicYear(from) : viewAcademicYear();
        const comment = { id: newId("c"), yearId: year.id, ay: ay.from, residentId: String(fd.get("residentId") || ""), from, to, text, createdAt: Date.now() };
        form.reset();
        return act(() => store.saveComment(comment), "Commento aggiunto.");
      }
    }
  });

  rep.addEventListener("change", async (e) => {
    const year = currentYear();
    if (!year) return;
    if (e.target.id === "rot-file" && e.target.files[0]) {
      const file = e.target.files[0];
      e.target.value = "";
      try {
        const parsed = await parseRotationsFile(file);
        const residents = residentsOf(year);
        const guesses = parsed.rows.map((r) => (residents.length ? guessResident(r.name, residents, year.rotationAliases) : "__new__"));
        // Uno specializzando indovinato per due righe: meglio lasciar scegliere al rappresentante
        guesses.forEach((g, i) => { if (g && g !== "__new__" && guesses.indexOf(g) !== guesses.lastIndexOf(g)) guesses[i] = ""; });
        ui.rotDraft = { yearId: year.id, ...parsed, guesses };
        render();
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }
    if (e.target.id === "comments-toggle") {
      const on = e.target.checked;
      return act(() => store.saveYear({ ...year, commentsEnabled: on }), on ? "Commenti attivati." : "Commenti disattivati.");
    }
    const rid = e.target.dataset.rename;
    if (rid) {
      const name = e.target.value.trim().replace(/\s+/g, " ");
      if (!name) return render();
      await act(() => store.saveYear({ ...year, residents: year.residents.map((r) => (r.id === rid ? { ...r, name } : r)) }), "Nome aggiornato.");
      return;
    }
    if (e.target.id === "import-file" && e.target.files[0]) {
      try {
        const obj = JSON.parse(await e.target.files[0].text());
        if (!confirm("Il ripristino sostituisce tutti i dati salvati in questo browser. Continuare?")) return;
        await act(() => store.importData(obj), "Backup ripristinato.");
      } catch {
        toast("File di backup non valido.", "error");
      }
    }
  });

  rep.addEventListener("click", async (e) => {
    const year = currentYear();
    if (!year) return;
    const cell = e.target.closest("[data-cell]");
    if (cell) {
      const entry = state.entries[cell.dataset.cell];
      if (entry) await setStatus(year, [entry], NEXT_STATUS[entry.status]);
      return;
    }
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const idx = indexYear(year);
    const prefix = `${ui.y}-${String(ui.m + 1).padStart(2, "0")}`;
    const pendingMonth = idx.all.filter((x) => x.status === "pending" && x.date.startsWith(prefix));

    switch (btn.dataset.action) {
      case "lock":
        setUnlocked(year, null);
        return render();
      case "set-status": {
        const entry = state.entries[btn.dataset.id];
        if (entry) await setStatus(year, [entry], btn.dataset.status);
        return;
      }
      case "approve-row":
        return setStatus(year, pendingMonth.filter((x) => x.residentId === btn.dataset.rid), "approved");
      case "approve-month":
        return setStatus(year, pendingMonth, "approved");
      case "approve-clean":
        return setStatus(year, pendingMonth.filter((x) => (idx.byDate.get(x.date) || []).length < 2), "approved");
      case "remove-res": {
        const rid = btn.dataset.rid;
        const ids = Object.values(state.entries).filter((x) => x.yearId === year.id && x.residentId === rid).map((x) => x.id);
        const commentIds = Object.values(state.comments || {}).filter((c) => c.yearId === year.id && c.residentId === rid).map((c) => c.id);
        if (!confirm(`Rimuovere ${nameOf(year, rid)}? Verranno eliminate anche le sue ${ids.length} richieste.`)) return;
        await act(async () => {
          await store.saveYear({ ...year, residents: year.residents.filter((r) => r.id !== rid) });
          if (ids.length) await store.deleteEntries(ids);
          if (commentIds.length) await store.deleteComments(commentIds);
        }, "Specializzando rimosso.");
        return;
      }
      case "rep-filter":
        ui.repFilter = btn.dataset.key;
        return render();
      case "goto-month":
        ui.y = Number(btn.dataset.ym.slice(0, 4));
        ui.m = Number(btn.dataset.ym.slice(5, 7)) - 1;
        render();
        return document.querySelector("#view-rep .grid")?.scrollIntoView({ behavior: "smooth", block: "center" });
      case "news-seen":
        try { localStorage.setItem(seenKey(year), String(Date.now())); } catch { /* ignorato */ }
        return render();
      case "rot-cancel":
        ui.rotDraft = null;
        return render();
      case "rot-save": {
        const draft = ui.rotDraft;
        if (!draft) return;
        const ayFrom = $("#rot-ay").value;
        const startYear = Number(ayFrom.slice(0, 4));
        const residents = [...year.residents];
        const aliases = { ...(year.rotationAliases || {}) };
        const byResident = {};
        for (const sel of document.querySelectorAll("[data-map]")) {
          const row = draft.rows[Number(sel.dataset.map)];
          let rid = sel.value;
          if (!rid) continue;
          if (rid === "__new__") {
            rid = newId("r");
            residents.push({ id: rid, name: titleCase(row.name) });
          }
          if (byResident[rid]) return toast(`${residents.find((r) => r.id === rid).name} è associato a più righe del file.`, "error");
          aliases[normName(row.name)] = rid;
          byResident[rid] = Object.fromEntries(Object.entries(row.byMonth).map(([m, v]) => [monthKey(startYear, Number(m), ACADEMIC_YEAR_START_MONTH), v]));
        }
        const n = Object.keys(byResident).length;
        if (!n) return toast("Associa almeno un nome del file a uno specializzando.", "warn");
        ui.rotDraft = null;
        await act(() => store.saveYear({
          ...year,
          residents,
          rotationAliases: aliases,
          rotations: { ...(year.rotations || {}), [ayFrom]: { updatedAt: Date.now(), byResident } },
        }), `Turni salvati per ${n} specializzandi.`);
        return render();
      }
      case "rot-remove": {
        const ay = viewAcademicYear();
        if (!confirm(`Rimuovere i turni dell'a.a. ${ay.label}?`)) return;
        const rotations = { ...(year.rotations || {}) };
        delete rotations[ay.from];
        return act(() => store.saveYear({ ...year, rotations }), "Turni rimossi.");
      }
      case "comment-prefill": {
        const form = $("#comment-form");
        if (!form) return;
        form.elements.residentId.value = btn.dataset.rid;
        form.elements.from.value = btn.dataset.date;
        form.elements.to.value = btn.dataset.date;
        form.scrollIntoView({ behavior: "smooth", block: "center" });
        form.elements.text.focus({ preventScroll: true });
        return;
      }
      case "delete-comment": {
        if (!confirm("Eliminare questo commento?")) return;
        return act(() => store.deleteComments([btn.dataset.id]), "Commento eliminato.");
      }
      case "export-pdf":
      case "export-csv": {
        const period = exportPeriod();
        const report = buildReport({ year, entries: idx.all, from: period.from, to: period.to, limit: FERIE_LIMIT });
        if (btn.dataset.action === "export-csv") return exportCsv({ year: { ...year, label: groupLabel(year) }, report, period });
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = "Preparazione…";
        const comments = year.commentsEnabled
          ? commentsOf(year, D.academicYear(period.from))
              .filter((c) => commentInPeriod(c, period.from, period.to))
              .map((c) => ({ who: c.residentId ? nameOf(year, c.residentId) : "Tutti", when: commentWhen(c) || "—", text: c.text }))
          : null;
        await act(() => exportPdf({ year: { ...year, label: groupLabel(year) }, report, period, limit: FERIE_LIMIT, comments }));
        btn.disabled = false;
        btn.textContent = old;
        return;
      }
      case "backup-export":
        return download(`backup-ferie-congressi_${D.todayIso()}.json`, JSON.stringify(state, null, 2), "application/json");
    }
  });
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
// Rimuove l'app installabile (service worker) attivata per breve tempo in una versione precedente
navigator.serviceWorker?.getRegistrations?.()
  .then((regs) => regs.forEach((r) => r.unregister()))
  .catch(() => {});

(async function init() {
  wire();
  try {
    store = await createStore((data) => {
      state = data;
      if (store) render();
    });
  } catch (err) {
    console.error(err);
    $("#loading").textContent = "Impossibile caricare i dati: " + (err?.message || err);
    return;
  }
  state = store.data;
  try {
    await store.watchAcademicYear(viewAcademicYear().from);
  } catch (err) {
    $("#loading").textContent = "Impossibile caricare i dati: " + (err?.message || err);
    return;
  }
  $("#loading").remove();
  const badge = $("#mode-badge");
  if (store.mode === "firebase") {
    badge.textContent = "● Dati condivisi";
    badge.className = "mode-badge online";
    badge.title = "I dati sono sincronizzati in tempo reale per tutti gli utenti.";
  } else {
    badge.textContent = "● Modalità locale";
    badge.className = "mode-badge local";
    badge.title = "I dati sono salvati solo in questo browser. Configura Firebase in js/config.js per condividerli (vedi README).";
    if (store.error) toast("Connessione al database non riuscita: uso i dati locali.", "error");
  }
  render();
})();
