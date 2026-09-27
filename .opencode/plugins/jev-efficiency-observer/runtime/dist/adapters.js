/** Best-effort structural kind from a tool name (adapters may override). */
export function inferToolKind(toolName) {
    const n = toolName.toLowerCase();
    if (/(^|[_\s-])(read|cat|view|open|file)([_\s-]|$)|readfile|read_file/.test(n))
        return 'file-read';
    if (/(run|command|shell|bash|exec|terminal|process|cmd)/.test(n))
        return 'shell';
    if (/(search|grep|find|glob|ripgrep|query)/.test(n))
        return 'search';
    if (/(fetch|browser|web|http|url)/.test(n))
        return 'browser';
    if (/(json)/.test(n))
        return 'json';
    return 'unknown';
}
function partToText(part) {
    if (part === null || part === undefined)
        return '';
    if (typeof part === 'string')
        return part;
    if (typeof part === 'object') {
        const p = part;
        for (const key of ['result', 'text', 'content', 'output', 'stdout']) {
            const v = p[key];
            if (typeof v === 'string')
                return v;
            if (v !== undefined)
                return contentToText(v);
        }
        try {
            return JSON.stringify(part);
        }
        catch {
            return String(part);
        }
    }
    return String(part);
}
/** Normalise the many Cline/OpenAI content shapes into one text payload. */
export function contentToText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content))
        return content.map(partToText).filter(Boolean).join('\n');
    return partToText(content);
}
export function clineToolResult(input) {
    return {
        toolName: input.toolName,
        kind: input.kind ?? inferToolKind(input.toolName),
        text: contentToText(input.content),
        ...(input.id ? { id: input.id } : {}),
        ...(input.isError !== undefined ? { isError: input.isError } : {}),
    };
}
export function openAIToolSchemas(tools) {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema ?? { type: 'object', additionalProperties: true },
        },
    }));
}
export function openAIToolResult(input) {
    return {
        toolName: input.name,
        kind: input.kind ?? inferToolKind(input.name),
        text: contentToText(input.content),
        id: input.toolCallId,
    };
}
export function browserObservation(input) {
    const kind = input.kind === 'screenshot' ? 'image' : input.kind === 'url' ? 'browser' : 'text';
    return {
        toolName: `browser.${input.kind}`,
        kind,
        text: input.text,
        ...(input.url ? { metadata: { url: input.url } } : {}),
        ...(input.isError !== undefined ? { isError: input.isError } : {}),
    };
}
