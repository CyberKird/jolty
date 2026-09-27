# Jolty

Aplicație desktop pentru Windows care rulează **Claude Code** și **Codex** într-un singur loc, cu mai multe conturi, chei API și modele locale. Face parte din familia [Joltarise](https://joltarise.com).

Jolty nu înlocuiește motoarele oficiale: le include și le pornește exact cum ar face-o aplicațiile Anthropic și OpenAI. Tu te conectezi cu propriile conturi, iar Jolty îți arată totul într-o singură interfață.

## Ce face

- **Mai multe profiluri**: două (sau oricâte) abonamente Claude, contul Codex, chei API Anthropic sau OpenAI, plus orice furnizor compatibil (DeepSeek, Xiaomi MiMo, Kimi, GLM, OpenRouter, LiteLLM).
- **Aceeași experiență ca în Claude Code**: aprobări pentru comenzi și modificări, moduri de lucru (Întreabă, Editează, Plan, Total), reluarea conversațiilor.
- **Alegi modelul și efortul** (auto, low, medium, high, xhigh, max), exact ca în Claude Code.
- **Sugestie pe măsură ce scrii**: Jolty estimează cât de complexă e cererea și propune modelul și efortul potrivite (de exemplu Haiku pentru o redenumire, Opus xhigh pentru o refactorizare mare). Nu propune niciodată singur modele care consumă credite extra peste abonament.
- **Continui conversația pe alt motor**: „Continuă în” mută conversația de pe Claude pe Codex sau pe alt cont, cu tot contextul.
- **Imagini pentru orice model**: dacă modelul ales nu vede imagini (DeepSeek, un model local), un profil Claude le descrie în detaliu și modelul primește descrierea.
- **Live**: vezi ce face modelul în timp real, ce fișiere citește și modifică, codul pe măsură ce îl scrie și comenzile din terminal.
- **Consum**: limitele de 5 ore și 7 zile ale fiecărui abonament, tokenii pe zi și pe model.
- **Import**: deschizi în Jolty conversațiile existente din Claude Code și Codex. CLAUDE.md, skills, subagenții, comenzile și serverele MCP de pe PC funcționează direct.
- **Modele locale** prin Ollama, cu recomandări pentru placa ta video și o comparație orientativă cu modelele Claude.

## Instalare

1. Descarcă `Jolty-Setup-x.y.z.exe` din pagina **Releases** a repo-ului sau din ultima rulare **Actions → Build → Jolty-Setup**.
2. Rulează instalatorul. Jolty nu are încă o semnătură digitală, așa că Windows poate afișa „Windows a protejat PC-ul”. Apasă **Mai multe informații → Rulează oricum**.
3. Instalatorul pune și Microsoft Visual C++ Runtime, dacă lipsește. Claude Code și Codex sunt deja incluse.
4. Deschide Jolty și intră în **Verificare sistem**. Dacă îți lipsește Git for Windows (Claude Code îl folosește pentru comenzi), îl instalezi de acolo cu un clic.

## Primii pași

1. **Conturi și chei → Claude (contul principal) → Conectează contul.** Se deschide login-ul oficial Claude.
2. Pentru al doilea cont Claude: **Adaugă profil → Claude Code → Abonament**, apoi **Conectează contul** și te loghezi cu celălalt cont. Fiecare profil își păstrează login-ul separat.
3. **Codex (contul principal) → Conectează contul** pentru ChatGPT.
4. Pentru DeepSeek sau MiMo: **Adaugă profil → Claude Code → Endpoint compatibil**, alegi furnizorul, pui numele modelului și cheia.
5. **Conversație nouă**: alegi proiectul, profilul, modelul și efortul, apoi scrii.

Când un abonament ajunge la limită, alegi alt profil din conversație sau folosești **Continuă în**. Jolty nu schimbă singur conturile: fiecare abonament se folosește doar cu login-ul lui, pentru uz personal, conform condițiilor Anthropic și OpenAI.

## Unde se păstrează datele

În `%APPDATA%\Jolty`: profilurile, conversațiile, consumul și setările. Cheile API sunt criptate cu protecția Windows a contului tău. Dezinstalarea nu le șterge. Din **Setări → Deschide datele Jolty** ajungi direct în acest folder.

Conversațiile făcute cu profilul principal Claude apar și în Claude Code, pentru că folosesc același folder `~/.claude`.

## Din codul sursă

Ai nevoie de Node.js 22.

```bash
npm ci
npm run dev        # pornește aplicația în modul de dezvoltare
npm run typecheck
npm run dist:win   # creează instalatorul în dist/ (pe Windows)
```

Instalatorul se construiește automat pe GitHub la fiecare push pe `main`. La un tag `v*` (de exemplu `v0.1.0`), instalatorul se atașează la un Release.

Testele sunt descrise în [test/README.md](test/README.md). Rulează pe modele mock, fără conturi reale și fără costuri.

## Structură

| Folder | Ce conține |
|---|---|
| `src/main` | procesul principal: profiluri, motoarele Claude Code și Codex, consum, modele locale, verificarea sistemului |
| `src/main/engines` | legătura cu Claude Agent SDK și cu `codex app-server` |
| `src/renderer` | interfața (React) |
| `src/shared` | tipurile comune și estimarea complexității cererilor |
| `build` | pictograma și scriptul instalatorului |
| `test` | testele end-to-end, de interfață și ale aplicației împachetate |
