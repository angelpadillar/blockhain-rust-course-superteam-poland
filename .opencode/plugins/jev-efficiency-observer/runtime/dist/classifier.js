const head = (text, n) => (text.length <= n ? text : text.slice(0, n));
const BUILD_MARKER = /\b(tsc|npm|yarn|pnpm|vite|webpack|rollup|esbuild|make|cargo|go build|pip|poetry|gradle|maven)\b|error TS\d+|Build failed|Compilation (error|failed)/i;
const CODE_MARKER = /\b(function|class|interface|enum|struct|impl|export|import|from|const|let|var|def|fn|public|private|protected|async|await|return)\b|[{};]/;
const TEST_FAILURE = /(\d+\s+failing|Test Files?\s+\d+\s+failed|Tests?\s+\d+\s+failed|AssertionError|Expected .* (to|received)|●|✕|×|FAIL\b)/i;
const TEST_CONTEXT = /(tests?|specs?|assert|expect|describe|suite|it\()/i;
const SEARCH_LINE = /^\s*\S.*?:\d+(?::\d+)?[: ]/;
function looksLikeJson(text) {
    const t = text.trim();
    if (!(t.startsWith('{') || t.startsWith('[')))
        return false;
    try {
        JSON.parse(t);
        return true;
    }
    catch {
        return false;
    }
}
function searchLineCount(text) {
    let n = 0;
    for (const line of text.split('\n')) {
        if (SEARCH_LINE.test(line))
            n += 1;
        if (n >= 8)
            return n;
    }
    return n;
}
export const DEFAULT_RULES = [
    {
        resultClass: 'test-failure',
        confidence: 0.9,
        reason: 'failure markers plus test context',
        test: (r) => TEST_FAILURE.test(r.text) && TEST_CONTEXT.test(r.text),
    },
    {
        resultClass: 'shell-build-log',
        confidence: 0.8,
        reason: 'build/toolchain markers in the command-output head',
        test: (r) => (r.kind === 'shell' || r.kind === undefined || r.kind === 'unknown') && BUILD_MARKER.test(head(r.text, 4000)) && r.text.length >= 200,
    },
    {
        resultClass: 'large-json',
        confidence: 0.75,
        reason: 'parseable JSON payload',
        test: (r) => (r.kind === 'json' || looksLikeJson(r.text)) && r.text.length >= 200,
    },
    {
        resultClass: 'search-results',
        confidence: 0.7,
        reason: 'many path:line search hits',
        test: (r) => r.kind === 'search' || searchLineCount(r.text) >= 8,
    },
    {
        resultClass: 'long-file-read',
        confidence: 0.7,
        reason: 'file read or code-shaped text',
        test: (r) => (r.kind === 'file-read' || (r.kind === undefined && CODE_MARKER.test(r.text))) && r.text.length >= 200,
    },
];
export class ToolResultClassifier {
    rules;
    constructor(rules = DEFAULT_RULES) {
        this.rules = rules;
    }
    classify(result) {
        for (const rule of this.rules) {
            if (rule.test(result)) {
                return { resultClass: rule.resultClass, confidence: rule.confidence, reasons: [rule.reason] };
            }
        }
        return { resultClass: null, confidence: 0, reasons: ['no rule matched'] };
    }
}
