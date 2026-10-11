// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

// Configurazione Firebase per condividere i dati tra tutti gli utenti.
// Incolla qui i valori del tuo progetto (Console Firebase → Impostazioni
// progetto → Le tue app → App web). Vedi README.md per i passaggi.
// Se lasciata vuota, il sito funziona in "modalità locale": i dati restano
// salvati solo nel browser del dispositivo in uso.
export const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// Limite di giorni di ferie per anno solare (oltre questa soglia viene
// mostrato un avviso). Per i congressi non c'è limite.
export const FERIE_LIMIT = 30;

// Anni di corso creati al primo avvio (altri possono essere aggiunti
// dall'area rappresentante).
export const DEFAULT_YEARS = [
  { id: "y1", label: "I anno", order: 1 },
  { id: "y2", label: "II anno", order: 2 },
  { id: "y3", label: "III anno", order: 3 },
  { id: "y4", label: "IV anno", order: 4 },
];
