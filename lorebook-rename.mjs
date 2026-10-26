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
