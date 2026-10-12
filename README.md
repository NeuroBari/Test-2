# Ferie & Congressi · Specializzandi in Neurologia

Sito statico (GitHub Pages) per organizzare mese per mese le **ferie** e i **congressi** degli specializzandi in Neurologia, diviso per anno di corso.

## Funzionalità

**Specializzando**
- sceglie l'anno di corso e il proprio nome;
- segna i singoli giorni sul calendario del mese come *Ferie* o *Congresso* (un tocco per segnare, un altro per togliere), oppure un intero periodo con il modulo "Segna un periodo", con l'opzione di escludere weekend e festivi e di aggiungere una nota (es. il nome del congresso);
- può **trascinare** sul calendario per segnare (o cancellare) più giorni insieme: con il mouse tieni premuto e trascina, sul telefono tieni premuto un attimo sul giorno e poi trascina; i weekend e i festivi in mezzo vengono saltati;
- apre la **scheda del giorno** (la sua richiesta, i colleghi assenti con tipo, stato e reparto, e i pulsanti Ferie / Congresso / Rimuovi) con lo strumento «Dettagli», tenendo premuto sul giorno dal telefono o con il tasto destro dal computer;
- trova un riquadro **Novità** con le richieste approvate o rifiutate e i nuovi messaggi del rappresentante dall'ultima visita;
- con **"Aggiungi al mio calendario"** scarica un file .ics con i giorni approvati dell'anno accademico da importare in Google Calendar, Calendario di iPhone o Outlook;
- vede lo stato di ogni richiesta (in attesa / approvata / rifiutata) e quanti colleghi del suo anno sono assenti in ogni giorno (👥);
- vede il contatore delle ferie dell'anno accademico (1° novembre – 31 ottobre), con un **avviso se supera i 30 giorni**. Per i congressi non c'è nessun limite.

**Rappresentante** (area protetta da un PIN per ogni anno di corso)
- tabella del mese con tutti gli specializzandi del suo anno: le **colonne arancioni indicano i giorni in cui più colleghi si sovrappongono**;
- elenco delle sovrapposizioni, con i pulsanti Approva/Rifiuta per decidere caso per caso;
- clic su una cella per cambiare stato (in attesa → approvato → rifiutato), approvazione per riga o in blocco (solo le richieste senza sovrapposizioni, oppure tutte);
- avviso per chi supera i 30 giorni di ferie e richiesta di conferma se un'approvazione li fa superare;
- **download del riepilogo dei giorni approvati** in PDF (mese o anno accademico, con il dettaglio mese per mese e lo spazio per la firma) o in CSV per Excel;
- **commenti del rappresentante** (da attivare in *Impostazioni*, per ogni anno di corso): servono a segnalare problemi nell'approvazione. Ogni commento può riguardare uno specializzando o tutti, con un periodo facoltativo, e si può scrivere direttamente dall'elenco delle sovrapposizioni con il pulsante *Commenta*. Lo specializzando interessato li vede nella sua pagina e, se i commenti sono attivi, finiscono nel PDF nella sezione "Commenti del rappresentante";
- **turni (reparti)**: il rappresentante carica l'Excel dei turni del proprio anno (una riga per specializzando, una colonna per mese da novembre a ottobre, nella cella il reparto). Il sito associa i nomi del file agli specializzandi (anche soprannomi come "MYRI"; chi non c'è ancora può essere aggiunto direttamente dal file) e segnala in **rosso** le sovrapposizioni tra colleghi dello stesso reparto, in arancione le altre. Lo specializzando vede il proprio reparto del mese e un ⚠ nei giorni in cui un collega dello stesso reparto è già assente. L'Excel può essere ricaricato quando cambiano i turni: i nomi vengono riconosciuti in automatico;
- **novità dall'ultimo accesso**: all'apertura dell'area rappresentante un riquadro elenca le nuove richieste in attesa (chi, cosa, quando) e quanti giorni toccano colleghi dello stesso reparto; "Segna come viste" lo nasconde fino alle prossime novità (ricordato su ogni dispositivo);
- **filtro per reparto** nella tabella del mese (dai turni caricati);
- **panoramica dell'anno accademico**: giorni di assenza per specializzando e per mese, ferie usate su 30 e numero di giorni con sovrapposizioni per mese (in rosso se nello stesso reparto); toccando un mese si apre quel mese;
- **promemoria di backup**: se da quel dispositivo non si scarica un backup da più di 30 giorni compare un avviso con il pulsante "Scarica backup" (o "Più tardi", che lo rimanda di una settimana). Il backup è completo: tutti gli anni di corso e tutti gli anni accademici;
- gestione dell'elenco degli specializzandi, del PIN e backup JSON.

