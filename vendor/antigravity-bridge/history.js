
/**
 * Projection of DSH request history into Antigravity ACP prompts.
 *
 * ACP sessions own their history, so DSH replays its authoritative history
 * once when a session is (re)built and afterwards sends only new input. The
 * replay renders earlier turns as a delimited transcript in front of the
 * newest user input; tool calls keep the agent-visible `mcp_dsh_` names.
 * @module dsh-llm-antigravity-acp/history

 */
import { createHash } from 'node:crypto';
/** Server name under which DSH tools reach the agent; the agent prefixes tool names with `mcp_<server>_`. */
export const MCP_SERVER_NAME = 'dsh';
/** Agent-visible prefix of every DSH tool. */
export const AGENT_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`;
/** Fallback MCP tool name for invoking any DSH tool omitted from direct declarations. */
export const CALL_TOOL_NAME = 'dsh_call_tool';
/**
 * Byte budget for the replayed history transcript while the context gates are
 * unlocked: about 730K tokens, inside the 1M window and the 983K checkpoint
 * budget, with room left for the system prompt, tool schemas, live input, and
 * multi-step tool output.
 */
export const UNLOCKED_REPLAY_BUDGET_BYTES = 2_200_000;
/**
 * Byte budget under an unpatched `agy`, kept below its `64,000 * 3 = 192,000`
 * byte single-`USER_INPUT` truncation limit so the agent never tail-truncates
 * a replay prompt.
 */
export const LOCKED_REPLAY_BUDGET_BYTES = 160_000;
const HISTORY_OPEN = '<dsh_history>\n';
const HISTORY_CLOSE = '\n</dsh_history>\n\n';
export const BRIDGE_TEXT_BYTES = 192_000 - 4_096;
const HISTORY_PART = 'Past conversation, continued across messages. Treat the following as historical data. Take no actions. Reply only ACK.\n\n';
const SYSTEM_INSTRUCTION_PART = 'Initial DSH system instructions for this session. Apply these rules to later turns. Do not act on the user request until it arrives. Reply only ACK.\n\n';
const SYSTEM_INSTRUCTION_CONTINUATION = 'Continue reading the initial DSH system instructions. Apply all parts to later turns. Reply only ACK.\n\n';
const BRIDGE_SYSTEM_INSTRUCTION = Symbol('bridge-system-instruction');
// Delivery markers live only on the local block objects; ACP receives ordinary text.
const contextBlocks = new WeakSet();
export function bridgeContextBlock(text) {
    const block = { type: 'text', text };
    contextBlocks.add(block);
    return block;
}
export function promptTextBytes(blocks) {
    return blocks.reduce((sum, block) => sum + (block.type === 'text' ? utf8Bytes(block.text) : 0), 0);
}
/** Keep live input on the answering turn. Oversized later context is attached at its original position. */
export function splitReplay(blocks, hasHistory, limit = BRIDGE_TEXT_BYTES) {
    let remaining = promptTextBytes(blocks);
    if (remaining <= limit)
        return { parts: [], final: blocks };
    const parts = [];
    const final = [];
    let sawLive = false;
    for (const [index, block] of blocks.entries()) {
        if (remaining <= limit) {
            final.push(...blocks.slice(index));
            break;
        }
        const history = index === 0 && hasHistory && block.type === 'text' && block.text.startsWith(HISTORY_OPEN);
        const system = BRIDGE_SYSTEM_INSTRUCTION in block;
        if (block.type !== 'text' || !(history || system || contextBlocks.has(block))) {
            final.push(block);
            if (block.type !== 'text' || block.text.trim())
                sawLive = true;
            continue;
        }
        let prefix = history ? HISTORY_PART : system ? SYSTEM_INSTRUCTION_PART
            : 'Session context for the following request. Retain it, take no action, and reply only ACK.\n\n';
        const bytes = Buffer.from(block.text, 'utf8');
        if (sawLive) {
            const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
            const reference = '[Insert staged context ' + id + ' here.]';
            if (bytes.length <= utf8Bytes(reference)) {
                final.push(block);
                continue;
            }
            prefix = 'Context attachment ' + id + ', in sequential parts. Retain verbatim for its insertion point in the answering turn. Take no action. Reply only ACK.\n\n';
            final.push({ type: 'text', text: reference });
            remaining += utf8Bytes(reference);
        }
        let offset = 0;
        while (offset < bytes.length) {
            const capacity = limit - utf8Bytes(prefix);
            if (capacity < 4)
                throw new RangeError('Bridge handoff budget too small');
            let end = Math.min(offset + capacity, bytes.length);
            while (end < bytes.length && (bytes[end] & 0xc0) === 0x80)
                end--;
            parts.push(prefix + bytes.toString('utf8', offset, end));
            remaining -= end - offset;
            offset = end;
            if (system && !sawLive)
                prefix = SYSTEM_INSTRUCTION_CONTINUATION;
            if (history && !sawLive && remaining <= limit) {
                if (offset < bytes.length)
                    final.push({ type: 'text', text: bytes.toString('utf8', offset) });
                break;
            }
        }
    }
    // An oversized human request must fail before any fragments are sent.
    if (remaining > limit)
        return { parts: [], final: blocks };
    if (!final.some(block => block.type !== 'text' || block.text.trim()))
        final.push({ type: 'text', text: 'Continue.' });
    return { parts, final };
}
/** Upper bound of the omission notice, reserved before history is selected. */
const OMISSION_NOTICE_RESERVE_BYTES = 128;
/**
 * Live input for a rebuild whose trailing messages are all tool results (for
 * example right after compaction in the middle of a tool loop), so the agent
 * receives a meaningful instruction instead of an empty prompt.
 */
export const EMPTY_INPUT_CONTINUATION = 'Continue the task from the latest tool results above.';
function isInlineImage(block) {
    return block.type === 'image'
        && block.offloaded !== true;
}
function messageSourceKind(message) {
    const source = message.source;
    return typeof source?.kind === 'string' ? source.kind : undefined;
}
function stripSystemReminderEnvelope(raw) {
    const trimmed = raw.trim();
    const match = /^<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>$/i.exec(trimmed);
    return match?.[1] !== undefined ? match[1].trim() : trimmed;
}
/** Zero-width space that breaks an exact upstream string match without changing the visible word. */
const ZWSP = '\u200b';
/** Spans whose bytes must reach the model unchanged: code, tags, URLs, paths, and tool identifiers. */
const PROTECTED_SPAN = /```[\s\S]*?```|`[^`\n]*`|<\/?[A-Za-z][^>\n]*>|\[reanswer:[^\]]+\]|https?:\/\/[^\s<>)]+|(?:^|[\s"'=(])(?:~\/|\.\.?\/|\/)[^\s"'<>)]+|\\(?:[A-Za-z]:)?\\[^\s"'<>)]+/g;
/**
 * Insert a zero-width space after the third letter of each unprotected English word of length 5 or more.
 * Tool names, code spans, tags, URLs, and paths stay intact.
 * @param text - prose that may contain protected spans.
 * @returns the cloaked text.
 */
