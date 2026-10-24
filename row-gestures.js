// Small, DOM-free coordinator for the immediate-first-click branch gesture.
// Timers make abandoned first clicks self-cleaning; dispose() is called whenever
// the rendered tree is replaced or removed.
export function syncBranchAriaExpanded(row, caret, open) {
    const value = String(Boolean(open));
    row?.setAttribute('aria-expanded', value);
    caret?.setAttribute('aria-expanded', value);
}

export function createRowGestureCoordinator({ delay = 500, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const pending = new Map();
    const completed = new Set();

    function clear(row) {
        const gesture = pending.get(row);
        if (!gesture) return null;
        clearTimer(gesture.timer);
        pending.delete(row);
        return gesture;
    }

    return {
        handle(row, detail, { read, toggle, restore, open }) {
            if (detail >= 3 || (detail === 2 && completed.has(row))) return 'ignore';
            if (detail === 2) {
                const gesture = clear(row);
                if (!gesture) return 'ignore';
                restore(gesture.original);
                completed.add(row);
                open();
                return 'open';
            }
            // detail === 1 denotes a separate single click. A preceding pending
            // gesture has expired in the browser before this sequence begins.
            clear(row);
            completed.delete(row);
            const original = read();
            toggle();
            const timer = setTimer(() => {
                pending.delete(row);
                if (row.isConnected === false) completed.delete(row);
            }, delay);
            pending.set(row, { original, timer });
            return 'toggle';
        },
        cancel(row, restorePending = false, restore = () => {}) {
            const gesture = clear(row);
            completed.delete(row);
            if (gesture && restorePending) restore(gesture.original);
        },
        dispose(restorePending = false, restore = () => {}) {
            for (const [row, gesture] of pending) {
                clearTimer(gesture.timer);
                if (restorePending) restore(row, gesture.original);
            }
            pending.clear();
            completed.clear();
        },
    };
}
