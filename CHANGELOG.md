# Changelog

## 0.13.2

### Improvements

- OpenCode has a row of its own in the usage meter, next to Gemini: the tokens of the last 24 hours and 7 days, as OpenCode reports them for each turn. OpenCode does not publish how much of the free daily allowance is left, so the row shows what was used, not what remains.

## 0.13.1

### Fixed

- OpenCode stopped answering because OpenCode 1 no longer has the free models at all. Jolty now installs OpenCode 2 (with a fallback build for older CPUs) and prefers it over an older copy on the PC; System check finds a 1.x install and offers the update. The free models come with a daily quota set by OpenCode.
- OpenCode conversations now have Jolty's own tools (conversation search, schedules, `ask_model`), so parallel sessions work with OpenCode the same as with Claude and Codex: the button appears for it and the model is told to start and wait for the sessions.

## 0.13.0

### New

- Obsidian can run quietly in the background while Jolty is open: set `obsidianVault` in settings.json to your vault folder. Jolty starts Obsidian hidden (no window, no taskbar button), Ctrl+Alt+O shows or hides it, and it closes when Jolty closes. Nothing is synced. Your vault is also zipped to a folder at start and at quit, one file per day with the last 14 kept (`obsidianBackupDir` in settings.json picks the folder; the default is `.claude/backups/obsidian` in your user folder).

## 0.12.0

### New

- The pages in the left sidebar (Import sessions, Accounts and keys, Settings and the rest) and the project groups in the conversation list can be put in the order you like: drag one, or focus it and press Alt with the up or down arrow. Jolty remembers the order.
- Automatic updates can be turned off in Settings (About). On, Jolty does what it did before: it downloads new versions in the background and installs them when you close the app. Off, it only tells you a version is out, and you press Update in the title bar or in Settings.
- Pressing Update or Restart now asks first, and says if something is still running, before Jolty closes and starts again.

### Improvements

- When "Improve message" has something to tell you (a question it needs answered, or an error), it now shows right above the message box instead of a pop-up on the right. It stays until you close it or send a message, and a newer one replaces it, so two notices never pile up.
- Updated the bundled Claude Code and Codex engines.
- Settings tells you when Windows has notifications turned off for everyone or for Jolty, which is why nothing shows outside the window when a task finishes or needs you, and opens the Windows setting for it.
- If Jolty is installed for all users, Settings explains that Windows then asks for permission at every update, and how to make updates silent (reinstall choosing "Instalează doar pentru mine").

### Fixed

- The scrollbar of the conversation list and of the Live list could not be grabbed, because the handle that resizes the sidebar sat on top of it. The scrollbars now sit just inside it.
- Importing sessions no longer lists Jolty's own background requests (conversation titles, message rewrites, picture descriptions) as conversations, so they stop showing up as an extra project.

## 0.11.0

### New

- Any model can ask another one: two new tools, `list_models` (every connected profile with its models, intelligence and speed) and `ask_model` (one question, one answer, optional files), so a chat can get a second opinion from the profile you choose. Gemini answers one-shot questions too, with images, PDFs, audio and video.
- Jolty now learns from your Gemini chats: after every 10 messages a background review saves the facts you stated to your memory folder and tells you in the chat what it saved. It never blocks the conversation and does nothing in temporary chats or when the learning loop is off.
- Gemini always has a row in the usage meter in the sidebar, with the messages and estimated tokens of the last 24 hours and 7 days.

### Improvements

- Smoother streaming: the app no longer re-renders everything on each piece of text, finished code blocks are parsed once, and nothing reads the settings file for every chunk while Jolty is in the background.
- The live browser view pauses while Jolty is hidden, so a minimized window stops receiving screenshots.
- Typing a long message into Gemini keeps all its lines and confirms the text is really in the box before sending.

## 0.10.2

### Improvements

- Intelligence and speed now show next to far more models in the picker, and the list keeps itself up to date: it is rebuilt every day from the Artificial Analysis leaderboard and the app picks it up without an update. New models, Gemini and the models of your own endpoints and Ollama included, get their numbers the day they are listed.
- Model names match however they are written ("gpt-6.1-sol", "GPT 6.1 Sol", "gpt-6-1-sol"), so fewer models are left without a score.

## 0.10.1

### Improvements

- Gemini models now show their intelligence and speed in the model list, like the other models.
- Gemini can be added from Accounts and keys with one button ("Add Gemini"), and its sign-in button shows there too.
- Backup accounts show your profile picture (Google, Dropbox, GitHub), and the Google Drive card is lined up properly.

## 0.10.0

### New

