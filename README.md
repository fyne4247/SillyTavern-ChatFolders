# Chat Folders

A SillyTavern extension that turns the Recent Chats list on the welcome screen into folders: one per character or group, with branches nested under the chat they came from.

Built for long-running roleplays with lots of branches and checkpoints, where the flat recent list stops being useful.

## Features

- **One folder per character or group**, showing its chat count, message count and last activity.
- **Branches and checkpoints nest** under the chat they were made from, as deep as they go.
- **Pinned conversations** folder at the top. It uses SillyTavern's own pins, so pins carry over if you turn the extension off. Pinned chats also stay in their normal folder.
- **Sort by clicking the column headers**, for folders and for the chats inside them:
  - Folders: Character, Lorebook, Threads, Messages, Last active
  - Chats: Branch (name), Lorebook, Messages, Last active
  - Lorebook sorts A–Z or Z–A with "None" last, then by name, so characters from the same world end up together
  - The chat sort is shared by every folder
- **Lorebook dropdowns** for each character and each chat, including "Create new…". A character's extra books are shown as tags.
- **Rename and delete** chats from the list.
- **Expand/collapse all**: a button per folder for its branches, and a floating button for every folder. The floating button can be dragged anywhere and remembers where you put it.
- Open/closed folders are remembered between visits.
- Optional [Memory Books](https://github.com/aikohanasaki/SillyTavern-MemoryBooks) integration (see below).

## Installation

1. In SillyTavern, open **Extensions → Install Extension**.
2. Paste `https://github.com/fyne4247/SillyTavern-ChatFolders` and press Install.
3. Go to the welcome screen (close any open chat).

## Usage

- Click a **folder** to open or close it.
- Click a **chat** to open it. If the chat has branches, a click opens or closes its branches instead, and a **double-click** opens the chat. With the keyboard, Space toggles and Enter opens.
- Click a **column header** to sort by it; click again to reverse.
- Use the **thumbtack** on a chat to pin or unpin it.
- Drag the **floating folder button** to move it; click it to expand or collapse everything.

## Settings

In **Extensions → Chat Folders**:

| Setting | Default | What it does |
|---|---|---|
| Enable Chat Folders | On | Off brings back SillyTavern's normal list |
| Enable Pinned Folder | On | Hide the Pinned folder (pins themselves are kept) |
| Enable Expand All Button | On | Hide the floating button |
| Reset Position | | Puts the floating button back in the corner of the list |
| Rename chat-linked lorebooks | On | Requires Memory Books; skips character-linked and shared books |
| Auto-link Memory Books to chats | Asked when needed | Manual Lorebook Mode only; see below |

Deleting a chat always asks for confirmation.

## Memory Books (optional)

Everything works without Memory Books, and most Memory Books users won't notice anything: normally Memory Books writes memories into the chat's own lorebook, so there's nothing for Chat Folders to do.

Auto-linking and manual book selection use Memory Books’ **Manual Lorebook Mode**. Renaming also works outside manual mode:

- If some chats have a manual-mode Memory Book but no lorebook, Chat Folders asks once whether to **link those books as their lorebooks**. Saying yes saves the lorebook into those chats. Choosing "None" for a chat is remembered, and it won't be linked again. Characters with a Memory Books lock get their locked book the same way.
- Picking a lorebook in Chat Folders also points Memory Books at that book.
- Renaming a chat also renames its chat-level lorebook to the new chat name and updates its Memory Books manual link when that link points to the same book. This is on by default and can be turned off in Chat Folders settings. It requires Memory Books to be enabled. Books linked to any character (including active character locks), another chat, a persona, or globally are left alone. An existing book with the new name is never overwritten. If saving or relinking fails, the original book is kept; a new copy may also remain for recovery.
- Linking follows manual mode live: turn manual mode off and it stops, turn it back on and it picks up again with your earlier answer.
- Characters with a Memory Books lock show a lock tag.

## Good to know

- **Big libraries:** the list reads the header of every chat each time the welcome screen opens. With thousands of chats this can take a few seconds. If it takes longer than 20 seconds, SillyTavern's normal list is shown instead.
- **Pins after turning the extension off:** SillyTavern's own list remembers pins from when the page loaded. If you pin chats here and then switch the extension off, reload the page to see them in the normal list.
- **Branch links on rename/delete:** SillyTavern currently doesn't update a branch's "Back to main chat" link when its parent is renamed or deleted. Chat Folders shows branches by that link, so a branch whose parent was renamed or deleted will show up as its own top-level chat.

### How is this different from Chat Collections?

[Chat Collections](https://github.com/starcore42/SillyTavern-Chat-Collections) lets you build your own virtual folders. Chat Folders is automatic: it groups by character, nests branches by their real parent links, and adds lorebook, pin and Memory Books handling to the welcome screen itself.

## Requirements

- SillyTavern 1.19.0 or newer. Older versions are untested.
- No server plugin needed.

## License

AGPL-3.0. See [LICENSE](LICENSE).
