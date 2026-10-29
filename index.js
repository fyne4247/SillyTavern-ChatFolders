import {
    characters, deleteCharacterChatByName, eventSource, event_types, getCurrentChatId, getRequestHeaders,
    getThumbnailUrl, openCharacterChat, renameGroupOrCharacterChat, saveSettingsDebounced, selectCharacterById,
    chat_metadata, saveMetadata, setActiveCharacter, setActiveGroup, system_avatar, this_chid, updateRemoteChatName,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { deleteGroupChatByName, getGroupAvatar, groups, openGroupById, openGroupChat } from '../../../group-chats.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { timestampToMoment } from '../../../utils.js';
import { openWelcomeScreen } from '../../../welcome-screen.js';
import {
    createNewWorldInfo, deleteWorldInfo, updateWorldInfoList, openWorldInfoEditor, setWorldInfoButtonClass, world_info, world_names,
} from '../../../world-info.js';
import { buildFolders, CHAT_SORTS, FOLDER_SORTS, sortChatSiblings, sortFolders } from './grouping.js';
import { createRowGestureCoordinator, syncBranchAriaExpanded } from './row-gestures.js';
import { CREATE, NONE, orderedLorebookOptions } from './lorebook-options.mjs';
import {
    canAutoLinkChat, createKeyedWriteQueue, createStartupPipeline, matchesCharacterChat, updateActiveChatMetadata,
} from './startup-pipeline.mjs';

import { power_user } from '../../../power-user.js';
import { chatStem, exclusiveChatBook, remapBranchCopyIdentity, remapBranchCopyBook, repairRenamedBranchReceipt } from './lorebook-rename.mjs';

const TAG = '[ChatFolders]';
const SETTINGS_KEY = 'chatFolders';
const LS_KEY = 'SillyTavern-ChatFolders.expanded';
const ENHANCED = 'chatfolders-on'; // class added to .welcomePanel while our list replaces the original
const ROOT_CLASS = 'chatfolders-root';

function ensureStartupStyle() {
    if (document.getElementById('chatfolders-startup-style')) return;
    const style = document.createElement('style');
    style.id = 'chatfolders-startup-style';
    style.textContent = '.welcomePanel.chatfolders-on .welcomeRecent .recentChatList{display:none}';
    document.head.append(style);
}

const settings = () => {
    const s = (extension_settings[SETTINGS_KEY] ??= { enabled: true });
    // linkMemoryBooks stays unset until the user answers the one-time question (askMemoryBooks).
    s.showPinned ??= true;
    s.showFloat ??= true;
    s.renameMemoryBook ??= true;
    s.sidebar ??= true;
    if (!FOLDER_SORTS.includes(s.folderSort)) s.folderSort = 'recent';
    if (!CHAT_SORTS.includes(s.chatSort)) s.chatSort = 'recent';
    return s;
};

function syncSortButton(button, current) {
    const ascending = button.dataset.sortAscending;
    const descending = button.dataset.sortDescending;
    const active = current === ascending || current === descending;
    const mode = active ? current : '';
    const direction = mode === ascending ? 'ascending' : mode === descending ? 'descending' : '';
    button.classList.toggle('chatFoldersSortActive', active);
    button.dataset.sortMode = mode;
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', `Sort by ${button.dataset.sortLabel}${direction ? `, ${direction}` : ''}`);
    button.title = `Sort by ${button.dataset.sortLabel}${direction ? `, ${direction}` : ''}. Activate to ${active ? `sort ${mode === ascending ? 'descending' : 'ascending'}` : 'apply the default order'}.`;
    const arrow = button.querySelector('.chatFoldersSortArrow');
    arrow?.classList.toggle('fa-chevron-up', mode === ascending);
    arrow?.classList.toggle('fa-chevron-down', mode === descending);
    arrow?.classList.toggle('fa-sort', !active);
}

function sortHeaderButton(label, ascending, descending, defaultMode, current, onChange) {
    const button = el('button', 'chatFoldersSortButton');
    button.type = 'button';
    button.dataset.sortLabel = label;
    button.dataset.sortAscending = ascending;
    button.dataset.sortDescending = descending;
    button.dataset.sortDefault = defaultMode;
    button.append(el('span', 'chatFoldersSortText', label), el('i', 'fa-solid fa-sort chatFoldersSortArrow'));
    const activate = (event) => {
        event.stopPropagation();
        event.preventDefault();
        const activeMode = button.dataset.sortMode;
        onChange(activeMode === ascending ? descending : activeMode === descending ? ascending : defaultMode);
    };
    button.addEventListener('click', activate);
    button.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
    syncSortButton(button, current);
    return button;
}

function sortHeaderRow(scope, current, onChange) {
    const row = el('div', `chatFoldersSortRow chatFoldersSortRow-${scope === 'pinned' ? 'chats' : scope}`);
    const add = (label, ascending, descending, defaultMode) => row.append(sortHeaderButton(label, ascending, descending, defaultMode, current, onChange));
    const addLore = () => {
        add('Lorebook', 'lore-asc', 'lore-desc', 'lore-asc');
        row.lastElementChild.classList.add('chatFoldersSortLoreSpacer');
    };
    if (scope === 'folders') {
        row.append(el('span', 'chatFoldersSortSpacer'), el('span', 'chatFoldersSortSpacer'));
        add('Character', 'name-asc', 'name-desc', 'name-asc');
        addLore();
        add('Threads', 'threads-asc', 'threads-desc', 'threads-desc');
        add('Messages', 'messages-asc', 'messages-desc', 'messages-desc');
        add('Last active', 'oldest', 'recent', 'recent');
        row.append(el('span', 'chatFoldersSortSpacer'));
    } else {
        add(scope === 'pinned' ? 'Character' : 'Branch', 'name-asc', 'name-desc', 'name-asc');
        addLore();
        row.append(el('span', 'chatFoldersSortSpacer chatFoldersSortThreadSpacer'));
        add('Messages', 'messages-asc', 'messages-desc', 'messages-desc');
        add('Last active', 'oldest', 'recent', 'recent');
    }
    return row;
}

function syncSortHeader(row, current) {
    for (const button of row.querySelectorAll('.chatFoldersSortButton')) syncSortButton(button, current);
}

function setSharedChatSort(value) {
    if (!CHAT_SORTS.includes(value)) return;
    settings().chatSort = value;
    saveSettingsDebounced();
    rowGestures.dispose();
    for (const [, api] of liveApis()) if (api.folder) api.applyChatSort(value);
}
const enhanced = new WeakSet();
const panelRuns = new WeakMap();
const panelRoots = new WeakMap();
const lorebookEditVersions = new Map();
const runLorebookWrite = createKeyedWriteQueue();
const startupPipeline = createStartupPipeline();
// One map per rendered list (welcome screen, Chat Top Bar sidebar), since both can be on screen at once.
/** @type {Map<HTMLElement, Map<string, {setOpen: Function, box: HTMLElement, folder: object}>>} */
const folderApis = new Map();
const rootApis = (root) => {
    let apis = folderApis.get(root);
    if (!apis) folderApis.set(root, apis = new Map());
    return apis;
};
/** [key, api] for every folder in a list still on the page. */
const liveApis = () => [...folderApis].flatMap(([root, apis]) => root.isConnected ? [...apis] : []);
const rowGestures = createRowGestureCoordinator();

// ---- expanded-state persistence (localStorage may be unavailable) ----
function loadExpanded() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
}
function saveExpanded(state) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

// ---- data ----
async function fetchChats() {
    // Same endpoint ST's welcome screen uses (public/scripts/welcome-screen.js getRecentChats), but without the
    // "max recent" cap. One request; the server streams each file once to count lines (no chat is loaded client-side).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const res = await fetch('/api/chats/recent', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ metadata: true }),
            cache: 'no-cache',
            signal: controller.signal,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('unexpected response');
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

const toMs = (ts) => { try { const m = timestampToMoment(ts); return m.isValid() ? m.valueOf() : NaN; } catch { return NaN; } };
const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const fmtLong = (ms) => ms ? new Date(ms).toLocaleString() : '';

// ---- opening (mirrors openRecentCharacterChat / openRecentGroupChat in welcome-screen.js, which are not exported) ----
async function openChat(folder, chatName) {
    try {
        if (folder.kind === 'group') {
            await openGroupById(folder.groupId);
            setActiveGroup(folder.groupId);
            saveSettingsDebounced();
            if (getCurrentChatId() === chatName) return;
            await openGroupChat(folder.groupId, chatName);
        } else {
            const id = characters.findIndex(x => x.avatar === folder.avatar);
            if (id === -1) throw new Error('character not found: ' + folder.avatar);
            await selectCharacterById(id);
            setActiveCharacter(folder.avatar);
            saveSettingsDebounced();
            if (getCurrentChatId() === chatName) return;
            await openCharacterChat(chatName);
        }
    } catch (e) {
        console.error(TAG, e);
        toastr.error('Failed to open chat. See console for details.', 'Chat Folders');
    }
}

// ---- rename / delete (mirror renameRecent*/deleteRecent* in welcome-screen.js, which are not exported) ----

async function listChatNames(avatar) {
    const res = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, simple: true }) });
    const list = res.ok ? await res.json() : [];
    return Array.isArray(list) ? list.map(x => x.file_id) : [];
}

let pendingBranchRename = null;