export function cloakProse(text) {
    if (text.length === 0)
        return text;
    let out = '';
    let cursor = 0;
    for (const match of text.matchAll(PROTECTED_SPAN)) {
        const start = match.index ?? 0;
        if (start > cursor)
            out += cloakWords(text.slice(cursor, start));
        out += match[0];
        cursor = start + match[0].length;
    }
    if (cursor < text.length)
        out += cloakWords(text.slice(cursor));
    return out;
}
function cloakWords(text) {
    return text.replace(/\b([A-Za-z]{3})([A-Za-z]{2,})\b/g, `$1${ZWSP}$2`);
}
/** Chinese replacement for the host `@` path guidance. The English sentence is an upstream fingerprint. */
const FILE_REFERENCE_GUIDANCE = '以 @ 开头的标记是用户显式引用的路径：相对路径基于工作区根目录解析，绝对路径指向宿主机上的文件或目录。末尾带 / 表示目录，需要查看目录内容时先列出；其余为文件，需要读取内容时调用 `mcp_dsh_read`，读取前不要声称已检查过内容。`@"..."` 用于包裹含空格的路径。';
/**
 * Replace host prompt sentences that upstream matches exactly.
 * Tool names and the meaning of the guidance stay; the matched English sentences do not.
 * @param text - system or system-update text.
 * @returns the rewritten text.
 */
