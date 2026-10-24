// Pure grouping/sorting logic for ST-ChatFolders. No DOM, no SillyTavern imports.

/** Default timestamp parser: numbers (ms) and anything Date.parse understands. Returns NaN if unknown. */
export function defaultToMs(ts) {
    if (typeof ts === 'number') return ts;
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts !== 'string' || !ts) return NaN;
    return Date.parse(ts);
}

const stem = (f) => String(f ?? '').replace(/\.jsonl$/i, '');

export const FOLDER_SORTS = ['name-asc', 'name-desc', 'lore-asc', 'lore-desc', 'threads-desc', 'threads-asc', 'messages-desc', 'messages-asc', 'recent', 'oldest'];
export const CHAT_SORTS = ['name-asc', 'name-desc', 'lore-asc', 'lore-desc', 'messages-desc', 'messages-asc', 'recent', 'oldest'];
const naturalName = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
const exactName = (a, b) => String(a ?? '') < String(b ?? '') ? -1 : String(a ?? '') > String(b ?? '') ? 1 : 0;
const stableCompare = (a, b) => naturalName(a.key ?? a.name, b.key ?? b.name)
    || exactName(a.key ?? a.name, b.key ?? b.name)
    || exactName(a.mainChat ?? '', b.mainChat ?? '');
// Lorebook A-Z (or Z-A); no lorebook stays last either way, and ties fall through to name A-Z.
const compareBooks = (a, b, desc) => (!a || !b) ? (a ? -1 : b ? 1 : 0) : naturalName(a, b) * (desc ? -1 : 1);

function compareChats(a, b, mode) {
    let result = 0;
    if (mode === 'name-asc' || mode === 'name-desc') result = naturalName(a.name, b.name) * (mode === 'name-desc' ? -1 : 1);
    else if (mode === 'lore-asc' || mode === 'lore-desc') result = compareBooks(a.lorebook, b.lorebook, mode === 'lore-desc');
    else if (mode === 'messages-desc' || mode === 'messages-asc') result = (Number(a.count) - Number(b.count)) * (mode === 'messages-desc' ? -1 : 1);
    else if (mode === 'recent' || mode === 'oldest') {
        const am = Number.isFinite(a.ms) && a.ms > 0 ? a.ms : NaN;
        const bm = Number.isFinite(b.ms) && b.ms > 0 ? b.ms : NaN;
        if (!Number.isFinite(am) || !Number.isFinite(bm)) result = Number.isFinite(am) ? -1 : Number.isFinite(bm) ? 1 : 0;
        else result = (am - bm) * (mode === 'recent' ? -1 : 1);
    }
    return result || naturalName(a.name, b.name) || exactName(a.name, b.name) || stableCompare(a, b);
}

/** Return a sorted sibling array without cloning or mutating its canonical chat objects. */
export function sortChatSiblings(chats, mode = 'recent') {
    return [...(Array.isArray(chats) ? chats : [])].sort((a, b) => compareChats(a, b, mode));
}

/** Sort a complete tree into independent copies for pure callers and tests. */
export function sortChats(chats, mode = 'recent') {
    return sortChatSiblings(chats, mode).map(chat => ({ ...chat, children: sortChats(chat.children, mode) }));
}

/** @param {(folder: object) => string} [lorebookOf] the folder's lorebook name, '' for none */
export function sortFolders(folders, mode = 'recent', lorebookOf = (folder) => folder.lorebook ?? '') {
    return [...(Array.isArray(folders) ? folders : [])].sort((a, b) => {
        let result = 0;
        if (mode === 'name-asc' || mode === 'name-desc') result = naturalName(a.name, b.name) * (mode === 'name-desc' ? -1 : 1);
        else if (mode === 'lore-asc' || mode === 'lore-desc') result = compareBooks(lorebookOf(a), lorebookOf(b), mode === 'lore-desc');
        else if (mode === 'threads-desc' || mode === 'threads-asc') result = (a.count - b.count) * (mode === 'threads-desc' ? -1 : 1);
        else if (mode === 'messages-desc' || mode === 'messages-asc') result = (a.messages - b.messages) * (mode === 'messages-desc' ? -1 : 1);
        else {
            const am = Number.isFinite(a.lastMs) && a.lastMs > 0 ? a.lastMs : NaN;
            const bm = Number.isFinite(b.lastMs) && b.lastMs > 0 ? b.lastMs : NaN;
            if (!Number.isFinite(am) || !Number.isFinite(bm)) result = Number.isFinite(am) ? -1 : Number.isFinite(bm) ? 1 : 0;
            else result = (am - bm) * (mode === 'oldest' ? 1 : -1);
        }
        return result || naturalName(a.name, b.name) || exactName(a.name, b.name) || stableCompare(a, b);
    });
}

