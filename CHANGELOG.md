# Changelog

## 0.3.10

- Compactarea pastreaza starea conversatiei sincronizata, iar mesajele in asteptare continua dupa terminarea ei.
- Notificarile intarziate nu mai blocheaza conversatia si nu mai afiseaza un tur activ ca fiind oprit.
- Stop functioneaza si in timpul pornirii. Comenzile intrerupte si aprobarile ramase sunt inchise corect.

## 0.3.9

- Linkurile catre imagini, PDF-uri si alte fisiere locale se deschid direct din conversatie, inclusiv cele din mesajele vechi.
- Caile Windows cu spatii, diacritice si numere de linie functioneaza corect. Erorile de deschidere sunt afisate in interfata.
- Programele si scripturile raman afisate doar in Explorer, iar linkurile periculoase raman blocate.

## 0.3.7

- Stergerea unui cont nu mai da eroare: conversatiile contului se inchid si sunt asteptate inainte, iar folderul lui de configurare se curata cu reincercari; daca fereastra de autentificare e inca deschisa, spune clar ce sa inchizi.

## 0.3.6

- CLI-urile incluse (Claude Code si Codex) sunt la zi.

## 0.3.5

- Actualizarile se citesc anonim din release-urile publice: nu mai ai nevoie de GitHub CLI.

## 0.3.4

- Modelul ales ramane afisat dupa ce trimiti mesajul; nu mai sare pe Opus.

## 0.3.3

- Fara permisiuni: confirmarea se face in meniu, nu intr-un dialog nativ, asa ca caseta de mesaj nu mai ramane blocata dupa ce schimbi modul.

## 0.3.2

- Fereastra ruleaza cu sandbox, iar din interfata nu se mai poate porni un fisier de pe disc; programele si scripturile se arata doar in Explorer.
- Meniu de click dreapta in tema Jolty: campuri de text, linkuri, fisiere (cu Arata in Explorer), cod, imagini, mesaje si conversatii.
- Selectorul de modele nu mai are randul Default; fiecare model are scor de inteligenta si viteza.
- Moduri noi: Liber in proiect (Codex, fara intrebari dar numai in folderul proiectului), confirmare la Fara permisiuni si comenzi ireversibile blocate la Claude.
- Fisierele cu secrete (.env, chei, ~/.ssh) cer acordul inainte de citire sau modificare, cu comutator in Setari.
- Nota discreta cand mesajul pare sa contina o cheie sau o parola.
- Browser: permisiuni (la fiecare actiune, o data pe site, liber) si trei moduri de conectare, inclusiv fereastra Jolty cu profil separat.

## 0.3.1

- Click dreapta in caseta de mesaj: Paste, Copy, Cut, Undo, Redo si Select all.
- Chatul nou se deschide imediat la primul mesaj, fara sa mai astepte incarcarea listei de conversatii.
- Mesajele trimise rapid, inainte sa porneasca conversatia, intra in coada si pleaca pe rand, in loc sa porneasca sesiuni duplicate.
- Pornirea unei sesiuni Claude sau Codex nu mai poate rula de doua ori in paralel.
- Consum live: antetul si butonul de refresh raman fixe, doar lista de conturi deruleaza.

## 0.3.0

- Browser fluid: tokenul extensiei se curata si se aplica imediat, browserul cu extensie e ales automat, aprobari pe site, halou, cursor Jolty si fulger pe tab.
- Chatul nou porneste pe ultimul model si nivel folosit.
- DeepSeek, MiMo si modelele locale au nivel de gandire dupa documentatia lor.