- Gemini with your own subscription, no key and no Antigravity: Jolty uses your signed-in gemini.google.com in its browser window. Add it in the first-run screen or in Accounts. You pick the model and the thinking level from the list Gemini itself shows for your plan, answers stream in as they are written, and images, PDFs, audio and video go up with your message. It is a conversation model: it has no tools and does not touch your project files.
- First-run setup is simpler and tells you what it found. After you connect, a "Models found" step lists every model with its intelligence and speed, says plainly when it has no data about one, and turns on automatic model choice for the sessions Jolty starts when there is a real choice.
- "Yes, do it for me" at the end of first-run setup, for Claude and OpenCode accounts: an assistant checks the programs Jolty needs, installs what is missing and explains each step. It works without asking permission at every step, and the screen says so before you start.
- Report a problem: a bug icon next to the account at the bottom left opens a short form that writes the email to contact@joltarise.com in your own mail app, with the Jolty version, Windows and language added. Nothing else is sent. A few reports per hour at most, and no link lists.
- Google Drive backup needs no setup any more: sign in with your Google account. Jolty only sees a hidden folder of its own in your Drive. The backup now also carries how long you have used Jolty, and a restore on a new PC brings it back.
- A discreet "Support Jolty" card in Settings, About, and a link in What's new, for Ko-fi.

### Improvements

- Free OpenCode models are used only for small jobs, and only when none of your own models fits.
- When a session Jolty started ends with an error, the chat that started it is told what went wrong and can start the job again on a stronger model.
- A privacy policy for the app is now on joltarise.com/jolty/privacy.

## 0.9.0

### New

- Back up your whole Jolty setup to a storage you own: Google Drive, OneDrive, Dropbox, Box, a private GitHub repository, WebDAV (Nextcloud, ownCloud, Synology), S3-compatible storage (AWS, Cloudflare R2, Backblaze B2) or any folder (iCloud Drive, a USB drive). Open Settings, then Account. The backup holds skills, commands, instructions, settings, accounts without keys, scheduled tasks and MCP servers. It is encrypted with a password you choose before it leaves your PC, each account keeps its own backup, and restoring goes through the same review screen as an import, with a copy of everything it replaces.
- The connected account shows under live usage, like the account in the Claude and Codex apps.
- Settings, Account also shows how long you have used Jolty: time spent prompting with AI and time spent in the app, as years, months and days with the total hours beside it, plus messages, conversations, tokens and active days.
- While a conversation is being compacted, a pill with a spinner appears above the message box and a spinner on its row in the list, then the result for a few seconds. Works with Claude, Codex and OpenCode.
- Computer use now sees every monitor. The model can list the screens, take a screenshot of the one it needs, and each window says which screen it is on.

### Improvements

- Temporary chats stay in the conversation list, marked with a dashed bubble, and you can delete them by hand like any other. Nothing of them is saved or remembered, and they are wiped when Jolty closes.
- A too-big skill alert can be hidden. It leaves the badge in the sidebar and waits in a small "Hidden alerts" list on the Skills page.
- OpenCode and Hermes agents show in live usage as soon as one of their chats works.

### Fixed

- The text typed in the message box was lost when you switched conversation, started a new one or restarted Jolty. It is now kept for each conversation.

## 0.8.3

### Fixed

- A long headline in the What's new window could run out of the top of the window, with its first line cut off. The headline is now smaller and limited to three lines.

## 0.8.2

### Fixed

- The Live panel could not be resized when its saved width was larger than the window allows: the panel showed the smaller capped width, and the first part of every drag did nothing. A drag now starts from the width on screen.

### Improvements

- Dragging the sidebar edge, the line above live usage or the Live panel edge is smoother in long chats. The browser no longer restyles the whole page on every mouse move, and a drag no longer restyles every element when it starts and ends.

## 0.8.1

### Fixed

- Animations were off even with Reduce motion unticked, whenever Windows had its own "Animation effects" switch off. Jolty followed the Windows switch on top of its own setting. Now only the Reduce motion setting in Jolty decides.
- A chat could get a title like "You've hit your session limit, resets 11:10pm" when the model that names chats had run out of usage. Chats are now named by the next model that works, and a model that just ran out of usage is skipped for a while.

### Improvements

- "Improve message" and chat naming pick their model by speed from everything your Jolty has: Claude and Codex subscriptions, API keys and OpenCode models, leaving out accounts that are at their limit or have just failed. The second model starts in parallel when the first is slow or fails, and the first good answer wins.

## 0.8.0

### New

- Low-power mode for weak PCs, in Settings, General: Automatic (the default, on for PCs with 4 cores or fewer, or 4 GB of memory or less), Always on, Always off. It gives a flat look with no decorative animations and a lighter mascot. On a normal PC nothing changes.
- Copy anything from the chat in one click. Code blocks have a header with the language, a Copy button, a wrap toggle and a fold for long ones (shell commands copy without the `$ `). Paths, commands, URLs, versions and similar values in inline code are click-to-copy chips, and a right-click offers Copy as path, Open and Show in Explorer for real paths. Each message has a hover bar (copy as text or Markdown, quote, copy the last code block). Tool rows can copy the command, path, output, error, diff and new file content, and tables copy as Markdown, TSV (for Excel and Sheets) or CSV. Ctrl+Shift+C copies the last reply, Ctrl+Alt+C the last code block. Models are also told to put every copyable value in its own code block.
- The mascot is bigger and livelier. Settings has a size choice (small, normal, big, big by default). He scratches his head while thinking, waves when a permission is waiting, facepalms on an error, dances when a task is done, dodges a chasing cursor, giggles when poked repeatedly, shadow-boxes, pushes an invisible wall and pants after a long run. He steps out of the way when you type, open a menu or select text, and never takes clicks meant for the interface.

