# Changelog

## 0.5.3

- Jolty's browser extension now works in Firefox too. Firefox gives extensions no DevTools protocol, so it has its own extension that does the same work with what Firefox offers: pages, clicks and typing, forms, tabs, screenshots, console and network, and the live picture. Pick Firefox under Settings > Browser (or let it be your Windows default) and follow the steps: Jolty copies the files, opens about:debugging and puts the manifest.json path in the clipboard. Firefox forgets temporary add-ons when it closes, so the steps repeat after a restart. Not available in Firefox: choosing files to upload, dragging between page parts, and dialogs that wait for an answer (alert, confirm and prompt are reported and answered at once, confirm with yes and prompt with its default).

## 0.5.2

- The bundled Claude Code and Codex are updated to their latest versions.
- System Check no longer fails on PCs without winget: Git, the Visual C++ runtime and Ollama are downloaded from their official sources and started (with the Windows admin prompt) when winget is missing. Before, "Install Git" only showed "Windows cannot find winget".
- System Check lists Jolty's browser extension as a requirement when the default way of connecting is used. One click copies its files (they ship with the app), opens the browser's extensions page and the folder, and the row turns green once the browser connects.

## 0.5.1

- Usage counted Codex input twice: Codex reports the cached part inside its input, and Jolty added it again, so Codex tokens on the Usage page were about double and its cache looked like 50% instead of the real 90% and more. New turns are counted once, and older lines are corrected when the page reads them.

## 0.5.0

- Search your earlier conversations: every Claude Code and Codex chat can now look through your past Jolty conversations and read one back when you mention earlier work ("what did we decide about the logo?"). It searches what was said, not tool output, ignores diacritics and case, and a chat moved with "Continue in" shows up once, not once per account. The first search after start takes a second or two, the next ones are instant.
- Scheduled tasks: a new Scheduled page, and the model can set them up from the chat ("every weekday at 8:30 check the deploys"). A task runs once, every N minutes (at least 10) or daily at a time, optionally on chosen weekdays. Each run is a new conversation in the list, with a notification when it ends. Runs happen while Jolty is open; one missed while it was closed runs once at the next start, and a run waits if the previous one is still working. Manual and Plan modes are not offered (nobody is there to click), and a task the model creates never gets more freedom than Auto or accept edits.
- Learning from conversations: every 10 messages the model is reminded to save what it learned about you to memory, and every 15 to update or create a skill when something reusable came up, with a one-line note in the reply when it saved something. It only keeps what you said or confirmed, never instructions from web pages or files. Codex writes to the same memory folder as Claude Code when one is set. A switch in Settings turns it off; temporary chats never save anything.
- Codex chats keep your own MCP servers from config.toml next to Jolty's.
- Codex asks before an MCP tool call (a page action in the browser, scheduling a task) with a request Jolty did not know, so every such call was refused. It now shows as a normal approval card. A request to open a link or fill a form is still declined, never opened on its own.

## 0.4.6

- Turning the PC off when the work is done did nothing if you armed it while a chat was already working (start the long task, arm, go to bed). That chat's start came before the arm, so its end never started the countdown. It now counts work that is already running when you arm it.

## 0.4.5

- Accounts can be reordered: drag a card on the Accounts and keys page, or a row in Live usage, to where you want it (or focus it and press Alt+Up / Alt+Down). The order is saved and the model menu follows it too.
- Every account now has its own color. New accounts take a color nobody uses yet, and accounts that shared a color (it happened once you had more than eight) get a free one on the next start.

## 0.4.4

- The thinking level row in the model menu (AUTO to MAX) stuck out past the right edge of the menu. It now fits the menu width and the buttons share the space evenly.

## 0.4.3

- Reading long articles: browser_snapshot has a text mode (mode "text") that returns only the readable text of the page, with headings, lists and table rows, without refs, links, menus, footnote markers or the footer. A long article comes in parts (20,000 characters by default) and each answer says which offset continues it. The page tree stays the default for acting on a page.

## 0.4.2

- Found while using the new browser for real: typing Enter in a search box (or any action that starts a navigation) could answer "ref undefined is not on the page any more" instead of showing the new page. It now waits for the new page.
- Going back took 45 seconds on pages restored from the browser cache; it takes about a second now.
- Page snapshots are much smaller: menus, footers and sidebars with more than 12 links collapse into one line that says how many links they hold; browser_snapshot with their ref opens them.

## 0.4.1

- The Jolty browser extension now works in Vivaldi: a new window there opens on Vivaldi's own start page, where the browser never answers DevTools commands. The extension points the tab at the real page first. The full set of 17 browser tool tests passes on Vivaldi 8.2 and on Chromium. The extension updates itself from the app (version 1.0.1).
- The model's tabs keep working while the browser window is minimized or covered by other windows (screenshots, clicks and snapshots checked).

## 0.4.0

- Turn the PC off when the work is done: a power button in the composer. Armed, Jolty keeps the PC awake, waits until work has started and every chat has been quiet for 30 seconds (or an account ran out of usage, or the work stopped on an error), then starts a 60 second countdown with a Cancel button, on every page. The shutdown is forced, so open programs cannot hold it back overnight. New work during the countdown cancels it.
- Jolty's own browser extension (Settings, Browser): a real-browser bridge that replaces the Playwright extension. It connects by itself (no tab picker, no token, no 30 second wait), works in a window of its own so your tabs stay untouched, takes over the tab you have open only on request, streams the page live into the Live panel, and handles forms, file uploads, dialogs, drag and drop, shadow DOM, frames and new tabs. The old Playwright modes stay available. Install once: Jolty prepares the folder and opens the extensions page.
- Smaller saved conversations and a temporary chat mode (0.3.15), a one-row composer toolbar and readable small text (0.3.16), a bigger Joltarise wordmark (0.3.18).

## 0.3.18

- The Joltarise wordmark in the title bar is almost twice as big (20 px instead of 11), so its spiked letters read clearly, with a thin divider after "by".

## 0.3.16

- The composer toolbar stays on one row: Plan, Browser and Temporary are icons that show their name only while on, the browser permissions menu appears with the browser, and the project name shortens before the send button ever drops to a second row.
- Small text is easier to read: labels, usage meters, balances, the effort tag and times use Barlow with a medium weight at a larger size instead of thin 9-10 px Space Mono.

## 0.3.15

- Temporary chat: a "Temporar" switch next to Browser in a new conversation. The chat lives only in memory: it is not listed, not saved by Jolty, and its Claude Code files (transcript, edit backups) are wiped when you leave it, start a new chat or close Jolty. Codex runs it as an ephemeral thread. Messages queued in it never touch disk. Not available for Hermes, and it cannot be moved to another account.
- Saved conversations are much smaller and cheaper to write: tool results are clipped to 20 KB, images returned by tools are no longer stored, and files are written compactly. Older large conversations shrink in the background after start (one of 61 MB drops to a few MB).

## 0.3.14

- Deleting an account works again. The sign-in check that kept polling in the background no longer restarts the account's engine while its folder is being removed, and the engine processes are stopped first. Shared skills and plugins are never touched.

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
