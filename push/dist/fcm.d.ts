import type { PushMessage, SendResult } from "./message.ts";
/** The service account JSON Firebase gives you (the fields used). */
export interface FcmServiceAccount {
    project_id: string;
    client_email: string;
    private_key: string;
    token_uri?: string;
}
export declare function resetFcmToken(): void;
/** The message FCM gets. `notification` makes Android show it while the
 *  app is in the background; `data` reaches the app either way. */
export declare function fcmPayload(message: PushMessage): object;
export declare function sendFcm(account: FcmServiceAccount, message: PushMessage, options?: {
    fetch?: typeof fetch;
    now?: number;
}): Promise<SendResult>;
