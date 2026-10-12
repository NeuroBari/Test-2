// App installabile (PWA): registrazione del service worker e pulsante "Installa app".

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function setupPwa() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker non registrato", err));
    });
  }

  const btn = document.getElementById("install-btn");
  const help = document.getElementById("install-help");
  if (!btn || isStandalone()) return;

  let deferred = null;
  // Android / Chrome / Edge: il browser propone l'installazione
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    btn.hidden = true;
    deferred = null;
  });
  // iPhone / iPad: l'installazione si fa dal menu Condividi di Safari, mostriamo le istruzioni
  if (isIos()) btn.hidden = false;

  btn.addEventListener("click", async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      btn.hidden = true;
    } else if (help?.showModal) {
      help.showModal();
    }
  });
  help?.querySelector("[data-close]")?.addEventListener("click", () => help.close());
}
