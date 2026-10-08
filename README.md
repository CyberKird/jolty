# Jolty

A Windows desktop app that runs **Claude Code** and **Codex** in one place, with several accounts, API keys and local models. Part of the [Joltarise](https://joltarise.com) family.

Jolty does not replace the official engines: it bundles them and starts them exactly the way the Anthropic and OpenAI apps do. You sign in with your own accounts, and Jolty shows everything in one interface.

## What it does

- **Several profiles**: two (or any number of) Claude subscriptions, the Codex account, Anthropic or OpenAI API keys, plus any compatible provider (DeepSeek, Xiaomi MiMo, Kimi, GLM, OpenRouter, LiteLLM).
- **The Claude Code experience**: approvals for commands and changes, working modes (Ask, Edit, Plan, Full), resuming conversations.
- **Pick the model and the effort** (auto, low, medium, high, xhigh, max), just like in Claude Code. The chat shows the model and effort of every reply.
- **A suggestion while you type**: Jolty estimates how demanding the request is and suggests a fitting model and effort. It only suggests; it never switches the model by itself.
- **Move a conversation**: "Continue in" moves a chat to another account or engine. On the same provider it stays the same chat with its full context; on another provider a compact brief goes along with your next message, so the switch costs a few thousand tokens instead of the whole history.
- **When a limit runs out**: one click carries the chat to another free account of the same provider and picks up where it stopped.
- **A second opinion**: Review sends the current changes to a model from the other family (Codex for Claude, or the other way round) for a read-only review.
- **Images for any model**: if the chosen model cannot see images (DeepSeek, a local model), a Claude profile describes them in detail and the model gets the description.
- **Live**: what the model does right now, the files it reads and changes, its thinking as it arrives, every edit line by line while it is written, the terminal, the task list with the time left, and the page in the Jolty browser.
- **Reply and quote**: select text in the chat to quote it, or reply to any message, like in a chat app.
- **Usage**: the 5 hour and 7 day limits of every subscription, tokens per day and per model.
- **Import**: open your existing Claude Code and Codex conversations in Jolty. CLAUDE.md, skills, subagents, commands and MCP servers on your PC work as they are.
- **Local models** through Ollama, with recommendations for your graphics card and a rough comparison with the Claude models.
- **12 languages**: English, Română, Français, Deutsch, Español, Italiano, Português (Brasil), 日本語, 한국어, हिन्दी, Bahasa Indonesia and العربية (right to left). Pick one in Settings; by default Jolty follows the system language.

## Install

1. Download `Jolty-Setup-x.y.z.exe` from the **Releases** page of this repository.
2. Run the installer. Jolty is not code signed yet, so Windows may show "Windows protected your PC". Click **More info → Run anyway**.
3. The installer also adds the Microsoft Visual C++ Runtime if it is missing. Claude Code and Codex are already bundled.
4. Open Jolty and go to **System check**. If Git for Windows is missing (Claude Code uses it for commands), install it from there with one click.

Updates install by themselves: Jolty checks at startup, every hour and when you come back to it, downloads in the background and asks you to restart.

## First steps

1. **Accounts and keys → Claude (main account) → Connect the account.** The official Claude sign-in opens.
2. For a second Claude account: **Add profile → Claude Code → Subscription**, then **Connect the account** and sign in with the other account. Each profile keeps its own login.
3. **Codex (main account) → Connect the account** for ChatGPT.
4. For DeepSeek or MiMo: **Add profile → Claude Code → Compatible endpoint**, choose the provider, enter the model name and the key.
5. **New conversation**: choose the project, the profile, the model and the effort, then write.

Jolty never rotates accounts on its own: each subscription is used only with its own login, for personal use, under the Anthropic and OpenAI terms. Switching accounts at a limit happens only when you click.

## Where the data lives

In `%APPDATA%\Jolty`: profiles, conversations, usage and settings. API keys are encrypted with your Windows account protection. Uninstalling does not delete them. **Settings → Open the Jolty data** takes you straight to this folder.

Conversations made with the main Claude profile also show up in Claude Code, because they share the same `~/.claude` folder.

## From source

You need Node.js 22.

```bash
npm ci
npm run dev        # starts the app in development mode
npm run typecheck
npm test           # unit tests, including a check that every language has every text
npm run dist:win   # builds the installer into dist/ (on Windows)
```

The end to end and interface tests are described in [test/README.md](test/README.md). They run on mock models, with no real accounts and no cost.

Interface texts go through `tr()` from `src/shared/i18n.ts`, with the dictionaries in `src/shared/locales`. `npm run test:i18n` fails when a text is missing in any language or its `{placeholders}` differ.

## Layout

| Folder | What is inside |
|---|---|
| `src/main` | the main process: profiles, the Claude Code and Codex engines, usage, local models, system check |
| `src/main/engines` | the link to the Claude Agent SDK and to `codex app-server` |
| `src/renderer` | the interface (React) |
| `src/shared` | shared types, translations, request complexity estimates |
| `build` | the icon and the installer script |
| `test` | end to end, interface and packaged app tests |
