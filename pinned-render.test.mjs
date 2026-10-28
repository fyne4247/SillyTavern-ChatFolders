import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const treeSource = source.slice(source.indexOf('function renderTree('), source.indexOf('function folderAvatar('));
for (const mode of ['name-asc', 'name-desc', 'recent']) {
    test(`ordinary folders render with ${mode} without pinned character data`, () => {
        const rendered = [];
        const context = vm.createContext({
            sortChatSiblings: (chats, sort) => [...chats].sort((a, b) => (sort === 'name-desc' ? -1 : 1) * a.name.localeCompare(b.name)),
            el: () => ({ dataset: {}, append() {} }),
            renderChat: (_folder, chat) => { rendered.push(chat.name); return {}; },
        });
        vm.runInContext(treeSource, context);
        context.renderTree({}, [{ name: 'B', children: [] }, { name: 'A', children: [] }], 0, { append() {} }, {}, mode);
        assert.deepEqual(rendered, mode === 'name-desc' ? ['B', 'A'] : ['A', 'B']);
    });
}