### Improvements

- Every state change now moves: menus, pickers, dialogs, toasts, the sidebar, the Live panel, page changes, opening a chat, new messages and permission cards fade or slide in and out in short eased steps. They can be interrupted, follow Reduce motion, and are shorter in low-power mode.
- Long chats open much faster: only the latest messages are drawn and older ones load as you scroll up, without a jump. Saving a long chat no longer blocks the app, and start-up does less before the window shows.

## 0.7.28

### Fixed

- In a conversation, the state of each tool line (running, error, done) was always written in Romanian ("acum", "eroare", "gata"). It follows the interface language now.


## 0.7.27

### Improvements

- PC control now warns you before it takes the real mouse and keyboard. The first time in each turn, a note appears on screen ("Jolty takes over the mouse and keyboard in 3 seconds") and Jolty waits 3 seconds, so you can lift your hand. After that it works as before: it still waits while you are moving the mouse and stops if you take over.
- Models are told to prefer the browser: with the Jolty browser available, anything inside a web page goes through it, and the PC is used only for what a page cannot do (desktop programs, file dialogs, other windows). Before the first thing it does on the PC in a task, the model says in one line what it is about to do.


## 0.7.26

### Improvements

- "Improve message" no longer leans toward websites or code projects. It does not read the folder name any more, and it takes the field (an app, a company task, a text, a script) from your message and from the context it is given: your last three messages in the chat and the titles of the latest chats in the same folder. If it still cannot tell what you mean, it asks one short question in a note, and you add the answer to the message and press again.
- It uses the cheapest model your Jolty has instead of the one picked in the chat box: a free OpenCode model if you picked one, then the small model of a Claude subscription (Haiku), Codex's mini model, an API profile's first model, and OpenCode's default. If one fails it tries the next. A one-word message keeps your interface language.

### Fixed

- The chat scrolled back down by itself when you started scrolling up from the bottom. Moving up by even a few pixels while the page was still growing (a streaming reply, an image, a long message settling) was treated as still being at the bottom, so the next change pulled you back like a rubber band. Going up now lets go of the bottom at once, and it only follows again when you reach the very end. A test covers it.


## 0.7.25

### New

- A checkbox in Settings, Models and sessions, "Suggest the right model", turns off the strip above the box that says a model is too weak for your task or proposes another effort. Unchecked, it never shows.

### Fixed

- The strip said "foarte complex" in the middle of an English sentence. The task levels are translated now (Medium, Complex, Very complex).


## 0.7.24

### Fixed

- Settings and other pages with tabs: when the window was narrow or the language had long names (German, French), the last tabs ran off the screen and the text was cut with no way to see it. The tabs now wrap onto a second line, so every one stays readable.
- More texts follow the language you picked: the effort levels in the advice strip (Medium, Complex, Very complex) and the reasons next to them, the "Remove" label of an attached file, the "another profile" notice, the sign-in process error, and the verbs of tool lines in chat (Read, Edit, Search...) when they are cut down to the file or command.


## 0.7.23

### Improvements

- Any account can be deleted now, the main Claude and Codex ones included, and you never have to keep one. Deleting an account no longer deletes its conversations: they stay in the list, you can read them, and "Continue in" moves them to another account. Temporary chats still disappear with it. Jolty only removes what it made itself; your own `~/.claude` and `~/.codex` stay as they are.

### Fixed

- The arrow next to the Browser button overlapped its border. There is a small gap between them now.

## 0.7.22

### Fixed

- Firefox: "Install" opened the signed extension as a file, and Firefox showed an empty page instead of the "Add Jolty?" question. Jolty now serves the extension on its local address and opens that, so Firefox asks, you press Add once and it stays installed. Checked in a real Firefox: the prompt appears, the extension pairs with Jolty, and after a restart it reconnects on its own.

## 0.7.21

### New

- A first start now opens a welcome screen instead of creating Claude and Codex profiles. You pick how to begin: OpenCode's free models with no key (one click, Jolty installs OpenCode and sends a test message), your own DeepSeek or OpenRouter key (tested before it is saved), or a Claude or ChatGPT subscription. After your first chat, one quiet line offers to add a key of your own, once. Existing users keep their profiles.
- Firefox: the Jolty extension now comes signed by Mozilla. "Install" opens it in Firefox, you press Add once and it stays installed after Firefox closes (before, it was a temporary add-on that disappeared). The old temporary route stays as a fallback.

### Fixed

- "No questions" now really asks nothing: a Claude chat that was already running kept asking about secret files, Codex asked for every Jolty tool, OpenCode asked before reading `.env`, and PC control still asked for system apps and terminals. Banks, password managers and security windows are still refused.
- Models answer in the language you write in again, also after tools run (Claude, Codex and OpenCode).
- A new chat no longer gets the title "Not logged in" when the helper that names chats is not signed in; it keeps the first words of your message instead.
- The DeepSeek preset uses the model name DeepSeek's docs now require.

