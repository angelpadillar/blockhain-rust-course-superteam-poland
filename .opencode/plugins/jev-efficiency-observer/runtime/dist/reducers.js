const OMITTED = (n) => `[... ${n} lines omitted ...]`;
const COLLAPSED = (n) => `[... ${n} identical lines collapsed ...]`;
/**
 * Many agent tools (including OpenCode's `read`) prefix every line with a line
 * number (`123: text` or `123| text`). Matching must look at the content after
 * that prefix, while the emitted line stays byte-exact.
 */
const LINE_PREFIX = /^(\s*\d+(?::|\|)\s?)(.*)$/;
const lineContent = (line) => line.match(LINE_PREFIX)?.[2] ?? line;
const isToolHeader = (line) => /^\s*Read file /.test(lineContent(line));
/** Keep `isKept` lines in order, collapsing dropped runs into a fixed marker. */
function collapse(lines, { maxKept, isKept }) {
    const out = [];
    const kept = [];
    let pending = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (kept.length < maxKept && isKept(line, i)) {
            if (pending > 0)
                out.push(OMITTED(pending));
            pending = 0;
            out.push(line);
            kept.push(i);
        }
        else {
            pending += 1;
        }
    }
    if (pending > 0)
        out.push(OMITTED(pending));
    return { text: out.join('\n'), kept };
}
function leadingHeaderEnd(lines) {
    let i = 0;
    const comment = /^\s*(\/\/|#|\*|\/\*|\*\/|'''|"""|<!--|-->|$)/;
    for (; i < lines.length && i < 20; i += 1) {
        if (!comment.test(lineContent(lines[i] ?? '')))
            break;
    }
    return i;
}
const DECLARATION = /^\s*(import|export|from|package|using|#include|require)\b|^\s*(export\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(const|let|var|function|class|interface|type|enum|def|fn|struct|impl|public|private|protected|static|readonly|return)\b/;
const MARKER = /\b(FIXME|TODO|NOTE|HACK|XXX)\b|@ts-(ignore|expect-error|nocheck)|eslint-disable/;
export class LongFileReadReducer {
    maxKeptLines;
    resultClass = 'long-file-read';
    constructor(maxKeptLines = 40) {
        this.maxKeptLines = maxKeptLines;
    }
    reduce(result) {
        const lines = result.text.split('\n');
        const headerEnd = leadingHeaderEnd(lines);
        const { text, kept } = collapse(lines, {
            maxKept: this.maxKeptLines,
            isKept: (line, i) => isToolHeader(line) ||
                (i < headerEnd && lineContent(line).trim() !== '') ||
                DECLARATION.test(lineContent(line)) ||
                MARKER.test(lineContent(line)),
        });
        if (text.length >= result.text.length || kept.length === 0)
            return null;
        return { text, strategy: 'header, declarations and marker lines only', exact: true, preservedLines: kept };
    }
}
const LOG_KEEP = /\b(error|errors|warning|warnings|failed|failure|fatal|panic|exception|traceback|ERR!|ERR_|not ok|cannot|undefined reference)\b|✕|×|✗|FAIL\b/i;
export class ShellBuildLogReducer {
    maxKeptLines;
    resultClass = 'shell-build-log';
    constructor(maxKeptLines = 30) {
        this.maxKeptLines = maxKeptLines;
    }
    reduce(result) {
        const lines = result.text.split('\n');
        const tailStart = Math.max(0, lines.length - 3);
        const { text, kept } = collapse(lines, {
            maxKept: this.maxKeptLines,
            isKept: (line, i) => LOG_KEEP.test(lineContent(line)) || i >= tailStart,
        });
        if (text.length >= result.text.length || kept.length === 0)
            return null;
        return { text, strategy: 'diagnostic and summary lines only', exact: true, preservedLines: kept };
    }
}
const TEST_KEEP = /(✕|×|●|✗|FAIL\b|AssertionError|Expected .* (to|received)|Received|Error:|at .*\(|Tests?\s+\d+\s+failed|Test Files?\s+\d+\s+failed|\d+\s+failing)/i;
export class TestFailureReducer {
    maxKeptLines;
    resultClass = 'test-failure';
    constructor(maxKeptLines = 40) {
        this.maxKeptLines = maxKeptLines;
    }
    reduce(result) {
        const lines = result.text.split('\n');
        const tailStart = Math.max(0, lines.length - 4);
        const { text, kept } = collapse(lines, {
            maxKept: this.maxKeptLines,
            isKept: (line, i) => TEST_KEEP.test(lineContent(line)) || i >= tailStart,
        });
        if (text.length >= result.text.length || kept.length === 0)
            return null;
        return { text, strategy: 'failing assertions and summary lines only', exact: true, preservedLines: kept };
    }
}
export class SearchResultsReducer {
    maxUniqueLines;
    resultClass = 'search-results';
    constructor(maxUniqueLines = 30) {
        this.maxUniqueLines = maxUniqueLines;
    }
    reduce(result) {
        const lines = result.text.split('\n');
        const seen = new Set();
        const out = [];
        const kept = [];
        let collapsed = 0;
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i] ?? '';
            const key = lineContent(line).trim();
            if (kept.length < this.maxUniqueLines && !seen.has(key)) {
                seen.add(key);
                out.push(line);
                kept.push(i);
            }
            else if (key !== '') {
                collapsed += 1;
            }
        }
        if (collapsed > 0)
            out.push(COLLAPSED(collapsed));
        const text = out.join('\n');
        if (text.length >= result.text.length || kept.length === 0)
            return null;
        return { text, strategy: 'unique hits only', exact: true, preservedLines: kept };
    }
}
/** A compact, deterministic shape of a JSON payload (types + sizes, no values). */
function jsonShape(value, depth = 0) {
    const pad = '  '.repeat(depth);
    if (value === null)
        return 'null';
    if (Array.isArray(value)) {
        if (value.length === 0)
            return '[]';
        return `[\n${pad}  ${jsonShape(value[0], depth + 1)}\n${pad}  ... ${value.length} items ...\n${pad}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value);
        const body = entries
            .slice(0, 40)
            .map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${jsonShape(v, depth + 1)}`)
            .join('\n');
        const more = entries.length > 40 ? `\n${pad}  ... ${entries.length - 40} more keys ...` : '';
        return `{\n${body}${more}\n${pad}}`;
    }
    return typeof value;
}
export class LargeJsonReducer {
    resultClass = 'large-json';
    reduce(result) {
        let parsed;
        try {
            parsed = JSON.parse(result.text);
        }
        catch {
            return null;
        }
        const text = jsonShape(parsed);
        if (text.length === 0 || text.length >= result.text.length)
            return null;
        return { text, strategy: 'json shape summary (keys and types only)', exact: false, preservedLines: [] };
    }
}
export class ReducerRegistry {
    map = new Map();
    constructor(reducers = []) {
        for (const r of reducers)
            this.register(r);
    }
    register(reducer) {
        this.map.set(reducer.resultClass, reducer);
        return this;
    }
    get(resultClass) {
        return this.map.get(resultClass);
    }
    has(resultClass) {
        return this.map.has(resultClass);
    }
    classes() {
        return [...this.map.keys()].sort();
    }
}
export function defaultReducerRegistry() {
    return new ReducerRegistry([
        new LongFileReadReducer(),
        new ShellBuildLogReducer(),
        new TestFailureReducer(),
        new SearchResultsReducer(),
        new LargeJsonReducer(),
    ]);
}
