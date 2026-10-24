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
    createNewWorldInfo, openWorldInfoEditor, setWorldInfoButtonClass, world_info, world_names,
} from '../../../world-info.js';
import { buildFolders, CHAT_SORTS, FOLDER_SORTS, sortChatSiblings, sortFolders } from './grouping.js';
import { createRowGestureCoordinator, syncBranchAriaExpanded } from './row-gestures.js';
import { CREATE, NONE, orderedLorebookOptions } from './lorebook-options.mjs';
import {
    canAutoLinkChat, createKeyedWriteQueue, createStartupPipeline, matchesCharacterChat, updateActiveChatMetadata,
} from './startup-pipeline.mjs';

const TAG = '[ChatFolders]';
const EXTENSION_EVALUATED_AT = performance.now();
const SETTINGS_KEY = 'chatFolders';
const LS_KEY = 'ST-ChatFolders.expanded';
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
    s.linkMemoryBooks ??= true;
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
    const row = el('div', `chatFoldersSortRow chatFoldersSortRow-${scope}`);
    const add = (label, ascending, descending, defaultMode) => row.append(sortHeaderButton(label, ascending, descending, defaultMode, current, onChange));
    if (scope === 'folders') {
        row.append(el('span', 'chatFoldersSortSpacer'), el('span', 'chatFoldersSortSpacer'));
        add('Character', 'name-asc', 'name-desc', 'name-asc');
        row.append(el('span', 'chatFoldersSortSpacer chatFoldersSortLoreSpacer'));
        add('Threads', 'threads-asc', 'threads-desc', 'threads-desc');
        add('Messages', 'messages-asc', 'messages-desc', 'messages-desc');
        add('Last active', 'oldest', 'recent', 'recent');
        row.append(el('span', 'chatFoldersSortSpacer'));
    } else {
        add('Branch', 'name-asc', 'name-desc', 'name-asc');
        row.append(el('span', 'chatFoldersSortSpacer chatFoldersSortLoreSpacer'));
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
    for (const api of folderApi.values()) api.applyChatSort(value);
}
const enhanced = new WeakSet();
const panelRuns = new WeakMap();
const panelRoots = new WeakMap();
const lorebookEditVersions = new Map();
const runLorebookWrite = createKeyedWriteQueue();
const startupPipeline = createStartupPipeline();
/** @type {Map<string, {setOpen: Function, box: HTMLElement, folder: object}>} */
const folderApi = new Map();
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
            body: JSON.stringify({ max: 100000, metadata: true }),
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
const countChats = (list) => list.reduce((n, c) => n + 1 + countChats(c.children), 0);

async function renameChat(folder, chat) {
    try {
        const newName = await callGenericPopup('Enter the new name for the chat:', POPUP_TYPE.INPUT, chat.name);
        if (!newName || typeof newName !== 'string' || newName.trim() === '' || newName === chat.name) return;
        const pinsBefore = readPins();
        if (folder.kind === 'group') {
            await renameGroupOrCharacterChat({ groupId: folder.groupId, oldFileName: chat.name, newFileName: newName, loader: false });
        } else {
            const id = characters.findIndex(x => x.avatar === folder.avatar);
            if (id === -1) throw new Error('character not found: ' + folder.avatar);
            const wasCurrent = characters[id].chat === chat.name;
            await renameGroupOrCharacterChat({ characterId: String(id), oldFileName: chat.name, newFileName: newName, loader: false });
            // Keep the character's "last chat" pointer valid, but don't move it to a chat that wasn't current.
            if (wasCurrent) await updateRemoteChatName(id, newName);
        }
        movePin(pinsBefore, folder, chat.name, newName.trim());
        await openWelcomeScreen({ force: true });
        toastr.success('Chat renamed.', 'Chat Folders');
    } catch (e) {
        console.error(TAG, e);
        toastr.error('Failed to rename chat. See console for details.', 'Chat Folders');
    }
}

