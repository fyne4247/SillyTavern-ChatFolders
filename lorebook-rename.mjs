const stem = name => String(name ?? '').replace(/\.jsonl$/i, '');
export const sameChat = (row, { avatarId, groupId, newFileName }) =>
    stem(row.file_name) === stem(newFileName) && (groupId
        ? String(row.group) === String(groupId)
        : !row.group && row.avatar === avatarId);

/** Only an exclusively chat-linked book can follow its chat's name. */
export function exclusiveChatBook(rows, target, characterBooks, { manualMode = true } = {}) {
    const row = rows.find(row => sameChat(row, target));
    const book = row?.chat_metadata?.world_info;
    if (!book || characterBooks.includes(book)) return null;
    if (rows.some(other => !sameChat(other, target) &&
        (other.chat_metadata?.world_info === book ||
            (manualMode && other.chat_metadata?.STMemoryBooks?.manualLorebook === book)))) return null;
    return book;
}
export const chatStem = stem;

/** Preserve a completed copy receipt for a known Chat Folders rename. */
export function remapBranchCopyIdentity(metadata, oldName, newName) {
    const marker = metadata?.STMemoryBooks?.branchLorebookCopies;
    if (marker?.version !== 1 || marker.status !== 'completed' || marker.branchChatId !== oldName) return false;
    marker.branchChatId = newName;
    const rollback = metadata.STMemoryBooks.autoRollbackForChild;
    if (rollback?.version === 1 && rollback.status === 'completed' && rollback.childChatId === oldName) {
        rollback.childChatId = newName;
    }
    return true;
}

/** Keep Memory Books' completed-copy receipt consistent with a book rename. */
export function remapBranchCopyBook(metadata, oldBook, newBook) {
    const marker = metadata?.STMemoryBooks?.branchLorebookCopies;
    if (marker?.version !== 1 || marker.status !== 'completed' || !Array.isArray(marker.mappings)) return;
    for (const mapping of marker.mappings) {
        if (mapping.copyName === oldBook) mapping.copyName = newBook;
    }
}

/**
 * Recognize a previously copied, exclusively linked book renamed to its chat.
 * Never bless a new branch's inherited receipt: its old chat still exists or
 * its parent still uses the same book. Ambiguous/multi-book receipts stay alone.
 */
export function repairRenamedBranchReceipt(metadata, rows, target, protectedBooks, { manualMode = false } = {}) {
    const marker = metadata?.STMemoryBooks?.branchLorebookCopies;
    const name = stem(target.newFileName);
    const book = metadata?.world_info;
    if (marker?.version !== 1 || marker.status !== 'completed' || !marker.branchChatId ||
        !Array.isArray(marker.mappings) || marker.mappings.length !== 1 ||
        !marker.mappings[0]?.copyName || !metadata.main_chat || metadata.main_chat === name ||
        !name || book !== name) return false;
    if (manualMode && metadata.STMemoryBooks.manualLorebook !== book) return false;
    if (manualMode && Object.values(metadata.STMemoryBooks.manualCharacterLorebooks ?? {}).some(Boolean)) return false;
    const oldName = marker.branchChatId;
    if (oldName !== name && rows.some(row => sameChat(row, { ...target, newFileName: oldName }))) return false;
    if (!rows.some(row => sameChat(row, target))) return false;
    // The active in-memory selection is authoritative, even before its save finishes.
    const activeRows = rows.map(row => sameChat(row, target) ? { ...row, chat_metadata: metadata } : row);
    if (exclusiveChatBook(activeRows, target, protectedBooks, { manualMode }) !== book) return false;
    const oldBook = marker.mappings[0].copyName;
    if (oldName === name && oldBook === book) return false;
    remapBranchCopyIdentity(metadata, oldName, name);
    remapBranchCopyBook(metadata, oldBook, book);
    return true;
}