// Core reloads the chat BEFORE CHAT_RENAMED. Repair its copy receipt before
// Memory Books handles that reload, otherwise it copies the branch a second time.
async function preserveRenamedBranchCopy() {
    if (!settings().enabled || !mbEnabled()) return;
    const chatName = getCurrentChatId();
    const metadata = chat_metadata;
    const context = SillyTavern.getContext();
    const target = { avatarId: characters[this_chid]?.avatar, groupId: context.groupId, newFileName: chatName };
    const stillCurrent = () => chat_metadata === metadata && getCurrentChatId() === chatName &&
        (target.groupId ? String(SillyTavern.getContext().groupId) === String(target.groupId)
            : !SillyTavern.getContext().groupId && characters[this_chid]?.avatar === target.avatarId);
    const pending = pendingBranchRename;
    if (pending && chatName === pending.newName && (pending.folder.kind === 'group'
        ? String(context.groupId) === String(pending.folder.groupId)
        : !context.groupId && target.avatarId === pending.folder.avatar)) {
        if (remapBranchCopyIdentity(metadata, pending.oldName, pending.newName)) await saveMetadata();
    }
    const marker = metadata?.STMemoryBooks?.branchLorebookCopies;
    // Old rename records can survive across sessions. Repair before Memory Books'
    // CHAT_CHANGED listener sees them, even when this opening has no pending rename.
    if (!marker || marker.status !== 'completed' || metadata.world_info !== chatName ||
        (marker.branchChatId === chatName && marker.mappings?.some(m => m.copyName === chatName))) return;
    try {
        const rows = await fetchChats();
        if (!stillCurrent()) return;
        const protectedBooks = characters.map(c => c.data?.extensions?.world);
        protectedBooks.push(...(world_info?.charLore ?? []).flatMap(x => x.extraBooks ?? []));
        if (mbManual()) protectedBooks.push(...Object.values(mbSettings()?.characterMemoryBookLocks ?? {}).map(x => x?.lorebookName));
        protectedBooks.push(...(world_info?.globalSelect ?? []), power_user.persona_description_lorebook,
            ...Object.values(power_user.persona_descriptions ?? {}).map(x => x?.lorebook));
        if (repairRenamedBranchReceipt(metadata, rows, target, protectedBooks, { manualMode: mbManual() })) {
            await saveMetadata();
            console.info(TAG, 'Repaired renamed branch lorebook receipt');
        }
    } catch (error) {
        console.error(TAG, 'Could not repair renamed branch lorebook receipt', error);
    }
}

async function renameFolderChat(folder, oldName, newName, options) {
    pendingBranchRename = { folder, oldName, newName };
    try {
        await renameGroupOrCharacterChat(options);
        // Inactive character chats never emit CHAT_CHANGED for the renamed file.
        if (folder.kind === 'character') {
            const rows = await fetchChats();
            const renamed = rows.find(row => row.avatar === folder.avatar && chatStem(row.file_name) === newName);
            const marker = renamed?.chat_metadata?.STMemoryBooks?.branchLorebookCopies;
            if (marker?.version === 1 && marker.status === 'completed' && marker.branchChatId === oldName) {
                await patchChatMetadata(folder, newName, metadata => remapBranchCopyIdentity(metadata, oldName, newName));
            }
        }
    } finally {
        pendingBranchRename = null;
    }
}

async function renameChat(folder, chat) {
    try {
        const typed = await callGenericPopup('Enter the new name for the chat:', POPUP_TYPE.INPUT, chat.name);
        const newName = typeof typed === 'string' ? typed.trim() : '';
        if (!newName || newName === chat.name) return;
        if (newName.localeCompare(chat.name, undefined, { sensitivity: 'base' }) === 0) {
            // Core refuses these too: on case-insensitive disks it would be the same file.
            toastr.warning('Name not accepted, as it is the same as before (ignoring case and accents).', 'Chat Folders');
            return;
        }
        if (folder.kind === 'group') {
            await renameFolderChat(folder, chat.name, newName, { groupId: folder.groupId, oldFileName: chat.name, newFileName: newName, loader: false });
        } else {
            const id = characters.findIndex(x => x.avatar === folder.avatar);
            if (id === -1) throw new Error('character not found: ' + folder.avatar);
            const wasCurrent = characters[id].chat === chat.name;
            const before = await listChatNames(folder.avatar);
            await renameFolderChat(folder, chat.name, newName, { characterId: String(id), oldFileName: chat.name, newFileName: newName, loader: false });
            // The server may sanitize the name, and core reports its own errors, so look at what's on disk now.
            const after = await listChatNames(folder.avatar);
            const actual = after.find(n => !before.includes(n));
            if (!actual || after.includes(chat.name)) {
                await refreshLists();
                return;
            }
            // Core moves the "last chat" pointer only for the active character; keep it valid for the others.
            if (wasCurrent && String(id) !== String(this_chid)) await updateRemoteChatName(id, actual);
        }
        await refreshLists();
        toastr.success('Chat renamed.', 'Chat Folders');
    } catch (e) {
        console.error(TAG, e);
        toastr.error('Failed to rename chat. See console for details.', 'Chat Folders');
    }
}

