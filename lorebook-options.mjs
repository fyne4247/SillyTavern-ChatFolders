export const NONE = '';
export const CREATE = '\u0000create';

/** Return the visible lorebook choices in UI order, preserving a missing current selection. */
export function orderedLorebookOptions(current, worldNames) {
    const names = [...(worldNames ?? [])].sort((a, b) => a.localeCompare(b));
    const options = [
        { value: NONE, label: 'None' },
        { value: CREATE, label: '+ Create new…' },
    ];
    if (current && !names.includes(current)) options.push({ value: current, label: `${current} (missing)` });
    for (const name of names) options.push({ value: name, label: name });
    return options;
}
