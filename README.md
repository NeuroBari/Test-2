# Ferie & Congressi · Specializzandi in Neurologia

Sito statico (GitHub Pages) per organizzare mese per mese le **ferie** e i **congressi** degli specializzandi in Neurologia, diviso per anno di corso.

## Funzionalità

**Specializzando**
- sceglie l'anno di corso e il proprio nome;
- segna i singoli giorni sul calendario del mese come *Ferie* o *Congresso* (un tocco per segnare, un altro per togliere), oppure un intero periodo con il modulo "Segna un periodo", con l'opzione di escludere weekend e festivi e di aggiungere una nota (es. il nome del congresso);
- vede lo stato di ogni richiesta (in attesa / approvata / rifiutata) e quanti colleghi del suo anno sono assenti in ogni giorno (👥);
- vede il contatore delle ferie dell'anno solare, con un **avviso se supera i 30 giorni**. Per i congressi non c'è nessun limite.

**Rappresentante** (area protetta da un PIN per ogni anno di corso)
- tabella del mese con tutti gli specializzandi del suo anno: le **colonne arancioni indicano i giorni in cui più colleghi si sovrappongono**;
- elenco delle sovrapposizioni, con i pulsanti Approva/Rifiuta per decidere caso per caso;
- clic su una cella per cambiare stato (in attesa → approvato → rifiutato), approvazione per riga o in blocco (solo le richieste senza sovrapposizioni, oppure tutte);
- avviso per chi supera i 30 giorni di ferie e richiesta di conferma se un'approvazione li fa superare;
- **download del riepilogo dei giorni approvati** in PDF (mese o anno solare, con il dettaglio mese per mese e lo spazio per la firma) o in CSV per Excel;
- gestione dell'elenco degli specializzandi, del nome dell'anno di corso, del PIN, aggiunta di nuovi anni di corso e backup JSON.

Le festività nazionali italiane (Pasqua e Pasquetta comprese) sono evidenziate automaticamente.

## Pubblicazione su GitHub Pages

1. Su GitHub apri **Settings → Pages**.
2. In *Build and deployment* scegli **Deploy from a branch**, seleziona il branch con questi file e la cartella **/ (root)**, poi premi **Save**.
3. Dopo un minuto circa il sito è disponibile su `https://<utente-o-organizzazione>.github.io/Test-2/`.

## Condividere i dati tra tutti (Firebase)

GitHub Pages ospita solo file statici, quindi per far vedere a tutti le stesse richieste serve un database. Il sito usa **Firebase Firestore**, il cui piano gratuito basta e avanza.

Finché `js/config.js` non è compilato, il sito funziona in **modalità locale** (badge giallo in alto): i dati restano solo nel browser in uso. È utile per provarlo, non per l'uso reale.

Configurazione (una sola volta, circa 10 minuti):

1. Vai su <https://console.firebase.google.com>, premi **Aggiungi progetto** e crea il progetto (Google Analytics non serve).
2. Nel menu **Build → Firestore Database** premi **Crea database**, scegli la località `eur3 (europe-west)` e avvia in **modalità produzione**.
3. Nella scheda **Regole** di Firestore incolla il contenuto del file [`firestore.rules`](firestore.rules) e premi **Pubblica**.
4. In **Impostazioni progetto → Generali → Le tue app** premi l'icona web `</>`, registra l'app (Firebase Hosting non serve) e copia i valori di `firebaseConfig`.
5. Incolla quei valori in [`js/config.js`](js/config.js) dentro `FIREBASE_CONFIG`, poi fai commit e push.

Ricarica il sito: il badge diventa verde ("Dati condivisi") e le modifiche compaiono in tempo reale su tutti i dispositivi.

> La `apiKey` di Firebase non è un segreto: identifica il progetto ed è normale che sia pubblica nel codice del sito. La protezione del database dipende dalle regole Firestore.

## Primo utilizzo

1. Apri la scheda **Rappresentante**, scegli il tuo anno di corso e imposta un PIN (il primo che entra lo sceglie).
2. Aggiungi i nomi degli specializzandi del tuo anno.
3. Condividi il link del sito con i colleghi: ognuno sceglie il proprio nome nella scheda **Specializzando**.

## Note e limiti

- Il limite di 30 giorni si calcola per **anno solare** e somma le ferie approvate e quelle in attesa (le rifiutate non contano). Si modifica con `FERIE_LIMIT` in `js/config.js`, dove si cambiano anche gli anni di corso iniziali (I–IV).
- Si conta ogni giorno segnato come ferie: con l'opzione "Escludi sabati, domeniche e festivi" si richiedono solo i giorni lavorativi.
- Il PIN del rappresentante e la scelta del nome sono una protezione "di cortesia", adatta a un gruppo di colleghi che si fida l'uno dell'altro. Chi conosce il link e sa usare gli strumenti per sviluppatori potrebbe modificare i dati direttamente. Se serve una protezione reale, il passo successivo è aggiungere il login con Firebase Authentication e restringere le regole Firestore.
- Le date sono salvate come `AAAA-MM-GG`, nel fuso orario del dispositivo.

## Struttura

```
index.html        pagina
css/style.css     stile (chiaro/scuro, responsive)
js/config.js      configurazione Firebase, limite ferie, anni di corso
js/app.js         interfaccia e logica
js/store.js       salvataggio dati (Firestore o localStorage)
js/dates.js       date, festività italiane, intervalli
js/export.js      riepilogo PDF (jsPDF) e CSV
firestore.rules   regole di sicurezza Firestore
```
