// Readable crash stacks, worked out when you read a crash rather than when it
// arrives (the Worker never sees symbols). `flare-telemetry symbols` uploads
// what a release build leaves behind, `flare-telemetry crash` reads one crash
// and turns its frames back into names:
//
// - Apple: frames are binary + offset + the binary's UUID (MetricKit has no
//   symbols). The dSYM with that UUID, run through atos or llvm-symbolizer,
//   gives the function and file:line.
// - Android: R8 renames classes and methods. Its mapping.txt, matched by the
//   app's build number, turns `a.b.c(SourceFile:12)` back into the real name
//   and line.
//
// Everything here is pure (bytes and text in, data out); bin/ does the files,
// R2 and processes.
const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
/** A UUID in one shape whatever wrote it: uppercase, dashed. */
export function normalizeUuid(id) {
    const hex = id.replace(/-/g, "").toUpperCase();
    if (!/^[0-9A-F]{32}$/.test(hex))
        return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function archName(cputype, cpusubtype) {
    const sub = cpusubtype & 0xff;
    switch (cputype) {
        case 0x0100000c:
            return sub === 2 ? "arm64e" : "arm64";
        case 0x0200000c:
            return "arm64_32";
        case 0x01000007:
            return sub === 8 ? "x86_64h" : "x86_64";
        case 12:
            return "armv7";
        case 7:
            return "i386";
        default:
            return `cpu${cputype}`;
    }
}
function thinSlice(view, start) {
    const magic = view.getUint32(start, true);
    const is64 = magic === 0xfeedfacf;
    if (!is64 && magic !== 0xfeedface)
        return null;
    const cputype = view.getUint32(start + 4, true);
    const cpusubtype = view.getUint32(start + 8, true);
    const ncmds = view.getUint32(start + 16, true);
    let at = start + (is64 ? 32 : 28);
    let uuid = null;
    let textVmaddr = null;
    for (let i = 0; i < ncmds && at + 8 <= view.byteLength; i++) {
        const cmd = view.getUint32(at, true);
        const size = view.getUint32(at + 4, true);
        if (cmd === LC_UUID) {
            let hex = "";
            for (let b = 0; b < 16; b++)
                hex += view.getUint8(at + 8 + b).toString(16).padStart(2, "0");
            uuid = normalizeUuid(hex);
        }
        else if (cmd === LC_SEGMENT_64 || cmd === LC_SEGMENT) {
            let name = "";
            for (let b = 0; b < 16; b++) {
                const c = view.getUint8(at + 8 + b);
                if (c === 0)
                    break;
                name += String.fromCharCode(c);
            }
            if (name === "__TEXT") {
                textVmaddr = cmd === LC_SEGMENT_64 ? view.getBigUint64(at + 24, true) : BigInt(view.getUint32(at + 24, true));
            }
        }
        if (size < 8)
            break;
        at += size;
    }
    if (!uuid)
        return null;
    return { arch: archName(cputype, cpusubtype), uuid, textVmaddr: textVmaddr ?? 0n };
}
/** The slices of a Mach-O file (an executable, a framework, or a dSYM's
 *  DWARF file). Empty when it isn't one. */
export function machOSlices(bytes) {
    if (bytes.byteLength < 32)
        return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(0, false);
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
        const wide = magic === 0xcafebabf;
        const count = view.getUint32(4, false);
        const out = [];
        for (let i = 0; i < count; i++) {
            const entry = 8 + i * (wide ? 32 : 20);
            if (entry + 16 > view.byteLength)
                break;
            const offset = wide ? Number(view.getBigUint64(entry + 8, false)) : view.getUint32(entry + 8, false);
            if (offset + 32 > view.byteLength)
                continue;
            const slice = thinSlice(view, offset);
            if (slice)
                out.push(slice);
        }
        return out;
    }
    const slice = thinSlice(view, 0);
    return slice ? [slice] : [];
}
const CLASS_LINE = /^(\S+) -> (\S+):$/;
const MEMBER_LINE = /^\s+(?:(\d+):(\d+):)?\S+\s+([^\s(]+)\([^)]*\)(?::(\d+)(?::(\d+))?)?\s+->\s+(\S+)$/;
/** Parses mapping.txt, keyed by the obfuscated class name. Fields are skipped. */
export function parseMapping(text) {
    const classes = new Map();
    let current = null;
    for (const line of text.split("\n")) {
        if (line.startsWith("#")) {
            if (current && line.includes('"sourceFile"')) {
                const name = /"fileName"\s*:\s*"([^"]+)"/.exec(line);
                if (name)
                    current.fileName = name[1];
            }
            continue;
        }
        const cls = CLASS_LINE.exec(line);
        if (cls) {
            current = { original: cls[1], fileName: null, members: [] };
            classes.set(cls[2], current);
            continue;
        }
        if (!current)
            continue;
        if (line.trimStart().startsWith("#")) {
            // Member-level metadata (synthesized, outline, …): not needed to rename.
            continue;
        }
        const m = MEMBER_LINE.exec(line);
        if (!m)
            continue;
        const num = (s) => (s === undefined ? null : Number(s));
        current.members.push({
            name: m[3],
            obf: m[6],
            minStart: num(m[1]),
            minEnd: num(m[2]),
            origStart: num(m[4]),
            origEnd: num(m[5]),
        });
    }
    return classes;
}
function simpleFile(className) {
    const outer = className.slice(className.lastIndexOf(".") + 1).split("$")[0];
    return `${outer}.java`;
}
/** One obfuscated frame back to the real one, or several when R8 inlined
 *  methods into it (innermost first, the way a stack trace reads). Frames
 *  of classes the mapping doesn't know (the OS, kept classes) come back as is. */
