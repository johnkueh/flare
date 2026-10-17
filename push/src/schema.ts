// notifications.json: every kind of notification an app sends, with its
// text and how the phone shows it. The Worker renders from it; the Swift
// and Kotlin clients read its channels (PUSH.md).

export type Interruption = "passive" | "active" | "time-sensitive";
export type Importance = "min" | "low" | "default" | "high";

export interface ChannelSpec {
  /** What Android's settings call it. */
  name: string;
  description?: string;
  /** Android channel importance. Default "default". */
  importance?: Importance;
}

export interface NotificationSpec {
  /** `{{name}}` is replaced with `data.name`. */
  title: string;
  body: string;
  /**
   * A newer one replaces the older one on the phone instead of stacking
   * (APNs `apns-collapse-id`, Android `tag`), per `scope` when notify()
   * gets one. Default false.
   */
  collapse?: boolean;
  /** iOS interruption level. "passive" also sends at low priority. Default "active". */
  interruption?: Interruption;
  /** Android channel id from `channels`. Default: the first channel. */
  channel?: string;
  /** Play the default sound. Default true. */
  sound?: boolean;
  description?: string;
}

export interface NotificationsFile {
  $schema?: string;
  channels?: Record<string, ChannelSpec>;
  notifications: Record<string, NotificationSpec>;
}

export type NotificationKey<F extends NotificationsFile> = Extract<keyof F["notifications"], string>;

export type Data = Record<string, string | number | boolean>;

const KEY = /^[a-z][a-z0-9_]{0,63}$/;
const INTERRUPTIONS: readonly string[] = ["passive", "active", "time-sensitive"];
const IMPORTANCES: readonly string[] = ["min", "low", "default", "high"];

/** The problems with a notifications.json, or none. */
export function checkNotifications(file: NotificationsFile): string[] {
  const problems: string[] = [];
  const channels = Object.keys(file.channels ?? {});
  for (const [id, channel] of Object.entries(file.channels ?? {})) {
    if (!KEY.test(id)) problems.push(`channel "${id}": ids are lowercase snake case`);
    if (!channel.name) problems.push(`channel "${id}": needs a name`);
    if (channel.importance && !IMPORTANCES.includes(channel.importance)) {
      problems.push(`channel "${id}": importance is one of ${IMPORTANCES.join(", ")}`);
    }
  }
  if (!file.notifications || typeof file.notifications !== "object") return [...problems, "needs a notifications object"];
  for (const [key, spec] of Object.entries(file.notifications)) {
    if (!KEY.test(key)) problems.push(`"${key}": keys are lowercase snake case`);
    if (typeof spec.title !== "string" || typeof spec.body !== "string") problems.push(`"${key}": needs a title and a body`);
    if (spec.interruption && !INTERRUPTIONS.includes(spec.interruption)) {
      problems.push(`"${key}": interruption is one of ${INTERRUPTIONS.join(", ")}`);
    }
    if (spec.channel && !channels.includes(spec.channel)) problems.push(`"${key}": no channel "${spec.channel}"`);
  }
  return problems;
}

/** `{{name}}` → `data.name` (missing ones become empty). */
export function render(template: string, data: Data): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name: string) => {
    const value = data[name];
    return value === undefined ? "" : String(value);
  });
}

/** The Android channel a notification posts to. */
export function channelOf(file: NotificationsFile, key: string): string | undefined {
  return file.notifications[key]?.channel ?? Object.keys(file.channels ?? {})[0];
}
