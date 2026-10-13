// Archivio dati: Firebase Firestore (condiviso) oppure localStorage (locale).
//
// Modello dati (Firestore)
//   years/{yearId}       { id, startYear, residents: [{ id, name }], pinHash, commentsEnabled,
//                          deadlines: [{ id, label, from, to, due, congressi }] }
//                        un gruppo di specializzandi (coorte): startYear è l'anno in cui
//                        inizia il loro I anno (2026 = a.a. 2026/27). L'anno di corso
//                        si calcola dall'anno accademico visualizzato.
//   comments/{id}        { id, yearId, ay, residentId ("" = tutti), from, to, text, createdAt }
//   pushSubs/{id}        { endpoint, keys: { p256dh, auth }, kind: "res" | "rep", yearId, residentId, createdAt }
//                        iscrizioni alle notifiche push (una per dispositivo e destinatario);
//                        dal sito si possono solo creare e cancellare, le legge il programma delle notifiche
//   meta/notifier        stato del programma delle notifiche (solo lato server)
//                        commenti del rappresentante (attivabili per anno di corso)
//   absences/{yearId}__{residentId}__{ay}
//                        { yearId, residentId, ay, days: { "YYYY-MM-DD": { type, status, note, updatedAt } } }
//                        un documento per specializzando e anno accademico (ay = data di inizio),
//                        così aprire il sito costa una lettura per specializzando.
//                        type:   "ferie" | "congresso"
//                        status: "pending" | "approved" | "rejected"
//                        reason: motivo del rifiuto (scritto dal rappresentante)
//                        late:   richiesta inviata dopo la scadenza del periodo (years.deadlines)
//                        cancel: lo specializzando chiede di annullare un giorno già approvato
//                        cancelDenied: il rappresentante ha mantenuto il giorno approvato
//
// Verso l'app i dati sono esposti come richieste "piatte":
//   entries[id] = { id, yearId, residentId, date, type, status, note, reason, late, cancel, cancelDenied, updatedAt }
// con id = `${yearId}__${residentId}__${date}`.

import { FIREBASE_CONFIG } from "./config.js";
import { academicYear } from "./dates.js";

const FIREBASE_VERSION = "10.12.2";

export async function createStore(onChange) {
  if (FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId) {
    try {
      return await firebaseStore(onChange);
    } catch (err) {
      console.error("Firebase non disponibile, uso la modalità locale", err);
      const store = localStore(onChange);
      store.error = err;
      return store;
    }
  }
  return localStore(onChange);
}

const normalizeYear = (id, y) => ({ id, residents: [], pinHash: "", commentsEnabled: false, deadlines: [], ...y });

// ---------------------------------------------------------------------------
// Modalità locale
// ---------------------------------------------------------------------------
function localStore(onChange) {
  const KEY = "neuro-ferie-data-v1";

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.years && d.entries) return { comments: {}, ...d };
    } catch { /* storage non disponibile o dati corrotti */ }
    return {
      years: {},
      entries: {},
      comments: {},
    };
  }

  const data = load();

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (err) {
      console.warn("Impossibile salvare in localStorage", err);
    }
    onChange(data);
  }

  // Sincronizza tra schede dello stesso browser
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    const fresh = load();
    data.years = fresh.years;
    data.entries = fresh.entries;
    data.comments = fresh.comments;
    onChange(data);
  });

  return {
    mode: "local",
    data,
    // In locale tutti i dati sono già in memoria
    watchAcademicYear: () => Promise.resolve(),
    // Modifica il gruppo partendo sempre dai dati più recenti (fn riceve una copia e la restituisce modificata)
    async updateYear(id, fn) {
      data.years[id] = structuredClone(fn(structuredClone(normalizeYear(id, data.years[id] || {}))));
      persist();
    },
    async exportAll() {
      return structuredClone(data);
    },
    async ensureYears(list) {
      for (const y of list) data.years[y.id] = normalizeYear(y.id, { ...y, ...data.years[y.id] });
      persist();
    },
    async saveEntries(list) {
      for (const e of list) data.entries[e.id] = structuredClone(e);
      persist();
    },
    async deleteEntries(ids) {
      for (const id of ids) delete data.entries[id];
      persist();
    },
    async saveComment(c) {
      data.comments[c.id] = structuredClone(c);
      persist();
    },
    async deleteComments(ids) {
      for (const id of ids) delete data.comments[id];
      persist();
    },
    async importData(obj) {
      if (!obj || typeof obj.years !== "object" || typeof obj.entries !== "object")
        throw new Error("File di backup non valido");
      data.years = obj.years;
      data.entries = obj.entries;
      data.comments = obj.comments || {};
      persist();
    },
  };
}

