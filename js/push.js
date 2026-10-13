// Notifiche push: iscrizione del dispositivo per uno specializzando ("res") o per il
// rappresentante di un anno di corso ("rep"). Le notifiche le invia il programma su
// GitHub Actions (notifier/), che ogni pochi minuti legge le novità da Firestore.

import { VAPID_PUBLIC_KEY } from "./config.js";

const LOCAL_KEY = "push-targets"; // destinatari attivati su questo dispositivo

const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

export const targetKey = (kind, yearId, residentId = "") => `${kind}:${yearId}:${residentId}`;

function readTargets() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch { return []; }
}
function writeTargets(list) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch { /* ignorato */ }
}

/**
 * Stato delle notifiche su questo dispositivo:
 *  "on"          attive per questo destinatario
 *  "off"         disponibili, non attive
 *  "denied"      bloccate nelle impostazioni del browser
 *  "install"     iPhone/iPad: servono l'app installata nella schermata Home
 *  "unsupported" browser senza notifiche push
 */
export function pushStatus(key) {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) return isIos() && !isStandalone() ? "install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && readTargets().includes(key) ? "on" : "off";
}

const b64ToBytes = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Un documento per dispositivo e destinatario: l'id deriva dall'indirizzo del dispositivo,
// così si può cancellare senza poterlo leggere
const subId = (endpoint, key) => sha256(`${endpoint}|${key}`);

async function currentSubscription(create) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub && create)
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
  return sub;
}

/** Attiva le notifiche per un destinatario (da chiamare dal clic su un pulsante). */
export async function enablePush(store, { kind, yearId, residentId = "" }) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied"
    ? "Notifiche bloccate: riattivale dalle impostazioni del browser o del telefono."
    : "Permesso per le notifiche non concesso.");
  const sub = (await currentSubscription(true)).toJSON();
  const key = targetKey(kind, yearId, residentId);
  await store.savePushSub(await subId(sub.endpoint, key), {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    kind, yearId, residentId,
    createdAt: Date.now(),
  });
  writeTargets([...new Set([...readTargets(), key])]);
}

/** Disattiva le notifiche per un destinatario; se non ne restano altri, anche per il dispositivo. */
export async function disablePush(store, { kind, yearId, residentId = "" }) {
  const key = targetKey(kind, yearId, residentId);
  const rest = readTargets().filter((k) => k !== key);
  const sub = await currentSubscription(false);
  if (sub) {
    await store.deletePushSub(await subId(sub.endpoint, key));
    if (!rest.length) await sub.unsubscribe();
  }
  writeTargets(rest);
}
