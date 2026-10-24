<!-- DRAFT: Fish to review/rewrite -->
# Chat Folders

A SillyTavern extension that replaces the recent-chats list on the welcome screen with a folder view, one folder per character or group.

## Features

- Groups chats into folders by character or group.
- Nests branches under the chat they were branched from.
- Sorts folders (name, number of chats, number of messages, recent/oldest) and chats (name, number of messages, recent/oldest).
- Expand/collapse state for folders and branches is remembered in the browser.
- Rename and delete chats from the list.
- Lorebook dropdowns for each character and each chat, including creating a new lorebook.
- Optional Memory Books integration (see below).

## Installation

1. In SillyTavern, open Extensions > Install Extension.
2. Paste `https://github.com/fyne4247/SillyTavern-ChatFolders` and install.

## Usage

Open the welcome screen. The recent-chats list is replaced by the folder list. Click a folder to expand it, click a chat to open it. Use the sort buttons to change the order. The extension can be turned off from its settings in the Extensions panel, which restores the normal list.

## Memory Books (optional)

If [SillyTavern-MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks) is installed and enabled, Chat Folders shows a lock tag for characters with a Memory Books lock, and can link a Memory Books book as the lorebook for a character or chat that has none (setting "Link Memory Books", on by default). When Memory Books is in manual mode, choosing a lorebook here also points Memory Books at that book. Without Memory Books, none of this runs.

## Prerequisites

- SillyTavern 1.19.0 or newer is what this was developed against. Older versions are untested.
- No server plugin needed.

## License

AGPL-3.0. See [LICENSE](LICENSE).
