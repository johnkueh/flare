import type { PushMessage, SendResult } from "./message.ts";
export interface ApnsConfig {
    /** The .p8 file's contents. */
    key: string;
    keyId: string;
    teamId: string;
    /** Bundle ids this Worker may send to; the first is the default topic. */
    topics: string[];
}
export declare function resetApnsToken(): void;
/** The JSON Apple gets. The app reads `data` from the notification's userInfo. */
export declare function apnsPayload(message: PushMessage): object;
export declare function sendApns(config: ApnsConfig, message: PushMessage, options?: {
    fetch?: typeof fetch;
    now?: number;
}): Promise<SendResult>;