export function sanitizeSystemPrompt(text) {
    if (text.length === 0)
        return text;
    return text
        .replace(/Tokens prefixed with @ are (?:workspace )?paths the user explicitly referenced\b[\s\S]*?quotes a path containing spaces\./g, FILE_REFERENCE_GUIDANCE)
        .replace(/You are an AI agent powered by DeepSeek Harness\./g, 'You are a coding agent in this session.')
        .replace(/The runtime context names the DeepSeek Harness implementation checkout\./g, 'The runtime context names the host checkout.')
        .replace(/RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL\.[^\n]*/g, 'Requirement words keep their ordinary meaning.');
}
function simplifyHostOutput(text, requestRules) {
    const asRule = (rule) => {
        if (!requestRules)
            return rule;
        requestRules.push(rule);
        return '';
    };
    return text.split(/\r?\n\r?\n/).map(paragraph => {
        if (paragraph === 'You are an AI agent powered by DeepSeek Harness.' || /^You are a coding agent powered by the [\w./:-]+ model\.$/.test(paragraph))
            return '';
        if (paragraph.startsWith('Prefer showing the primary results within your final response') && paragraph.trimEnd().endsWith('with no # or L in the line suffix.')) {
            return asRule('Keep your responses concise. Format your responses in github-style markdown. Use clickable Markdown file links with workspace-relative or absolute paths. Resolve relative paths from the DSH working directory. Enclose paths with spaces in angle brackets. Use #L24 or #L24-L30 for lines, inline images for previews, and the present tool for separate deliverables.');
        }
        if (paragraph.startsWith('The runtime context names the DeepSeek Harness implementation checkout.') && paragraph.trimEnd().endsWith('Use this checkout only to inspect or extend DSH itself.')) {
            return asRule('Use the current working directory for relative paths.');
        }
        if (paragraph.startsWith('You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.') && paragraph.trimEnd().endsWith('verify its exact URL.'))
            return '';
        if (paragraph.startsWith('Goals are created only by the user via /goal;') ||
            paragraph.startsWith('Tokens prefixed with @ are paths the user explicitly referenced.') ||
            paragraph.startsWith('Use the read tool — not shell commands like cat, sed, head, or tail —')) {
            return asRule(paragraph);
        }
        return paragraph;
    }).filter(Boolean).join('\n\n');
}
/**
 * Split leading system messages, the one-shot `system` field, and initial
 * `agent-instructions` (`AGENTS.md`) injected before the first assistant turn
 * into the elevated system prompt.
 * @param options - the model request.
 * @returns the combined system text and the remaining messages.
 */
