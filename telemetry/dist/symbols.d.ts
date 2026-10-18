/** One architecture inside a Mach-O file (a fat file has several). */
export type MachOSlice = {
    arch: string;
    /** Uppercase, dashed, as MetricKit's `binaryUUID` prints it. */
    uuid: string;
    /** Where `__TEXT` starts; a frame's address is this plus its offset. */
    textVmaddr: bigint;
};
/** A UUID in one shape whatever wrote it: uppercase, dashed. */
export declare function normalizeUuid(id: string): string | null;
/** The slices of a Mach-O file (an executable, a framework, or a dSYM's
 *  DWARF file). Empty when it isn't one. */
export declare function machOSlices(bytes: Uint8Array): MachOSlice[];
type MappedMember = {
    /** `bar`, or `com.other.Util.helper` when inlined from another class. */
    name: string;
    obf: string;
    minStart: number | null;
    minEnd: number | null;
    origStart: number | null;
    origEnd: number | null;
};
type MappedClass = {
    original: string;
    fileName: string | null;
    members: MappedMember[];
};
export type Mapping = Map<string, MappedClass>;
/** Parses mapping.txt, keyed by the obfuscated class name. Fields are skipped. */
export declare function parseMapping(text: string): Mapping;
export type JavaFrame = {
    className: string;
    method: string;
    file: string | null;
    line: number | null;
};
/** One obfuscated frame back to the real one, or several when R8 inlined
 *  methods into it (innermost first, the way a stack trace reads). Frames
 *  of classes the mapping doesn't know (the OS, kept classes) come back as is. */
export declare function retraceFrame(mapping: Mapping, frame: JavaFrame): JavaFrame[];
/** A frame as the SDK sends it (TELEMETRY.md, "Crashes"). */
export type EventFrame = {
    module?: string;
    function?: string;
    file_line?: string;
    offset?: number;
    image_id?: string;
    in_app?: boolean;
};
/** A frame after symbols: what to print. `inlined` frames sit inside the
 *  real frame that follows them. */
export type ReadableFrame = {
    module: string;
    function: string | null;
    fileLine: string | null;
    inApp: boolean;
    inlined?: boolean;
    /** Why it is still unreadable, e.g. no dSYM for that UUID. */
    missing?: string;
};
/** `a.b.C.method` + `SourceFile:12` as the Kotlin layer sends them. */
export declare function javaFrame(f: EventFrame): JavaFrame | null;
/** Parses one line of `atos -i` output: `Foo.bar() (in Cooked) (Foo.swift:42)`.
 *  Null when atos only echoed the address back. */
export declare function parseAtosLine(line: string): {
    function: string;
    fileLine: string | null;
} | null;
/** Parses `llvm-symbolizer --output-style=JSON` for several addresses: per
 *  address, its frames innermost (inlined) first; empty when unknown. */
export declare function parseSymbolizerJson(json: string): {
    function: string;
    fileLine: string | null;
}[][];
/** The address to look up in the dSYM: `__TEXT` start plus the frame's
 *  offset. A return address points just past its call, so callers look up
 *  one byte earlier to land on the call's line (`isReturnAddress`). */
export declare function frameAddress(slice: MachOSlice, offset: number, isReturnAddress: boolean): string;
/** Fixed-width lines for a terminal. */
export declare function formatFrames(frames: ReadableFrame[]): string[];
export {};
