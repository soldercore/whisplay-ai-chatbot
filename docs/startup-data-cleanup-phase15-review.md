# Fase 1.5 – vedvarende data beskyttet ved oppstart

Status 2026-10-16: **Implementert etter eksplisitt godkjenning. 110/110 tester består.**
Undersøkelsen 2026-10-15 stoppet før fjerning, i tråd med brukerens instruks.
Den destruktive oppstartsoppryddingen er nå fjernet. Gamle `true`-verdier gir
bare en advarsel. Katalogstier, opprettelse av manglende mapper, minneformat
og sikkerhetsimplementeringen fra fase 1 er bevart.
Ingen SSH, Pi-forbindelse, full applikasjonsoppstart, installasjon, restart,
commit, push eller deploy er utført.

## Opprinnelig feil og standardverdi (før rettingen)

Tidligere `src/utils/dir.ts:7–24` leste flagget ved import, etter
`dotenv.config()`. Bare den eksakte verdien `true` aktiverte slettingen;
utelatt verdi betydde false. Katalogen er fast utledet fra modulens plassering,
ikke en konfigurerbar slettesti: prosjektrotens `data/`, både fra `src/utils`
og fra `dist/utils`. Den fjernede `cleanupDataDir()` kjørte:

```ts
fs.rmSync(dataDir, { recursive: true, force: true });
```

Dette slettet hele treet før katalogene ble opprettet igjen. Det var ingen
tillatelsesliste, klassifisering av filenes levetid, bekreftelse eller
tilbakerulling. Opprettelse av tomme kataloger gjenoppretter ikke innholdet.
Feil under sletting kunne etterlate et delvis slettet tre og avbryte importen.
Det fantes ingen eksplisitt symlink-/kanoniseringspolicy i funksjonen; dette
er ikke en påstand om at Nodes rekursive rm følger alle symlinker.

Flaggets referanser før denne rapporten:

- `src/utils/dir.ts:7–8`: eneste produksjonsleser av flagget.
- `.env.template:73–74`: kommentar som foreslår å aktivere sletting med true.
- `AGENTS.md:493`: allerede eksisterende advarsel fra fase 1.
- `docs/tool-execution-phase1.md:90–94`: allerede dokumentert, uløst risiko.
- `src/test/fixtures/isolate-tests.cjs:10,20`: tvinger flagget av i testprosesser.

Ingen rot-`.env` finnes i Windows-kopien. Det ble ikke funnet overstyring av
flagget i repoets oppstartsskript, Docker-filer, serviceoppsett eller
pi-gen-oppsett. Ingen hemmelige konfigurasjonsverdier er skrevet ut.
`run_chatbot.sh` starter normalt `dist/index.js` fra arbeidsmappen;
`startup.sh` og pi-gen-provisionering oppretter systemd-oppsett med prosjektet
som arbeidsmappe. Node laster `.env`; arvede miljøvariabler kan også styre
flagget. Docker Compose kjører AI-støttetjenestene, ikke Node-applikasjonen,
og monterer `docker/volume/{ollama,faster-whisper,piper}`.

**Faktisk miljø, .env, systemd-konfigurasjon og installert dist på Pi:
IKKE VERIFISERT.**

## Faktiske lagringssteder

