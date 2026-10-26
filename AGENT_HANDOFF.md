# Branch reopen compatibility fix

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

Install as a committed fast-forward in the local Chat Folders extension checkout so its Git record matches its files. Keep the prior installed commit as a backup branch. No Memory Books or Rename Relink edits, no existing duplicate cleanup, no source main merge, no push for this follow-up. Previous permission to push covered the earlier delivered fix.

## NEXT ACTION

Reload the SillyTavern browser page to load Chat Folders 1.8.1. Open an affected renamed chat and check that repeated opens create no additional book. Preserve existing duplicates pending a separate cleanup decision. If the issue persists, inspect only the affected chat header, selected book and receipt, plus listener ordering, without reading message content unnecessarily.
