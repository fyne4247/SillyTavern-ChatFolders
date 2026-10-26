import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatStem, exclusiveChatBook, sameChat } from './lorebook-rename.mjs';
const target = { avatarId: 'a.png', newFileName: 'Renamed.jsonl' };
const row = { avatar: 'a.png', file_name: 'Renamed.jsonl', chat_metadata: { world_info: 'Book' } };
test('exclusive chat book follows a rename', () => assert.equal(exclusiveChatBook([row], target, []), 'Book'));
test('character and locked books stay put', () => assert.equal(exclusiveChatBook([row], target, ['Book']), null));
test('character-only link does not qualify', () => assert.equal(exclusiveChatBook([{ ...row, chat_metadata: {} }], target, []), null));
for (const field of ['world_info', 'manualLorebook']) {
    test(`another chat sharing ${field} blocks rename`, () => {
        const metadata = field === 'world_info' ? { world_info: 'Book' } : { STMemoryBooks: { manualLorebook: 'Book' } };
        assert.equal(exclusiveChatBook([row, { avatar: 'b.png', file_name: 'Other', chat_metadata: metadata }], target, []), null);
    });
}
test('same filename for another character counts as another chat', () => {
    assert.equal(exclusiveChatBook([row, { ...row, avatar: 'b.png' }], target, []), null);
});
test('group chat identity includes its group', () => {
    const groupTarget = { groupId: '1', newFileName: 'Renamed.jsonl' };
    assert.equal(sameChat({ ...row, group: '1' }, groupTarget), true);
    assert.equal(sameChat({ ...row, group: '2' }, groupTarget), false);
});
test('unrelated books do not block rename', () => assert.equal(exclusiveChatBook([row, { avatar: 'b.png', file_name: 'Other', chat_metadata: { world_info: 'Other book' } }], target, []), 'Book'));

// Exercise the actual event handler with in-memory services, without changing user chats.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
async function runRename({ enabled = true, shared = false, collision = false, failSave = false, failLink = false } = {}) {
    const calls = [];
    const metadata = { world_info: 'Book', STMemoryBooks: { manualLorebook: 'Book' } };
    const sandbox = {
        settings: () => ({ enabled: true, renameMemoryBook: enabled }), mbEnabled: () => true,
        fetchChats: async () => [row, ...(shared ? [{ ...row, avatar: 'b.png' }] : [])],
        characters: [], world_info: {}, power_user: {}, mbSettings: () => ({}),
        exclusiveChatBook, chatStem, world_names: collision ? ['Book', 'Renamed'] : ['Book'],
        updateWorldInfoList: async () => {},
        post: async (url) => {
            calls.push(url);
            if (failSave && url.endsWith('/edit')) throw Error('write failed');
            return { json: async () => ({ entries: { 1: { content: 'memory' } } }) };
        },
        patchChatMetadata: async (_folder, _name, patch) => {
            calls.push('link');
            if (failLink) throw Error('link failed');
            patch(metadata);
            return true;
        },
        deleteWorldInfo: async () => { calls.push('delete'); return true; },
        toastr: { warning: () => calls.push('warning') }, console: { error() {} }, TAG: 'test',
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(source.indexOf('async function renameLinkedMemoryBook('), source.indexOf('function setPinMark(')), sandbox);
    await sandbox.renameLinkedMemoryBook(target);
    return { calls, metadata };
}
test('event handler writes, relinks both metadata fields, then removes original', async () => {
    const { calls, metadata } = await runRename();
    assert.deepEqual(calls, ['/api/worldinfo/get', '/api/worldinfo/edit', 'link', 'delete']);
    assert.equal(metadata.world_info, 'Renamed');
    assert.equal(metadata.STMemoryBooks.manualLorebook, 'Renamed');
});
test('toggle off performs no writes', async () => assert.deepEqual((await runRename({ enabled: false })).calls, []));
test('shared book performs no writes', async () => assert.deepEqual((await runRename({ shared: true })).calls, []));
test('collision warns without writing', async () => assert.deepEqual((await runRename({ collision: true })).calls, ['warning']));
test('failed book save never relinks or deletes original', async () => {
    const { calls, metadata } = await runRename({ failSave: true });
    assert.equal(calls.includes('link'), false);
    assert.equal(calls.includes('delete'), false);
    assert.equal(metadata.world_info, 'Book');
});
test('failed relink never deletes original', async () => assert.equal((await runRename({ failLink: true })).calls.includes('delete'), false));
