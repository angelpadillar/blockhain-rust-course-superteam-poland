export const TOOL_FAMILIES = [
    {
        id: 'file_read',
        description: 'Read or open the contents of workspace files.',
        members: ['read_files', 'read_file', 'open_file_in_editor', 'cat', 'view_file', 'editor_open'],
        keywords: ['read', 'open', 'cat', 'view', 'inspect', 'file'],
    },
    {
        id: 'file_search',
        description: 'Search or list workspace files and symbols without reading whole files.',
        members: ['search_codebase', 'grep_search', 'ripgrep_search', 'glob_files', 'list_directory', 'find_files', 'search_files'],
        keywords: ['search', 'grep', 'glob', 'find', 'list', 'locate'],
    },
    {
        id: 'code_edit',
        description: 'Create, edit, patch, rename or format workspace source files.',
        members: ['editor', 'write_file', 'write_to_file', 'replace_in_file', 'apply_patch', 'rename_symbol', 'format_document'],
        keywords: ['edit', 'write', 'patch', 'replace', 'rename', 'format', 'create'],
    },
    {
        id: 'code_validation',
        description: 'Standalone validation tools, when a registry exposes them separately from the shell. ' +
            'In registries with a single command runner, validation is a tag inside `shell` instead.',
        members: [],
        keywords: [],
    },
    {
        id: 'shell',
        description: 'Run shell commands: arbitrary commands, tests, typechecks and linters, and read their output.',
        members: [
            'run_commands',
            'run_tests',
            'run_typecheck',
            'run_linter',
            'execute_command',
            'shell',
            'bash',
            'terminal',
            'vitest',
            'tsc',
            'eslint',
        ],
        keywords: ['command', 'shell', 'run', 'exec', 'terminal', 'test', 'tests', 'typecheck', 'lint', 'validate', 'verify', 'build'],
    },
    {
        id: 'git',
        description: 'Inspect or change version-control state.',
        members: ['git_status', 'git_diff', 'git_commit', 'git_checkout', 'git_log'],
        keywords: ['git', 'commit', 'branch', 'checkout', 'diff', 'status'],
    },
    {
        id: 'browser_observation',
        description: 'Observe a web page without acting on it: screenshots, DOM snapshots, extraction.',
        members: ['browser_screenshot', 'browser_snapshot', 'browser_extract', 'browser_read'],
        keywords: ['screenshot', 'snapshot', 'observe', 'extract', 'dom'],
    },
    {
        id: 'browser_navigation',
        description: 'Navigate to or find web pages and URLs.',
        members: ['browser_navigate', 'web_fetch', 'web_search', 'browser_open'],
        keywords: ['navigate', 'fetch', 'url', 'web', 'search web', 'open page'],
    },
    {
        id: 'browser_interaction',
        description: 'Interact with a web page: click, type, scroll, select, press.',
        members: ['browser_click', 'browser_type', 'browser_scroll', 'browser_select', 'browser_press'],
        keywords: ['click', 'type', 'scroll', 'select', 'press', 'fill', 'submit'],
    },
    {
        id: 'memory',
        description: 'Record or recall bounded causal memory episodes.',
        members: ['memory_recall', 'memory_write'],
        keywords: ['memory', 'recall', 'remember', 'episode'],
    },
    {
        id: 'mcp_external',
        description: 'Call an external system through MCP (GitHub, Slack, databases, tickets).',
        members: [],
        keywords: ['mcp', 'external', 'integration', 'ticket', 'issue', 'slack', 'database'],
    },
    {
        id: 'human_escalation',
        description: 'Ask the user a question or hand off to a human.',
        members: ['ask_user', 'ask_followup_question', 'send_email'],
        keywords: ['ask', 'question', 'user', 'email', 'escalate', 'clarify'],
    },
    {
        id: 'task_control',
        description: 'Control the task lifecycle: finish, complete, abort.',
        members: ['finish_task', 'finish', 'attempt_completion', 'task_done'],
        keywords: ['finish', 'complete', 'done', 'control', 'abort'],
    },
    { id: 'other', description: 'Tools that do not fit a known family.', members: [], keywords: [] },
];
const FAMILY_BY_ID = new Map(TOOL_FAMILIES.map((f) => [f.id, f]));
export function getToolFamily(id) {
    return FAMILY_BY_ID.get(id);
}
const NAME_MEMBERSHIP = (() => {
    const map = new Map();
    for (const family of TOOL_FAMILIES) {
        for (const member of family.members ?? [])
            map.set(member.toLowerCase(), family.id);
    }
    return map;
})();
/** Ordered heuristics. Specific families are checked before generic ones. */
const HEURISTICS = [
    { id: 'mcp_external', test: /^mcp_|(^|[_\s-])mcp([_\s-]|$)/ },
    { id: 'memory', test: /memory|recall|episode/ },
    { id: 'human_escalation', test: /ask_user|ask_followup|send_email|escalat|clarify|summari[sz]e/ },
    { id: 'task_control', test: /^finish|finish_task|attempt_completion|task_done/ },
    { id: 'git', test: /^git_|\bgit\b/ },
    { id: 'code_validation', test: /^validate_|_validator$/ },
    { id: 'browser_observation', test: /screenshot|snapshot|browser_read|browser_extract/ },
    { id: 'browser_navigation', test: /navigate|web_fetch|web_search|browser_open/ },
    { id: 'browser_interaction', test: /browser_click|browser_type|browser_scroll|browser_select|browser_press/ },
    { id: 'shell', test: /run_command|run_tests|run_typecheck|run_linter|execute_command|typecheck|\btsc\b|\blint\b|vitest|jest|eslint|\bshell\b|\bbash\b|terminal/ },
    { id: 'code_edit', test: /\bedit\b|\bwrite\b|patch|replace|rename|format_document/ },
    { id: 'file_search', test: /search|grep|glob|\bfind\b|list_directory|ripgrep/ },
    { id: 'file_read', test: /\bread\b|read_|_read|readfile|open_file|\bcat\b|view_file/ },
];
/** Deterministic family resolution for any descriptor. */
export function resolveToolFamily(tool) {
    if (tool.family)
        return tool.family;
    const explicit = NAME_MEMBERSHIP.get(tool.name.toLowerCase());
    if (explicit)
        return explicit;
    const haystack = `${tool.name} ${(tool.tags ?? []).join(' ')}`.toLowerCase();
    for (const rule of HEURISTICS)
        if (rule.test.test(haystack))
            return rule.id;
    return 'other';
}
/**
 * Intent -> family boosts. A change request must surface the edit family even
 * when the surrounding text is dominated by read/test words (the failure mode
 * observed for T4 type-drift tasks). Deterministic and explainable.
 */
