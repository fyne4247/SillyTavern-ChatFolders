import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { repairRenamedBranchReceipt, remapBranchCopyIdentity } from './lorebook-rename.mjs';

const target = { avatarId: 'a.png', newFileName: 'Ending' };
function fixture({ oldId = 'Old branch', oldBook = 'Book Branch 1' } = {}) {
    const metadata = { main_chat: 'Parent', world_info: 'Ending', STMemoryBooks: {
        branchLorebookCopies: { version: 1, status: 'completed', branchChatId: oldId,
            parentChatId: 'Parent', mappings: [{ rootName: 'Book', sourceName: 'Book', copyName: oldBook }] },
        autoRollbackForChild: { version: 1, status: 'completed', childChatId: oldId },
    } };
    const rows = [{ avatar: 'a.png', file_name: 'Ending.jsonl', chat_metadata: structuredClone(metadata) },
        { avatar: 'a.png', file_name: 'Parent.jsonl', chat_metadata: { world_info: 'Parent Book' } }];
    return { metadata, rows };
}

test('opening an older renamed branch repairs identity, book and completed rollback receipt', () => {
    const { metadata, rows } = fixture();
    assert.equal(repairRenamedBranchReceipt(metadata, rows, target, []), true);
    assert.equal(metadata.STMemoryBooks.branchLorebookCopies.branchChatId, 'Ending');
    assert.equal(metadata.STMemoryBooks.branchLorebookCopies.mappings[0].copyName, 'Ending');
    assert.equal(metadata.STMemoryBooks.branchLorebookCopies.mappings[0].rootName, 'Book');
    assert.equal(metadata.STMemoryBooks.autoRollbackForChild.childChatId, 'Ending');
    assert.equal(repairRenamedBranchReceipt(metadata, rows, target, []), false);
});
test('opening a branch with correct identity but stale lorebook receipt repairs it', () => {
    const { metadata, rows } = fixture({ oldId: 'Ending' });
    assert.equal(repairRenamedBranchReceipt(metadata, rows, target, []), true);
});
for (const [name, change, protectedBooks] of [
    ['parent still uses this book', (m, r) => { r[1].chat_metadata.world_info = 'Ending'; }, []],
    ['old chat still exists', (m, r) => { r.push({ avatar: 'a.png', file_name: 'Old branch.jsonl' }); }, []],
    ['character/global book', () => {}, ['Ending']],
    ['more than one copied book', m => { m.STMemoryBooks.branchLorebookCopies.mappings.push({ copyName: 'Other' }); }, []],
    ['unrelated selected book', m => { m.world_info = 'Other'; }, []],
    ['missing copy receipt', m => { delete m.STMemoryBooks.branchLorebookCopies; }, []],
    ['failed copy', m => { m.STMemoryBooks.branchLorebookCopies.status = 'failed'; }, []],
    ['missing current row', (m, r) => { r.shift(); }, []],
]) {
    test(`reopen repair refuses ${name}`, () => {
        const { metadata, rows } = fixture();
        change(metadata, rows);
        const before = structuredClone(metadata);
        assert.equal(repairRenamedBranchReceipt(metadata, rows, target, protectedBooks), false);
        assert.deepEqual(metadata, before);
    });
}
test('another character using the selected book blocks repair', () => {
    const { metadata, rows } = fixture();
    rows.push({ avatar: 'b.png', file_name: 'Ending', chat_metadata: { world_info: 'Ending' } });
    assert.equal(repairRenamedBranchReceipt(metadata, rows, target, []), false);
});
test('manual mode refuses a different effective book', () => {
    const { metadata, rows } = fixture();
    metadata.STMemoryBooks.manualLorebook = 'Manual';
    assert.equal(repairRenamedBranchReceipt(metadata, rows, target, [], { manualMode: true }), false);
});

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function loadOpeningHook(metadata, rows, extra = {}) {
    let saves = 0;
    const sandbox = {
        settings: () => ({ enabled: true }), mbEnabled: () => true, mbManual: () => false,
        getCurrentChatId: () => 'Ending', SillyTavern: { getContext: () => ({}) },
        characters: [{ avatar: 'a.png' }], this_chid: 0, chat_metadata: metadata,
        remapBranchCopyIdentity, repairRenamedBranchReceipt,
        world_info: {}, power_user: {}, fetchChats: async () => rows,
        saveMetadata: async () => { saves++; }, console: { info() {}, error() {} }, TAG: 'test', ...extra,
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(source.indexOf('let pendingBranchRename'), source.indexOf('async function renameFolderChat')), sandbox);
    return { sandbox, open: () => sandbox.preserveRenamedBranchCopy(), saves: () => saves };
}
test('actual opening hook repairs a saved receipt without a pending rename', async () => {
    const { metadata, rows } = fixture();
    const harness = loadOpeningHook(metadata, rows);
    await harness.open();
    assert.equal(metadata.STMemoryBooks.branchLorebookCopies.branchChatId, 'Ending');
    assert.equal(metadata.STMemoryBooks.branchLorebookCopies.mappings[0].copyName, 'Ending');
    assert.equal(harness.saves(), 1);
    await harness.open();
    assert.equal(harness.saves(), 1);
});
test('a chat switch during inspection prevents stale metadata writes', async () => {
    const { metadata, rows } = fixture();
    let resolveRows;
    const harness = loadOpeningHook(metadata, rows, { fetchChats: () => new Promise(resolve => { resolveRows = resolve; }) });
    const opening = harness.open();
    harness.sandbox.chat_metadata = {};
    resolveRows(rows);
    await opening;
    assert.equal(metadata.STMemoryBooks.branchLorebookCopies.branchChatId, 'Old branch');
    assert.equal(harness.saves(), 0);
});