## 0.7.20

### Fixed

- A key could stay stuck after PC control was stopped halfway. If the Windows key was down when you pressed Stop, or the plan ended early because you took over the mouse or another window came to the front, every key you pressed next acted as Win plus that key: all windows minimized and came back (Win+D, Win+M). Jolty now lets go of every key and mouse button it pressed whenever a plan ends, finished or not. A test presses a key, stops the plan and checks that Windows no longer sees it held.
- "Improve message" on OpenCode's free models failed with "The model did not give a usable version". The model you pick is now the one that rewrites your message (before, a Claude model quietly did it instead). The rewrite does not carry your Claude rules or memory into the prompt and leaves no chat behind in OpenCode.
- OpenCode kept asking for permission in "No questions" mode when a command touched a folder outside the project (for example its own auth file). That mode now also allows those folders.

## 0.7.19

### New

- OpenCode installs with one click. In System check, "Install OpenCode" downloads OpenCode's own release, puts it where OpenCode's installer would, checks that it starts and adds the OpenCode account. No Node.js, npm or terminal needed. If it is already installed, nothing changes.
- System check now also checks PC control: it tells you at once if the Windows compiler it builds its helper with is missing, instead of failing on first use.

### Changed

- The "OpenCode is not installed" message points to System check instead of an npm command.

## 0.7.18

### New

- Opera is now a supported browser for the Jolty extension. Jolty finds it, offers it in Settings and opens its extensions page when you install the extension. Chrome, Edge, Brave, Vivaldi and Firefox work as before.

## 0.7.17

### Changed

- "Improve message" now uses the model you picked in the chat box, not a small helper model, and turns what you typed into a proper prompt: the goal stated plainly, the steps in order, what "done" means and what must not break, without inventing anything you did not say. A short message no longer comes back as something that reads like a chat title.

### Fixed

- Skills that carry your own changes on top of their source no longer show as out of date when the source has nothing newer.
- The active tab in Settings and on the Skills page scrolls into view instead of staying cut off at the edge.
- Cards on the Skills page fit their column instead of spilling past it.

## 0.7.16

### New

- An "Improve message" button in the chat box. It rewrites what you typed to be clearer, in the same language, and puts the result in the box instead of the old text. Nothing is sent: you read it, edit it and send as usual, and Ctrl+Z brings your original back.
- On the PC, Jolty now shows what it is doing. The pill at the top says the action ("Click in notepad", "Typing in notepad: ..."), the window it works in gets an outline, the pointer presses when it clicks, and a click leaves a double ripple.
- A Skills page. All your skills in one table (Claude, Codex and shared folders) with search, filters and sortable columns. "Check for updates" compares skills that come from Git with their source and updates them in one click; the old folder is kept as a backup, and a skill you edited asks first. You can tell Jolty where a skill came from. A badge on the sidebar counts what needs a look.
- An Attention tab on the Skills page: skills that are broken (missing SKILL.md, shortcut to nowhere, unreadable header), out of date or changed here, grouped by reason, each with what to do.
- Export and Import. Pick skills, commands, instructions, settings, accounts (never the keys) and scheduled tasks and save them as one .joltypack file to send to someone. On import you see what is new, identical, different, newer or older than yours and choose per item: keep mine, replace (with a backup) or add next to mine. Risky items (code that runs, instructions, settings) are flagged, and the whole import can be undone.
- Personal data stays home. On export, e-mail addresses, phone numbers, IBANs, card numbers and your user name in file paths are replaced with markers like <email> and <user>. API keys, tokens and cookies never go into a pack.

### Changed

- Settings are sorted into tabs: General, Models and sessions, Browser and computer, Privacy, and Updates and about.
- With "No permissions", computer control no longer asks about ordinary applications, starting a program or the clipboard. Windows itself, terminals, Win-key shortcuts, password managers and banking pages still keep their rules.
- The timer next to the stop button only counts up. The progress bar and the "time left" estimate are gone, since nobody can know how long a task takes.

### Fixed

- Stop now stops the chat at once: the chat shows idle immediately, pending questions are answered no, tools in flight and the computer typing under way end, and late text from the old turn no longer wakes the chat up again.

## 0.7.15

### New

- Intelligence and speed scores for more models in the picker: GLM-5.3 and GLM-5.3-Flash, Beam, and the Nemotron family (Super VL, Ultra, Bolt, Lightning). Flint 40B and Big Pickle stay without a score until they are ranked.

### Changed

- A roomier chat box. It is wider, the text field is taller, and the project name gets more room, so the bar is less cramped.
- The power button moved into the Tools menu as "Oprire PC". It shows in the bar only while a shutdown plan is set.

## 0.7.14

### Changed

- A tidier chat box. Plan, Browser, Computer and Temporary chat now sit behind one Tools button, and only the ones that are on show in the bar. The power button stays beside it.

## 0.7.13

### Changed

