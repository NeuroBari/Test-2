// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

// Configurazione Firebase per condividere i dati tra tutti gli utenti.
// Incolla qui i valori del tuo progetto (Console Firebase → Impostazioni
// progetto → Le tue app → App web). Vedi README.md per i passaggi.
// Se lasciata vuota, il sito funziona in "modalità locale": i dati restano
// salvati solo nel browser del dispositivo in uso.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDSYhLzfbKEH77hqVj59SNetXbOq_Npk_I",
  authDomain: "ferie-neurologia-bari.firebaseapp.com",
  projectId: "ferie-neurologia-bari",
  storageBucket: "ferie-neurologia-bari.firebasestorage.app",
  messagingSenderId: "293835462349",
  appId: "1:293835462349:web:ec199590a4fa30c84f3b84",
};

// Limite di giorni di ferie per anno accademico (oltre questa soglia viene
// mostrato un avviso). Per i congressi non c'è limite.
export const FERIE_LIMIT = 30;

// Mese di inizio dell'anno accademico (1 = gennaio … 11 = novembre).
// Con 11 l'anno accademico va dal 1° novembre al 31 ottobre successivo.
export const ACADEMIC_YEAR_START_MONTH = 11;

// Durata della scuola di specializzazione in anni. Ogni gruppo di
// specializzandi avanza automaticamente di un anno di corso all'inizio di
// ogni anno accademico (es. il 1° novembre il II anno diventa III anno);
// dopo l'ultimo anno il gruppo resta consultabile solo negli anni passati.
export const COURSE_YEARS = 4;

// Chiave pubblica per le notifiche push (Web Push / VAPID). È pubblica per natura:
// la chiave privata corrispondente è solo nei "Secrets" di GitHub (VAPID_PRIVATE_KEY)
// e la usa il programma che invia le notifiche (.github/workflows/notifiche.yml).
export const VAPID_PUBLIC_KEY = "BBQTyKYyuDst2Uh1ATQQpZ82oVSs3oN-wb2v525AazOmCr83uPIN03MlMVMVSK3CR0-hzoXoVReMdNRTXSLBjsQ";
