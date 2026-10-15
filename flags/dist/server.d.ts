import { type EvaluationContext, type FlagKey, type FlagsFile, type FlagValue, type FlagValues } from "./schema.ts";
export type { EvaluationContext, FlagsFile, FlagValues } from "./schema.ts";
interface Details<T> {
    value: T;
    variant?: string;
    reason?: string;
    errorCode?: string;
    errorMessage?: string;
}
/** The part of Cloudflare's `Flagship` binding this package uses. */
export interface FlagshipBinding {
    getBooleanDetails(key: string, defaultValue: boolean, context?: object): Promise<Details<boolean>>;
    getStringDetails(key: string, defaultValue: string, context?: object): Promise<Details<string>>;
    getNumberDetails(key: string, defaultValue: number, context?: object): Promise<Details<number>>;
    getObjectDetails<T extends object>(key: string, defaultValue: T, context?: object): Promise<Details<T>>;
}
/** What the client sent, kept to the attributes worth trusting by default. */
export interface ClientContext {
    /** The signed-in user's id or the install's random id, as the app sent it. */
    targetingKey?: string;
    platform?: string;
    appVersion?: string;
    osVersion?: string;
    locale?: string;
}
export interface FlagsHttpOptions<F extends FlagsFile> {
    binding: FlagshipBinding;
    /** The app's flags.json. */
    flags: F;
    /** Mounted under a prefix, such as "/v1". Default: none. */
    prefix?: string;
    /**
     * The context Flagship evaluates with. Default: `defaults`, which is the
     * client's targetingKey, platform, appVersion, osVersion and locale plus
     * `country` from the request. Override it to use your own user id, or to
     * add attributes the client can't be trusted to send (a plan, a role):
     *
     *   context: async ({ request, defaults }) => ({
     *     ...defaults,
     *     targetingKey: (await whoIs(auth, request.headers))?.userId ?? defaults.targetingKey,
     *   })
     */
    context?: (args: {
        request: Request;
        client: ClientContext;
        defaults: EvaluationContext;
    }) => EvaluationContext | Promise<EvaluationContext>;
    /** Allow web pages on other origins: "*" or a list of origins. */
    cors?: "*" | readonly string[];
}
/** The flags endpoint for `request`, or null when it's for another route. */
export declare function flagsHttp<F extends FlagsFile>(request: Request, options: FlagsHttpOptions<F>): Promise<Response> | null;
/**
 * Every flag for `context`, typed from flags.json. A flag Flagship can't
 * evaluate (missing, wrong type) gets its default.
 *
 *   const { "new-checkout": newCheckout } = await evaluateFlags(env.FLAGS, flags, { targetingKey: userId });
 */
export declare function evaluateFlags<F extends FlagsFile>(binding: FlagshipBinding, flags: F, context?: EvaluationContext): Promise<FlagValues<F>>;
/** One flag for `context`, typed from flags.json. */
export declare function evaluateFlag<F extends FlagsFile, K extends FlagKey<F>>(binding: FlagshipBinding, flags: F, key: K, context?: EvaluationContext): Promise<FlagValue<F, K>>;
