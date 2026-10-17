// notifications.json: every kind of notification an app sends, with its
// text and how the phone shows it. The Worker renders from it; the Swift
// and Kotlin clients read its channels (PUSH.md).
const KEY = /^[a-z][a-z0-9_]{0,63}$/;
const INTERRUPTIONS = ["passive", "active", "time-sensitive"];
const IMPORTANCES = ["min", "low", "default", "high"];
/** The problems with a notifications.json, or none. */
export function checkNotifications(file) {
    const problems = [];
    const channels = Object.keys(file.channels ?? {});
    for (const [id, channel] of Object.entries(file.channels ?? {})) {
        if (!KEY.test(id))
            problems.push(`channel "${id}": ids are lowercase snake case`);
        if (!channel.name)
            problems.push(`channel "${id}": needs a name`);
        if (channel.importance && !IMPORTANCES.includes(channel.importance)) {
            problems.push(`channel "${id}": importance is one of ${IMPORTANCES.join(", ")}`);
        }
    }
    if (!file.notifications || typeof file.notifications !== "object")
        return [...problems, "needs a notifications object"];
    for (const [key, spec] of Object.entries(file.notifications)) {
        if (!KEY.test(key))
            problems.push(`"${key}": keys are lowercase snake case`);
        if (typeof spec.title !== "string" || typeof spec.body !== "string")
            problems.push(`"${key}": needs a title and a body`);
        if (spec.interruption && !INTERRUPTIONS.includes(spec.interruption)) {
            problems.push(`"${key}": interruption is one of ${INTERRUPTIONS.join(", ")}`);
        }
        if (spec.channel && !channels.includes(spec.channel))
            problems.push(`"${key}": no channel "${spec.channel}"`);
    }
    return problems;
}
/** `{{name}}` → `data.name` (missing ones become empty). */
export function render(template, data) {
    return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name) => {
        const value = data[name];
        return value === undefined ? "" : String(value);
    });
}
/** The Android channel a notification posts to. */
export function channelOf(file, key) {
    return file.notifications[key]?.channel ?? Object.keys(file.channels ?? {})[0];
}
