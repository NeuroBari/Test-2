// Archivio dati: Firebase Firestore (condiviso) oppure localStorage (locale).
//
// Modello dati (Firestore)
//   years/{yearId}       { id, label, order, residents: [{ id, name }], pinHash }
//   absences/{yearId}__{residentId}__{ay}
//                        { yearId, residentId, ay, days: { "YYYY-MM-DD": { type, status, note, updatedAt } } }
//                        un documento per specializzando e anno accademico (ay = data di inizio),
//                        così aprire il sito costa una lettura per specializzando.
//                        type:   "ferie" | "congresso"
//                        status: "pending" | "approved" | "rejected"
//
// Verso l'app i dati sono esposti come richieste "piatte":
//   entries[id] = { id, yearId, residentId, date, type, status, note, updatedAt }
// con id = `${yearId}__${residentId}__${date}`.

import { FIREBASE_CONFIG, DEFAULT_YEARS } from "./config.js";
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

const normalizeYear = (id, y) => ({ id, label: id, order: 99, residents: [], pinHash: "", ...y });

// ---------------------------------------------------------------------------
// Modalità locale
// ---------------------------------------------------------------------------
function localStore(onChange) {
  const KEY = "neuro-ferie-data-v1";

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.years && d.entries) return d;
    } catch { /* storage non disponibile o dati corrotti */ }
    return {
      years: Object.fromEntries(DEFAULT_YEARS.map((y) => [y.id, normalizeYear(y.id, y)])),
      entries: {},
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
    onChange(data);
  });

  return {
    mode: "local",
    data,
    // In locale tutti i dati sono già in memoria
    watchAcademicYear: () => Promise.resolve(),
    async saveYear(y) {
      data.years[y.id] = structuredClone(y);
      persist();
    },
    async deleteYear(id) {
      delete data.years[id];
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
    async importData(obj) {
      if (!obj || typeof obj.years !== "object" || typeof obj.entries !== "object")
        throw new Error("File di backup non valido");
      data.years = obj.years;
      data.entries = obj.entries;
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
  const data = { years: {}, entries: {} };

  const seed = () => {
    // merge: non sovrascrive specializzandi o PIN se un altro client ha già creato l'anno
    for (const y of DEFAULT_YEARS)
      fs.setDoc(fs.doc(db, "years", y.id), { id: y.id, label: y.label, order: y.order }, { merge: true });
  };

  const firstYears = new Promise((resolve, reject) => {
    fs.onSnapshot(
      fs.collection(db, "years"),
      (snap) => {
        const years = {};
        snap.forEach((d) => (years[d.id] = normalizeYear(d.id, d.data())));
        data.years = years;
        resolve();
        onChange(data);
        if (snap.empty && !snap.metadata.fromCache) seed();
      },
      reject,
    );
  });

  // Ascolta solo le assenze dell'anno accademico visualizzato
  let watchedAy = null;
  let unsubscribe = null;
  let firstLoad = null;
  function watchAcademicYear(ay) {
    if (ay === watchedAy) return firstLoad;
    watchedAy = ay;
    unsubscribe?.();
    data.entries = {};
    firstLoad = new Promise((resolve, reject) => {
      unsubscribe = fs.onSnapshot(
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
      );
    });
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
      if (!docs.has(key)) docs.set(key, { yearId, residentId, ay, days: {} });
      docs.get(key).days[date] = value;
    }
    // merge: aggiorna solo i giorni toccati, senza sovrascrivere gli altri
    return batched([...docs], (b, [key, doc]) => b.set(fs.doc(db, "absences", key), doc, { merge: true }));
  }

  return {
    mode: "firebase",
    data,
    watchAcademicYear,
    saveYear: (y) => fs.setDoc(fs.doc(db, "years", y.id), JSON.parse(JSON.stringify(y))),
    deleteYear: (id) => fs.deleteDoc(fs.doc(db, "years", id)),
    saveEntries: (list) =>
      groupByDoc(list, (e) => ({
        ...e,
        value: { type: e.type, status: e.status, note: e.note || "", updatedAt: e.updatedAt || Date.now() },
      })),
    deleteEntries: (ids) =>
      groupByDoc(ids, (id) => {
        const [yearId, residentId, date] = id.split("__");
        return { yearId, residentId, date, value: fs.deleteField() };
      }),
  };
}
