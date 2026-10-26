const stem = name => String(name ?? '').replace(/\.jsonl$/i, '');
export const sameChat = (row, { avatarId, groupId, newFileName }) =>
    stem(row.file_name) === stem(newFileName) && (groupId
        ? String(row.group) === String(groupId)
        : !row.group && row.avatar === avatarId);

/** Only an exclusively chat-linked book can follow its chat's name. */
export function exclusiveChatBook(rows, target, characterBooks) {
    const row = rows.find(row => sameChat(row, target));
    const book = row?.chat_metadata?.world_info;
    if (!book || characterBooks.includes(book)) return null;
    if (rows.some(other => !sameChat(other, target) &&
        [other.chat_metadata?.world_info, other.chat_metadata?.STMemoryBooks?.manualLorebook].includes(book))) return null;
    return book;
}
export const chatStem = stem;
