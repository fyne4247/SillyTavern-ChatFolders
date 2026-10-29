# Branch reopen compatibility fix

## 2026-10-29 folder pin highlight fix

Routine fix on `fix/folder-pin-highlight`, baseline `0709c05`. Folder pin controls now use the existing chat pin highlight classes and expose `aria-pressed`, so pinned folders show the theme accent at full opacity and unpinned folders return to the normal style. Existing `isPinned` marker and persistence remain intact. Preexisting `.gitignore` changes are untouched and excluded.

Verification: 43 Node tests passed, 2 optional Memory Books integrations skipped; module syntax and diff whitespace checks passed. Self-reviewed only; live browser appearance remains unverified. No deployment, main merge or push performed.

NEXT ACTION: Load the updated extension in SillyTavern and verify folder pin/unpin color changes in the main view and sidebar. Merge after owner approval; do not push without an explicit request.

## Objective and scope

Stop repeat Memory Books copies when opening previously renamed chats. Chat and exclusive lorebook must still rename together. Change only Chat Folders; preserve user data and Memory Books source. Routine task, no phase workflow or delegated review.

## Current work

Baseline main a7d8cb8; task branch fix/reopen-renamed-branch. Preexisting untracked futureplan.md is untouched and excluded. Prior fix 67122b3 only handled a pending rename. The owner confirmed duplicates appear on opening a chat without renaming.

The CHAT_CHANGED listener now also recognizes stale, completed single-book copy receipts on reopen: the selected book must have the chat's name and be exclusive, the old chat identity must no longer exist if different, and the receipt must not describe multiple books. Character/global/persona protections and manual-mode checks apply. Repairs update the copy identity/name before Memory Books sees the event. An already-completed rollback receipt follows a proven identity rename so rollback is not accidentally repeated. A chat switch during inspection cancels the repair. Healthy receipts avoid the additional chat listing.

Existing copies are not deleted or relinked automatically. Ambiguous receipts, shared books, missing/failed receipts and multi-book cases remain unchanged. The repair takes effect after the browser reloads the extension. Native rename events with sanitized names and inactive group rename receipts remain outside the earlier pending-rename fix; recognizable stale records can now be repaired on subsequent opening.

## Evidence

42 Node tests pass, including two optional integrations against the installed, unmodified Memory Books branch controller. The actual Chat Folders opening handler is exercised without a pending rename: unguarded stale metadata creates an extra copy; guarded metadata creates none across repeated opens. A genuine new branch still gets exactly one copy. Tests cover shared/character books, old chat existence, groups, manual mode, missing and failed receipts, multi-book records, idempotence and switching chats during inspection. Syntax and whitespace checks pass. No real chat/lorebook writes occurred in tests. Read-only header inspection confirmed stale receipts in the local data. No real-browser verification or independent review claimed.

Run portable checks: `node --test *.test.mjs` (the two real-controller tests skip without configuration).
Run integration: set `STMB_BRANCH_MODULE` to the installed Memory Books `branchLorebooks.js` and run the same command. All controller writes are in-memory mocks.

## Installation and repository state

Implemented in 76d9097 and installed by fast-forwarding the local Chat Folders extension checkout. Runtime file bytes match the source, and the installed checkout is clean. Prior installed a7d8cb8 is preserved on backup/before-reopen-fix-20261026-192044. The installed checkout uses its local main. Owner approved merging and pushing this follow-up; source main was fast-forwarded through 459fb20. Publication target is origin/main; verify the remote ref for push completion. No Memory Books or Rename Relink edits and no existing duplicate cleanup.

## NEXT ACTION

Reload the SillyTavern browser page to load Chat Folders 1.8.1. Open an affected renamed chat and check that repeated opens create no additional book. Preserve existing duplicates pending a separate cleanup decision. If the issue persists, inspect only the affected chat header, selected book and receipt, plus listener ordering, without reading message content unnecessarily.

## 2026-10-28 pinned folder enhancements
Implemented chat lorebook selectors in pinned conversations, independent pinned sorting (Character heading, character-name default), and persistent folder pin buttons. Pinned folders sort below pinned conversations and above ordinary folders. Existing .gitignore edits preserved and excluded from commit.
Validation: node --test *.test.mjs: 40 passed, 2 skipped; module syntax check passed. Live browser validation pending; no deployment or push performed. Implementation self-reviewed; owner approval and main integration pending.
NEXT ACTION: Check lorebook selection, independent sorting, and folder pin/unpin in the live UI before approval/integration.

## Rendering regression correction
The previous change accidentally inserted pinned-character sorting into renderTree, referencing an undefined owner map. Ordinary folders using name sorting could fail to render. Restored ordinary branch sorting and added executable renderTree regression checks for ascending, descending, and recent modes.
Validation: 43 passed, 2 skipped; module syntax and diff whitespace checks passed. Live UI remains unverified. Correction saved locally; not pushed. Existing .gitignore edit remains excluded.
NEXT ACTION: Publish the correction when authorized, then verify the affected folder view in SillyTavern.