| Data | Kilde og plassering | Tidligere sletterisiko |
|---|---|---|
| Lokalt minne | `src/config/local-memory.ts:55–58,264–298,791–806`: `MEMORY_DIR` eller `data/memory/`; `memory.json`, atomisk `.tmp`, `.bak-*`, `.corrupt-*` | Alt under data slettes, også gjenopprettingsfiler. Eksternt MEMORY_DIR ligger utenfor dette slettetreet. |
| Andre langtidsminner | `src/config/mempalace.ts:9,256`: `MEMPALACE_PALACE_PATH` eller `~/.mempalace/palace` | Avhenger av om konfigurert sti ligger under data; standarden ligger utenfor. |
| Samtalehistorikk | `src/utils/dir.ts:37` og LLM-adapterne, blant annet `ollama-llm.ts:448`: `data/chat_history/` | Slettes. |
| Brukeropptak | `src/core/chat-flow/states.ts:162,212`: `data/recordings/user-<tid>.<format>` | Slettes sammen med alle brukerlagrede filer i mappen. |
| TTS og transkripsjon | `src/utils/dir.ts:28–32`, lokale TTS-/Whisper-adaptere: `data/tts/`, `data/asr/` | Alt slettes. Midlertidige mellomfiler og beholdte resultater er ikke skilt med eierskapsmarkør eller levetid. |
| Bilder og kamera | `src/utils/dir.ts:40–47`, `src/utils/image.ts`, `web-audio-bridge.ts:429`: `data/images/`, `data/camera/`, `data/camera_feed/` | Alt slettes, inkludert lagrede bilder og ukjente filer. |
| Piper-tjenestebackuper | `scripts/piper-voice.sh:108–115`: `data/piper-service-backups/` | Slettes selv om de er konfigurasjonsbackuper. |
| Plugins | `src/plugin/loader.ts:33–37,52–64,97–107`: `plugins/<navn>/.env`, npm-plugins i `node_modules/`; plugins kan selv velge andre datastier | Standard plugin-kode/-konfig ligger utenfor data. Plugin-data under data slettes. Det finnes ingen komplett kontrakt for plugin-datastier. |
| Skills | `src/config/harness-command.ts:39–52`: `HARNESS_SKILL_DIRS` eller arbeidsmappens `skills/` | Standard utenfor data; konfigurert mappe under data slettes. |
| Konfig og logger | `configure-env.ts:45–47,357–367`: rot-`.env`, `.env.backups/`; `startup.sh`, pi-gen og `scripts/register-whisplay-daemon-app.js:52–60`: rot-`chatbot.log` | Standard utenfor data; ukjente logger/configs under data slettes. |
| Kunnskap og modeller | `src/utils/dir.ts:50`: rot-`knowledge/`; `docker/docker-compose.yml`: `docker/volume/`; Piper-voicescript: `assets/voices/` og tjenestens konfigurerte modellmappe | Disse standardstedene ligger utenfor data. Eventuelle øvrige filer under data, også et `data/db/`, slettes uten særbehandling. |

Dette er en kildekodekartlegging av standarder og konfigurerbare stier,
ikke en inventarliste fra den fysiske Pi-en eller fra installerte plugins.
En global regel for `.tmp`, `.wav`, en mappe eller et leverandørprefiks vil
ikke bevise at en fil kan kastes. Minne har for eksempel en atomisk `.tmp`-fil.

## Opprinnelig hensikt og hvorfor fjerning anbefales

Git-historikken viser innføringen i commit
`395db681192d17e827857afc2fe25429b9198fc4`, 2025-10-25,
`feat: manage data folder, save chat history`. Den samlet tidligere spredte
TTS-/opptaksstier og innførte lagring av samtaler og valgfri nullstilling ved
oppstart. Kommentaren beskriver ønsket om å tømme data ved hver start.
Ingen mer detaljert begrunnelse er dokumentert i den undersøkte endringen.
Plassbesparelse er en mulig hensikt, ikke et dokumentert krav.

Jeg fant ingen nødvendig avhengighet av et tomt dataområde ved start.
Piper HTTP rydder selv originalfilen etter vellykket konvertering og ved flere
feil (`piper-http-tts.ts:106–110,172,188,221,242`). Konverterte WAV-filer
beholdes (`:228–238`). `src/test/audio-play.ts:11–42` spiller slike lagrede
WAV-filer på nytt. Derfor anbefales ikke automatisk sletting basert på
filnavn alene. Den minste rettingen trenger ingen ny midlertidig lagrings-
eller manifestmekanisme og ingen nye avhengigheter.

## Implementert retting