async function deleteChat(folder, chat) {
    try {
        const box = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = 'Are you sure?';
        const what = document.createElement('p');
        what.append('Delete ', Object.assign(document.createElement('b'), { textContent: chat.name }),
            ` (${chat.count} messages) from ${folder.name}? This can't be undone.`);
        box.append(title, what);
        if (!await callGenericPopup(box, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' })) return;
        if (folder.kind === 'group') {
            await deleteGroupChatByName(folder.groupId, chat.name);
        } else {
            const id = characters.findIndex(x => x.avatar === folder.avatar);
            if (id === -1) throw new Error('character not found: ' + folder.avatar);
            await deleteCharacterChatByName(String(id), chat.name);
        }
        await refreshLists();
        toastr.success('Chat deleted.', 'Chat Folders');
    } catch (e) {
        console.error(TAG, e);
        toastr.error('Failed to delete chat. See console for details.', 'Chat Folders');
    }
}

// ---- lorebooks ----

/** Extra ("additional") character books from world_info.charLore; shown read-only next to the dropdown. */
function extraCharacterBooks(folder) {
    const fileName = String(folder.avatar).replace(/\.[^/.]+$/, '');
    const extra = world_info?.charLore?.find(e => e.name === fileName)?.extraBooks;
    return Array.isArray(extra) ? extra.filter(Boolean) : [];
}

const characterOf = (folder) => characters.find(x => x.avatar === folder.avatar);
const primaryBook = (folder) => characterOf(folder)?.data?.extensions?.world || NONE;
const folderBook = (folder) => folder.kind === 'character' ? primaryBook(folder) : NONE;

// Memory Books (third-party/SillyTavern-MemoryBooks): settings live in extension_settings.STMemoryBooks.
// Manual mode keeps the chat's book in chat_metadata.STMemoryBooks.manualLorebook, and a per-character
// lock in characterMemoryBookLocks[avatar].lorebookName.
const mbSettings = () => extension_settings.STMemoryBooks;
const mbEnabled = () => !!mbSettings()
    && !(extension_settings.disabledExtensions ?? []).includes('third-party/SillyTavern-MemoryBooks');
const mbManual = () => mbEnabled() && mbSettings()?.moduleSettings?.manualModeEnabled === true;
const mbLock = (avatar) => {
    const locks = mbSettings()?.characterMemoryBookLocks;
    return locks && Object.hasOwn(locks, avatar) ? locks[avatar] : null;
};

async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res;
}

/** Edit one character chat's header metadata. The open chat lives in browser memory, so edit it there. */
const lorebookEditKey = (folder, chatName = '') => `${folder.kind}:${folder.key}:${chatName}`;
const lorebookEditVersion = (folder, chatName = '') => lorebookEditVersions.get(lorebookEditKey(folder, chatName)) ?? 0;
function markLorebookEdited(folder, chatName = '') {
    const key = lorebookEditKey(folder, chatName);
    lorebookEditVersions.set(key, (lorebookEditVersions.get(key) ?? 0) + 1);
}
const isActiveCharacterChat = (folder, chatName) => {
    return matchesCharacterChat(folder.avatar, chatName, characters, this_chid, getCurrentChatId());
};

async function patchChatMetadata(folder, chatName, patch, { expectedVersion, shouldContinue = () => true, automatic = false } = {}) {
    const valid = () => shouldContinue() && (expectedVersion === undefined || lorebookEditVersion(folder, chatName) === expectedVersion);
    if (!valid()) return false;
    if (isActiveCharacterChat(folder, chatName)) {
        if (automatic && !canAutoLinkChat(chat_metadata)) return false;
        return updateActiveChatMetadata(chat_metadata, patch, saveMetadata);
    }
    const c = characterOf(folder);
    if (!c) throw new Error('character not found: ' + folder.avatar);
    const chat = await (await post('/api/chats/get', { ch_name: c.name, file_name: chatName, avatar_url: c.avatar })).json();
    if (!Array.isArray(chat) || !chat.length) throw new Error('empty chat: ' + chatName);
    if (!valid()) return false;
    const metadata = chat[0].chat_metadata ?? {};
    if (automatic && !canAutoLinkChat(metadata)) return false;
    // The chat may have become active while the read was in flight. Update its in-memory metadata
    // so the server snapshot cannot overwrite edits made after it became active.
    if (isActiveCharacterChat(folder, chatName)) {
        if (automatic && !canAutoLinkChat(chat_metadata)) return false;
        return updateActiveChatMetadata(chat_metadata, patch, saveMetadata);
    }
    chat[0].chat_metadata ??= {};
    patch(chat[0].chat_metadata);
    if (!valid()) return false;
    // No force flag: the header's integrity slug is unchanged, so ST's integrity check stays active.
    await post('/api/chats/save', { ch_name: c.name, file_name: chatName, avatar_url: c.avatar, chat });
    return true;
}

/** @param {{syncMemoryBook?: boolean}} opts syncMemoryBook: also point Memory Books' manual book here. */
async function setChatLorebook(folder, chat, name, { syncMemoryBook = true, expectedVersion, shouldContinue = () => true, automatic = false } = {}) {
    return runLorebookWrite(lorebookEditKey(folder, chat.name), async () => {
        if (!shouldContinue()) return false;
        const saved = await patchChatMetadata(folder, chat.name, (m) => {
            if (name) m.world_info = name; else delete m.world_info;
            // An explicit "None" sticks: Memory Books auto-linking won't undo it.
            if (name) { if (m.chatFolders) delete m.chatFolders.noLorebook; } else (m.chatFolders ??= {}).noLorebook = true;
            // Only follow a real choice; "None" leaves the Memory Book alone so memories keep their home.
            if (name && syncMemoryBook && mbManual()) {
                m.STMemoryBooks ??= {};
                m.STMemoryBooks.manualLorebook = name;
            }
        }, { expectedVersion, shouldContinue, automatic });
        if (!saved) return false;
        chat.lorebook = name;
        chat.noLorebook = !name;
        if (name && syncMemoryBook && mbManual()) chat.memoryBook = name;
        return true;
    });
}

async function setCharacterLorebook(folder, name, { syncMemoryBook = true, expectedVersion, shouldContinue = () => true } = {}) {
    return runLorebookWrite(lorebookEditKey(folder), async () => {
        if (!shouldContinue()) return false;
        const id = characters.findIndex(x => x.avatar === folder.avatar);
        if (id === -1) throw new Error('character not found: ' + folder.avatar);
        if (expectedVersion !== undefined && lorebookEditVersion(folder) !== expectedVersion) return false;
        if (!shouldContinue()) return false;
        await post('/api/characters/merge-attributes', { avatar: folder.avatar, data: { extensions: { world: name || '' } } });
        if (!shouldContinue() || (expectedVersion !== undefined && lorebookEditVersion(folder) !== expectedVersion)) return false;
        const c = characters[id];
        c.data ??= {}; c.data.extensions ??= {};
        c.data.extensions.world = name || '';
        if (String(this_chid) === String(id)) {
            $('#character_world').val(name || '');
            setWorldInfoButtonClass(undefined, !!name);
        }
        const noLink = (settings().noLorebook ??= {});
        if (name) delete noLink[folder.avatar]; else noLink[folder.avatar] = true;
        const lock = mbLock(folder.avatar);
        if (name && syncMemoryBook && mbManual() && lock && lock.lorebookName !== name) lock.lorebookName = name;
        saveSettingsDebounced();
        return true;
    });
}

async function createLorebook(suggested) {
    const name = await callGenericPopup('Name for the new lorebook:', POPUP_TYPE.INPUT, suggested);
    if (!name || typeof name !== 'string' || !name.trim()) return null;
    const ok = await createNewWorldInfo(name.trim(), { interactive: true });
    return ok ? name.trim() : null;
}

/** A lorebook dropdown: None, Create new…, every lorebook. Calls onPick(name) and re-renders on change. */
function lorebookSelect(current, title, suggested, onPick, editTarget) {
    const wrap = el('span', 'chatFoldersLore');
    if (editTarget) {
        wrap.dataset.lorebookFolder = editTarget.folder.key;
        if (editTarget.chat) wrap.dataset.lorebookChat = editTarget.chat.name;
    }
    const stop = (e) => e.stopPropagation();
    for (const t of ['click', 'mousedown', 'keydown', 'touchstart']) wrap.addEventListener(t, stop);
    wrap.append(Object.assign(el('i', 'fa-solid fa-book-atlas fa-xs'), { title }));
    const sel = el('select', 'text_pole chatFoldersLoreSelect');
    sel.title = title;
    const add = (value, label) => sel.append(Object.assign(el('option', '', label), { value }));
    for (const { value, label } of orderedLorebookOptions(current, world_names)) add(value, label);
    sel.value = current || NONE;
    const openBtn = actionButton('fa-arrow-up-right-from-square', 'Open lorebook', async () => {
        if (sel.value && sel.value !== CREATE) openWorldInfoEditor(sel.value);
    });
    openBtn.classList.toggle('chatFoldersHidden', !current); // keeps its slot so columns stay aligned
    sel.addEventListener('change', async () => {
        let pick = sel.value;
        try {
            if (pick === CREATE) {
                pick = await createLorebook(suggested);
                if (!pick) { sel.value = current || NONE; return; }
            }
            sel.disabled = true;
            if (editTarget) markLorebookEdited(editTarget.folder, editTarget.chat?.name ?? '');
            await onPick(pick);
            toastr.success(pick ? `Lorebook set to "${pick}".` : 'Lorebook removed.', 'Chat Folders');
        } catch (e) {
            console.error(TAG, e);
            toastr.error('Failed to change lorebook. See console for details.', 'Chat Folders');
        }
        await refreshLists();
    });
    wrap.append(sel, openBtn);
    return wrap;
}

/**
 * When Memory Books already has a book for a character (lock) or chat (manual book) but ST has no lorebook
 * linked there, link that book. Skips books that no longer exist and the open chat's in-memory edit races.
 * @returns {Promise<number>} how many links were made
 */
/**
 * What Memory Books auto-linking would change: characters with a Memory Books lock but no lorebook, and chats with
 * a manual-mode Memory Book but no lorebook. Both only exist in Memory Books' manual mode; otherwise Memory Books
 * writes into the chat's own lorebook and there is nothing to link.
 */
function linkCandidates(folders) {
    const exists = (n) => !!n && (world_names ?? []).includes(n);
    const found = [];
    for (const folder of folders) {
        if (folder.kind !== 'character') continue;
        const lockBook = mbLock(folder.avatar)?.lorebookName;
        if (!primaryBook(folder) && exists(lockBook) && !settings().noLorebook?.[folder.avatar]) found.push({ folder, book: lockBook });
        const walk = (list) => list.forEach((chat) => {
            if (!chat.lorebook && !chat.noLorebook && exists(chat.memoryBook)) found.push({ folder, chat, book: chat.memoryBook });
            walk(chat.children);
        });
        walk(folder.chats);
    }
    return found;
}

let askingMemoryBooks = null;
/** Linking writes into chat files, so it's opt-in. Asked once, the first time there is something to link. */
function askMemoryBooks() {
    askingMemoryBooks ??= (async () => {
        const yes = await callGenericPopup(
            '<h3>Chat Folders + Memory Books</h3><p>Some chats have a Memory Book from manual lorebook mode but no lorebook. Should Chat Folders link those books as their lorebooks?</p><p><small>This saves the lorebook into those chats. It only happens while Memory Books\' manual mode is on. You can change it later in the extension settings.</small></p>',
            POPUP_TYPE.CONFIRM, '', { okButton: 'Link them', cancelButton: 'No thanks' });
        settings().linkMemoryBooks = !!yes;
        saveSettingsDebounced();
        const box = document.getElementById('chatfolders_linkmb');
        if (box) box.checked = settings().linkMemoryBooks;
    })().finally(() => { askingMemoryBooks = null; });
    return askingMemoryBooks;
}

async function autoLinkMemoryBooks(folders, shouldContinue = () => true) {
    // Follows Memory Books' manual mode live: switching it off pauses linking without touching the user's answer.
    if (!mbManual()) return 0;
    const candidates = linkCandidates(folders);
    if (!candidates.length) return 0;
    if (settings().linkMemoryBooks === undefined) await askMemoryBooks();
    if (!settings().linkMemoryBooks) return 0;
    let linked = 0;
    for (const { folder, chat, book } of candidates) {
        if (!shouldContinue()) break;
        try {
            const done = chat
                ? await setChatLorebook(folder, chat, book, { syncMemoryBook: false, expectedVersion: lorebookEditVersion(folder, chat.name), shouldContinue, automatic: true })
                : await setCharacterLorebook(folder, book, { syncMemoryBook: false, expectedVersion: lorebookEditVersion(folder), shouldContinue });
            if (done) { linked++; console.log(TAG, 'linked', chat ? 'chat' : 'character', chat?.name ?? folder.name, '->', book); }
        } catch (e) { console.warn(TAG, 'auto-link failed for', chat?.name ?? folder.name, e); }
    }
    if (linked) toastr.info(`Linked ${linked} Memory Book${linked === 1 ? '' : 's'} as lorebook${linked === 1 ? '' : 's'}.`, 'Chat Folders');
    return linked;
}

// ---- pinned chats ----
// SillyTavern's own store (welcome-screen.js PinnedChatsManager): accountStorage 'pinnedChats', a JSON object of
// { key: { group, avatar, file_name } } kept in settings.json. Same key format, so stock pins and ours are the same pins.
const PIN_STORE = 'pinnedChats';
const PIN_FOLDER_KEY = 'p:pinned';
let pinnedNow = new Set();
// The pins as last read or written here. Stock's rename handler saves from a copy it loaded at startup.
let knownPins = null;
/** Each rendered list and the folders it shows, so pins can be refreshed in place. @type {Map<HTMLElement, object[]>} */
const pinHosts = new Map();

function readPins() {
    try {
        const state = JSON.parse(accountStorage.getItem(PIN_STORE) || '{}');
        return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    } catch { return {}; }
}
const pinKeyOf = ({ group, avatar, file_name }) => `${group ? 'group_' + group : ''}${avatar ? 'char_' + avatar : ''}_${file_name}`;
const pinOf = (folder, chat) => ({
    group: folder.kind === 'group' ? folder.groupId : '',
    avatar: folder.kind === 'character' ? folder.avatar : '',
    file_name: `${chat.name}.jsonl`,
});
const pinnedKeys = () => {
    knownPins = readPins();
    return new Set(Object.values(knownPins).filter(p => p && typeof p === 'object').map(pinKeyOf));
};

function togglePin(folder, chat) {
    const pin = pinOf(folder, chat);
    const key = pinKeyOf(pin);
    const state = { ...readPins() };
    if (key in state) delete state[key]; else state[key] = pin;
    accountStorage.setItem(PIN_STORE, JSON.stringify(state));
    syncPins();
}

/**
 * Any chat rename makes stock re-save pins from its startup copy, which drops pins made here since (and brings
 * back ones removed). Runs after stock's handler: put back the pins as we last saw them, with the rename applied.
 */
function onChatRenamed({ avatarId, groupId, oldFileName, newFileName } = {}) {
    if (!settings().enabled || !knownPins) return; // never read them this session: nothing to restore
    const state = { ...knownPins };
    const oldPin = { group: groupId ?? '', avatar: avatarId ?? '', file_name: oldFileName };
    const oldKey = pinKeyOf(oldPin);
    if (oldKey in state) {
        const newPin = { ...state[oldKey], file_name: newFileName };
        delete state[oldKey];
        state[pinKeyOf(newPin)] = newPin;
    }
    accountStorage.setItem(PIN_STORE, JSON.stringify(state));
    knownPins = state;
    syncPins();
}

// Listen to core so renames from the chat menu also follow this preference.
async function renameLinkedMemoryBook(target) {
    if (!settings().enabled || !settings().renameMemoryBook || !mbEnabled()) return;
    try {
        const rows = await fetchChats();
        const characterBooks = characters.map(c => c.data?.extensions?.world);
        characterBooks.push(...(world_info?.charLore ?? []).flatMap(x => x.extraBooks ?? []));
        if (mbManual()) characterBooks.push(...Object.values(mbSettings()?.characterMemoryBookLocks ?? {}).map(x => x?.lorebookName));
        characterBooks.push(...(world_info?.globalSelect ?? []), power_user.persona_description_lorebook,
            ...Object.values(power_user.persona_descriptions ?? {}).map(x => x?.lorebook));
        const oldBook = exclusiveChatBook(rows, target, characterBooks, { manualMode: mbManual() });
        const newBook = chatStem(target.newFileName);
        if (!oldBook || oldBook === newBook) return;
        await updateWorldInfoList();
        if (!world_names.includes(oldBook)) throw new Error('Linked lorebook no longer exists');
        // Never overwrite another book, including on case-insensitive filesystems.
        if (!newBook || /[<>:"/\\|?*\x00-\x1f]/.test(newBook) ||
            world_names.some(n => n.localeCompare(newBook, undefined, { sensitivity: 'base' }) === 0)) {
            toastr.warning('Chat renamed. Its lorebook was kept because the new book name is unavailable.', 'Chat Folders');
            return;
        }
        const data = await (await post('/api/worldinfo/get', { name: oldBook })).json();
        if (!data?.entries) throw new Error('Could not read linked lorebook');
        // Confirm the write and relink before removing the original.
        await post('/api/worldinfo/edit', { name: newBook, data });
        const patch = m => {
            if (m.world_info !== oldBook) throw new Error('Chat lorebook changed during rename');
            m.world_info = newBook;
            remapBranchCopyIdentity(m, chatStem(target.oldFileName), newBook);
            remapBranchCopyBook(m, oldBook, newBook);
            if (m.STMemoryBooks?.manualLorebook === oldBook) m.STMemoryBooks.manualLorebook = newBook;
        };
        if (target.groupId) {
            const context = SillyTavern.getContext();
            if (String(context.groupId) === String(target.groupId) && getCurrentChatId() === newBook) {
                await updateActiveChatMetadata(chat_metadata, patch, saveMetadata);
            } else {
                const chat = await (await post('/api/chats/group/get', { id: newBook })).json();
                if (!chat?.[0]?.chat_metadata) throw new Error('Missing group chat metadata');
                patch(chat[0].chat_metadata);
                await post('/api/chats/group/save', { id: newBook, chat });
            }
        } else {
            await patchChatMetadata({ kind: 'character', key: 'c:' + target.avatarId, avatar: target.avatarId }, newBook, patch);
        }
        await updateWorldInfoList();
        if (!await deleteWorldInfo(oldBook)) throw new Error('New book linked; original book could not be removed');
    } catch (error) {
        console.error(TAG, 'Linked lorebook rename failed', error);
        toastr.warning('Chat renamed, but its lorebook rename could not finish. Check the chat link and both book names before retrying. See console for details.', 'Chat Folders');
    }
}

function setPinMark(row, on) {
    row.classList.toggle('isPinned', on);
    const button = row.querySelector('.chatFoldersPinAction');
    if (!button) return;
    button.classList.toggle('chatFoldersPinOn', on);
    button.title = on ? 'Unpin chat' : 'Pin chat';
    button.setAttribute('aria-pressed', String(on));
}

/** Refresh every pin mark and rebuild the Pinned folder from the store. */
function syncPins() {
    for (const root of pinHosts.keys()) if (!root.isConnected) pinHosts.delete(root);
    if (!pinHosts.size) return;
    pinnedNow = pinnedKeys();
    for (const [root, folders] of pinHosts) {
        for (const row of root.querySelectorAll('.chatFoldersChat[data-pin-key]')) setPinMark(row, pinnedNow.has(row.dataset.pinKey));
        renderPinned(root, folders);
    }
}

function renderPinned(root, folders, expanded = loadExpanded()) {
    rootApis(root).delete(PIN_FOLDER_KEY);
    root.querySelector(':scope > .chatFoldersPinned')?.remove();
    const entries = [];
    if (pinnedNow.size && settings().showPinned) {
        for (const folder of folders) {
            const walk = (list) => list.forEach((chat) => {
                if (pinnedNow.has(pinKeyOf(pinOf(folder, chat)))) entries.push({ folder, chat });
                walk(chat.children);
            });
            walk(folder.chats);
        }
    }
    if (entries.length) root.querySelector(':scope > .chatFoldersSortRow-folders')?.after(renderPinnedFolder(entries, expanded, rootApis(root)));
    updateFloat();
}

// ---- rendering ----
function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

// A spool of thread (Font Awesome has none); inherits the text colour.
const SPOOL_SVG = '<svg class="chatFoldersSpool" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="1" width="12" height="2.2" rx="1" fill="currentColor"/><rect x="2" y="12.8" width="12" height="2.2" rx="1" fill="currentColor"/><rect x="4" y="3.2" width="8" height="9.6" fill="currentColor" opacity="0.55"/><path d="M4 5.2h8M4 7.4h8M4 9.6h8" stroke="currentColor" stroke-width="1"/></svg>';

function stat(iconHtml, value, title) {
    const s = el('span', 'chatFoldersCount');
    s.title = title;
    s.insertAdjacentHTML('beforeend', iconHtml);
    s.append(' ', String(value));
    return s;
}

function actionButton(icon, title, fn) {
    const b = el('i', `fa-solid ${icon} fa-fw chatFoldersAction`);
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    b.title = title;
    const go = (e) => { e.stopPropagation(); e.preventDefault(); void fn(); };
    b.addEventListener('click', go);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    return b;
}

function branchKey(folder, chat) {
    return `b:${folder.key}\u0000${chat.name}`;
}

function folderHasBranches(folder) {
    const walk = (list) => list.some(c => c.children.length > 0 || walk(c.children));
    return walk(folder.chats);
}

function branchNodes(box) {
    return [...box.querySelectorAll('.chatFoldersBranchNode')].filter(node => node.querySelector(':scope > .chatFoldersBranchBody'));
}

function syncBranchCaret(node) {
    const caret = node.querySelector(':scope > .chatFoldersChat .chatFoldersBranchCaret');
    if (!caret) return;
    const open = node.classList.contains('open');
    const count = node.dataset.count || '';
    caret.title = open ? `Hide branches (${count})` : `Show branches (${count})`;
    const row = node.querySelector(':scope > .chatFoldersChat');
    if (row) {
        syncBranchAriaExpanded(row, caret, open);
        row.title = `${row.dataset.chatName || ''}\n${row.dataset.chatDate || ''}\nClick the name or double-click to open chat; click elsewhere to ${open ? 'collapse' : 'expand'} branches. Press Space to toggle; Enter to open.`;
    }
}

function persistBranch(folder, chat, open) {
    const st = loadExpanded();
    const key = branchKey(folder, chat);
    if (open) st[key] = 1; else delete st[key];
    saveExpanded(st);
}

function setBranchOpen(folder, chat, node, open) {
    node.classList.toggle('open', open);
    syncBranchCaret(node);
    persistBranch(folder, chat, open);
    const folderBox = node.closest('.chatFoldersFolder');
    const allButton = folderBox?.querySelector(':scope > .chatFoldersBody .chatFoldersAll');
    if (folderBox && allButton) updateAllButton(folderBox, allButton, folder);
    updateFloat();
}

/** Open or close every nested branch in one character folder. The folder itself stays as it is. */
function setAllBranches(box, folder, open) {
    const st = loadExpanded();
    const walk = (list) => {
        for (const chat of list) {
            if (chat.children.length) {
                const key = branchKey(folder, chat);
                if (open) st[key] = 1; else delete st[key];
            }
            walk(chat.children);
        }
    };
    walk(folder.chats);
    saveExpanded(st);
    for (const node of branchNodes(box)) {
        node.classList.toggle('open', open);
        syncBranchCaret(node);
    }
}

function contentsFullyOpen(box, folder) {
    if (!box.classList.contains('open')) return false;
    if (!folderHasBranches(folder)) return true;
    const nodes = branchNodes(box);
    if (!nodes.length) return false;
    return nodes.every(node => node.classList.contains('open'));
}

function updateAllButton(box, button, folder) {
    const open = contentsFullyOpen(box, folder);
    const icon = button.querySelector('i') ?? button;
    icon.classList.toggle('fa-angles-up', open);
    icon.classList.toggle('fa-angles-down', !open);
    const has = folderHasBranches(folder);
    button.title = has
        ? (open ? 'Collapse all branches' : 'Expand all branches')
        : (box.classList.contains('open') ? 'Collapse folder' : 'Expand folder');
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-expanded', String(open));
}

function renderChat(folder, chat, depth, flat = false) {
    const kids = flat ? [] : chat.children; // the Pinned folder lists chats flat, without their branches
    const row = el('div', 'chatFoldersChat');
    row.style.setProperty('--cf-depth', String(depth));
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.dataset.chatName = chat.name;
    row.dataset.chatDate = fmtLong(chat.ms);
    row.dataset.pinKey = pinKeyOf(pinOf(folder, chat));
    if (kids.length) row.setAttribute('aria-expanded', 'false');
    row.title = kids.length
        ? `${chat.name}\n${fmtLong(chat.ms)}\nClick the name or double-click to open chat; click elsewhere to expand branches. Press Space to toggle; Enter to open.`
        : `${chat.name}\n${fmtLong(chat.ms)}\nClick or press Enter to open chat.`;
    const name = el('div', 'chatFoldersChatName');
    name.append(Object.assign(el('i', 'fa-solid fa-thumbtack fa-xs chatFoldersPinMark'), { title: 'Pinned chat' }));
    if (kids.length) {
        const caret = el('i', 'fa-solid fa-chevron-right fa-fw chatFoldersBranchCaret');
        caret.tabIndex = 0;
        caret.setAttribute('role', 'button');
        name.append(caret);
    } else if (!flat) {
        const spacer = el('span', 'chatFoldersBranchSpacer');
        spacer.setAttribute('aria-hidden', 'true');
        name.append(spacer);
    }
    if (depth > 0) name.append(Object.assign(el('i', 'fa-solid fa-code-branch fa-xs'), { title: 'Branch / checkpoint' }), ' ');
    if (flat) name.append(pinnedAvatar(folder), el('strong', 'chatFoldersPinnedChar', folder.name), ' \u2013 ');
    // The name always opens the chat, so a chat with branches doesn't need a double-click.
    const link = el('a', 'chatFoldersChatLink', chat.name);
    link.title = `Open ${chat.name}`;
    link.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        rowGestures.cancel(row);
        if (event.detail <= 1) go();
    });
    name.append(link);
    const lore = folder.kind === 'character'
        ? lorebookSelect(chat.lorebook, 'Chat lorebook', chat.name, (n) => setChatLorebook(folder, chat, n), { folder, chat })
        : el('span');
    const meta = el('div', 'chatFoldersMeta');
    meta.append(stat('<i class="fa-solid fa-comment fa-xs"></i>', chat.count, 'Messages'), el('small', 'chatFoldersDate', fmtDate(chat.ms)));
    const actions = el('div', 'chatFoldersActions');
    const pinButton = actionButton('fa-thumbtack', 'Pin chat', () => togglePin(folder, chat));
    pinButton.classList.add('chatFoldersPinAction');
    actions.append(
        pinButton,
        actionButton('fa-pen', 'Rename chat', () => renameChat(folder, chat)),
        actionButton('fa-trash-can', 'Delete chat', () => deleteChat(folder, chat)),
    );
    row.append(name, lore, el('span', 'chatFoldersSpacer'), meta, actions); // spacer sits under the header's thread count
    setPinMark(row, pinnedNow.has(row.dataset.pinKey));
    const current = currentChatRef();
    row.classList.toggle(CURRENT_CHAT, current?.key === folder.key && current.name === chat.name);
    const go = () => openChat(folder, chat.name);
    const isProtectedTarget = (target) => target instanceof Element && !!target.closest(
        '.chatFoldersBranchCaret, .chatFoldersActions, .chatFoldersLore, button, select, input, textarea, a',
    );
    row.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('.chatFoldersBranchCaret')) return;
        if (isProtectedTarget(event.target)) return;
        if (!kids.length) { if (event.detail <= 1) go(); return; }
        event.preventDefault();
        const node = row.parentElement;
        rowGestures.handle(row, event.detail, {
            read: () => node.classList.contains('open'),
            toggle: () => setBranchOpen(folder, chat, node, !node.classList.contains('open')),
            restore: (open) => setBranchOpen(folder, chat, node, open),
            open: go,
        });
    });
    row.addEventListener('keydown', (event) => {
        if (event.target !== row || isProtectedTarget(event.target)) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            rowGestures.cancel(row);
            go();
        } else if (event.key === ' ') {
            event.preventDefault();
            rowGestures.cancel(row);
            if (kids.length) {
                const node = row.parentElement;
                setBranchOpen(folder, chat, node, !node.classList.contains('open'));
            } else go();
        }
    });
    return row;
}

