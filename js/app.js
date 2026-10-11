import { createStore } from "./store.js";
import { FERIE_LIMIT } from "./config.js";
import * as D from "./dates.js";
import { buildReport, exportPdf, exportCsv } from "./export.js";

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
let state = { years: {}, entries: {} };
let store = null;

const yearsSorted = () =>
  Object.values(state.years).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.label.localeCompare(b.label));
const currentYear = () => state.years[ui.yearId] || null;
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
  if (!state.years[ui.yearId]) ui.yearId = yearsSorted()[0]?.id ?? null;
  const year = currentYear();

  $("#year-select").innerHTML = yearsSorted()
    .map((y) => `<option value="${esc(y.id)}" ${y.id === ui.yearId ? "selected" : ""}>${esc(y.label)}</option>`)
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
    ${residents.length ? "" : `<p class="muted">Non ci sono ancora specializzandi nel ${esc(year.label)}. Il rappresentante può aggiungerli dall'area <strong>Rappresentante</strong>.</p>`}
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
    cells += `<button type="button" class="day ${cls}" data-date="${date}" title="${esc(titleParts.join("\n"))}">
      <span class="day-num">${d}</span>
      ${hol ? `<span class="day-hol">${esc(hol)}</span>` : ""}
      ${mine ? `<span class="pill ${mine.type} ${mine.status}"><span class="long">${mine.type === "ferie" ? "Ferie" : "Congr."}</span><span class="short">${mine.type === "ferie" ? "F" : "C"}</span> ${STATUS_ICON[mine.status]}</span>` : ""}
      ${others.length ? `<span class="others">👥 ${others.length}</span>` : ""}
    </button>`;
  }
  return `<div class="calendar"><div class="cal-grid">${head}${cells}</div></div>`;
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
        <h2>Area rappresentante · ${esc(year.label)}</h2>
        ${setup
          ? `<p class="muted">Primo accesso: scegli un PIN (almeno 4 caratteri) per proteggere l'area rappresentante di questo anno di corso.</p>
             <div class="form-row center">
               <label class="field"><span>Nuovo PIN</span><input type="password" name="pin" minlength="4" required autocomplete="new-password"></label>
               <label class="field"><span>Conferma PIN</span><input type="password" name="pin2" minlength="4" required autocomplete="new-password"></label>
             </div>
             <button class="btn primary">Imposta PIN ed entra</button>`
          : `<p class="muted">Inserisci il PIN del rappresentante del ${esc(year.label)}.</p>
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
  const pendingMonth = idx.all.filter((e) => e.status === "pending" && e.date.startsWith(monthPrefix));
  const pendingClean = pendingMonth.filter((e) => !overlapSet.has(e.date));
  const overLimit = residents.filter((r) => countDays(year.id, r.id, "ferie", ay, ["approved", "pending"]) > FERIE_LIMIT);
  const today = D.todayIso();

  // Tabella mensile
  const colCls = (date) => [
    D.isWeekend(date) && "weekend",
    D.holidayName(date) && "holiday",
    overlapSet.has(date) && "overlap",
    date === today && "today",
  ].filter(Boolean).join(" ");

  const headCells = dates.map((date) => {
    const act = idx.byDate.get(date) || [];
    const title = [D.fmtDay(date), D.holidayName(date), overlapSet.has(date) && `Sovrapposizione: ${act.map((e) => nameOf(year, e.residentId)).join(", ")}`].filter(Boolean).join("\n");
    return `<th class="${colCls(date)}" title="${esc(title)}">${Number(date.slice(8))}<small>${D.WD1[D.weekday(date)]}</small></th>`;
  }).join("");

  const bodyRows = residents.map((r) => {
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
      <th class="sticky name" scope="row">${esc(r.name)}</th>
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
      <p class="muted small">Clic su una cella per cambiare stato: in attesa → approvato → rifiutato. Le colonne arancioni indicano giorni in cui più colleghi sono assenti.</p>`
    : `<p class="muted">Aggiungi gli specializzandi del ${esc(year.label)} nella sezione qui sotto.</p>`;

  // Sovrapposizioni
  const conflicts = overlapDates.length
    ? overlapDates.map((date) => {
        const list = idx.byDate.get(date);
        return `<div class="conflict">
          <div class="conflict-date">${D.fmtDay(date)}<small>${list.length} assenti</small></div>
          <ul>${list.sort((a, b) => nameOf(year, a.residentId).localeCompare(nameOf(year, b.residentId), "it")).map((e) => `<li>
            <span class="dot ${e.type}"></span>
            <span class="req-main"><strong>${esc(nameOf(year, e.residentId))}</strong> · ${TYPE_LABEL[e.type]}${e.note ? ` <span class="muted">— ${esc(e.note)}</span>` : ""}</span>
            <span class="status ${e.status}">${STATUS_LABEL[e.status]}</span>
            <span class="actions">
              ${e.status !== "approved" ? `<button type="button" class="btn tiny ok" data-action="set-status" data-id="${esc(e.id)}" data-status="approved">Approva</button>` : ""}
              <button type="button" class="btn tiny danger" data-action="set-status" data-id="${esc(e.id)}" data-status="rejected">Rifiuta</button>
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
        <h2>Area rappresentante · ${esc(year.label)}</h2>
        <button type="button" class="btn ghost" data-action="lock">Esci</button>
      </div>
      <div class="kpis">
        <div class="kpi"><span>${pendingMonth.length}</span>richieste in attesa nel mese</div>
        <div class="kpi ${overlapDates.length ? "warn" : ""}"><span>${overlapDates.length}</span>giorni con sovrapposizioni</div>
        <div class="kpi ${overLimit.length ? "danger" : ""}"><span>${overLimit.length}</span>oltre ${FERIE_LIMIT} gg di ferie (a.a. ${ay.label})</div>
        <div class="kpi"><span>${residents.length}</span>specializzandi</div>
      </div>
      ${overLimit.length ? `<div class="alert danger">Superano i ${FERIE_LIMIT} giorni di ferie nell'a.a. ${ay.label} (approvati + in attesa): ${overLimit.map((r) => `<strong>${esc(r.name)}</strong> (${countDays(year.id, r.id, "ferie", ay, ["approved", "pending"])})`).join(", ")}.</div>` : ""}
      <div class="bulk">
        <button type="button" class="btn primary" data-action="approve-clean" ${pendingClean.length ? "" : "disabled"}>Approva le richieste senza sovrapposizioni (${pendingClean.length})</button>
        <button type="button" class="btn" data-action="approve-month" ${pendingMonth.length ? "" : "disabled"}>Approva tutte le richieste del mese (${pendingMonth.length})</button>
      </div>
    `)}
    ${card(`<h3>${D.monthLabel(ui.y, ui.m)}</h3>${table}${legendHtml()}`)}
    ${card(`<h3>Sovrapposizioni · ${D.monthLabel(ui.y, ui.m)}</h3>${conflicts}`, "conflicts")}
    ${card(`
      <h3>Scarica riepilogo</h3>
      <p class="muted">Documento con i soli giorni <strong>approvati</strong> per ogni specializzando del ${esc(year.label)}, con il totale ferie dell'anno accademico e l'avviso di superamento dei ${FERIE_LIMIT} giorni.</p>
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
    `)}
    ${card(`
      <h3>Specializzandi del ${esc(year.label)}</h3>
      ${residents.length ? `<ul class="res-list">${residentList}</ul>` : ""}
      <form id="add-res-form" class="form-row">
        <label class="field grow"><span>Nuovo specializzando</span><input name="name" data-keep="add-res" placeholder="Cognome Nome" maxlength="80" required></label>
        <button class="btn primary">Aggiungi</button>
      </form>
    `)}
    ${card(`
      <h3>Impostazioni</h3>
      <form id="rename-year-form" class="form-row">
        <label class="field grow"><span>Nome dell'anno di corso</span><input name="label" value="${esc(year.label)}" maxlength="40" required></label>
        <button class="btn">Rinomina</button>
      </form>
      <form id="change-pin-form" class="form-row">
        <label class="field"><span>Nuovo PIN</span><input type="password" name="pin" minlength="4" required autocomplete="new-password"></label>
        <label class="field"><span>Conferma</span><input type="password" name="pin2" minlength="4" required autocomplete="new-password"></label>
        <button class="btn">Cambia PIN</button>
      </form>
      <div class="form-row">
        <button type="button" class="btn" data-action="add-year">+ Aggiungi anno di corso</button>
        ${residents.length ? "" : `<button type="button" class="btn ghost danger-text" data-action="delete-year">Elimina ${esc(year.label)}</button>`}
        <button type="button" class="btn ghost" data-action="backup-export">${store.mode === "local" ? "Backup dati (JSON)" : `Backup a.a. ${ay.label} (JSON)`}</button>
        ${store.mode === "local" ? `<label class="btn ghost">Ripristina backup<input type="file" id="import-file" accept="application/json" hidden></label>` : ""}
      </div>
    `)}
  `);
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
  if (await act(() => store.saveEntries(list), `${list.length} giorni di ${TYPE_LABEL[type].toLowerCase()} richiesti.`)) {
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
      case "rename-year-form": {
        const label = String(fd.get("label") || "").trim();
        if (label) return act(() => store.saveYear({ ...year, label }), "Anno di corso rinominato.");
      }
    }
  });

  rep.addEventListener("change", async (e) => {
    const year = currentYear();
    if (!year) return;
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
        if (!confirm(`Rimuovere ${nameOf(year, rid)}? Verranno eliminate anche le sue ${ids.length} richieste.`)) return;
        await act(async () => {
          await store.saveYear({ ...year, residents: year.residents.filter((r) => r.id !== rid) });
          if (ids.length) await store.deleteEntries(ids);
        }, "Specializzando rimosso.");
        return;
      }
      case "export-pdf":
      case "export-csv": {
        const period = exportPeriod();
        const report = buildReport({ year, entries: idx.all, from: period.from, to: period.to, limit: FERIE_LIMIT });
        if (btn.dataset.action === "export-csv") return exportCsv({ year, report, period });
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = "Preparazione…";
        await act(() => exportPdf({ year, report, period, limit: FERIE_LIMIT }));
        btn.disabled = false;
        btn.textContent = old;
        return;
      }
      case "add-year": {
        const label = prompt("Nome del nuovo anno di corso (es. V anno):");
        if (!label?.trim()) return;
        const order = Math.max(0, ...Object.values(state.years).map((y) => y.order ?? 0)) + 1;
        const id = newId("y");
        await act(() => store.saveYear({ id, label: label.trim(), order, residents: [], pinHash: "" }), "Anno di corso aggiunto.");
        ui.yearId = id;
        savePrefs({ yearId: id });
        return render();
      }
      case "delete-year":
        if (!confirm(`Eliminare ${year.label}?`)) return;
        return act(() => store.deleteYear(year.id), "Anno di corso eliminato.");
      case "backup-export":
        return download(`backup-ferie-congressi_${D.todayIso()}.json`, JSON.stringify(state, null, 2), "application/json");
    }
  });
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
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