async function deleteChat(folder, chat) {
    try {
        const branches = countChats(chat.children);
        const warn = branches
            ? `<p>It has ${branches} branch${branches === 1 ? '' : 'es'} linked to it. They are kept, but their "Back to main chat" link will point at nothing.</p>`
            : '';
        const box = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = 'Are you sure?';
        const what = document.createElement('p');
        what.append('Delete ', Object.assign(document.createElement('b'), { textContent: chat.name }),
            ` (${chat.count} messages) from ${folder.name}? This can't be undone.`);
        box.append(title, what);
        box.insertAdjacentHTML('beforeend', warn);
        const ok = await callGenericPopup(box, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' });
        if (!ok) return;
        if (folder.kind === 'group') {
            await deleteGroupChatByName(folder.groupId, chat.name);
        } else {
            const id = characters.findIndex(x => x.avatar === folder.avatar);
            if (id === -1) throw new Error('character not found: ' + folder.avatar);
            await deleteCharacterChatByName(String(id), chat.name);
        }
        await openWelcomeScreen({ force: true });
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
        await openWelcomeScreen({ force: true });
    });
    wrap.append(sel, openBtn);
    return wrap;
}

/**
 * When Memory Books already has a book for a character (lock) or chat (manual book) but ST has no lorebook
 * linked there, link that book. Skips books that no longer exist and the open chat's in-memory edit races.
 * @returns {Promise<number>} how many links were made
 */