function renderTree(folder, chats, depth, into, expanded = loadExpanded(), sortMode = 'recent') {
    for (const chat of sortChatSiblings(chats, sortMode)) {
        const node = el('div', 'chatFoldersBranchNode');
        node.dataset.chat = chat.name;
        node.dataset.count = String(chat.children.length);
        const row = renderChat(folder, chat, depth);
        node.append(row);
        if (chat.children.length) {
            const body = el('div', 'chatFoldersBranchBody');
            renderTree(folder, chat.children, depth + 1, body, expanded, sortMode);
            node.append(body);
            if (expanded[branchKey(folder, chat)]) node.classList.add('open');
            const caret = row.querySelector('.chatFoldersBranchCaret');
            const toggle = (event) => {
                rowGestures.cancel(row);
                event.stopPropagation();
                event.preventDefault();
                setBranchOpen(folder, chat, node, !node.classList.contains('open'));
            };
            caret.addEventListener('click', toggle);
            caret.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') toggle(event);
            });
            syncBranchCaret(node);
        }
        into.append(node);
    }
}

function folderAvatar(folder) {
    const wrap = el('div', 'avatar');
    try {
        if (folder.kind === 'group') {
            const g = groups.find(x => String(x.id) === folder.groupId);
            const a = g && getGroupAvatar(g);
            if (a && a[0]) return a[0];
        } else {
            const img = document.createElement('img');
            img.src = getThumbnailUrl('avatar', folder.avatar);
            img.alt = folder.name;
            wrap.append(img);
            return wrap;
        }
    } catch { /* fall through */ }
    const img = document.createElement('img');
    img.src = system_avatar; img.alt = folder.name;
    wrap.append(img);
    return wrap;
}