- The original Jolty mascot is back. The rebuilt one from 0.7.11 is gone.
- OpenCode lists only its free models, each shown by the model name alone.

## 0.7.12

### New

- Jolty can use the computer. A new Computer switch in the chat (also in the new chat box) lets the model see the screen and work the PC like a person: it moves the mouse along a natural path, clicks and types at a human speed. Jolty asks you before it touches each application, and Ctrl+Alt+Esc stops it at once. The switch is off every time Jolty starts, and Settings has a page for it. It works with Claude, Codex and OpenCode.
- OpenCode is a new engine next to Claude, Codex and Hermes. Pick it in the model list to use the free models OpenCode offers (Big Pickle and the other free ones), with the Jolty browser attached. Each model shows its own thinking levels in the picker. OpenCode has to be installed (npm i -g opencode-ai), or point Settings at opencode.exe.

## 0.7.11

### New

- A new Jolty. The mascot was rebuilt from a clean 3D model: a soft fleece hoodie with real stitching and folds, a glossy black visor with glowing eyes, free sleeves, detailed sneakers with glowing soles, and the lightning bolt coming out of a slot in the hood. Both arms now move on their own, so raised arms (cheering, waving, pointing) no longer tear the hoodie.
- The right hand is sized to the glove on the left and starts exactly at the cuff.

## 0.7.10

### New

- Hard jobs can go to Opus 5.5. A new box in the card for sessions started by a chat: when the chat starts a session for a hard job it runs on Opus 5.5, with the thinking level you pick next to the box. The chat's own account is used if it has Opus, otherwise another connected one that is not at its limit. It comes before the model set for hard tasks and before the automatic choice.

## 0.7.9

### New

- Jolty can choose the model of a started session for you. A new box in the card for sessions started by a chat: where the model is left on "Same model as the chat", Jolty picks from the accounts and providers you have connected, by the score in the model picker. A hard job gets the strongest model, a simple one the fastest model that is still good enough. Accounts close to their limit are skipped. It is off until you tick it.

## 0.7.8

### New

- Gemini describes images for models that cannot see. In Settings, in the images card, pick "Gemini (through the Jolty browser)": a small agent opens gemini.google.com in the Jolty browser, attaches the picture and brings back Gemini's description. It uses your own Google account (sign in once in the Jolty browser window), takes about a minute, and when it fails the automatic profile describes the image. Every model that has the browser is also told that Gemini is there for video, audio and very long documents.
- A send button for parallel work. Next to Send there is a second button (Ctrl+Shift+Enter) that sends the message as written and asks the model to split the job into independent parts and run them in sessions of their own. The chat shows only your words.
- Sessions a chat starts begin with no permissions and with the Jolty browser, and Settings has a card for it: their permission mode, the browser, and a model of their own for simple jobs and for hard ones (the chat says which when it starts the session). Left on "Same model as the chat", they use the model of the chat.
- Models that are new or updated get a NEW or UPDATED badge in the model picker for a week. Jolty now checks DeepSeek, MiMo, Codex and Ollama too, every hour, not only the Claude list.
- The intelligence and speed numbers in the picker come from a table in the Jolty repository that is refreshed every hour, so a new model gets its score without a new release.

### Fixes

- Live usage in the sidebar updates by itself: every minute while Jolty is open, and at once when you come back to the window, with no refresh button.

## 0.7.7

### New

- A Live list above your conversations in the sidebar: every chat that is working (with its current step and how long the turn has run), every chat waiting for your approval (with what it asks), and every chat that finished while you were looking elsewhere. Click one to switch to it, or press Alt+1 to Alt+9. A finished one stays until you open it or dismiss it with the cross.
- Run several sessions at once. A chat can now start sessions of its own for the parts of a job (`start_session`): each gets its own git worktree and branch cut from the last commit, so two of them never write the same file, and a short brief that stands on its own. The lead waits for them (`wait_for_sessions`), reads what they answered (`list_sessions`), sends a follow-up (`send_to_session`) and merges the branches itself. Up to 8 work at once, in Auto or "accept edits" mode, and a started session cannot start more. Sessions started this way show a branch icon, and a right-click copies the branch name or opens the worktree. An unused worktree disappears with its session; one with changes or commits stays on its branch.
- A shared ledger per project (`ledger_read`, `ledger_write`): one notes file that every session of the project reads when it starts and writes decisions, state and open work to, so a new session does not explore the whole codebase again. It lives in Jolty's data folder, nothing is added to your project.
- Compact first, then continue on another account or model. A new account or model reads the whole conversation with a cold cache, which was the usage spike of a switch. Now "Continue in" and the model picker compact the chat first, on the model that still has it warm (one switch in the Continue in menu turns it off; small chats are left alone). On the same provider, "quick summary" starts a new chat with a brief of a few thousand tokens instead.

### Improvements