// Optional integration against the real installed controller; no Memory Books edits
// or live data writes. Run with STMB_BRANCH_MODULE=/path/to/branchLorebooks.js.
const modulePath = process.env.STMB_BRANCH_MODULE;
test('real Memory Books controller: stale reopen copies again; guarded reopen does not', { skip: !modulePath }, async () => {
    const { createBranchLorebookController } = await import(pathToFileURL(modulePath));
    for (const guarded of [false, true]) {
        const { metadata, rows } = fixture({ oldId: 'Ending' });
        const books = new Map([['Ending', { entries: {} }]]);
        let copyWrites = 0;
        const controller = createBranchLorebookController({
            getCurrentChatId: () => 'Ending', getChatMetadata: () => metadata, getChatMessages: () => [],
            getSettings: () => ({ moduleSettings: { copyMemoryBooksOnBranch: true,
                autoRollbackEnabled: true, autoRollbackApplyToBranches: true } }),
            getWorldNames: () => [...books.keys()], loadWorldInfo: async name => books.get(name),
            saveWorldInfo: async (name, data) => { copyWrites++; books.set(name, data); },
            updateWorldInfoList: async () => {}, saveMetadata: async () => {},
        });
        controller.initialize();
        const hook = loadOpeningHook(metadata, rows);
        for (let i = 0; i < 3; i++) {
            if (guarded) await hook.open();
            await controller.handleChatChanged('Ending');
        }
        assert.equal(copyWrites, guarded ? 0 : 1);
        assert.equal(metadata.world_info, guarded ? 'Ending' : 'Ending Branch 1');
        assert.equal(controller.hasVerifiedCopies('Ending'), true);
    }
});

test('real Memory Books controller still copies a genuine new branch once', { skip: !modulePath }, async () => {
    const { createBranchLorebookController } = await import(pathToFileURL(modulePath));
    const { metadata, rows } = fixture({ oldId: 'Parent', oldBook: 'Ending' });
    rows[1].chat_metadata.world_info = 'Ending';
    const books = new Map([['Ending', { entries: {} }]]);
    let writes = 0;
    const controller = createBranchLorebookController({
        getCurrentChatId: () => 'Ending', getChatMetadata: () => metadata, getChatMessages: () => [],
        getSettings: () => ({ moduleSettings: { copyMemoryBooksOnBranch: true,
            autoRollbackEnabled: true, autoRollbackApplyToBranches: true } }),
        getWorldNames: () => [...books.keys()], loadWorldInfo: async name => books.get(name),
        saveWorldInfo: async (name, data) => { writes++; books.set(name, data); },
        updateWorldInfoList: async () => {}, saveMetadata: async () => {},
    });
    controller.initialize();
    const hook = loadOpeningHook(metadata, rows);
    await hook.open();
    assert.equal(hook.saves(), 0);
    await controller.handleChatChanged('Ending');
    assert.equal(writes, 1);
    assert.equal(metadata.world_info, 'Book Branch 1');
    await hook.open();
    await controller.handleChatChanged('Ending');
    assert.equal(writes, 1);
});

test('group receipts use group identity when checking whether the old chat still exists', () => {
    const { metadata } = fixture();
    const groupTarget = { groupId: 'g1', newFileName: 'Ending' };
    const rows = [{ group: 'g1', file_name: 'Ending', chat_metadata: metadata },
        { group: 'g2', file_name: 'Old branch', chat_metadata: {} }];
    assert.equal(repairRenamedBranchReceipt(metadata, rows, groupTarget, []), true);
});
