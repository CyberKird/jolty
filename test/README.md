# Tests

The tests run on fake (mock) models, with no real accounts and no cost.

```bash
# 0. fast unit tests: Codex lifecycle, time estimates, handoff briefs, quotes, translations
npm test

# 1. start the mock servers (in two terminals)
python3 test/mocks/mock_anthropic.py 8766 /tmp/mock_anthropic.log
python3 test/mocks/mock_responses.py 8767 /tmp/mock_responses.log

# 2. the full engine test (Claude Code + Codex through Jolty)
JOLTY_DATA_DIR=/tmp/jolty-test MOCK_ANTHROPIC_LOG=/tmp/mock_anthropic.log MOCK_RESPONSES_LOG=/tmp/mock_responses.log npm run test:engines

# 3. screenshots of every page
JOLTY_DATA_DIR=/tmp/jolty-ui SHOTS=/tmp/shots npm run test:ui
```

On Linux without a display, put `xvfb-run -a` in front of commands 2 and 3.