- When an account hits its limit, "Continue on ..." now carries a compact brief by default. The same chat with its whole context is still one click away, with its size next to it.
- The context meter drops right after a compaction instead of showing the old size until the next message.
- The clock beside the composer no longer says "estimating" forever. Without a task list it shows only the time worked, and a list left over from an earlier turn is estimated again in the next one.
- A chat's task list is back after you close and reopen Jolty, in the strip above the composer and in the Plan tab, and a resumed chat goes on updating it.
- The browser picture and the preview in the Live panel keep following the model while Jolty is behind other windows or without focus. If the browser window stops painting, the picture is taken directly every 2 seconds.

## 0.7.6

### New

- Jolty's right hand is a real glove now, with every finger on its own joints (three phalanges each, and a thumb), instead of the scan's mitten. It changes shape with what he does: an open hand to wave and cheer, a pointing finger when he thinks (and for the "aha" when an idea comes), a fist around the magnifying glass, a flat hand shading his eyes, a claw for a running command, fingers that tap on the keys when he types and flap loosely when he is held or flung.
- A thumbs-up at you now and then when a task is done, instead of always the cheer.

## 0.7.5

### New

- Jolty has more life when nothing is going on: his eyes wander about on their own now and then, he sometimes blinks twice, stretches (one arm up, leaning away, up on his toes, a yawn) and shrugs.
- Sound where it was missing: soft footsteps while he walks and runs, a small "hup" and cloth rustle as he gets up, laptop keys while he types, a blip when he starts thinking, and a slow breath while he sleeps.

### Improvements

- The model is closer to the reference render. The scan's flat-shaded faces are smoothed (folds stay sharp), the hood top is rounded instead of a pinch of creases, the bolt comes out of a dark slot with a thin volt glow around it, and the cold blue stains baked into the hood are gone, so it is matte charcoal fabric.

## 0.7.4

### Improvements

- The get-up is staged like a real one, in beats with ease in and out: a breath, the arm props him and pushes the floor until he sits with his legs out in front, the heels are drawn in, the weight goes forward with his hands reaching down, the hips lift into a squat, the legs drive, and he settles with a small overshoot. He is turned three-quarters to you so the arms and legs read, and his lowest point always rests on the floor.
- Dust puffs where he hits something, by how hard: a landing, a bump into a wall, a tumble.
- Smoother walking: he is placed to the device pixel instead of whole css pixels, so a slow stroll no longer steps along the screen, and he leans into his pace.
- The sparks while a command runs crackle off the bolt on his head, outward in every direction from that one point (the burst for a click or a cheer still fans up from the bolt).

### Fixes

- Held by the hood he is glued to the cursor again, with his arms, legs and hood flopping about with how you move him, like before. The physical ragdoll takes over only when you let go: he flies, braces, bounces and tumbles with the speed of your hand, and that is where the spin went too far.
- Getting up is an animation now, the way a person gets up after a fall: the knees come up, he props himself on his arm and pushes the floor until he sits, leans forward with his hands reaching, lifts into a squat and stands. It starts from the exact pose he lay in and his lowest point stays on the floor, so it no longer looks like a clip pasted in. The physical get-up could leave him stuck lying on the floor until you hid and showed him again: that cannot happen any more, and a pile that will not settle gets him up by itself after a few seconds.
- If you let go of the button where Jolty cannot see it (a screenshot tool, another window taking focus) he lets go too, instead of staying stuck to the cursor.

## 0.7.3

### Fixes

- The stool makes noise: a rough wooden scrape with creaks while he drags it under him, and a dull knock when it stops, instead of a barely audible hiss.
- The teleport zap has a sound now: a bright zip that sweeps up when he vanishes and a short snap with a little crackle where he lands. Like his other sounds it stays quiet while Jolty is not the window you are using.

## 0.7.2

### Fixes

- No more drag in the air: a thrown Jolty keeps his speed (the ragdoll had a little air resistance and a heavy spin damping), and held by the hood he follows the cursor more tightly.
- The sparks come from where they should: the burst when he cheers or is clicked starts at the bolt on his head, and the charge while a command runs flies from his hands, forward, instead of a fixed point above his feet that did not move with him.
- He no longer looks like he hovers on tiptoe over nothing when he stands on the window's floor: the floor line is a few pixels up so his shoes are whole, and a faint volt glow under his feet shows where he stands.

## 0.7.1

### Fixes

- The stool you can actually see: it was a 12-unit seat hidden under his thighs, so only a speck of wood showed. It is now a taller, wider and lighter wooden stool, and he sits up on it with his shoes dangling and swinging, so the legs of the stool show below him.

## 0.7.0

### New

- Jolty is a full active ragdoll now, in the spirit of Euphoria: a physical skeleton (head, trunk, pelvis, thighs, shins, upper arms and forearms, each with its own mass) driven by muscles at every joint. Take him by the hood and he hangs from your cursor, his hands reaching for it and his legs kicking; swing him around and he swings with it. Let go and he flails through the air, braces his arms and tucks his head toward whatever he is about to hit, bounces off the walls, the composer and the cards, tumbles, and lies dazed for a moment before he pushes himself up with his hands and stands again.
- Legs cannot go through his chest or head, or a hand through a thigh: the parts of him that could meet collide. Joints stop where a real one would.
- An error in a chat knocks him backwards on the spot and he staggers or goes down, instead of a canned fall. With Reduce motion on he keeps the old keyframed fall.

