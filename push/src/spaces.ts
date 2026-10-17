// Notify the other members of a space (needs @sync/server).
//
//   await notifySpace(env, push, spaceId, { from: who.userId, except: who.deviceId },
//     "item_added", { actor: "Sam", item: "milk" });
//
// Sends to every member except `from`. The space's member list is the
// source of truth, so someone removed from a household stops getting its
// notifications at once.

import { spaceStub, type SpacesEnv } from "@sync/server/spaces";
import type { NotifyOptions, Recipients } from "./index.ts";
import type { PushMessage } from "./message.ts";
import type { Data } from "./schema.ts";

export interface NotifySpaceOptions extends NotifyOptions {
  /** The member making the change. They must be in the space; they're not notified. */
  from: string;
  /** Notify `from`'s other devices too. Default false. */
  includeSender?: boolean;
}

/** The part of flarePush() this uses. */
interface Notifier<K extends string> {
  notify(key: K, to: Recipients, data?: Data, options?: NotifyOptions): Promise<PushMessage[]>;
}

export async function notifySpace<K extends string>(
  env: Pick<SpacesEnv, "SPACES">,
  push: Notifier<K>,
  spaceId: string,
  options: NotifySpaceOptions,
  key: NoInfer<K>,
  data: Data = {},
): Promise<PushMessage[]> {
  const space = spaceStub(env, spaceId);
  if (!space) return [];
  const info = await space.info(options.from);
  if (!info.ok) return [];
  const members = info.info.devices.map((m) => m.id).filter((id) => options.includeSender || id !== options.from);
  return push.notify(key, { members }, data, { scope: options.scope ?? spaceId, except: options.except });
}
