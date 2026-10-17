import type { PushMessage, PushPlatform, SendResult } from "./message.ts";
import { type Data, type NotificationKey, type NotificationsFile } from "./schema.ts";
export { apnsPayload, resetApnsToken, sendApns, type ApnsConfig } from "./apns.ts";
export { fcmPayload, resetFcmToken, sendFcm, type FcmServiceAccount } from "./fcm.ts";
export type { PushMessage, PushPlatform, SendResult } from "./message.ts";
export { checkNotifications, render, type Data, type NotificationKey, type NotificationsFile } from "./schema.ts";
export interface PushEnv {
    DB: D1Database;
    /** Where notify() puts messages. Without it they're sent right away. */
    PUSH_QUEUE?: Queue<PushMessage>;
    /** The APNs .p8 key's contents, its key id and your team id. */
    APNS_KEY?: string;
    APNS_KEY_ID?: string;
    APNS_TEAM_ID?: string;
    /** Comma-separated bundle ids (e.g. "com.example.app,com.example.app.dev"); the first is the default. */
    APNS_TOPICS?: string;
    /** The Firebase service account JSON. */
    FCM_SERVICE_ACCOUNT?: string;
}
export type Permission = "allowed" | "quiet" | "blocked" | "not_asked";
/** Who a request is: the device, and the member it belongs to (the user,
 *  or before accounts the device itself). */
export type Identity = {
    device: string;
    member: string;
};
export interface FlarePushOptions<F extends NotificationsFile> {
    /** The app's notifications.json. */
    notifications: F;
    /** For `http()`: who the request is, or the response refusing it. */
    identify?: (request: Request) => Promise<Identity | Response>;
    /** Where the routes are mounted. Default "/v1". */
    prefix?: string;
    /** For tests: what APNs, FCM and Google's OAuth are reached with. */
    fetch?: typeof fetch;
    /** One JSON line per send result. Default console.log. */
    log?: (event: Record<string, unknown>) => void;
}
export type Recipients = {
    devices: string[];
} | {
    members: string[];
};
export interface NotifyOptions {
    /** What collapsing is per (a list, a chat): `key:scope` becomes the
     *  collapse id and the iOS thread id. Default: the key alone. */
    scope?: string;
    /** A device not to notify, typically the one that made the change. */
    except?: string;
}
export declare function flarePush<F extends NotificationsFile>(env: PushEnv, options: FlarePushOptions<F>): {
    http: (request: Request) => Promise<Response> | null;
    notify: (key: NotificationKey<F>, to: Recipients, data?: Data, notifyOptions?: NotifyOptions) => Promise<PushMessage[]>;
    deliver: (messages: PushMessage[]) => Promise<SendResult[]>;
    queue: (batch: MessageBatch<PushMessage>) => Promise<void>;
};
export type FlarePush<F extends NotificationsFile> = ReturnType<typeof flarePush<F>>;
/** Moves a member's devices to another member id, as when an anonymous
 *  user signs in to an account (call it next to relinkMember). */
export declare function relinkPushMember(env: Pick<PushEnv, "DB">, from: string, to: string): Promise<void>;
type Device = {
    platform: PushPlatform;
    token: string;
    apnsEnv: "sandbox" | "production" | null;
    appId: string | null;
    permission: Permission;
    mutedChannels: string[];
    locale: string | null;
};
/** The PUT body, or what's wrong with it. */
export declare function parseDevice(body: Record<string, unknown> | null): Device | string;