function renderFolder(folder, expandedState, apis) {
    const box = el('div', 'chatFoldersFolder');
    box.classList.toggle(CURRENT_FOLDER, currentChatRef()?.key === folder.key);
    const head = el('div', 'chatFoldersHeader');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    const caret = el('i', 'fa-solid fa-chevron-right fa-fw chatFoldersCaret');
    const allButton = el('button', 'chatFoldersAll');
    allButton.type = 'button';
    allButton.append(el('i', 'fa-solid fa-angles-down fa-fw'));
    allButton.tabIndex = 0;
    const carets = el('span', 'chatFoldersCarets');
    carets.append(caret);
    const info = el('div', 'chatFoldersInfo');
    info.append(el('strong', 'chatFoldersName', folder.name));
    if (folder.kind === 'group') info.append(el('small', 'chatFoldersTag', 'group'));
    if (folder.kind === 'character') for (const t of characterLoreTags(folder)) info.append(t);
    const lore = folder.kind === 'character'
        ? lorebookSelect(primaryBook(folder), 'Character lorebook (every chat with this character)', folder.name, (n) => setCharacterLorebook(folder, n), { folder })
        : el('span');
    const meta = el('div', 'chatFoldersMeta');
    const date = el('small', 'chatFoldersDate', fmtDate(folder.lastMs));
    date.title = fmtLong(folder.lastMs);
    meta.append(
        stat(SPOOL_SVG, folder.count, 'Threads (chats)'),
        stat('<i class="fa-solid fa-comment fa-xs"></i>', folder.messages, 'Total messages'),
        date,
    );
    const folderPin = actionButton('fa-thumbtack', settings().pinnedFolders?.includes(folder.key) ? 'Unpin folder' : 'Pin folder', () => {
        const pins = new Set(settings().pinnedFolders || []);
        if (pins.has(folder.key)) pins.delete(folder.key); else pins.add(folder.key);
        settings().pinnedFolders = [...pins];
        saveSettingsDebounced();
        for (const [host, items] of pinHosts) renderInto(host, items);
    });
    const folderPinned = !!settings().pinnedFolders?.includes(folder.key);
    folderPin.classList.add('chatFoldersPinAction');
    folderPin.classList.toggle('isPinned', folderPinned);
    folderPin.classList.toggle('chatFoldersPinOn', folderPinned);
    folderPin.setAttribute('aria-pressed', String(folderPinned));
    head.append(carets, folderAvatar(folder), info, lore, meta, folderPin);
    const onAll = (event) => {
        event.stopPropagation();
        event.preventDefault();
        if (contentsFullyOpen(box, folder)) {
            if (folderHasBranches(folder)) setAllBranches(box, folder, false);
            else setOpen(false, true);
        } else {
            setOpen(true, true);
            if (folderHasBranches(folder)) setAllBranches(box, folder, true);
        }
        updateAllButton(box, allButton, folder);
        updateFloat();
    };
    allButton.addEventListener('click', onAll);
    allButton.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === ' ') onAll(event);
    });

    const body = el('div', 'chatFoldersBody');
    const tree = el('div', 'chatFoldersTree');
    let sortMode = settings().chatSort;
    const sortHead = sortHeaderRow('chats', sortMode, setSharedChatSort);
    const branchHeading = el('div', 'chatFoldersBranchHeading');
    const branchSort = sortHead.firstElementChild;
    branchSort.replaceWith(branchHeading);
    if (folderHasBranches(folder)) branchHeading.append(allButton);
    branchHeading.append(branchSort);
    sortHead.append(el('span', 'chatFoldersSortSpacer'));
    body.append(sortHead, tree);
    let filled = false;
    const applyChatSort = (value) => {
        sortMode = CHAT_SORTS.includes(value) ? value : 'recent';
        syncSortHeader(sortHead, sortMode);
        if (!filled) return;
        tree.replaceChildren();
        renderTree(folder, sortChatSiblings(folder.chats, sortMode), 0, tree, undefined, sortMode);
        updateAllButton(box, allButton, folder);
        updateFloat();
    };
    const setOpen = (open, persist) => {
        box.classList.toggle('open', open);
        head.setAttribute('aria-expanded', String(open));
        if (open && !filled) {
            renderTree(folder, sortChatSiblings(folder.chats, sortMode), 0, tree, undefined, sortMode);
            filled = true;
        }
        if (persist) {
            const st = loadExpanded();
            if (open) st[folder.key] = 1; else delete st[folder.key];
            saveExpanded(st);
        }
        updateAllButton(box, allButton, folder);
        updateFloat();
    };
    const toggle = () => setOpen(!box.classList.contains('open'), true);
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    box.append(head, body);
    setOpen(!!expandedState[folder.key], false);
    updateAllButton(box, allButton, folder);
    apis.set(folder.key, { setOpen, applyChatSort, box, folder });
    return box;
}