export const INTENT_FAMILY_RULES = [
    {
        family: 'code_edit',
        test: /\b(fix|correct|edit|change|implement|write|add|update|repair|patch|refactor|create|reconcile|align|restore)\b|\b(mismatch|disagree\w*|wrong|incorrect|broken|bug)\b|\b(stopped passing|not passing|failing|typecheck)\b/i,
        boost: 8,
    },
    { family: 'shell', test: /\b(run|execute|verify|validate|test|typecheck|lint|build|compile)\b/i, boost: 6 },
    { family: 'file_read', test: /\b(read|inspect|open|review)\b/i, boost: 3 },
    { family: 'file_search', test: /\b(search|find|grep|locate|discover)\b/i, boost: 3 },
];
export function intentFamilyBoosts(query) {
    const boosts = new Map();
    for (const rule of INTENT_FAMILY_RULES) {
        if (rule.test.test(query))
            boosts.set(rule.family, (boosts.get(rule.family) ?? 0) + rule.boost);
    }
    return boosts;
}
export function groupByFamily(tools) {
    const out = new Map();
    for (const tool of tools) {
        const family = resolveToolFamily(tool);
        const list = out.get(family) ?? [];
        list.push(tool);
        out.set(family, list);
    }
    return out;
}
/* ------------------------------------------------------------------ *
 * Near-duplicate collapse.
 *
 * Measured problem: `run_tests` / `run_typecheck` / `run_linter` are narrower
 * restatements of `run_commands`, and lexical scoring prefers the narrower name
 * even when the task needs the general runner. We cluster descriptors whose
 * tag+name signature overlaps strongly (Jaccard >= 0.5 with >= 2 shared items)
 * and prefer the widest-coverage member as the cluster representative. The
 * others stay available; they are only demoted deterministically.
 * ------------------------------------------------------------------ */