// ---------------------------------------------------------------------------
// Modalità condivisa (Firebase Firestore)
// ---------------------------------------------------------------------------
async function firebaseStore(onChange) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fs = await import(`${base}/firebase-firestore.js`);

  const app = initializeApp(FIREBASE_CONFIG);
  const db = fs.getFirestore(app);
  const data = { years: {}, entries: {}, comments: {} };

  const firstYears = new Promise((resolve, reject) => {
    fs.onSnapshot(
      fs.collection(db, "years"),
      (snap) => {
        const years = {};
        snap.forEach((d) => (years[d.id] = normalizeYear(d.id, d.data())));
        data.years = years;
        resolve();
        onChange(data);
      },
      reject,
    );
  });

  // Ascolta solo le assenze e i commenti dell'anno accademico visualizzato
  let watchedAy = null;
  let unsubscribe = [];
  let firstLoad = null;
  function watchAcademicYear(ay) {
    if (ay === watchedAy) return firstLoad;
    watchedAy = ay;
    unsubscribe.forEach((u) => u());
    unsubscribe = [];
    data.entries = {};
    data.comments = {};
    const comments = new Promise((resolve, reject) => {
      unsubscribe.push(fs.onSnapshot(
        fs.query(fs.collection(db, "comments"), fs.where("ay", "==", ay)),
        (snap) => {
          const comments = {};
          snap.forEach((d) => (comments[d.id] = { ...d.data(), id: d.id }));
          data.comments = comments;
          resolve();
          onChange(data);
        },
        (err) => {
          console.error(err);
          reject(err);
        },
      ));
    });
    const absences = new Promise((resolve, reject) => {
      unsubscribe.push(fs.onSnapshot(
        fs.query(fs.collection(db, "absences"), fs.where("ay", "==", ay)),
        (snap) => {
          const entries = {};
          snap.forEach((d) => {
            const { yearId, residentId, days = {} } = d.data();
            for (const [date, v] of Object.entries(days)) {
              const id = `${yearId}__${residentId}__${date}`;
              entries[id] = { note: "", ...v, id, yearId, residentId, date };
            }
          });
          data.entries = entries;
          resolve();
          onChange(data);
        },
        (err) => {
          console.error(err);
          reject(err);
        },
      ));
    });
    firstLoad = Promise.all([absences, comments]);
    return firstLoad;
  }

  await firstYears;

  async function batched(items, apply) {
    // Firestore accetta al massimo 500 operazioni per batch
    for (let i = 0; i < items.length; i += 450) {
      const batch = fs.writeBatch(db);
      for (const it of items.slice(i, i + 450)) apply(batch, it);
      await batch.commit();
    }
  }

  /** Raggruppa le modifiche per documento (specializzando + anno accademico). */
  function groupByDoc(items, valueOf) {
    const docs = new Map();
    for (const { yearId, residentId, date, value } of items.map(valueOf)) {
      const ay = academicYear(date).from;
      const key = `${yearId}__${residentId}__${ay}`;
      // touchedAt (ora del server): permette al programma delle notifiche di leggere solo i documenti cambiati
      if (!docs.has(key)) docs.set(key, { yearId, residentId, ay, touchedAt: fs.serverTimestamp(), days: {} });
      docs.get(key).days[date] = value;
    }
    // merge: aggiorna solo i giorni toccati, senza sovrascrivere gli altri
    return batched([...docs], (b, [key, doc]) => b.set(fs.doc(db, "absences", key), doc, { merge: true }));
  }

  return {
    mode: "firebase",
    data,
    watchAcademicYear,
    // Transazione: rilegge il gruppo dal database e applica solo la modifica richiesta, così due
    // rappresentanti che salvano quasi insieme non si sovrascrivono a vicenda (Firestore la ripete se serve)
    updateYear: (id, fn) =>
      fs.runTransaction(db, async (tx) => {
        const ref = fs.doc(db, "years", id);
        const snap = await tx.get(ref);
        const current = normalizeYear(id, snap.exists() ? snap.data() : {});
        tx.set(ref, JSON.parse(JSON.stringify(fn(current))));
      }),
    // Backup completo: tutti gli anni accademici, non solo quello visualizzato
    exportAll: async () => {
      const [ys, abs, cms] = await Promise.all(["years", "absences", "comments"].map((c) => fs.getDocs(fs.collection(db, c))));
      const out = { years: {}, entries: {}, comments: {} };
      ys.forEach((d) => (out.years[d.id] = normalizeYear(d.id, d.data())));
      abs.forEach((d) => {
        const { yearId, residentId, days = {} } = d.data();
        for (const [date, v] of Object.entries(days)) {
          const id = `${yearId}__${residentId}__${date}`;
          out.entries[id] = { note: "", ...v, id, yearId, residentId, date };
        }
      });
      cms.forEach((d) => (out.comments[d.id] = { ...d.data(), id: d.id }));
      return out;
    },
    // merge: se un altro dispositivo ha già creato il gruppo non ne tocca nomi e PIN
    ensureYears: (list) => batched(list, (b, y) => b.set(fs.doc(db, "years", y.id), y, { merge: true })),
    saveEntries: (list) =>
      groupByDoc(list, (e) => ({
        ...e,
        // Tutti i campi sempre presenti: con il merge di Firestore un campo omesso resterebbe com'era
        value: {
          type: e.type, status: e.status, note: e.note || "", reason: e.reason || "",
          late: !!e.late, cancel: !!e.cancel, cancelDenied: !!e.cancelDenied, updatedAt: e.updatedAt || Date.now(),
        },
      })),
    saveComment: (c) => fs.setDoc(fs.doc(db, "comments", c.id), JSON.parse(JSON.stringify(c))),
    deleteComments: (ids) => batched(ids, (b, id) => b.delete(fs.doc(db, "comments", id))),
    // Iscrizioni alle notifiche push: si possono creare e cancellare, ma non leggere dal sito
    savePushSub: (id, sub) => fs.setDoc(fs.doc(db, "pushSubs", id), sub),
    deletePushSub: (id) => fs.deleteDoc(fs.doc(db, "pushSubs", id)),
    deleteEntries: (ids) =>
      groupByDoc(ids, (id) => {
        const [yearId, residentId, date] = id.split("__");
        return { yearId, residentId, date, value: fs.deleteField() };
      }),
  };
}