function pinnedAvatar(folder) {
    if (folder.kind === 'group') return Object.assign(el('i', 'fa-solid fa-user-group fa-xs chatFoldersPinnedAvatar'), { title: folder.name });
    const img = el('img', 'chatFoldersPinnedAvatar');
    img.src = getThumbnailUrl('avatar', folder.avatar);
    img.alt = folder.name;
    return img;
}

/** The Pinned folder: every pinned chat from every character, flat, ordered by its independent sort. */
function renderPinnedFolder(entries, expandedState, apis) {
    const owner = new Map(entries.map(({ folder, chat }) => [chat, folder]));
    const chats = entries.map(({ chat }) => chat);
    const box = el('div', 'chatFoldersFolder chatFoldersPinned');
    const current = currentChatRef();
    box.classList.toggle(CURRENT_FOLDER, entries.some(({ folder, chat }) => folder.key === current?.key && chat.name === current.name));
    const head = el('div', 'chatFoldersHeader');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    const carets = el('span', 'chatFoldersCarets');
    carets.append(el('i', 'fa-solid fa-chevron-right fa-fw chatFoldersCaret'));
    const icon = el('div', 'chatFoldersPinnedIcon');
    icon.append(el('i', 'fa-solid fa-thumbtack fa-fw'));
    const info = el('div', 'chatFoldersInfo');
    info.append(el('strong', 'chatFoldersName', 'Pinned conversations'));
    const lastMs = chats.reduce((m, c) => Math.max(m, c.ms), 0);
    const date = el('small', 'chatFoldersDate', fmtDate(lastMs));
    date.title = fmtLong(lastMs);
    const meta = el('div', 'chatFoldersMeta');
    meta.append(
        stat(SPOOL_SVG, chats.length, 'Pinned chats'),
        stat('<i class="fa-solid fa-comment fa-xs"></i>', chats.reduce((n, c) => n + c.count, 0), 'Total messages'),
        date,
    );
    head.append(carets, icon, info, el('span'), meta, el('span', 'chatFoldersSpacer'));

    const body = el('div', 'chatFoldersBody');
    const tree = el('div', 'chatFoldersTree');
    let sortMode = settings().pinnedSort || 'name-asc';
    const sortHead = sortHeaderRow('pinned', sortMode, (value) => {
        settings().pinnedSort = value;
        saveSettingsDebounced();
        for (const [key, api] of liveApis()) {
            if (!api.folder) api.applyChatSort(value);
        }
    });
    body.append(sortHead, tree);
    let filled = false;
    const fill = () => {
        tree.replaceChildren();
        const sorted = sortMode.startsWith('name-')
            ? [...chats].sort((a, b) => (sortMode === 'name-desc' ? -1 : 1) * owner.get(a).name.localeCompare(owner.get(b).name) || a.name.localeCompare(b.name))
            : sortChatSiblings(chats, sortMode);
        for (const chat of sorted) {
            const node = el('div', 'chatFoldersBranchNode');
            node.dataset.chat = chat.name;
            node.append(renderChat(owner.get(chat), chat, 0, true));
            tree.append(node);
        }
        filled = true;
    };
    const applyChatSort = (value) => {
        sortMode = CHAT_SORTS.includes(value) ? value : 'recent';
        syncSortHeader(sortHead, sortMode);
        if (filled) fill();
    };
    const setOpen = (open, persist) => {
        box.classList.toggle('open', open);
        head.setAttribute('aria-expanded', String(open));
        if (open && !filled) fill();
        if (persist) {
            const st = loadExpanded();
            if (open) st[PIN_FOLDER_KEY] = 1; else delete st[PIN_FOLDER_KEY];
            saveExpanded(st);
        }
        updateFloat();
    };
    const toggle = () => setOpen(!box.classList.contains('open'), true);
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    box.append(head, body);
    setOpen(!!expandedState[PIN_FOLDER_KEY], false);
    apis.set(PIN_FOLDER_KEY, { setOpen, applyChatSort, box, folder: null });
    return box;
}

/** Small tags next to the character name: additional character books and a Memory Books lock. */
function characterLoreTags(folder) {
    const tags = [];
    for (const b of extraCharacterBooks(folder)) {
        const tag = el('small', 'chatFoldersTag', '+ ' + b);
        tag.title = 'Additional character lorebook (change it in the character\'s World Info menu)';
        tags.push(tag);
    }
    const lock = mbLock(folder.avatar);
    if (lock?.lorebookName && mbEnabled()) {
        const tag = el('small', 'chatFoldersTag');
        tag.append(el('i', 'fa-solid fa-lock fa-xs'), ' ' + lock.lorebookName);
        tag.title = 'Memory Books character lock: ' + lock.lorebookName;
        tags.push(tag);
    }
    return tags;
}

function orderedFolders(folders, mode) {
    const pins = new Set(settings().pinnedFolders || []);
    return sortFolders(folders, mode, folderBook).sort((a, b) => Number(pins.has(b.key)) - Number(pins.has(a.key)));
}

function renderInto(root, folders) {
    rowGestures.dispose();
    for (const old of folderApis.keys()) if (!old.isConnected) folderApis.delete(old);
    const apis = new Map();
    folderApis.set(root, apis);
    root.replaceChildren();
    const st = loadExpanded();
    if (st.__expandAll) {
        for (const folder of folders) st[folder.key] = 1;
        st[PIN_FOLDER_KEY] = 1;
        delete st.__expandAll;
        saveExpanded(st);
    }
    const folderSortHead = sortHeaderRow('folders', settings().folderSort, (value) => {
        const s = settings();
        s.folderSort = FOLDER_SORTS.includes(value) ? value : 'recent';
        saveSettingsDebounced();
        syncSortHeader(folderSortHead, s.folderSort);
        for (const folder of orderedFolders(folders, s.folderSort)) {
            const api = apis.get(folder.key);
            if (api) root.append(api.box);
        }
    });
    root.append(folderSortHead);
    pinHosts.set(root, folders);
    pinnedNow = pinnedKeys();
    if (!folders.length) { root.append(el('div', 'chatFoldersEmpty', 'No chats')); applyFloatPosition(); return; }
    const expanded = loadExpanded();
    for (const folder of orderedFolders(folders, settings().folderSort)) root.append(renderFolder(folder, expanded, apis));
    renderPinned(root, folders, expanded);
    applyFloatPosition();
}

function refreshLorebookSelects(root, folders) {
    const wrappers = new Map([...root.querySelectorAll('.chatFoldersLore')].map((item) =>
        [JSON.stringify([item.dataset.lorebookFolder, item.dataset.lorebookChat ?? '']), item]));
    for (const folder of folders) {
        const rows = [];
        const walk = (chats) => chats.forEach((chat) => { rows.push(chat); walk(chat.children); });
        walk(folder.chats);
        const updates = [{ chatName: '', value: primaryBook(folder) }, ...rows.map((chat) => ({ chatName: chat.name, value: chat.lorebook }))];
        for (const update of updates) {
            const wrap = wrappers.get(JSON.stringify([folder.key, update.chatName]));
            const select = wrap?.querySelector('select');
            if (!select || select === document.activeElement || select.disabled) continue;
            select.value = update.value || NONE;
            wrap.querySelector('.chatFoldersAction')?.classList.toggle('chatFoldersHidden', !update.value);
        }
    }
}