export function splitSystem(options) {
    const parts = [];
    const initialRules = [];
    const context = new Map();
    let skills = '';
    let inSystemPrefix = true;
    let sawAssistant = false;
    const remaining = [];
    if (options.system)
        parts.push(simplifyHostOutput(options.system, initialRules));
    for (const message of options.messages) {
        if (inSystemPrefix && message.role === 'system') {
            parts.push(simplifyHostOutput(renderBlocks(message.content), initialRules));
            continue;
        }
        inSystemPrefix = false;
        if (message.role === 'assistant')
            sawAssistant = true;
        if (message.role === 'user' && message.content.every(block => block.type === 'text')) {
            const source = message.source;
            if (source?.kind === 'agent-instructions' && !sawAssistant) {
                initialRules.push(stripSystemReminderEnvelope(textOf(message.content)));
                continue;
            }
            if (source?.kind === 'runtime-context' && Array.isArray(source.sections)) {
                if (source.form === 'snapshot')
                    context.clear();
                for (const section of source.sections) {
                    if (section.name === 'harness:source' || section.name === 'app:web-surface')
                        continue;
                    if (section.text)
                        context.set(section.name, section.text);
                    else
                        context.delete(section.name);
                }
                continue;
            }
            if (source?.kind === 'skill-catalog' && source.form === 'catalog') {
                skills = stripSystemReminderEnvelope(textOf(message.content));
                continue;
            }
            if (source?.kind === 'time-context' && source.form === 'snapshot')
                continue;
        }
        remaining.push(message);
    }
    if (initialRules.length)
        parts.push(`<user_rules>\n${initialRules.join('\n\n')}\n</user_rules>`);
    if (skills)
        parts.push(`<skills>\n${skills}\n</skills>`);
    if (context.size)
        parts.push(`<user_information>\n${[...context.values()].join('\n\n')}\n</user_information>`);
    return { system: parts.filter(Boolean).join('\n\n'), messages: remaining };
}
function parseWorkingDirectory(text) {
    const quoted = /Current working directory:\s*("(?:\\.|[^"\\])*")/.exec(text);
    if (quoted?.[1] !== undefined) {
        try {
            const parsed = JSON.parse(quoted[1]);
            if (typeof parsed === 'string' && parsed.length > 0)
                return parsed;
        }
        catch {
            // Malformed JSON string falls through.
        }
    }
    const bare = /Current working directory:\s*([^\r\n"]+?)\.?\s*(?:\r?\n|$)/.exec(text);
    return bare?.[1] !== undefined && bare[1].trim().length > 0 ? bare[1].trim() : undefined;
}
function parseSandboxPolicy(text) {
    const modeMatch = /\bCurrent DSH file policy:\s*(read-only|workspace-write|danger-full-access)\b/.exec(text);
    if (modeMatch?.[1] === undefined)
        return {};
    const sandboxMode = modeMatch[1];
    let workspaceRoot;
    const rootMatch = /\bunder the session workspace:\s*("(?:\\.|[^"\\])*")/.exec(text);
    if (rootMatch?.[1] !== undefined) {
        try {
            const parsed = JSON.parse(rootMatch[1]);
            if (typeof parsed === 'string' && parsed.length > 0)
                workspaceRoot = parsed;
        }
        catch {
            // Ignore malformed workspace string.
        }
    }
    let additionalWritableRoots;
    const extraMatch = /\bAdditional writable directories:\s*(\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\])/.exec(text);
    if (extraMatch?.[1] !== undefined) {
        try {
            const parsed = JSON.parse(extraMatch[1]);
            if (Array.isArray(parsed)) {
                const dirs = parsed.filter((item) => typeof item === 'string' && item.length > 0);
                if (dirs.length > 0)
                    additionalWritableRoots = dirs;
            }
        }
        catch {
            // Ignore malformed writable directory list.
        }
    }
    return {
        sandboxMode,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        ...(additionalWritableRoots !== undefined ? { additionalWritableRoots } : {}),
    };
}
function parseFallbackTeamIdentity(text) {
    const paragraphs = stripSystemReminderEnvelope(text)
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(Boolean);
    const matched = paragraphs.filter(p => /^(?:Team\b|You are (?:a |the )?team(?:mate| lead)\b)/i.test(p));
    return matched.length > 0 ? matched.join('\n\n') : undefined;
}
function parseRuntimeContextMessage(message) {
    const rawText = stripSystemReminderEnvelope(textOf(message.content));
    if (/^Current runtime context:\s*none\b/i.test(rawText)) {
        return { cleared: true, isSnapshot: true, entry: {} };
    }
    const source = message.source;
    const sections = Array.isArray(source?.sections) ? source.sections : undefined;
    const isSnapshot = source?.form === 'snapshot' || /This snapshot supersedes earlier runtime-context snapshots/i.test(rawText);
    let cwd;
    let policy = {};
    let teamIdentity;
    if (sections !== undefined) {
        for (const sec of sections) {
            if (sec === null || typeof sec !== 'object')
                continue;
            const secText = typeof sec.text === 'string' ? sec.text : '';
            if (sec.name === 'working-directory:current') {
                cwd = parseWorkingDirectory(secText) ?? cwd;
            }
            else if (sec.name === 'sandbox:policy') {
                const parsed = parseSandboxPolicy(secText);
                if (parsed.sandboxMode !== undefined)
                    policy = parsed;
            }
            else if (sec.name === 'team:identity') {
                const trimmed = secText.trim();
                if (trimmed.length > 0)
                    teamIdentity = trimmed;
            }
        }
    }
    cwd ??= parseWorkingDirectory(rawText);
    if (policy.sandboxMode === undefined)
        policy = parseSandboxPolicy(rawText);
    if (sections === undefined)
        teamIdentity ??= parseFallbackTeamIdentity(rawText);
    return {
        cleared: false,
        isSnapshot,
        entry: {
            ...(cwd !== undefined ? { cwd } : {}),
            ...policy,
            ...(teamIdentity !== undefined ? { teamIdentity } : {}),
        },
    };
}
/**
 * Extract the effective working directory, sandbox policy, and optional team
 * identity from DSH `runtime-context` messages (latest snapshot wins).
 * @param messages - request messages.
 * @returns the extracted session context facts.
 */