1. `src/utils/dir.ts`: flaggkonstanten, `cleanupDataDir()` og den rekursive
   slettingen er fjernet. Alle eksporterte stier og katalogopprettelse er beholdt.
   `true` gir bare en kort advarsel om at oppstartssletting er deaktivert.
2. `.env.template`: true-anbefalingen er erstattet med forklaring om at det
   gamle flagget ignoreres. Ingen faktisk `.env` er endret.
3. `src/test/startup-data.spec.ts`: 17 isolerte regresjonstester av den faktiske
   initialiseringen er registrert i `package.json`. Den vanlige test-preloaden
   erstatter `utils/dir`, så de 93 eksisterende testene alene kunne ikke bevise
   rettingen. Den nye suiten omgår denne erstatningen gjennom en isolert VM.
4. `AGENTS.md`, `docs/tool-execution-phase1.md` og denne rapporten er oppdatert.

Ingen oppstartssletting betyr ingen slettetillatelsesliste eller slettesti
som kan misbrukes med traversal eller symlinker. Eksisterende, målrettet
opprydding av egne mellomfiler under en konkret TTS-forespørsel beholdes.
Dette er ikke en garanti om andre komponenters filoperasjoner eller en
endring av minneformat, persona, stemme, modell eller agentfunksjoner.

Implementert erstatning for eksporten og den destruktive blokken:

```ts
export const dataDir = path.join(__dirname, "../..", "data");
if (process.env.CLEAN_DATA_FOLDER_ON_START === "true") {
  console.warn(
    "[Startup] CLEAN_DATA_FOLDER_ON_START is ignored; automatic data deletion is disabled.",
  );
}
ensureDirExists(dataDir);
```

Ingen ny avhengighet, slettesti, tillatelsesliste eller datamigrering er innført.

Konsekvens: beholdte lydfiler og annen historikk vil fortsatt kunne vokse.
Eventuell kvote-/levetidsstyring krever egen avgrensning av data som trygt
kan kastes; det er ikke nødvendig for å stoppe denne oppstartsrisikoen.

## Historisk reproduksjon før rettingen

`.test-artifacts/phase15-inspection.cjs` transpilerer faktisk `src/utils/dir.ts`
til en isolert VM. Bare `fs`, `path` og stubbet dotenv tillates. `__dirname`
peker til ny testmappe under prosjektets `.test-artifacts/`, ikke den virkelige
datamappen. Ingen applikasjon eller konfigurasjonsfil importeres. Før hver
destruktive operasjon kontrollerer harnesset den eksakte teststien.

Bekreftet på den gamle koden 2026-10-15:

- false: 0 slettekall; alle 19 syntetiske vedvarende filer bevares.
- true: 1 rekursivt slettekall; samtlige 11 filer under syntetisk data går tapt,
  mens de 8 filene utenfor data bevares.
- Fault injection: etter simulert første sletting kastes EIO; syntetisk
  `memory.json` er allerede borte. Ingen faktisk prosess eller tjeneste stoppes.
- Gjentatt true-start sletter også et nytt opptak lagret mellom startene.
- Manglende mapper med false opprettes normalt.

Resultat: `.test-artifacts/phase15-inspection.json`. Dette er historisk
reproduksjon av feilen, ikke den nye regresjonssuiten. Undersøkelsesskriptet
har bevisst gamle forventninger og skal ikke brukes som test av den nye koden.

Fase 1-regresjon før rettingen: **93/93 bestått**, 0 feil, 0 hoppet over.
Dette inkluderer godkjent `searchLocalMemory` gjennom Ollamas JSON-fallback,
godkjent volumkall, native/verktøydispatch og avvisning av ugyldige/deaktiverte
kall. Testene bruker falske Ollama-/Piper-servere og eksisterende lydtestdobler.
Historisk logg: `.test-artifacts/phase15-regressions.log`.

## Validering etter implementering