### Improvements

- Hits sound as hard as they were, from a soft step to a thud with an oof.

## 0.6.3

### New

- A thud when Jolty is thrown into a wall or the top of the window, as hard as he hit it.
- When he looks up at the cursor his head goes back, and down it dips, instead of only swiveling left and right. In What's new his head follows the cursor too, not just his eyes.
- A real wave: the arm goes out and up and the forearm swings side to side in view (before it only bent toward you, so it hardly moved).

### Improvements

- Smoother and less stiff: at rest he now draws 30 frames a second, up from 12, and every frame while you move the cursor. His eyes glide to the cursor instead of snapping, poses blend more softly, he winds up with a crouch before a jump, builds up speed when he starts walking and eases off as he arrives, and his steps keep pace with the ground.
- Jolty in What's new always runs at full frame rate; at the start of the animation he dropped to 12.

### Fixes

- He no longer floats beside the composer after a long dash: he lands on the window's floor, not on the top of the composer's area.

## 0.6.2

### New

- Notifications in Settings, each with its own switch: when a task finishes or stops with an error, when a model waits for you (a permission or a plan approval), and the Windows sound that goes with them. They only appear while Jolty is not in front, and clicking one brings it back.

### Fixes

- Jolty's sounds are cut the moment the window loses focus, including anything already scheduled, so nothing is heard while you work elsewhere.

## 0.6.1

### New

- Jolty has a proper rig now, with knees, elbows and a spine in two: he lifts his feet when he walks, lands in his knees, really sits (thighs level, shins down), types with bent elbows and waves from the elbow, and at rest his joints stay a little soft as he shifts his weight from foot to foot.
- Jolty has weight, like a ragdoll held up by muscles. His arms, legs and head lag behind when he speeds up or stops, a jolt throws his arms out, held by the hood he swings like a pendulum as you move the cursor, and thrown he tumbles with the throw, flails, lands on the side he was turning to with a bounce, then gets up.
- He pulls a little wooden three-legged stool out of the composer when he sits down on the window's floor and sits on it with his feet on the ground, instead of sitting on nothing. Sitting he turns side-on, so the bent knees read.
- He lives on the page more, without pulling at your eye: every 9 to 17 seconds he strolls, sits on his stool, checks his laptop, looks around, thinks, or hops onto your last message for a while and comes back.
- Soft sounds for what he does: a hop, a landing (a thud when it is hard), a whoosh when thrown, a squeak when picked up, a crackle on commands, a laptop click, the stool sliding, a little chime when he cheers. They stay quiet while you work in another window, and have their own switch in Settings.

### Fixes

- Beside the composer he stands on the window's bottom edge and stays there when the composer grows with your text; before he floated up with it.

## 0.6.0

### New

- Dictation in the composer. Click the microphone, talk, click again, and your words land at the cursor (Esc drops the recording). It is transcribed on your own PC by Whisper large-v3 turbo through whisper.cpp, on the graphics card when there is one (any brand, through Vulkan) and on the processor otherwise, so nothing you say leaves the PC. The ring around the button follows your voice while it records, and Jolty puts a hand to his ear and listens. The model (574 MB) is downloaded once, the first time you use it. On a Radeon RX 6800 XT ten seconds of speech are written in about two seconds.

## 0.5.9

### Fixes

- Jolty no longer stands over buttons. On top of the composer he covered the right end of whatever sat above it, like the update banner's close button and the queue's buttons, and clicks there went to him. When the chat column has room he now stands beside the composer, on the column's floor, and strolls only in that margin. The end of the chat also keeps room for him, so he never stands over the last lines.
- His eyes follow the cursor across his visor instead of the whole body turning after it.
- Dropped at the very bottom of the window he no longer sinks out of it; he stays inside its edges with room for his legs.
- Lighter at rest: while nothing moves he draws 12 frames a second instead of 24, and he turns to what you click and glances up when you scroll or an answer arrives.

## 0.5.8

### New

- Jolty reacts to what you do in the app. He reads along while you type, hops when your message goes out, cheers when you approve a request and looks worried when you refuse one, points at the chat when you drag files over the window and celebrates when you drop them, nods at a confirmation, worries at an error, waves when you start a new conversation, points up when an update is ready and waves a sleepy goodbye when you arm a shutdown. On the other pages he does what the page is about: inspects Usage and System check with his magnifying glass, thinks over Settings and Schedules, reads through Import. While a model works with its context window nearly full, he looks worried.

### Fixes

- A small bolt flickered in the top-left corner of the window while a command ran: the sparks off Jolty's bolt showed at the window's corner before their animation started. They are hidden until they fly now, and removed even when the window is minimised.
- Jolty is easier to see on the dark app: two cold rim lights from behind draw his edges and the light from below lifts his hoodie and trousers, without changing how he looks.

## 0.5.7

### New

