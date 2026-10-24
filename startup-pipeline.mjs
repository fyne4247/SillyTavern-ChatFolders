/** Testable orchestration for loading panel data, rendering it, then linking in the background. */
export function createStartupPipeline() {
    const jobs = new WeakMap();
    return {
        start(key, steps) {
            const existing = jobs.get(key);
            if (existing) return existing;
            let job;
            const clear = () => { if (jobs.get(key) === job) jobs.delete(key); };
            job = Promise.resolve().then(() => {
                steps.showLoading();
                return steps.fetch();
            }).then((rows) => {
                if (!steps.isCurrent()) {
                    steps.onStale?.();
                    clear();
                    return { status: 'stale' };
                }
                const folders = steps.build(rows);
                steps.render(folders, rows);
                if (folders.length && steps.link) {
                    const linkJob = Promise.resolve().then(() => steps.link(folders)).then((linked) => {
                        if (steps.isCurrent()) steps.onLinked?.(linked, folders);
                        return linked;
                    }).catch((error) => {
                        steps.onLinkError?.(error);
                        return 0;
                    });
                    steps.onLinkStarted?.(linkJob);
                }
                return { status: 'rendered', rows, folders };
            }).catch((error) => {
                steps.onError?.(error, steps.isCurrent());
                clear();
                return { status: 'failed', error };
            });
            jobs.set(key, job);
            return job;
        },
        invalidate(key) { jobs.delete(key); },
        has(key) { return jobs.has(key); },
    };
}

/** Serialize writes by key so an explicit user choice follows any automatic write already in flight. */
export function createKeyedWriteQueue() {
    const queues = new Map();
    return async function run(key, action) {
        const previous = queues.get(key) ?? Promise.resolve();
        const running = previous.catch(() => {}).then(action);
        queues.set(key, running);
        try {
            return await running;
        } finally {
            if (queues.get(key) === running) queues.delete(key);
        }
    };
}

export async function updateActiveChatMetadata(metadata, patch, save) {
    patch(metadata);
    await save();
    return true;
}

export function matchesCharacterChat(avatar, chatName, characters, activeCharacterId, activeChatName) {
    const id = characters.findIndex((item) => item.avatar === avatar);
    return id >= 0 && String(activeCharacterId) === String(id) && activeChatName === chatName;
}

export function canAutoLinkChat(metadata) {
    return !metadata?.world_info && !metadata?.chatFolders?.noLorebook;
}