`npm test`: **110/110 bestått**, 0 feil, 0 hoppet over. Alle de 93 eksisterende
testene og de 17 nye testene kjører. Godkjent minne-/volumverktøy, avvisning
av ugyldige/deaktiverte kall og Ollama-dispatch består fortsatt.
Logg: `.test-artifacts/phase15-complete-regressions.log`.

Den nye suiten kjører den faktiske TypeScript-modulen med eksisterende
TypeScript-transpilator og isolert `src/utils` eller `dist/utils`-plassering.
Bare `fs`, `path` og stubbet dotenv tilbys; ingen applikasjon, `.env` eller
ekstern tjeneste lastes. Virkelige testfiler brukes til innholds-/metadata-
kontroll. Destruktive fs-kall blokkeres før utførelse og registreres, også om
de skulle komme tilbake ved en regresjon. Alle slike kall skal være fraværende.
Ingen testfixture eller auditfil ryddes bort.

Dekning:

- true, false og utelatt flagg, både fra src- og dist-layout: 21 filer med
  minne, atomisk minnefil, backuper, samtalehistorikk, opptak, bilder, plugin-
  data, skills, logger, konfig og ukjente filer beholder innhold og metadata.
- Opprinnelige eksporterte stier og opprettelse av manglende mapper består.
- Gjentatt oppstart bevarer også opptak lagret mellom oppstartene.
- Fault injection kaster EIO etter en katalogopprettelse; vedvarende filer
  forblir intakte og neste initialisering lykkes. Ingen tjeneste avsluttes.
- Ugyldig modulsti med nullbyte avvises av Nodes filsystem uten sletting.
  Flagget kan ikke angi en sti; relative/absolutte stilignende flaggverdier
  endrer ikke slettemål eller lagringsstier. Det finnes ikke lenger et API
  for å sende inn en slettesti.
- Kataloglenker fra data og data/tts til mål utenfor data bevares med filene
  i målene. Windows-junctions er prøvd; Linux/Pi-symlinker er ikke fysisk testet.

Før rettingen: samme nye suite ga **7 feil / 10 bestått**, med blokkerte
`fs.rmSync`-forsøk i true-tilfellene. Etter rettingen: **17/17 bestått**.
Logger: `.test-artifacts/phase15-before-fix.log`, `phase15-after-fix.log`.

TypeScript `tsc --noEmit --incremental false`: bestått.
Den nye testfilen er også separat typekontrollert med strict/ES2020/CommonJS.
`git diff --check`: bestått; Git oppgir eksisterende LF/CRLF-normaliseringsvarsler.
Repoet har ikke en konfigurert lint-kommando.

Tre kontrollpunkter med størst konsekvens:

- **Ekte data bevart:** før-/etter-kontroll av faktisk data inkluderer
  innholdshash, størrelse og endringstid for alle 442 eksisterende filer:
  ingen endringer. Ingen test bruker dette området som mål for filoperasjoner.
- **Fase 1 bevart:** de eksisterende sikkerhets-/dispatchfilene er uendret,
  og alle 93 eksisterende tester består sammen med de nye testene. Av 259
  tidligere registrerte filer har bare de seks planlagte filene endret hash;
  den nye testfilen kommer i tillegg. Manifestet ligger i
  `.test-artifacts/phase15-preservation-result.json`.
- **Kobling og feilgren kontrollert:** reell dir.ts kjøres med begge flaggverdier
  gjennom den nye registrerte suiten; tidligere feil blir grønn etter rettingen,
  og EIO-injeksjon etterlater vedvarende filer intakte.

Før en senere deploy må faktisk Pi-konfigurasjon og bygd dist kontrolleres,
og minne samt GLaDOS/Piper/Faster-Whisper/Ollama, Whisplay-skjerm og
lydsynkronisering prøves på maskinvaren. **Alt dette er IKKE VERIFISERT her.**
Deploy og fase 2 er ikke del av denne leveransen.
Typekontroll har ikke bygd ny dist eller kjørt build-skriptets daemonregistrering.