// ---- welcome screen hook ----
function enhance(panel) {
    if (!settings().enabled || enhanced.has(panel)) return;
    const list = panel.querySelector('.welcomeRecent .recentChatList');
    if (!list) return;
    enhanced.add(panel);
    const run = {};
    panelRuns.set(panel, run);
    let root;
    const current = () => panel.isConnected && settings().enabled && panelRuns.get(panel) === run && !!root?.isConnected;
    return startupPipeline.start(panel, {
        showLoading: () => {
            if (!panel.isConnected || !settings().enabled || panelRuns.get(panel) !== run) throw new Error('welcome panel startup was cancelled');
            root = el('div', `${ROOT_CLASS} chatFoldersLoading`);
            root.setAttribute('role', 'status');
            root.setAttribute('aria-live', 'polite');
            root.append(el('div', 'chatFoldersLoadingMessage', 'Loading chats…'));
            list.after(root);
            panelRoots.set(panel, root);
            panel.classList.add(ENHANCED);
        },
        fetch: fetchChats,
        build: (rows) => buildFolders(rows, { characters, groups, toMs }),
        isCurrent: current,
        render: (folders) => {
            root.classList.remove('chatFoldersLoading');
            root.removeAttribute('role');
            root.removeAttribute('aria-live');
            renderInto(root, folders);
        },
        link: (folders) => autoLinkMemoryBooks(folders, current),
        onLinked: (linked, folders) => {
            if (linked) refreshLorebookSelects(root, folders);
        },
        onLinkError: (error) => console.warn(TAG, 'Memory Books auto-link failed', error),
        onStale: () => {
            if (panel.isConnected && settings().enabled && panelRuns.get(panel) === run) {
                root?.remove();
                panel.classList.remove(ENHANCED);
                enhanced.delete(panel);
                panelRoots.delete(panel);
                queueMicrotask(scan);
            }
        },
        onError: (error) => {
            console.warn(TAG, 'falling back to the original recent chats list', error);
            if (panelRuns.get(panel) === run) {
                root?.remove();
                panel.classList.remove(ENHANCED);
                enhanced.delete(panel);
                panelRoots.delete(panel);
            }
        },
    });
}

// ---- Chat Top Bar sidebar hook ----
// third-party/Extension-TopInfoBar adds #extensionSideBar (current character's chats only) and toggles its
// "visible" class. While it's open, our folders take the place of its list; its own list stays underneath, hidden.
const SIDEBAR_ID = 'extensionSideBar';
const SIDEBAR_ON = 'chatfolders-sidebar-on';
const CURRENT_CHAT = 'chatFoldersCurrent';
const CURRENT_FOLDER = 'chatFoldersCurrentFolder';
let sidebarRoot = null;
let sidebarRun = 0;
let sidebarHooked = null;
let sidebarRevealed = null;
let sidebarTimer = 0;

const sidebarWanted = (bar) => !!bar?.classList.contains('visible') && settings().enabled && settings().sidebar;

function hookSidebar() {
    const bar = document.getElementById(SIDEBAR_ID);
    if (!bar || sidebarHooked === bar) return;
    sidebarHooked = bar;
    let wasVisible = bar.classList.contains('visible');
    // Only react to the sidebar opening or closing, not to our own class changes.
    new MutationObserver(() => {
        const visible = bar.classList.contains('visible');
        if (visible === wasVisible) return;
        wasVisible = visible;
        void refreshSidebar();
    }).observe(bar, { attributes: true, attributeFilter: ['class'] });
    void refreshSidebar();
}

function queueSidebarRefresh() {
    clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(() => void refreshSidebar(), 300);
}

function dropSidebar(bar) {
    sidebarRun++;
    sidebarRoot?.remove();
    sidebarRoot = null;
    sidebarRevealed = null;
    bar?.classList.remove(SIDEBAR_ON);
    applyFloatPosition();
}

async function refreshSidebar() {
    const bar = document.getElementById(SIDEBAR_ID);
    if (!sidebarWanted(bar)) { dropSidebar(bar); return; }
    const run = ++sidebarRun;
    if (!sidebarRoot?.isConnected) {
        sidebarRoot = el('div', `${ROOT_CLASS} chatfolders-sidebar chatFoldersLoading`);
        sidebarRoot.append(el('div', 'chatFoldersLoadingMessage', 'Loading chats…'));
        bar.append(sidebarRoot);
        bar.classList.add(SIDEBAR_ON);
        sidebarRevealed = null;
    }
    let folders;
    try {
        folders = buildFolders(await fetchChats(), { characters, groups, toMs });
    } catch (error) {
        console.warn(TAG, 'falling back to the Chat Top Bar list', error);
        if (run === sidebarRun) dropSidebar(bar);
        return;
    }
    if (run !== sidebarRun || !sidebarRoot?.isConnected || !sidebarWanted(bar)) return;
    // A refresh keeps the scroll position; only a new current chat scrolls itself into view.
    const scrollTop = sidebarRoot.scrollTop;
    sidebarRoot.classList.remove('chatFoldersLoading');
    renderInto(sidebarRoot, folders);
    sidebarRoot.scrollTop = scrollTop;
    revealCurrentChat(sidebarRoot);
}

/** Folder key and chat name of the open chat, or null on the welcome screen. */
function currentChatRef() {
    const name = getCurrentChatId();
    if (!name) return null;
    const { groupId } = SillyTavern.getContext();
    const avatar = characters[this_chid]?.avatar;
    const key = groupId ? 'g:' + groupId : avatar ? 'c:' + avatar : '';
    return key ? { key, name } : null;
}

/**
 * Open the current chat's folder, the branches above it and its own branches (none of it saved), then scroll
 * it to the middle: once per chat, or every time with center. A pinned chat is shown in the Pinned folder instead.
 */
function revealCurrentChat(root, { center = false } = {}) {
    const current = currentChatRef();
    if (!current) return;
    const apis = rootApis(root);
    const pinned = apis.get(PIN_FOLDER_KEY);
    if (pinned?.box.classList.contains(CURRENT_FOLDER)) {
        pinned.setOpen(true, false);
        const row = pinned.box.querySelector('.' + CURRENT_CHAT);
        if (row) scrollToCurrent(row, current, center);
        return;
    }
    const api = apis.get(current.key);
    if (!api) return;
    api.setOpen(true, false);
    const row = [...api.box.querySelectorAll('.chatFoldersChat')].find(r => r.dataset.chatName === current.name);
    if (!row) return;
    for (let node = row.parentElement; node && api.box.contains(node); node = node.parentElement?.closest('.chatFoldersBranchNode')) {
        if (!node.querySelector(':scope > .chatFoldersBranchBody')) continue;
        node.classList.add('open');
        syncBranchCaret(node);
    }
    scrollToCurrent(row, current, center);
}

function scrollToCurrent(row, current, center) {
    const shown = `${current.key}\u0000${current.name}`;
    if (center || sidebarRevealed !== shown) {
        sidebarRevealed = shown;
        row.scrollIntoView({ block: 'center', behavior: center ? 'smooth' : 'auto' });
    }
}

/** Rebuild every list on screen after a change made from one of them. */
async function refreshLists() {
    await openWelcomeScreen({ force: true }); // does nothing while a chat is open
    await refreshSidebar();
}

function scan() {
    hookSidebar();
    if (!document.querySelector('.' + ROOT_CLASS)) rowGestures.dispose();
    document.querySelectorAll('#chat .welcomePanel').forEach(p => {
        if (enhanced.has(p) && !panelRoots.get(p)?.isConnected) {
            p.classList.remove(ENHANCED);
            enhanced.delete(p);
            panelRuns.delete(p);
            panelRoots.delete(p);
            startupPipeline.invalidate(p);
        }
        void enhance(p);
    });
    applyFloatPosition();
}

function disable() {
    rowGestures.dispose();
    folderApis.clear();
    document.querySelectorAll('.' + ROOT_CLASS).forEach(n => n.remove());
    document.getElementById(SIDEBAR_ID)?.classList.remove(SIDEBAR_ON);
    sidebarRoot = null;
    sidebarRun++;
    document.querySelectorAll('.welcomePanel.' + ENHANCED).forEach(p => {
        p.classList.remove(ENHANCED);
        enhanced.delete(p);
        panelRuns.delete(p);
        panelRoots.delete(p);
        startupPipeline.invalidate(p);
    });
    pinHosts.clear();
    updateFloat();
    applyFloatPosition();
}

const FLOAT_KEY = 'SillyTavern-ChatFolders.floatPosition';
const FLOAT_SIZE = 32;
const FLOAT_MARGIN = 12;
const FLOAT_HOME_INSET = 4; // default spot: just inside the top-left corner of the Recent Chats list
const FLOAT_HOME_CLASS = 'chatfolders-float-home'; // on <body> while the button sits at its default spot
let floatButton = null;
let floatDrag = null;
let floatFrame = 0;

function folderRecordOpen(st) {
    return Object.entries(st).some(([key, value]) => value && (key.startsWith('c:') || key.startsWith('g:')));
}

function anyFolderOpen() {
    const live = liveApis();
    // The open chat's folder always stays open, so it doesn't count.
    if (live.length) return live.some(([, api]) => api.box.classList.contains('open') && !api.box.classList.contains(CURRENT_FOLDER));
    const st = loadExpanded();
    return !!st.__expandAll || folderRecordOpen(st);
}

