# Branch rename compatibility fix

Objective: renaming a branch through Chat Folders must continue renaming its exclusive chat-linked lorebook without Memory Books creating another branch copy. Only Chat Folders may be edited. No user-data repair or Memory Books changes authorized. Owner subsequently authorized merging and pushing main.

Baseline: main c2a3967. Task branch: fix/branch-rename-copy-receipt. Preexisting untracked futureplan.md is untouched and excluded.

Implemented: known Chat Folders rename supplies a pending identity; a first CHAT_CHANGED listener updates a completed Memory Books copy receipt before the core reload reaches Memory Books. Inactive character chats receive identity repair after the core operation. Lorebook rename updates matching receipt copyName entries together with world_info/manualLorebook, retaining lineage roots and other mappings. Both chat and lorebook names still follow the requested rename. Existing sharing/collision checks remain.

Verified: 25 Node tests pass; index.js syntax and whitespace checks pass. Separate in-memory check with the installed Memory Books branch controller confirms zero extra copy writes both at the early reload and after the book rename. No real chats or lorebooks were changed during tests. No browser verification performed. Separate native chat-menu renames do not receive the early pending-rename protection; sanitized chat names and inactive group receipts need further coverage. No independent agent review claimed.

Installed only index.js and lorebook-rename.mjs into local SillyTavern Chat Folders; bytes verified. Original backup: /Users/fish4247/Library/Application Support/SillyTavern-fixes/chatfolders-branch-rename-20261026-183257. Memory Books and Rename Relink files untouched. Existing duplicates untouched. Owner approved merging to main and pushing origin/main; see Git refs for the resulting state.

## NEXT ACTION

Reload SillyTavern to load the corrected Chat Folders files. Verify a branch rename through Chat Folders renames both chat and exclusive lorebook and reopening does not create another book. Preserve existing duplicates pending an explicit cleanup request. Extend early protection to native-menu renames only with an evidence-based approach; core emits CHAT_RENAMED after reload.