/**
 * @param {Array<object>} chats rows from POST /api/chats/recent
 *   ({file_name, chat_items, last_mes, mes, avatar?, group?, file_size?, chat_metadata?})
 * @param {object} opts
 * @param {Array<{avatar:string,name:string}>} opts.characters ST characters list
 * @param {Array<{id:string,name:string}>} opts.groups ST groups list
 * @param {(ts:any)=>number} [opts.toMs] timestamp parser (ST's timestampToMoment in the browser)
 * @returns {Array<Folder>} folders sorted by last activity (desc)
 */
export function buildFolders(chats, { characters = [], groups = [], toMs = defaultToMs } = {}) {
    const charByAvatar = new Map(characters.map(c => [c.avatar, c]));
    const groupById = new Map(groups.map(g => [String(g.id), g]));
    const folders = new Map();

    for (const row of Array.isArray(chats) ? chats : []) {
        if (!row || !row.file_name) continue;
        let key, kind, name, avatar = '', groupId = '';
        if (row.group) {
            const g = groupById.get(String(row.group));
            if (!g) continue;
            key = 'g:' + g.id; kind = 'group'; name = g.name; groupId = String(g.id);
        } else if (row.avatar) {
            const c = charByAvatar.get(row.avatar);
            if (!c) continue; // chat of a deleted character: ST's own list drops these too
            key = 'c:' + c.avatar; kind = 'character'; name = c.name; avatar = c.avatar;
        } else {
            continue; // loose chats in the chats/ root belong to nobody
        }

        let folder = folders.get(key);
        if (!folder) {
            folder = { key, kind, name, avatar, groupId, chats: [], count: 0, messages: 0, lastMs: 0 };
            folders.set(key, folder);
        }
        let ms = toMs(row.last_mes);
        if (!Number.isFinite(ms)) ms = 0;
        const name_ = stem(row.file_name);
        const mainChat = stem(row.chat_metadata?.main_chat) || '';
        folder.chats.push({
            name: name_, count: Number(row.chat_items) || 0, ms,
            lastMes: row.last_mes, preview: row.mes ?? '', size: row.file_size ?? '',
            mainChat, lorebook: String(row.chat_metadata?.world_info ?? ''),
            memoryBook: String(row.chat_metadata?.STMemoryBooks?.manualLorebook ?? ''),
            noLorebook: row.chat_metadata?.chatFolders?.noLorebook === true, children: [],
        });
    }

    for (const folder of folders.values()) {
        const byName = new Map(folder.chats.map(c => [c.name, c]));
        const top = [];
        for (const c of folder.chats) {
            const parent = c.mainChat && c.mainChat !== c.name ? byName.get(c.mainChat) : null;
            // Guard against cycles: only nest when the parent is not itself nested under c.
            if (parent && !isAncestor(c, parent, byName)) parent.children.push(c); else top.push(c);
        }
        const newestFirst = (a, b) => b.ms - a.ms || a.name.localeCompare(b.name);
        const sortRec = (list) => { list.sort(newestFirst); list.forEach(c => sortRec(c.children)); };
        sortRec(top);
        folder.count = folder.chats.length;
        folder.messages = folder.chats.reduce((n, c) => n + c.count, 0);
        folder.lastMs = folder.chats.reduce((m, c) => Math.max(m, c.ms), 0);
        folder.chats = top;
    }

    return [...folders.values()].sort((a, b) => b.lastMs - a.lastMs || a.name.localeCompare(b.name));
}

function isAncestor(candidate, node, byName) {
    const seen = new Set();
    let cur = node;
    while (cur && !seen.has(cur.name)) {
        if (cur === candidate) return true;
        seen.add(cur.name);
        cur = cur.mainChat ? byName.get(cur.mainChat) : null;
    }
    return false;
}
