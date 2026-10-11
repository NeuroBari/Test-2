// Generazione del riepilogo (PDF e CSV) con i soli giorni approvati.

import * as D from "./dates.js";

const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const AUTOTABLE_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";

const scriptCache = new Map();
function loadScript(src) {
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {
        scriptCache.delete(src);
        reject(new Error("Impossibile caricare la libreria PDF (connessione assente?)"));
      };
      document.head.appendChild(s);
    }));
  }
  return scriptCache.get(src);
}

const byName = (a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" });

/**
 * Prepara i dati del riepilogo per un anno di corso e un periodo.
 * entries: tutte le richieste dell'anno di corso.
 */
export function buildReport({ year, entries, from, to, limit }) {
  const ay = D.academicYear(from);
  const rows = [...year.residents].sort(byName).map((r) => {
    const mine = entries.filter((e) => e.residentId === r.id);
    const approved = mine.filter((e) => e.status === "approved");
    const inPeriod = approved.filter((e) => e.date >= from && e.date <= to);
    const ferieYear = approved.filter((e) => e.type === "ferie" && e.date >= ay.from && e.date <= ay.to).length;
    return {
      name: r.name,
      ferie: inPeriod.filter((e) => e.type === "ferie"),
      congressi: inPeriod.filter((e) => e.type === "congresso"),
      ferieYear,
      over: ferieYear > limit,
      pending: mine.filter((e) => e.status === "pending" && e.date >= from && e.date <= to).length,
    };
  });
  return { ay, rows };
}

const noteKey = (e) => e.note || "";

export function rangesText(list, withNotes = false) {
  if (!list.length) return "—";
  return D.groupRanges(list, withNotes ? noteKey : undefined)
    .map((g) => D.fmtRange(g.from, g.to) + (withNotes && g.key ? ` (${g.key})` : ""))
    .join(", ");
}

const slug = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

export async function exportPdf({ year, report, period, limit, comments = null }) {
  await loadScript(JSPDF_URL);
  await loadScript(AUTOTABLE_URL);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const blue = [37, 99, 235];

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Riepilogo ferie e congressi approvati", 14, 18);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(80);
  doc.text(`Scuola di Specializzazione in Neurologia - ${year.label}`, 14, 25);
  doc.text(`Periodo: ${period.label}`, 14, 30);
  const now = new Date();
  doc.text(`Generato il ${now.toLocaleDateString("it-IT")} alle ${now.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`, 14, 35);
  doc.setTextColor(0);

  const { rows, ay } = report;
  doc.autoTable({
    startY: 41,
    head: [["Specializzando", "Ferie approvate", "gg", "Congressi approvati", "gg", `Ferie a.a.\n${ay.label}\n(tot. approvate)`]],
    body: rows.map((r) => [
      r.name,
      rangesText(r.ferie),
      String(r.ferie.length),
      rangesText(r.congressi, true),
      String(r.congressi.length),
      `${r.ferieYear}/${limit}${r.over ? "\nOLTRE LIMITE" : ""}`,
    ]),
    styles: { fontSize: 9, cellPadding: 2, valign: "top", lineColor: [220, 225, 235], lineWidth: 0.1 },
    headStyles: { fillColor: blue, textColor: 255, valign: "middle" },
    alternateRowStyles: { fillColor: [246, 248, 252] },
    columnStyles: {
      0: { cellWidth: 36, fontStyle: "bold" },
      2: { cellWidth: 10, halign: "center" },
      4: { cellWidth: 10, halign: "center" },
      5: { cellWidth: 24, halign: "center" },
    },
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 5 && rows[data.row.index].over) {
        data.cell.styles.textColor = [185, 28, 28];
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  let y = doc.lastAutoTable.finalY + 7;
  doc.setFontSize(9);
  const notes = [];
  notes.push("Sono riportati esclusivamente i giorni approvati dal rappresentante.");
  const over = rows.filter((r) => r.over);
  if (over.length)
    notes.push(`Attenzione - superato il limite di ${limit} giorni di ferie nell'a.a. ${ay.label}: ${over.map((r) => `${r.name} (${r.ferieYear})`).join(", ")}.`);
  const pending = rows.reduce((s, r) => s + r.pending, 0);
  if (pending) notes.push(`Nel periodo restano ${pending} giorni richiesti in attesa di approvazione (non inclusi).`);
  for (const n of notes) {
    const lines = doc.splitTextToSize(n, pageW - 28);
    doc.text(lines, 14, y);
    y += lines.length * 4.5;
  }

  // Commenti del rappresentante (solo se attivati per l'anno di corso)
  if (comments) {
    y += 4;
    if (y > pageH - 40) { doc.addPage(); y = 20; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Commenti del rappresentante", 14, y);
    doc.setFont("helvetica", "normal");
    if (comments.length) {
      doc.autoTable({
        startY: y + 3,
        head: [["Specializzando", "Periodo", "Commento"]],
        body: comments.map((c) => [c.who, c.when, c.text]),
        styles: { fontSize: 9, cellPadding: 2, valign: "top" },
        headStyles: { fillColor: [180, 83, 9] },
        columnStyles: { 0: { cellWidth: 36, fontStyle: "bold" }, 1: { cellWidth: 32 } },
      });
      y = doc.lastAutoTable.finalY + 7;
    } else {
      doc.setFontSize(9);
      doc.text("Nessun commento nel periodo.", 14, y + 6);
      y += 12;
    }
  }

  // Dettaglio mese per mese (solo per periodi più lunghi di un mese)
  if (period.from.slice(0, 7) !== period.to.slice(0, 7)) {
    const body = [];
    const start = D.parse(period.from);
    for (let dt = new Date(start.getFullYear(), start.getMonth(), 1); D.toIso(dt) <= period.to; dt.setMonth(dt.getMonth() + 1)) {
      const prefix = D.toIso(dt).slice(0, 7);
      const monthName = D.monthLabel(dt.getFullYear(), dt.getMonth());
      for (const r of rows) {
        const f = r.ferie.filter((e) => e.date.startsWith(prefix));
        const c = r.congressi.filter((e) => e.date.startsWith(prefix));
        if (!f.length && !c.length) continue;
        body.push([monthName, r.name, f.length ? `${rangesText(f)} (${f.length} gg)` : "—", c.length ? `${rangesText(c, true)} (${c.length} gg)` : "—"]);
      }
    }
    if (body.length) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      y += 4;
      if (y > pageH - 40) { doc.addPage(); y = 20; }
      doc.text("Dettaglio mese per mese", 14, y);
      doc.setFont("helvetica", "normal");
      doc.autoTable({
        startY: y + 3,
        head: [["Mese", "Specializzando", "Ferie", "Congressi"]],
        body,
        styles: { fontSize: 9, cellPadding: 2, valign: "top" },
        headStyles: { fillColor: blue },
        columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 38 } },
      });
      y = doc.lastAutoTable.finalY + 7;
    }
  }

  // Firma
  if (y > pageH - 30) { doc.addPage(); y = 20; }
  y += 10;
  doc.setFontSize(10);
  doc.text("Il/La rappresentante", pageW - 80, y);
  doc.line(pageW - 80, y + 12, pageW - 14, y + 12);

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(130);
    doc.text(`${year.label} - ${period.label} - pagina ${i} di ${pages}`, pageW / 2, pageH - 8, { align: "center" });
  }

  doc.save(`ferie-congressi_${slug(year.label)}_${slug(period.label)}.pdf`);
}

export function exportCsv({ year, report, period }) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [["Anno di corso", "Specializzando", "Data", "Giorno", "Tipo", "Nota"].map(q).join(";")];
  for (const r of report.rows) {
    const all = [...r.ferie, ...r.congressi].sort((a, b) => a.date.localeCompare(b.date));
    for (const e of all)
      lines.push([year.label, r.name, D.fmtNumeric(e.date), D.WD3[D.weekday(e.date)], e.type === "ferie" ? "Ferie" : "Congresso", e.note || ""].map(q).join(";"));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ferie-congressi_${slug(year.label)}_${slug(period.label)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