const SIGNATURE_STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'tool']);
/**
 * Capability signature: curated tags (singularised) when present, otherwise
 * name tokens. Tags encode capability; name tokens mostly encode style, so
 * including both prevented genuine near-duplicates from clustering.
 */
function signature(tool) {
    const source = (tool.tags ?? []).length > 0 ? (tool.tags ?? []).join(' ') : tool.name;
    const parts = source.toLowerCase().split(/[^a-z0-9_]+/);
    return new Set(parts
        .filter((p) => p.length >= 3 && !SIGNATURE_STOP.has(p))
        .map((p) => (p.endsWith('s') && p.length > 4 ? p.slice(0, -1) : p)));
}
const jaccard = (a, b) => {
    let shared = 0;
    for (const item of a)
        if (b.has(item))
            shared += 1;
    const union = a.size + b.size - shared;
    return { score: union === 0 ? 0 : shared / union, shared };
};
/**
 * Cluster near-duplicate tools. The representative is the member whose
 * signature covers the most of the cluster union (widest capability), with a
 * deterministic tie-break on shorter name then alphabetical.
 */
export function clusterNearDuplicates(tools) {
    const signatures = new Map(tools.map((t) => [t.name, signature(t)]));
    const parent = new Map(tools.map((t) => [t.name, t.name]));
    const find = (x) => {
        const p = parent.get(x);
        if (p === x)
            return x;
        const root = find(p);
        parent.set(x, root);
        return root;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb)
            parent.set(rb, ra);
    };
    for (let i = 0; i < tools.length; i += 1) {
        for (let j = i + 1; j < tools.length; j += 1) {
            const a = tools[i];
            const b = tools[j];
            const { score, shared } = jaccard(signatures.get(a.name), signatures.get(b.name));
            if (shared >= 2 && score >= 0.5)
                union(a.name, b.name);
        }
    }
    const groups = new Map();
    for (const tool of tools) {
        const root = find(tool.name);
        const list = groups.get(root) ?? [];
        list.push(tool);
        groups.set(root, list);
    }
    const clusters = [];
    const status = new Map();
    const representativeOf = new Map();
    for (const members of groups.values()) {
        if (members.length === 1) {
            status.set(members[0].name, 'unique');
            continue;
        }
        const unionSignature = new Set();
        for (const member of members)
            for (const item of signatures.get(member.name))
                unionSignature.add(item);
        const coverage = (member) => {
            let covered = 0;
            for (const item of signatures.get(member.name))
                if (unionSignature.has(item))
                    covered += 1;
            return covered;
        };
        const ordered = members
            .slice()
            .sort((a, b) => coverage(b) - coverage(a) || a.name.length - b.name.length || a.name.localeCompare(b.name));
        const representative = ordered[0];
        clusters.push({ members: ordered.map((m) => m.name).sort(), representative: representative.name });
        status.set(representative.name, 'representative');
        for (const member of ordered.slice(1)) {
            status.set(member.name, 'suppressed');
            representativeOf.set(member.name, representative.name);
        }
    }
    return { clusters: clusters.sort((a, b) => a.representative.localeCompare(b.representative)), status, representativeOf };
}
export function scoreFamilies(tools, queryTokens, weight) {
    const grouped = groupByFamily(tools);
    const scores = [];
    for (const family of TOOL_FAMILIES) {
        const members = grouped.get(family.id) ?? [];
        if (members.length === 0)
            continue;
        let score = weight(`${family.description} ${(family.keywords ?? []).join(' ')}`, 2);
        for (const member of members) {
            score += weight(`${member.name} ${(member.tags ?? []).join(' ')} ${member.description}`, 1);
        }
        // Small bias toward larger families only if they already matched, so an
        // unrelated huge family cannot dominate.
        if (score > 0)
            score += Math.min(members.length, 6) * 0.25;
        scores.push({ id: family.id, score, toolCount: members.length, members });
    }
    return scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