async function autoLinkMemoryBooks(folders, shouldContinue = () => true) {
    if (!settings().linkMemoryBooks || !mbEnabled()) return 0;
    const exists = (n) => !!n && (world_names ?? []).includes(n);
    let linked = 0;
    for (const folder of folders) {
        if (!shouldContinue()) break;
        if (folder.kind !== 'character') continue;
        const lockBook = mbLock(folder.avatar)?.lorebookName;
        if (!primaryBook(folder) && exists(lockBook) && !settings().noLorebook?.[folder.avatar]) {
            const version = lorebookEditVersion(folder);
            try {
                if (await setCharacterLorebook(folder, lockBook, { syncMemoryBook: false, expectedVersion: version, shouldContinue })) {
                    linked++; console.log(TAG, 'linked character', folder.name, '->', lockBook);
                }
            }
            catch (e) { console.warn(TAG, 'auto-link failed for', folder.name, e); }
        }
        const walk = async (list) => {
            for (const chat of list) {
                if (!shouldContinue()) return;
                if (!chat.lorebook && !chat.noLorebook && exists(chat.memoryBook)) {
                    const version = lorebookEditVersion(folder, chat.name);
                    try {
                        if (await setChatLorebook(folder, chat, chat.memoryBook, { syncMemoryBook: false, expectedVersion: version, shouldContinue, automatic: true })) {
                            linked++; console.log(TAG, 'linked chat', chat.name, '->', chat.memoryBook);
                        }
                    }
                    catch (e) { console.warn(TAG, 'auto-link failed for', chat.name, e); }
                }
                await walk(chat.children);
            }
        };
        await walk(folder.chats);
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
/** @type {{root: HTMLElement, folders: object[]} | null} */
let pinHost = null;

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
const pinnedKeys = () => new Set(Object.values(readPins()).filter(p => p && typeof p === 'object').map(pinKeyOf));

function togglePin(folder, chat) {
    const pin = pinOf(folder, chat);
    const key = pinKeyOf(pin);
    const state = { ...readPins() };
    if (key in state) delete state[key]; else state[key] = pin;
    accountStorage.setItem(PIN_STORE, JSON.stringify(state));
    syncPins();
}

/** A rename moves the pin to the new file name (stock does this too, but from a cache that can be stale). */
function movePin(before, folder, oldName, newName) {
    const oldPin = pinOf(folder, { name: oldName });
    const oldKey = pinKeyOf(oldPin);
    if (!(oldKey in before)) return;
    const state = { ...before };
    const newPin = { ...oldPin, file_name: `${newName}.jsonl` };
    delete state[oldKey];
    state[pinKeyOf(newPin)] = newPin;
    accountStorage.setItem(PIN_STORE, JSON.stringify(state));
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
    if (!pinHost?.root.isConnected) return;
    pinnedNow = pinnedKeys();
    for (const row of pinHost.root.querySelectorAll('.chatFoldersChat[data-pin-key]')) setPinMark(row, pinnedNow.has(row.dataset.pinKey));
    renderPinned(pinHost.root, pinHost.folders);
}

function renderPinned(root, folders, expanded = loadExpanded()) {
    folderApi.delete(PIN_FOLDER_KEY);
    root.querySelector(':scope > .chatFoldersPinned')?.remove();
    const entries = [];
    if (pinnedNow.size) {
        for (const folder of folders) {
            const walk = (list) => list.forEach((chat) => {
                if (pinnedNow.has(pinKeyOf(pinOf(folder, chat)))) entries.push({ folder, chat });
                walk(chat.children);
            });
            walk(folder.chats);
        }
    }
    if (entries.length) root.querySelector(':scope > .chatFoldersSortRow-folders')?.after(renderPinnedFolder(entries, expanded));
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
        row.title = `${row.dataset.chatName || ''}\n${row.dataset.chatDate || ''}\nClick to ${open ? 'collapse' : 'expand'} branches; double-click to open chat. Press Space to toggle; Enter to open.`;
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
        ? `${chat.name}\n${fmtLong(chat.ms)}\nClick to expand branches; double-click to open chat. Press Space to toggle; Enter to open.`
        : `${chat.name}\n${fmtLong(chat.ms)}\nClick or press Enter to open chat.`;
    const name = el('div', 'chatFoldersChatName');
    name.append(Object.assign(el('i', 'fa-solid fa-thumbtack fa-xs chatFoldersPinMark'), { title: 'Pinned chat' }));
    if (kids.length) {
        const caret = el('i', 'fa-solid fa-chevron-right fa-fw chatFoldersBranchCaret');
        caret.tabIndex = 0;
        caret.setAttribute('role', 'button');
        name.append(caret);
    }
    if (depth > 0) name.append(Object.assign(el('i', 'fa-solid fa-code-branch fa-xs'), { title: 'Branch / checkpoint' }), ' ');
    if (flat) name.append(pinnedAvatar(folder), el('strong', 'chatFoldersPinnedChar', folder.name), ' \u2013 ');
    name.append(chat.name);
    const lore = folder.kind === 'character' && !flat
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
        if (event.key === 'Enter') { event.preventDefault(); rowGestures.cancel(row); go(); }
        else if (event.key === ' ') {
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

function renderFolder(folder, expandedState) {
    const box = el('div', 'chatFoldersFolder');
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
    head.append(carets, folderAvatar(folder), info, lore, meta, el('span', 'chatFoldersSpacer'));
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
    sortHead.append(allButton);
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
    folderApi.set(folder.key, { setOpen, applyChatSort, box, folder });
    return box;
}

function pinnedAvatar(folder) {
    if (folder.kind === 'group') return Object.assign(el('i', 'fa-solid fa-user-group fa-xs chatFoldersPinnedAvatar'), { title: folder.name });
    const img = el('img', 'chatFoldersPinnedAvatar');
    img.src = getThumbnailUrl('avatar', folder.avatar);
    img.alt = folder.name;
    return img;
}

/** The Pinned folder: every pinned chat from every character, flat, ordered by the shared chat sort. */
function renderPinnedFolder(entries, expandedState) {
    const owner = new Map(entries.map(({ folder, chat }) => [chat, folder]));
    const chats = entries.map(({ chat }) => chat);
    const box = el('div', 'chatFoldersFolder chatFoldersPinned');
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
    let sortMode = settings().chatSort;
    const sortHead = sortHeaderRow('chats', sortMode, setSharedChatSort);
    body.append(sortHead, tree);
    let filled = false;
    const fill = () => {
        tree.replaceChildren();
        for (const chat of sortChatSiblings(chats, sortMode)) {
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
    folderApi.set(PIN_FOLDER_KEY, { setOpen, applyChatSort, box, folder: null });
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

function renderInto(root, folders) {
    rowGestures.dispose();
    folderApi.clear();
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
        for (const folder of sortFolders(folders, s.folderSort)) {
            const api = folderApi.get(folder.key);
            if (api) root.append(api.box);
        }
    });
    root.append(folderSortHead);
    pinHost = { root, folders };
    pinnedNow = pinnedKeys();
    if (!folders.length) { root.append(el('div', 'chatFoldersEmpty', 'No chats')); applyFloatPosition(); return; }
    const expanded = loadExpanded();
    for (const folder of sortFolders(folders, settings().folderSort)) root.append(renderFolder(folder, expanded));
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
    let fetchStarted;
    let linkStarted;
    const panelDetectedAt = performance.now();
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
            fetchStarted = performance.now();
        },
        fetch: fetchChats,
        build: (rows) => buildFolders(rows, { characters, groups, toMs }),
        isCurrent: current,
        render: (folders, rows) => {
            const fetched = performance.now();
            root.classList.remove('chatFoldersLoading');
            root.removeAttribute('role');
            root.removeAttribute('aria-live');
            renderInto(root, folders);
            console.info(TAG, 'startup timings (ms)', {
                fetch: Math.round(fetched - fetchStarted),
                folderBuildAndRender: Math.round(performance.now() - fetched),
                scriptEvaluationToReady: Math.round(performance.now() - EXTENSION_EVALUATED_AT),
                panelDiscoveryToReady: Math.round(performance.now() - panelDetectedAt),
                rows: rows.length,
                folders: folders.length,
                extensionResourceRequests: performance.getEntriesByType('resource')
                    .filter((entry) => entry.name.includes('/ST-ChatFolders/'))
                    .map(({ name, startTime, duration }) => ({ name, startTime: Math.round(startTime), duration: Math.round(duration) })),
            });
        },
        link: (folders) => { linkStarted = performance.now(); return autoLinkMemoryBooks(folders, current); },
        onLinked: (linked, folders) => {
            if (linked) refreshLorebookSelects(root, folders);
            console.info(TAG, 'Memory Books linking (ms)', Math.round(performance.now() - linkStarted));
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

function scan() {
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
    folderApi.clear();
    document.querySelectorAll('.' + ROOT_CLASS).forEach(n => n.remove());
    document.querySelectorAll('.welcomePanel.' + ENHANCED).forEach(p => {
        p.classList.remove(ENHANCED);
        enhanced.delete(p);
        panelRuns.delete(p);
        panelRoots.delete(p);
        startupPipeline.invalidate(p);
    });
    pinHost = null;
    updateFloat();
    applyFloatPosition();
}

const FLOAT_KEY = 'ST-ChatFolders.floatPosition';
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
    const live = [...folderApi.values()].filter(api => api.box.isConnected);
    if (live.length) return live.some(api => api.box.classList.contains('open'));
    const st = loadExpanded();
    return !!st.__expandAll || folderRecordOpen(st);
}

function setEveryFolder(open) {
    const st = loadExpanded();
    const live = [...folderApi.entries()].filter(([, api]) => api.box.isConnected);
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
    floatButton.hidden = !document.querySelector('.' + ROOT_CLASS)?.isConnected;
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
    const html = `
    <div class="chatfolders-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chat Folders</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="chatfolders_enabled">
                    <input id="chatfolders_enabled" type="checkbox" />
                    <span>Group Recent Chats on the welcome screen into one folder per character</span>
                </label>
                <small>When off, SillyTavern's original list is shown.</small>
                <label class="checkbox_label" for="chatfolders_linkmb">
                    <input id="chatfolders_linkmb" type="checkbox" />
                    <span>If Memory Books has a book for a character or chat that has no lorebook, link it as the lorebook</span>
                </label>
            </div>
        </div>
    </div>`;
    const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!target) return;
    target.insertAdjacentHTML('beforeend', html);
    const box = document.getElementById('chatfolders_enabled');
    box.checked = !!settings().enabled;
    const linkBox = document.getElementById('chatfolders_linkmb');
    linkBox.checked = !!settings().linkMemoryBooks;
    linkBox.addEventListener('change', () => { settings().linkMemoryBooks = linkBox.checked; saveSettingsDebounced(); });
    box.addEventListener('change', () => {
        settings().enabled = box.checked;
        saveSettingsDebounced();
        if (box.checked) scan(); else disable();
    });
}

(function init() {
    try {
        settings();
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
        scan();
        console.log(TAG, 'loaded');
    } catch (e) {
        console.error(TAG, 'init failed; ST list unaffected', e);
    }
})();