/** The scroll box of a list, if it scrolls. */
function scrollBoxOf(root) {
    for (let node = root; node && node !== document.body; node = node.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
}

/** Remember the first row in view of each list, so it can be put back where it was after folders open. */
function scrollAnchors() {
    return [...folderApis.keys()].filter(root => root.isConnected).flatMap((root) => {
        const box = scrollBoxOf(root);
        if (!box) return [];
        const top = box.getBoundingClientRect().top;
        const row = [...root.querySelectorAll('.chatFoldersHeader, .chatFoldersChat')]
            .find(r => r.offsetParent && r.getBoundingClientRect().bottom > top);
        return row ? [{ box, row, at: row.getBoundingClientRect().top }] : [];
    });
}

function restoreScrollAnchors(anchors) {
    for (const { box, row, at } of anchors) {
        if (row.isConnected) box.scrollTop += row.getBoundingClientRect().top - at;
    }
}

function setEveryFolder(open) {
    const st = loadExpanded();
    const live = liveApis();
    const anchors = open ? scrollAnchors() : [];
    if (live.length) {
        delete st.__expandAll;
        for (const [key, api] of live) {
            api.setOpen(open, false);
            if (open) st[key] = 1; else delete st[key];
        }
    } else if (open) {
        st.__expandAll = 1;
        for (const key of Object.keys(st)) {
            if (key.startsWith('c:') || key.startsWith('g:')) st[key] = 1;
        }
    } else {
        for (const key of Object.keys(st)) {
            if (!key.startsWith('b:')) delete st[key];
        }
    }
    saveExpanded(st);
    // Expanding keeps the view where it was; collapsing brings the open chat back into view.
    if (open) restoreScrollAnchors(anchors);
    else if (sidebarRoot?.isConnected) revealCurrentChat(sidebarRoot, { center: true });
    updateFloat();
}

function updateFloat() {
    if (!floatButton) return;
    const open = anyFolderOpen();
    const icon = floatButton.querySelector('i');
    icon.classList.toggle('fa-folder-minus', open);
    icon.classList.toggle('fa-folder-plus', !open);
    const action = open ? 'Collapse all folders' : 'Expand all folders';
    floatButton.title = `${action}. Drag to move.`;
    floatButton.setAttribute('aria-label', action);
}

function readFloatPosition() {
    try {
        const parsed = JSON.parse(localStorage.getItem(FLOAT_KEY) || 'null');
        if (!Number.isFinite(parsed?.left) || !Number.isFinite(parsed?.top)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function homeFloatPosition() {
    const list = document.querySelector('.' + ROOT_CLASS);
    if (!list?.isConnected) return null;
    const rect = list.getBoundingClientRect();
    return { left: rect.left + FLOAT_HOME_INSET, top: rect.top + FLOAT_HOME_INSET };
}

function clampFloat(position) {
    const maxLeft = Math.max(FLOAT_MARGIN, window.innerWidth - FLOAT_SIZE - FLOAT_MARGIN);
    const maxTop = Math.max(FLOAT_MARGIN, window.innerHeight - FLOAT_SIZE - FLOAT_MARGIN);
    const left = Number.isFinite(Number(position?.left)) ? Number(position.left) : FLOAT_MARGIN;
    const top = Number.isFinite(Number(position?.top)) ? Number(position.top) : FLOAT_MARGIN;
    return {
        left: Math.round(Math.min(maxLeft, Math.max(FLOAT_MARGIN, left))),
        top: Math.round(Math.min(maxTop, Math.max(FLOAT_MARGIN, top))),
    };
}

function applyFloatPosition() {
    if (!floatButton) return;
    const saved = readFloatPosition();
    const home = saved ? null : homeFloatPosition();
    document.body.classList.toggle(FLOAT_HOME_CLASS, !!home);
    // Expand/collapse only means something while the folder list is on screen.
    floatButton.hidden = !settings().showFloat || !document.querySelector('.' + ROOT_CLASS)?.isConnected;
    const position = clampFloat(saved || home || {});
    floatButton.style.left = `${position.left}px`;
    floatButton.style.top = `${position.top}px`;
}

function onFloatMove(event) {
    if (!floatDrag || !floatButton) return;
    const position = clampFloat({
        left: event.clientX - floatDrag.offsetX,
        top: event.clientY - floatDrag.offsetY,
    });
    if (Math.abs(position.left - floatDrag.startLeft) > 2 || Math.abs(position.top - floatDrag.startTop) > 2) {
        floatDrag.moved = true;
    }
    floatButton.style.left = `${position.left}px`;
    floatButton.style.top = `${position.top}px`;
}

function onFloatUp() {
    if (!floatDrag || !floatButton) return;
    const moved = floatDrag.moved;
    document.removeEventListener('pointermove', onFloatMove);
    document.removeEventListener('pointerup', onFloatUp);
    floatDrag = null;
    if (!moved) return;
    const position = clampFloat({
        left: parseInt(floatButton.style.left, 10),
        top: parseInt(floatButton.style.top, 10),
    });
    try { localStorage.setItem(FLOAT_KEY, JSON.stringify(position)); } catch { /* stays where it was dropped */ }
    floatButton.dataset.dragged = 'true';
    setTimeout(() => { if (floatButton) delete floatButton.dataset.dragged; }, 0);
    applyFloatPosition();
}

function ensureFloat() {
    if (floatButton) return floatButton;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'chatfolders-float';
    button.className = 'chatfolders-float interactable';
    button.append(Object.assign(el('i', 'fa-solid fa-folder-plus'), { ariaHidden: 'true' }));
    button.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = button.getBoundingClientRect();
        floatDrag = {
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            startLeft: rect.left,
            startTop: rect.top,
            moved: false,
        };
        document.addEventListener('pointermove', onFloatMove);
        document.addEventListener('pointerup', onFloatUp);
    });
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.dragged === 'true') return;
        setEveryFolder(!anyFolderOpen());
    });
    document.body.append(button);
    floatButton = button;
    applyFloatPosition();
    updateFloat();
    window.addEventListener('resize', applyFloatPosition);
    // The default spot follows the list as the welcome screen scrolls.
    document.getElementById('chat')?.addEventListener('scroll', () => {
        if (floatFrame) return;
        floatFrame = requestAnimationFrame(() => { floatFrame = 0; applyFloatPosition(); });
    }, { passive: true });
    return button;
}

function addSettingsUi() {
    const check = (id, text) => `
                <label class="checkbox_label" for="${id}">
                    <input id="${id}" type="checkbox" />
                    <span>${text}</span>
                </label>`;
    const html = `
    <div class="chatfolders-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chat Folders</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                ${check('chatfolders_enabled', 'Enable Chat Folders')}
                ${check('chatfolders_pinned', 'Enable Pinned Folder')}
                <div class="chatfolders-setting-row">
                    ${check('chatfolders_float', 'Enable Expand All Button')}
                    <button type="button" class="menu_button" id="chatfolders_float_reset" title="Move the Expand All button back to its default position">Reset Position</button>
                </div>
                <hr>
                <b class="chatfolders-settings-heading">Chat Top Bar</b>
                ${check('chatfolders_sidebar', 'Sidebar override')}
                <small>Show every chat as folders in the Chat Top Bar sidebar, instead of only the current character's chats.</small>
                <hr>
                <b class="chatfolders-settings-heading">Memory Books Integration</b>
                ${check('chatfolders_renamemb', 'Rename chat-linked lorebooks')}
                <small>Follow chat renames when the book is used only by that chat. Shared and character-linked books stay unchanged.</small>
                ${check('chatfolders_linkmb', 'Auto-link Memory Books to chats')}
                <small>In Memory Books’ Manual Lorebook Mode, link an existing Memory Book when the chat has no lorebook. Also links character-locked books to their characters.</small>
            </div>
        </div>
    </div>`;
    const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!target) return;
    target.insertAdjacentHTML('beforeend', html);
    const bind = (id, key, after = () => {}) => {
        const box = document.getElementById(id);
        box.checked = !!settings()[key];
        box.addEventListener('change', () => { settings()[key] = box.checked; saveSettingsDebounced(); after(box.checked); });
    };
    bind('chatfolders_enabled', 'enabled', on => { if (on) { scan(); void refreshSidebar(); } else disable(); });
    bind('chatfolders_sidebar', 'sidebar', () => void refreshSidebar());
    bind('chatfolders_pinned', 'showPinned', () => syncPins());
    bind('chatfolders_float', 'showFloat', () => applyFloatPosition());
    bind('chatfolders_renamemb', 'renameMemoryBook');
    bind('chatfolders_linkmb', 'linkMemoryBooks');
    document.getElementById('chatfolders_float_reset').addEventListener('click', () => {
        try { localStorage.removeItem(FLOAT_KEY); } catch { /* nothing saved */ }
        applyFloatPosition();
    });
}

/** 1.6 and older named these keys after the old folder name. */
function migrateStorageKeys() {
    for (const [from, to] of [['ST-ChatFolders.expanded', LS_KEY], ['ST-ChatFolders.floatPosition', FLOAT_KEY]]) {
        try {
            const value = localStorage.getItem(from);
            if (value !== null && localStorage.getItem(to) === null) localStorage.setItem(to, value);
            localStorage.removeItem(from);
        } catch { /* storage unavailable */ }
    }
}

(function init() {
    try {
        settings();
        migrateStorageKeys();
        ensureStartupStyle();
        ensureFloat();
        addSettingsUi();
        // The welcome panel is appended to #chat asynchronously after CHAT_CHANGED / APP_READY (welcome-screen.js
        // initWelcomeScreen) and on every refresh (rename/delete/pin), and no event marks "panel rendered",
        // so watch #chat for it.
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            new MutationObserver(() => scan()).observe(chatEl, { childList: true });
        }
        eventSource.on(event_types.APP_READY, scan);
        eventSource.makeFirst(event_types.CHAT_CHANGED, preserveRenamedBranchCopy);
        eventSource.makeLast(event_types.CHAT_RENAMED, onChatRenamed);
        eventSource.on(event_types.CHAT_RENAMED, renameLinkedMemoryBook);
        for (const type of [event_types.CHAT_CHANGED, event_types.CHAT_RENAMED, event_types.CHAT_DELETED, event_types.GROUP_CHAT_DELETED]) {
            eventSource.on(type, queueSidebarRefresh);
        }
        scan();
        console.log(TAG, 'loaded');
    } catch (e) {
        console.error(TAG, 'init failed; ST list unaffected', e);
    }
})();