- Jolty, the mascot, in 3D. The hooded character from the approved render now lives in the app as a real 3D model, turned into a mesh and rigged in Blender. His volt parts (eyes, bolt, drawstrings, soles) glow, his eyes blink and follow the cursor, he cheers when a turn ends, points at approval cards, and can be picked up by his hood and thrown. Hide him from his own right-click menu or in Settings.
- Jolty does what the model does. When it writes code he pulls a laptop out of his hoodie pocket, opens it and types away, with a hard Enter now and then. He reads on it while files are read, holds up a magnifying glass for searches, charges a command with both hands and sparks off his bolt, shades his eyes to look around while the model is on the web, and puts a hand on his chin while it thinks.
- What's new: after an update Jolty shows this window once, with what changed in every version, newest first. Open it again any time from Settings.
- Better conversation titles: after your first message a small model names the chat after what it is about (3 to 7 words, in your language), so it is easy to find in the sidebar and in conversation search. Right-click a chat and pick Rename, or double-click its title, to name it yourself. Your own title is never replaced.

### Fixes

- Jolty no longer freezes while a model writes a big file. The Live code tab received the whole file every 60 ms and coloured and laid out all of it each time, so with a large page the window stopped taking clicks, without any "Not responding", until the file was done. While a file is written the tab now shows its last 150 lines and how many are above them, and the whole file once it is written. On a 4000-line page clicks went from not landing at all to answering in about 30 ms.

## 0.5.6

- Updates go straight to the newest version. Once an update was downloaded, Jolty stopped checking, so "Restart" installed that version even when a newer one had come out in the meantime, and after the restart you had to update again. Jolty now keeps checking while an update waits, and the restart button checks once more and fetches the newest release first, so one restart is enough. The "ready" notification no longer repeats for a version you were already told about.
- The menus in the composer (browser, power, model) open above the Live panel again. In 0.5.5 the right part of a menu that reached over the panel was hidden under it.

## 0.5.5

- The window can be any size without parts landing on each other. On a narrow window (with the sidebar shown) the Live panel opens as a drawer over a dimmed chat: a click on the chat closes it, making the window that narrow closes it by itself, and widening the window brings it back. With the sidebar hidden there is room again and the panel sits next to the chat. However wide you drag the panel, the chat keeps at least 480 px.
- The sidebar can be resized: drag its edge. The line between Conversations and Live usage can be dragged up or down too. Both sizes are remembered, and a double click on a handle goes back to the default size.
- The Live panel's tabs have icons. When their names do not fit, the tabs not in use show only the icon (the name on hover), and a volt bar slides to the tab in use.
- The composer bar no longer overlaps itself in long languages or in a narrow chat: the model and mode names shorten with an ellipsis, a narrow composer keeps only the folder icon, and the power and browser buttons keep their size.
- The welcome headline is sized to the chat column instead of the whole window, and the folder and account chips in the chat header end with an ellipsis instead of being cut mid-letter. The Live panel button's tooltip is now translated.
- Smoother: the Live signal now moves on the GPU. Before, it was redrawn on every frame while the model worked (about 48 ms of main thread work per second, now about 3). Dragging the Live panel's edge no longer re-renders the whole panel on every mouse move.
- Motion: pages cross-fade when you switch them, the highlight in the sidebar slides to the page in use, a Live tab's content slides in, and the read, changed and commands counters tick when they change. Reduce motion in Settings still turns all of it off.
- Jolty now has a proprietary license: the code is public to read, all rights reserved (see LICENSE).

## 0.5.4

- Live preview of what the model is building: the Live panel has a new Preview tab. When the model makes an HTML page, Jolty serves the project folder on your own PC (127.0.0.1 only, no dot-files, nothing outside the project) and shows the page rendered, reloading by itself every time a file changes. A page still being written already shows while the model types it, so a client who is waiting sees the page take shape instead of a progress snake. When the model starts a dev server (Next.js, Vite, `serve`), the tab shows that server instead, and its own hot reload keeps it current. A server started in the background is found on the usual ports (3000, 5173, 8080 and a few more), and sites that forbid being framed (X-Frame-Options, frame-ancestors) still show up, because Jolty drops those two headers for pages from your own PC inside its window. The tab opens by itself while the model writes or edits, and has buttons to reload and to open the page in your browser.
- The Browser tab names what the model is doing on the page: the last four actions (Click, Type, Navigate, Screenshot, Scroll, Read the page) with the target, the current one marked while it runs, next to the live picture with the cursor and glow the extension already draws.
- The Live panel's tab strip keeps the tab in use in view (there are seven of them now).
- Power plans: the power button in the composer opens a menu like ShutdownTimer's. Pick what the PC does (shut down, restart, sleep, hibernate, log off or lock) and when (once the work is done, after some minutes, or at a time of day), and whether to close programs that would hold a shutdown back. A timer fires at its time whatever the chats are doing; "once the work is done" still waits for the chats to go quiet. Shutdown and restart use Windows' own countdown, so they still happen if Jolty closes, and you can cancel during the warning. Sleep, hibernate and lock get a short 15 second warning.

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