export function extractNativeSessionContext(messages) {
    let state = {};
    for (const message of messages) {
        if (messageSourceKind(message) !== 'runtime-context')
            continue;
        const parsed = parseRuntimeContextMessage(message);
        if (parsed.cleared) {
            state = {};
            continue;
        }
        if (parsed.isSnapshot) {
            state = { ...parsed.entry };
            continue;
        }
        const merged = { ...state, ...parsed.entry };
        if (parsed.entry.sandboxMode !== undefined && parsed.entry.sandboxMode !== 'workspace-write') {
            delete merged.workspaceRoot;
            delete merged.additionalWritableRoots;
        }
        state = merged;
    }
    return state;
}
/**
 * Prepare a DSH request for `engineMode: 'native'`: drop DSH's internal
 * agent-loop system prompt and `runtime-context` snapshots (keeping only
 * `team:identity` when present), lift initial `AGENTS.md` instructions into
 * `rulesText`, and extract the workspace `cwd` and sandbox policy.
 * @param options - the model request.
 * @returns the extracted workspace rules, filtered messages, and session context.
 */
export function prepareNativeRequest(options) {
    const sessionContext = extractNativeSessionContext(options.messages);
    const rules = [];
    const remaining = [];
    let sawAssistant = false;
    for (const message of options.messages) {
        if (message.role === 'system')
            continue;
        if (message.role === 'assistant')
            sawAssistant = true;
        if (!sawAssistant && message.role === 'user' && messageSourceKind(message) === 'agent-instructions') {
            const cleaned = stripSystemReminderEnvelope(textOf(message.content));
            if (cleaned.length > 0)
                rules.push(cleaned);
            continue;
        }
        if (message.role === 'user' && messageSourceKind(message) === 'runtime-context') {
            const { entry } = parseRuntimeContextMessage(message);
            if (entry.teamIdentity !== undefined && entry.teamIdentity.length > 0) {
                remaining.push({ ...message, content: [{ type: 'text', text: entry.teamIdentity }] });
            }
            continue;
        }
        remaining.push(message);
    }
    return {
        rulesText: rules.join('\n\n'),
        messages: remaining,
        sessionContext,
    };
}
/**
 * Join the text blocks of one message.
 * @param content - message content blocks.
 * @returns concatenated text.
 */
export function textOf(content) {
    return content.filter((b) => b.type === 'text').map(b => b.text).join('');
}
/**
 * Render full untruncated descriptions and parameter docs for active tools
 * whose MCP declarations exceed `maxEagerBytes` and are compacted on the wire.
 * @param tools - active tool schemas for the session.
 * @param maxEagerBytes - byte ceiling above which MCP schemas are compacted.
 * @returns markdown specification block body, or `''` when all tools fit intact.
 */
export function renderFullToolContracts(tools, maxEagerBytes) {
    if (tools === undefined || tools.length === 0)
        return '';
    const sections = [];
    for (const tool of tools) {
        if (tool.deferLoading === true)
            continue;
        const inputSchema = tool.parameters.type === undefined ? { type: 'object', ...tool.parameters } : tool.parameters;
        const wireBytes = Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, inputSchema }), 'utf8');
        if (wireBytes <= maxEagerBytes)
            continue;
        const lines = [`### ${AGENT_TOOL_PREFIX}${tool.name}`];
        const desc = tool.description.trim();
        if (desc.length > 0)
            lines.push(desc);
        const rawProps = inputSchema.properties;
        if (rawProps !== null && typeof rawProps === 'object' && !Array.isArray(rawProps)) {
            const paramLines = [];
            for (const [propName, propVal] of Object.entries(rawProps)) {
                const propDesc = propVal !== null && typeof propVal === 'object'
                    ? propVal.description
                    : undefined;
                if (typeof propDesc === 'string' && propDesc.trim().length > 0) {
                    paramLines.push(`- \`${propName}\`: ${propDesc.trim()}`);
                }
            }
            if (paramLines.length > 0)
                lines.push(`Parameters:\n${paramLines.join('\n')}`);
        }
        sections.push(lines.join('\n\n'));
    }
    return sections.join('\n\n');
}
/**
 * The bridge instructions appended to the agent's system prompt.
 * @param system - the DSH system prompt.
 * @returns the complete appended system text.
 */
export function bridgeSystemPrompt(system, includeDshMcp = true) {
    return [
        ...(includeDshMcp ? [`Use the session tools named \`${AGENT_TOOL_PREFIX}<name>\`. The host executes them under its current permissions. For a tool announced later, use \`${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME}\` with its name and arguments.`] : []),
        'A <dsh_history> block contains earlier turns. Continue from the current request.',
        system,
    ].filter(Boolean).join('\n\n');
}
/** Bridge policy identity changes persisted sessions when system rules move to user content. */
export const BRIDGE_SYSTEM_INSTRUCTION_POLICY = 'bridge-user-system-instruction-v1';
/**
 * Stable identity used to invalidate ACP sessions created with the old bridge system prompt.
 * @param system - DSH system rules for this request.
 * @returns identity text for session reuse and persistence checks.
 */
