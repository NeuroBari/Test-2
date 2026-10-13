// Programma delle notifiche push, eseguito da GitHub Actions ogni 5 minuti
// (.github/workflows/notifiche.yml).
//
// 1. legge da Firestore le assenze e i commenti cambiati dall'ultima esecuzione;
// 2. prepara un messaggio per ogni destinatario (lib.mjs);
// 3. lo invia ai dispositivi iscritti (collezione pushSubs) con Web Push;
// 4. salva in meta/notifier l'ora dell'esecuzione e le modifiche già notificate.
//
// Secrets richiesti (GitHub → Settings → Secrets and variables → Actions):
//   FIREBASE_SERVICE_ACCOUNT  contenuto del file .json della chiave di servizio di Firebase
//   VAPID_PRIVATE_KEY         chiave privata per firmare le notifiche
// La chiave pubblica VAPID si legge da js/config.js.

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import webpush from "web-push";
import { buildMessages, targetKey, MARGIN_MS, SITE_URL } from "./lib.mjs";

const { FIREBASE_SERVICE_ACCOUNT, VAPID_PRIVATE_KEY } = process.env;
if (!FIREBASE_SERVICE_ACCOUNT || !VAPID_PRIVATE_KEY) {
  console.log("Secrets FIREBASE_SERVICE_ACCOUNT e/o VAPID_PRIVATE_KEY non impostati: nessuna notifica inviata.");
  process.exit(0);
}

const config = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
const VAPID_PUBLIC_KEY = /VAPID_PUBLIC_KEY\s*=\s*"([^"]+)"/.exec(config)?.[1];
if (!VAPID_PUBLIC_KEY) throw new Error("VAPID_PUBLIC_KEY non trovata in js/config.js");
webpush.setVapidDetails(SITE_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.trim());

initializeApp({ credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const metaRef = db.doc("meta/notifier");

const now = new Date();
const meta = (await metaRef.get()).data() || {};

// Prima esecuzione: si parte da adesso, senza notificare tutto lo storico
if (!meta.lastRun) {
  await metaRef.set({ lastRun: now.getTime(), recent: {} });
  console.log("Prima esecuzione: da ora in poi le novità verranno notificate.");
  process.exit(0);
}

const from = meta.lastRun - MARGIN_MS;
const [absSnap, comSnap] = await Promise.all([
  db.collection("absences").where("touchedAt", ">", Timestamp.fromMillis(from)).get(),
  db.collection("comments").where("createdAt", ">", from).get(),
]);

// Elenco delle modifiche già notificate negli ultimi 2 ore (serve con la tolleranza di 15 minuti)
const recent = Object.fromEntries(Object.entries(meta.recent || {}).filter(([, t]) => t > now.getTime() - 2 * 3600 * 1000));
let sent = 0, failed = 0, removed = 0;

if (!absSnap.empty || !comSnap.empty) {
  const years = {};
  (await db.collection("years").get()).forEach((d) => (years[d.id] = d.data()));
  const absences = absSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const comments = comSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const { messages, seen } = buildMessages({ absences, comments, years, since: meta.lastRun, recent, now });
  for (const k of seen) recent[k] = now.getTime();

  if (messages.size) {
    const subs = await db.collection("pushSubs").get();
    await Promise.all(subs.docs.map(async (d) => {
      const s = d.data();
      const msg = messages.get(targetKey(s.kind, s.yearId, s.residentId));
      if (!msg) return;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), { TTL: 24 * 3600, urgency: "normal" });
        sent++;
      } catch (err) {
        // 404/410: il dispositivo ha revocato l'iscrizione (app disinstallata, permesso tolto)
        if (err.statusCode === 404 || err.statusCode === 410) {
          await d.ref.delete();
          removed++;
        } else {
          failed++;
          console.error(`Invio non riuscito (${err.statusCode || "?"}):`, err.body || err.message);
        }
      }
    }));
  }
  console.log(`Modifiche: ${absSnap.size} documenti di assenze, ${comSnap.size} commenti → ${messages.size} destinatari.`);
}

await metaRef.set({ lastRun: now.getTime(), recent, lastSent: sent });
console.log(`Notifiche inviate: ${sent}${failed ? `, non riuscite: ${failed}` : ""}${removed ? `, iscrizioni scadute rimosse: ${removed}` : ""}.`);
// La connessione a Firestore resterebbe aperta: si chiude esplicitamente
process.exit(failed && !sent ? 1 : 0);
