// Triggers: app code that runs after documents change, whoever changed
// them (a phone's push, a web page's write, the server itself).
//
// Each space reports what it committed to the SYNC_TRIGGERS queue the Worker
// binds, and keeps trying until the queue takes it. The Worker's queue
// handler hands the batch to `syncTriggers`, which reads each changed
// document as it is now and calls that collection's trigger:
//
//   "queues": {
//     "producers": [{ "binding": "SYNC_TRIGGERS", "queue": "my-app-sync-triggers" }],
//     "consumers": [{ "queue": "my-app-sync-triggers", "max_batch_timeout": 1 }]
//   }
//
//   export default {
//     fetch,
//     queue: (batch, env) => syncTriggers(env, triggers).queue(batch),
//   };
//
// Delivery is at least once, and a document that changes several times in
// quick succession may be seen once, as it ended up. Triggers act on a
// document's state ("queued") rather than on the change, and must be safe to
// run twice.
//
// Each trigger has a budget per space, 50 calls a day unless it sets its
// own, so a flood of changes (or a trigger re-triggering itself) can't run
// up a bill. Documents over budget go to its `limited` handler instead.
// See SYNC.md, "Reacting to changes on the server".

import type { Doc, Write } from "./docs";
import type { Result, TriggerMessage } from "./space";
import { serverWrite, spaceStub, type SpacesEnv } from "./spaces";

export type { TriggerMessage };

/** One collection's trigger. */
export type Trigger<E> = {
  /** Only changes to these fields call it (a delete always does). Leave
   *  out the fields the trigger itself writes back. */
  fields?: string[];
  /** Calls per space, one per changed document, in a fixed window.
   *  DEFAULT_LIMIT when left out; false for none. */
  limit?: Limit | false;
  changed(change: Changed<E>): void | Promise<void>;
  /** A document over the budget, so the app can show it (write
   *  `status: "limited"`, say). Without it, the document is logged and
   *  skipped. Either way it isn't tried again. */
  limited?(change: Changed<E>): void | Promise<void>;
};

export type Limit = { count: number; per: "minute" | "hour" | "day" };

/** Strict on purpose: a trigger can start paid work. Raise it per trigger. */
export const DEFAULT_LIMIT: Limit = { count: 50, per: "day" };

const WINDOW_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

/** A changed document, as it is now. */
export type Changed<E> = {
  env: E;
  space: TriggerSpace;
  /** The document's id, also when it has been deleted. */
  id: string;
  /** Merged, or null when the document has been deleted. */
  doc: Doc | null;
};

/** The space a change happened in. */
export type TriggerSpace = {
  id: string;
  /** Writes as the server (see `serverWrite`). */
  write(writes: Write[]): Promise<Result<{ version: number }>>;
};

/** Triggers by collection name. */
export type SyncTriggers<E> = Record<string, Trigger<E>>;

export function syncTriggers<E extends Pick<SpacesEnv, "SPACES">>(env: E, triggers: SyncTriggers<E>) {
  const collections = Object.fromEntries(Object.entries(triggers).map(([c, t]) => [c, t.fields ?? null]));

  /** Calls the triggers for one reported range. Throws when one fails, so
   *  the queue retries the range. */
  async function run(message: TriggerMessage) {
    const stub = spaceStub(env, message.spaceId);
    // A space that's gone has nothing left to react to.
    if (!stub) return;
    const result = await stub.changedDocs(message.from, message.to, collections);
    if (!result.ok) return;
    const space: TriggerSpace = { id: message.spaceId, write: (writes) => serverWrite(env, message.spaceId, writes) };
    for (const [c, trigger] of Object.entries(triggers)) {
      const docs = result.docs.filter((d) => d.c === c);
      if (!docs.length) continue;
      const limit = trigger.limit === undefined ? DEFAULT_LIMIT : trigger.limit;
      let granted = docs.length;
      if (limit) {
        const taken = await stub.take(c, limit.count, WINDOW_MS[limit.per], docs.length);
        if (!taken.ok) return;
        granted = taken.granted;
      }
      for (const { id, doc } of docs.slice(0, granted)) await trigger.changed({ env, space, id, doc });
      const over = docs.slice(granted);
      if (!over.length) continue;
      console.log(
        JSON.stringify({ event: "sync_trigger_limited", trigger: c, space: message.spaceId.slice(0, 8), skipped: over.length }),
      );
      for (const { id, doc } of over) await trigger.limited?.({ env, space, id, doc });
    }
  }

  /** The queue handler. A range whose trigger throws is retried (and
   *  goes to the dead-letter queue, when one is set, after the last try);
   *  the rest of the batch isn't. */
  async function queue(batch: MessageBatch<TriggerMessage>) {
    for (const message of batch.messages) {
      try {
        await run(message.body);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({ event: "sync_trigger_error", space: message.body.spaceId.slice(0, 8), detail: String(error).slice(0, 300) }),
        );
        message.retry();
      }
    }
  }

  return { queue, run };
}