Le festività nazionali italiane (Pasqua e Pasquetta comprese) sono evidenziate automaticamente.

## Passaggio all'anno successivo e nuovo anno accademico

I nomi si inseriscono **una sola volta**. Ogni gruppo di specializzandi avanza da solo di un anno di corso all'inizio di ogni anno accademico: il 1° novembre il I anno diventa II anno, il II diventa III e così via, con gli stessi nomi, lo stesso PIN del rappresentante e la stessa impostazione dei commenti.

- Il 1° novembre compare in automatico un nuovo **I anno** vuoto: il suo rappresentante entra, imposta il PIN e aggiunge i nomi dei nuovi specializzandi.
- Dopo il IV anno il gruppo non compare più tra gli anni in corso, ma i suoi dati restano consultabili tornando con le frecce ai mesi passati.
- Con il nuovo anno accademico ripartono da zero il contatore delle ferie, le richieste e i commenti. Quelli degli anni precedenti non vengono cancellati: basta tornare indietro con le frecce del mese per rivederli o scaricarne il PDF.

La durata della scuola (4 anni) si modifica con `COURSE_YEARS` in `js/config.js`.

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

### Quante persone regge il piano gratuito?

Il piano gratuito Spark consente 50.000 letture e 20.000 scritture al giorno e 1 GB di spazio. Il sito salva un documento per specializzando per anno accademico e, quando si apre, legge solo l'anno accademico visualizzato. Un'apertura costa quindi circa una lettura per specializzando (≈ 50 con 50 persone), cioè circa 1.000 aperture al giorno senza pagare nulla. Ogni giorno segnato o approvato costa una scrittura.

## Primo utilizzo

1. Apri la scheda **Rappresentante**, scegli il tuo anno di corso e imposta un PIN (il primo che entra lo sceglie).
2. Aggiungi i nomi degli specializzandi del tuo anno.
3. Condividi il link del sito con i colleghi: ognuno sceglie il proprio nome nella scheda **Specializzando**.

## Note e limiti

- Il limite di 30 giorni si calcola per **anno accademico, dal 1° novembre al 31 ottobre dell'anno successivo**, e somma le ferie approvate e quelle in attesa (le rifiutate non contano). Limite e mese di inizio si modificano con `FERIE_LIMIT` e `ACADEMIC_YEAR_START_MONTH` in `js/config.js`.
- Si conta ogni giorno segnato come ferie: con l'opzione "Escludi sabati, domeniche e festivi" si richiedono solo i giorni lavorativi.
- Le modifiche ai dati del gruppo (nomi, PIN, turni, impostazioni) sono salvate con una transazione: se due rappresentanti salvano quasi insieme, nessuna delle due modifiche va persa.
- Il PIN del rappresentante e la scelta del nome sono una protezione "di cortesia", adatta a un gruppo di colleghi che si fida l'uno dell'altro. Chi conosce il link e sa usare gli strumenti per sviluppatori potrebbe modificare i dati direttamente. Se serve una protezione reale, il passo successivo è aggiungere il login con Firebase Authentication e restringere le regole Firestore.
- Le date sono salvate come `AAAA-MM-GG`, nel fuso orario del dispositivo.

## Struttura

```
index.html        pagina
css/style.css     stile "Fusione" (mare dell'Adriatico + pietra di Bari), chiaro/scuro, responsive
img/logo.svg      logo "Neurone sul mare" (originale, non è un marchio dell'università)
js/config.js      configurazione Firebase, limite ferie, durata della scuola
js/app.js         interfaccia e logica
js/store.js       salvataggio dati (Firestore o localStorage)
js/dates.js       date, festività italiane, intervalli
js/export.js      riepilogo PDF (jsPDF) e CSV
js/rotations.js   lettura dell'Excel dei turni (SheetJS)
firestore.rules   regole di sicurezza Firestore
```
