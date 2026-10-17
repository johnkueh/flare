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
/** The problems with a notifications.json, or none. */
export declare function checkNotifications(file: NotificationsFile): string[];
/** `{{name}}` → `data.name` (missing ones become empty). */
export declare function render(template: string, data: Data): string;
/** The Android channel a notification posts to. */
export declare function channelOf(file: NotificationsFile, key: string): string | undefined;