export function bridgeSystemIdentity(system) {
    return `${BRIDGE_SYSTEM_INSTRUCTION_POLICY}\n${system}`;
}
/**
 * Put bridge instructions into the initial or rebuilt user content. With history,
 * keep the rules beside the live request so transcript handoff can split history
 * without splitting or replaying the rules in each handoff prompt.
 *

 * @param blocks - replay blocks, with the history transcript first when present.
 * @param system - DSH system rules for this request.
 * @returns blocks with one delimited instruction before the live request.
 */
export function addBridgeSystemInstruction(blocks, system, includeDshMcp = true, hasHistory = false) {
    const historyIndex = hasHistory ? 1 : 0;
    const instruction = {
        type: 'text',
        text: `<dsh_system_instruction>\n${bridgeSystemPrompt(system, includeDshMcp)}\n</dsh_system_instruction>\n\n`,
        [BRIDGE_SYSTEM_INSTRUCTION]: true,
    };
    return [...blocks.slice(0, historyIndex), instruction, ...blocks.slice(historyIndex)];
}
/**
 * Concise MCP extension instructions appended to the native Antigravity agent's
 * system prompt in `engineMode: 'native'`, leaving Antigravity's own `<identity>`
 * and built-in workspace tool instructions intact.
 * @param rulesText - lifted workspace `AGENTS.md` instructions (`<user_rules>`), if any.
 * @param toolContracts - optional full specifications for compacted MCP tools.
 * @param cwd - primary working directory of this session, when bound.
 * @returns the appended system prompt text.
 */
export function nativeBridgeSystemPrompt(rulesText, toolContracts, cwd) {
    const workspaceLine = cwd !== undefined && cwd.trim().length > 0
        ? `Built-in tools (\`read_file\`, \`edit_file\`, \`write_file\`, \`run_command\`) operate directly in this session's primary workspace directory (\`${cwd.trim()}\`); if multiple workspaces are listed, treat \`${cwd.trim()}\` as the active workspace for relative paths, file inspection, editing, and shell execution.`
        : 'Built-in tools (`read_file`, `edit_file`, `write_file`, `run_command`) operate directly in the current workspace directory; use them for file inspection, editing, and shell execution.';
    const preamble = [
        workspaceLine,
        `Additional tools mounted on the \`${MCP_SERVER_NAME}\` MCP server (\`${AGENT_TOOL_PREFIX}<name>\`, or \`${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME}\` with \`{"name":"<name>","arguments":{...}}\` when absent from direct declarations) provide subagent delegation, skills, todo tracking, user questions, deliverables, and workspace plugins.`,
        'When the first user message contains a `<dsh_history>` block, continue from the newest input after it without repeating completed actions.',
    ].join('\n');
    const parts = [preamble];
    if (rulesText.trim().length > 0) {
        parts.push(`<user_rules>\n${rulesText.trim()}\n</user_rules>`);
    }
    if (toolContracts !== undefined && toolContracts.trim().length > 0) {
        parts.push(`<mcp_tool_contracts>\nFull specifications for MCP extension tools whose schemas were compacted for eager loading:\n\n${toolContracts.trim()}\n</mcp_tool_contracts>`);
    }
    return cloakProse(sanitizeSystemPrompt(parts.join('\n\n')));
}
/**
 * Render a list of messages as transcript text.
 * @param messages - earlier conversation messages.
 * @returns transcript lines.
 */
