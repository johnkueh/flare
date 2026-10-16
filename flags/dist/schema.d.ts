/** One flag in flags.json. Its type comes from `default`. */
export interface FlagDef {
    /** The value until the server says otherwise, and whenever it can't. */
    readonly default: unknown;
    /** Change at once, even on screen (kill switches). Default: false. */
    readonly live?: boolean;
    readonly description?: string;
    /** Only to say "number" for a whole-number default that may get a fraction. */
    readonly type?: "boolean" | "integer" | "number" | "string" | "object" | string;
}
/** The parsed flags.json: `import flags from "./flags.json"`. */
export interface FlagsFile {
    readonly flags: {
        readonly [key: string]: FlagDef;
    };
}
export type FlagKey<F extends FlagsFile> = Extract<keyof F["flags"], string>;
export type FlagValue<F extends FlagsFile, K extends FlagKey<F>> = F["flags"][K]["default"];
export type FlagValues<F extends FlagsFile> = {
    [K in FlagKey<F>]: FlagValue<F, K>;
};
export type Kind = "boolean" | "integer" | "number" | "string" | "object";
/** Flagship's limit on keys, and what the generated Swift/Kotlin can name. */
export declare const KEY: RegExp;
export declare function kindOf(key: string, def: FlagDef): Kind;
export declare function accepts(kind: Kind, v: unknown): boolean;
/** Every flag's kind, checking flags.json on the way. */
export declare function kinds(file: FlagsFile): Map<string, Kind>;
export declare const PATH = "/ofrep/v1/evaluate/flags";
export type ContextValue = string | number | boolean;
export type EvaluationContext = {
    targetingKey?: string;
} & Record<string, ContextValue | undefined>;
export interface FlagResult {
    key: string;
    value?: unknown;
    reason?: string;
    variant?: string;
    errorCode?: string;
    errorDetails?: string;
}
export interface BulkResponse {
    flags: FlagResult[];
}
