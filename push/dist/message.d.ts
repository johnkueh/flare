import type { Interruption } from "./schema.ts";
export type PushPlatform = "ios" | "android";
export interface PushMessage {
    v: 1;
    /** Which notifications.json entry. */
    key: string;
    device: string;
    platform: PushPlatform;
    token: string;
    /** iOS: which APNs host the token belongs to. */
    apnsEnv?: "sandbox" | "production";
    /** iOS bundle id, the APNs topic. */
    appId?: string;
    title: string;
    body: string;
    /** Replaces an earlier notification with the same id on the phone. */
    collapseId?: string;
    /** iOS groups notifications with the same thread id. */
    threadId?: string;
    interruption: Interruption;
    channel?: string;
    sound: boolean;
    /** Delivered to the app with the notification. Strings only (FCM's rule). */
    data: Record<string, string>;
}
/** What APNs or FCM said, reduced to what the consumer does next. */
export type SendResult = {
    status: "sent";
    id?: string;
}
/** The token is dead: delete it. */
 | {
    status: "gone";
    reason: string;
}
/** Try again later (rate limited, the service is down, a network error). */
 | {
    status: "retry";
    reason: string;
    after?: number;
}
/** Won't work however often we try (a bad payload, missing credentials). */
 | {
    status: "failed";
    reason: string;
};