export function retraceFrame(mapping, frame) {
    const cls = mapping.get(frame.className);
    if (!cls)
        return [frame];
    const named = cls.members.filter((m) => m.obf === frame.method);
    if (named.length === 0)
        return [{ ...frame, className: cls.original, file: cls.fileName ?? frame.file }];
    const line = frame.line;
    let hits = line === null ? [] : named.filter((m) => m.minStart !== null && m.minStart <= line && line <= (m.minEnd ?? m.minStart));
    if (hits.length > 0) {
        // An inline chain is consecutive entries over the same minified range.
        const first = hits[0];
        hits = hits.filter((m) => m.minStart === first.minStart && m.minEnd === first.minEnd);
    }
    else {
        hits = named.filter((m) => m.minStart === null);
        if (hits.length === 0)
            hits = named;
        // Without a line, R8 can't tell which of several methods it was.
        const names = [...new Set(hits.map((m) => m.name))];
        if (names.length > 1) {
            return [{ className: cls.original, method: names.join(" | "), file: cls.fileName, line: null }];
        }
        hits = hits.slice(0, 1);
    }
    return hits.map((m) => {
        const dot = m.name.lastIndexOf(".");
        const className = dot === -1 ? cls.original : m.name.slice(0, dot);
        const method = dot === -1 ? m.name : m.name.slice(dot + 1);
        let original = line;
        if (line !== null && m.minStart !== null && m.origStart !== null) {
            original = m.origEnd !== null ? m.origStart + (line - m.minStart) : m.origStart;
        }
        else if (m.origStart !== null) {
            original = m.origStart;
        }
        const file = className === cls.original ? (cls.fileName ?? simpleFile(className)) : simpleFile(className);
        return { className, method, file, line: original };
    });
}
/** `a.b.C.method` + `SourceFile:12` as the Kotlin layer sends them. */
export function javaFrame(f) {
    const fn = f.function;
    if (!fn)
        return null;
    const dot = fn.lastIndexOf(".");
    if (dot <= 0)
        return null;
    let file = null;
    let line = null;
    if (f.file_line) {
        const colon = f.file_line.lastIndexOf(":");
        const n = colon === -1 ? NaN : Number(f.file_line.slice(colon + 1));
        if (Number.isInteger(n)) {
            file = f.file_line.slice(0, colon);
            line = n;
        }
        else {
            file = f.file_line;
        }
    }
    return { className: fn.slice(0, dot), method: fn.slice(dot + 1), file, line };
}
/** Parses one line of `atos -i` output: `Foo.bar() (in Cooked) (Foo.swift:42)`.
 *  Null when atos only echoed the address back. */
export function parseAtosLine(line) {
    const s = line.trim();
    if (s === "" || /^0x[0-9a-f]+$/i.test(s))
        return null;
    const m = /^(.*?) \(in [^)]+\)(?: \((.+:\d+)\)| \+ \d+)?$/.exec(s);
    if (!m)
        return { function: s, fileLine: null };
    if (/^0x[0-9a-f]+$/i.test(m[1]))
        return null;
    return { function: m[1], fileLine: m[2] ?? null };
}
/** Parses `llvm-symbolizer --output-style=JSON` for several addresses: per
 *  address, its frames innermost (inlined) first; empty when unknown. */
export function parseSymbolizerJson(json) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return [];
    }
    return (Array.isArray(parsed) ? parsed : [parsed]).map((one) => (one.Symbol ?? [])
        .filter((s) => s.FunctionName && s.FunctionName !== "??")
        .map((s) => {
        const file = s.FileName ? s.FileName.slice(s.FileName.lastIndexOf("/") + 1) : "";
        return { function: s.FunctionName, fileLine: file && s.Line ? `${file}:${s.Line}` : null };
    }));
}
/** The address to look up in the dSYM: `__TEXT` start plus the frame's
 *  offset. A return address points just past its call, so callers look up
 *  one byte earlier to land on the call's line (`isReturnAddress`). */
export function frameAddress(slice, offset, isReturnAddress) {
    const at = slice.textVmaddr + BigInt(offset) - (isReturnAddress && offset > 0 ? 1n : 0n);
    return `0x${at.toString(16)}`;
}
/** Fixed-width lines for a terminal. */
export function formatFrames(frames) {
    const width = Math.min(28, Math.max(0, ...frames.map((f) => f.module.length)));
    let n = 0;
    return frames.map((f) => {
        const index = f.inlined ? "  " : String(n++).padStart(2);
        const mark = f.inApp ? "*" : " ";
        const what = f.function
            ? `${f.inlined ? "(inlined) " : ""}${f.function}${f.fileLine ? `  ${f.fileLine}` : ""}`
            : (f.fileLine ?? f.missing ?? "?");
        return `${index} ${mark} ${f.module.padEnd(width)}  ${what}`;
    });
}