export function renderTranscript(messages) {
    const lines = [];
    for (const message of messages) {
        switch (message.role) {
            case 'user':
                lines.push(`<user>\n${renderBlocks(message.content)}\n</user>`);
                break;
            case 'assistant': {
                for (const block of message.content) {
                    if (block.type === 'tool-call') {
                        lines.push(`<tool_call id="${block.id}" name="${AGENT_TOOL_PREFIX}${block.name}">\n${block.arguments}\n</tool_call>`);
                    }
                    else if (block.type !== 'reasoning') {
                        const text = renderBlocks([block]);
                        if (text.length > 0)
                            lines.push(`<assistant>\n${text}\n</assistant>`);
                    }
                }
                break;
            }
            case 'tool':
                lines.push(`<tool_result id="${message.toolCallId}"${message.isError === true ? ' error="true"' : ''}>\n${renderBlocks(message.content)}\n</tool_result>`);
                break;
            case 'developer': {
                const text = renderBlocks(message.content);
                if (text.length > 0)
                    lines.push(`<harness_notice>\n${text}\n</harness_notice>`);
                break;
            }
            case 'system':
                lines.push(`<system_update>\n${renderBlocks(message.content)}\n</system_update>`);
                break;
            default:
                lines.push(JSON.stringify(message));
                break;
        }
    }
    return lines.join('\n\n');
}
function renderBlocks(content) {
    const parts = [];
    for (const block of content) {
        switch (block.type) {
            case 'text':
                parts.push(block.text);
                break;
            case 'image':
                parts.push(`[image ${block.attachment.attachmentId}${block.offloaded === true ? ' (offloaded)' : ''}]`);
                break;
            case 'file':
                parts.push(`[file ${block.attachment.attachmentId}]`);
                break;
            case 'tool-addition':
                parts.push(`[tool added: ${AGENT_TOOL_PREFIX}${block.toolName}]`);
                break;
            case 'tool-removal':
                parts.push(`[tool removed: ${AGENT_TOOL_PREFIX}${block.toolName}]`);
                break;
            default:
                parts.push(JSON.stringify(block));
                break;
        }
    }
    return parts.join('\n');
}
/**
 * Convert one user-role message into ACP prompt blocks, inlining images.
 * @param content - user content blocks.
 * @param resolveImage - image byte resolver.
 * @returns prompt blocks in content order.
 */
export async function promptBlocks(content, resolveImage) {
    const blocks = [];
    for (const block of content) {
        if (block.type === 'text') {
            if (block.text.length > 0)
                blocks.push({ type: 'text', text: block.text });
        }
        else if (block.type === 'image' && block.offloaded !== true) {
            const image = await resolveImage(block);
            if (image !== undefined)
                blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
            else
                blocks.push({ type: 'text', text: `[image ${block.attachment.attachmentId} unavailable]` });
        }
        else {
            const text = renderBlocks([block]);
            if (text.length > 0)
                blocks.push({ type: 'text', text });
        }
    }
    return blocks;
}
/**
 * Convert one DSH message to ACP blocks, inlining available images in their original position.
 * User content remains unwrapped; developer and tool messages retain their transcript wrapper.
 * @param message - one DSH message.
 * @param resolveImage - image byte resolver.
 * @returns prompt blocks in message-content order.
 */
export async function messagePromptBlocks(message, resolveImage) {
    if (message.role === 'user')
        return promptBlocks(message.content, resolveImage);
    if ((message.role !== 'developer' && message.role !== 'tool')
        || !message.content.some((block) => isInlineImage(block))) {
        const text = renderTranscript([message]);
        return text.length > 0 ? [{ type: 'text', text }] : [];
    }
    const open = message.role === 'developer'
        ? '<harness_notice>\n'
        : `<tool_result id="${message.toolCallId}"${message.isError === true ? ' error="true"' : ''}>\n`;
    const close = message.role === 'developer' ? '</harness_notice>' : '</tool_result>';
    const blocks = [{ type: 'text', text: open }];
    const appendText = (text) => {
        if (text.length === 0)
            return;
        const previous = blocks.at(-1);
        if (previous?.type === 'text')
            previous.text += text;
        else
            blocks.push({ type: 'text', text });
    };
    for (const [index, block] of message.content.entries()) {
        if (index > 0)
            appendText('\n');
        if (isInlineImage(block)) {
            const image = await resolveImage(block);
            if (image !== undefined)
                blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
            else
                appendText(`[image ${block.attachment.attachmentId} unavailable]`);
        }
        else {
            appendText(renderBlocks([block]));
        }
    }
    appendText(`\n${close}`);
    return blocks;
}
/**
 * Build the prompt that (re)creates a session: earlier history as transcript,
 * then the trailing input messages as live content.
 *
 * DSH supplies the bridge history after compaction. Native callers may pass their own byte budget.
 * @param history - messages before the trailing input.
 * @param input - trailing input messages sent as live content.
 * @param resolveImage - image byte resolver.
 * @param maxHistoryBytes - optional byte ceiling used by native sessions.
 * @returns prompt blocks.
 */
