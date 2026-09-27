# Teste

Testele rulează pe modele false (mock), fără conturi reale și fără costuri.

```bash
# 1. pornește serverele mock (în două terminale)
python3 test/mocks/mock_anthropic.py 8766 /tmp/mock_anthropic.log
python3 test/mocks/mock_responses.py 8767 /tmp/mock_responses.log

# 2. testul complet al motoarelor (Claude Code + Codex prin Jolty)
JOLTY_DATA_DIR=/tmp/jolty-test MOCK_ANTHROPIC_LOG=/tmp/mock_anthropic.log MOCK_RESPONSES_LOG=/tmp/mock_responses.log npm run test:engines

# 3. capturi de ecran ale fiecărei pagini
JOLTY_DATA_DIR=/tmp/jolty-ui SHOTS=/tmp/shots npm run test:ui
```

Pe Linux fără ecran, pune `xvfb-run -a` în fața comenzilor 2 și 3.
