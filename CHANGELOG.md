# Changelog

## 0.3.13

- Refresh in the sidebar now imports new local conversations, reloads usage and checks every account. The icon spins until the refresh finishes.
- MiMo shows locally recorded token usage for the last 24 hours and 7 days even when its optional console cookie expires. An exact account balance still needs a valid console session.
- The chat composer shows elapsed time in minutes and seconds, estimated time left when task progress allows it, and a progress bar while a reply is running.
- Live thinking stays readable and scrollable instead of cutting off older text.

## 0.3.12

- The interface comes in 12 languages: English, Romanian, French, German, Spanish, Italian, Brazilian Portuguese, Japanese, Korean, Hindi, Indonesian and Arabic. Pick one in Settings; a new install follows the system language, an existing one stays in Romanian.
- Arabic reads right to left: the whole layout mirrors, while code, diffs, commands and paths stay left to right.
- Dates, numbers and limit windows follow the chosen language.
- Reviews and handoff briefs for the models are written in English, and the model answers in the language of your message.
- After switching accounts at a limit, the sidebar keeps showing the chat as working (the old session's late "idle" no longer overwrites it).
- The idle state of the Live panel and the conversation search no longer reuse the words for "queued" and "searching".

## 0.3.11

- The Live panel has a Browser tab: watch the page the model drives, in real time (with Jolty's own browser window).
- The task bar shows the estimated time left, and the Live panel how long the model has worked on the current message.
- Thinking shows in the chat while the model thinks, and edits appear live line by line, including every change in a MultiEdit.
- A message sent during a long command goes in at once: the command keeps running in the background instead of holding the reply.
- Quote selected text or reply to any message, like in a chat app.
- Continue in no longer sends anything by itself. On the same provider you stay in the same chat with its full context; on another provider a compact brief goes along (a few thousand tokens instead of the whole history).
- When a Claude account hits its limit, one click moves the chat to another free account and carries on.
- The Review button asks a model from the other family (Codex for Claude) for a read-only review of the changes.
- The chat shows the model and the effort. Jolty no longer moves messages to a cheap model on its own.
- Updates are checked every hour and also show above the message box.
- Limits appear in the same order for every account (5 hours, then 7 days), and a balance that cannot be read (an expired MiMo cookie, for example) shows the reason instead of disappearing.

## 0.3.10

- Compaction keeps the conversation state in sync, and queued messages continue once it ends.
- Late notifications no longer block the conversation or show an active turn as stopped.
- Stop works during startup too. Interrupted commands and leftover approvals close properly.

## 0.3.9

- Links to images, PDFs and other local files open straight from the conversation, including in older messages.
- Windows paths with spaces, diacritics and line numbers work. Opening errors show in the interface.
- Programs and scripts are only shown in Explorer, and dangerous links stay blocked.

## 0.3.7

- Deleting an account no longer fails: its conversations close and are awaited first, and its configuration folder is cleaned with retries; if a sign-in window is still open, Jolty says exactly what to close.

## 0.3.6

- The bundled CLIs (Claude Code and Codex) are up to date.

## 0.3.5

- Updates are read anonymously from the public releases: the GitHub CLI is no longer needed.

## 0.3.4

- The chosen model stays shown after you send the message; it no longer jumps to Opus.

## 0.3.3

- No permissions: the confirmation happens in the menu, not in a native dialog, so the message box no longer stays stuck after switching modes.

## 0.3.2

- The window runs sandboxed, and the interface can no longer launch a file from disk; programs and scripts are only shown in Explorer.
- A right click menu in the Jolty theme: text fields, links, files (with Show in Explorer), code, images, messages and conversations.
- The model picker no longer has a Default row; every model has an intelligence and speed score.
- New modes: Free in the project (Codex, no questions but only inside the project folder), a confirmation for No permissions, and irreversible commands blocked for Claude.
- Files with secrets (.env, keys, ~/.ssh) ask for approval before being read or changed, with a switch in Settings.
- A quiet note when a message seems to contain a key or a password.
- Browser: permissions (every action, once per site, free) and three ways to connect, including a Jolty window with a separate profile.

## 0.3.1

- Right click in the message box: Paste, Copy, Cut, Undo, Redo and Select all.
- A new chat opens at the first message, without waiting for the conversation list to load.
- Messages sent quickly, before the conversation starts, are queued and go out in order instead of starting duplicate sessions.
- Starting a Claude or Codex session can no longer run twice in parallel.
- Live usage: the header and the refresh button stay fixed, only the account list scrolls.

## 0.3.0

- A smoother browser: the extension token is cleaned and applied at once, the browser with the extension is picked automatically, per-site approvals, a halo, a Jolty cursor and a bolt on the tab.
- A new chat starts on the last model and level used.
- DeepSeek, MiMo and local models get thinking levels according to their own documentation.