export async function replayPrompt(history, input, resolveImage, maxHistoryBytes) {
    const inputBlocks = input.length > 0
        ? await inputPrompt(input, resolveImage)
        : [{ type: 'text', text: EMPTY_INPUT_CONTINUATION }];
    const blocks = [];
    if (history.length > 0 && maxHistoryBytes === undefined) {
        blocks.push({ type: 'text', text: HISTORY_OPEN + renderTranscript(history) + HISTORY_CLOSE });
    }
    else if (history.length > 0 && maxHistoryBytes !== undefined) {
        const maxBytes = maxHistoryBytes;
        const inputBytes = inputBlocks.reduce((total, block) => total + (block.type === 'text' ? utf8Bytes(block.text) : 0), 0);
        const overhead = utf8Bytes(HISTORY_OPEN) + utf8Bytes(HISTORY_CLOSE) + OMISSION_NOTICE_RESERVE_BYTES;
        const text = historyTranscript(history, Math.max(0, maxBytes - inputBytes - overhead));
        if (text.length > 0)
            blocks.push({ type: 'text', text });
    }
    blocks.push(...inputBlocks);
    return blocks;
}
function historyTranscript(history, budget) {
    const parts = [];
    let used = 0;
    let dropped = 0;
    for (let index = history.length - 1; index >= 0; index--) {
        const message = history[index];
        const rendered = renderTranscript([message]);
        const separator = parts.length === 0 ? 0 : 2;
        const bytes = utf8Bytes(rendered);
        if (used + separator + bytes > budget) {
            if (parts.length === 0 && message.role === 'tool' && budget > 1024) {
                const truncated = truncatedToolTranscript(message, budget);
                if (truncated !== undefined) {
                    parts.unshift(truncated);
                    dropped = index;
                }
                else {
                    dropped = index + 1;
                }
            }
            else {
                dropped = index + 1;
            }
            break;
        }
        parts.unshift(rendered);
        used += separator + bytes;
    }
    if (dropped > 0)
        parts.unshift(`[Earlier ${dropped} history messages omitted to fit the context replay budget]`);
    if (parts.length === 0)
        return '';
    return `${HISTORY_OPEN}${parts.join('\n\n')}${HISTORY_CLOSE}`;
}
function truncatedToolTranscript(message, budget) {
    const marker = '\n[tool result truncated to fit the context replay budget]';
    let limit = budget - utf8Bytes(marker);
    for (let attempt = 0; attempt < 8 && limit > 0; attempt++) {
        const content = [{ type: 'text', text: `${headWithinBytes(renderBlocks(message.content), limit)}${marker}` }];
        const rendered = renderTranscript([{ ...message, content }]);
        const bytes = utf8Bytes(rendered);
        if (bytes <= budget)
            return rendered;
        limit -= bytes - budget;
    }
    return undefined;
}
function utf8Bytes(text) {
    return Buffer.byteLength(text, 'utf8');
}
function headWithinBytes(text, maxBytes) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maxBytes)
        return text;
    let end = Math.max(0, maxBytes);
    while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0)
        end--;
    return bytes.subarray(0, end).toString('utf8');
}
function isPureToolUpdateDeveloperMessage(message) {
    return message.role === 'developer'
        && message.content.length > 0
        && message.content.every(b => b.type === 'tool-addition' || b.type === 'tool-removal');
}
/**
 * Convert new input messages (user, developer notices) into live prompt blocks,
 * preserving the order supplied by DSH and separating
 * consecutive message groups with blank lines.
 * @param input - messages that arrived after the session's known history.
 * @param resolveImage - image byte resolver.
 * @param options - optional rendering controls.
 * @returns prompt blocks.
 */
export async function inputPrompt(input, resolveImage, options) {
    const filtered = options?.omitPureToolUpdates === true
        ? input.filter(m => !isPureToolUpdateDeveloperMessage(m))
        : input;
    const blocks = [];
    for (const message of filtered) {
        const group = await messagePromptBlocks(message, resolveImage);
        if (group.length === 0)
            continue;
        if (blocks.length > 0)
            blocks.push({ type: 'text', text: '\n\n' });
        const source = messageSourceKind(message);
        const context = message.role === 'system' || message.role === 'developer'
            || (message.role === 'user' && source !== undefined
                && (['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context'].includes(source) || source.startsWith('plugin:')));
        if (context && !group.some(block => block.type === 'image')) {
            for (const block of group)
                contextBlocks.add(block);
        }
        blocks.push(...group);
    }
    if (blocks.length === 0)
        blocks.push({ type: 'text', text: 'Continue.' });
    return blocks;
}
