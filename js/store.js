// Archivio dati: Firebase Firestore (condiviso) oppure localStorage (locale).
//
// Modello dati
//   years/{yearId}   { id, label, order, residents: [{ id, name }], pinHash }
//   entries/{id}     { id, yearId, residentId, date, type, status, note, updatedAt }
//                     type:   "ferie" | "congresso"
//                     status: "pending" | "approved" | "rejected"

import { FIREBASE_CONFIG, DEFAULT_YEARS } from "./config.js";

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
        if (snap.empty && !snap.metadata.fromCache) seed();
        const years = {};
        snap.forEach((d) => (years[d.id] = normalizeYear(d.id, d.data())));
        data.years = years;
        resolve();
        onChange(data);
      },
      reject,
    );
  });

  const firstEntries = new Promise((resolve, reject) => {
    fs.onSnapshot(
      fs.collection(db, "entries"),
      (snap) => {
        const entries = {};
        snap.forEach((d) => (entries[d.id] = { ...d.data(), id: d.id }));
        data.entries = entries;
        resolve();
        onChange(data);
      },
      reject,
    );
  });

  await Promise.all([firstYears, firstEntries]);

  async function batched(items, apply) {
    // Firestore accetta al massimo 500 operazioni per batch
    for (let i = 0; i < items.length; i += 450) {
      const batch = fs.writeBatch(db);
      for (const it of items.slice(i, i + 450)) apply(batch, it);
      await batch.commit();
    }
  }

  return {
    mode: "firebase",
    data,
    saveYear: (y) => fs.setDoc(fs.doc(db, "years", y.id), JSON.parse(JSON.stringify(y))),
    deleteYear: (id) => fs.deleteDoc(fs.doc(db, "years", id)),
    saveEntries: (list) =>
      batched(list, (b, e) => b.set(fs.doc(db, "entries", e.id), JSON.parse(JSON.stringify(e)))),
    deleteEntries: (ids) => batched(ids, (b, id) => b.delete(fs.doc(db, "entries", id))),
  };
}
