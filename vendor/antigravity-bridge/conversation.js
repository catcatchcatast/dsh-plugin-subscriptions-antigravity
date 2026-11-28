/**
 * Per-conversation ACP session state and the turn pump that maps one ACP
 * prompt turn onto DSH model steps.
 *
 * An ACP prompt turn can span many model calls: the agent calls a DSH tool
 * through the MCP bridge, the call parks, and the pump ends the current DSH
 * step with `finish(tool-calls)`. DSH runs the tool through its own pipeline
 * and opens the next step with the result, which resolves the parked call and
 * resumes the same ACP turn. Parked calls that outlive the agent's MCP
 * deadline are relayed through the `dsh_await_result` tool.
 * @module dsh-llm-antigravity-acp/conversation
 */
import { LlmError, ProviderRequestId, ToolCallId } from '@deepseek-ai/dsh-llm';
import { AGENT_TOOL_PREFIX, CALL_TOOL_NAME } from "./history.js";
import { labeled } from "./labels.js";
import { lastGenerationError } from "./usage-db.js";
import { AsyncQueue, deferred } from "./util.js";
export { CALL_TOOL_NAME };
/** Agent-side transport retry notice streamed as message text, e.g. `⚠ API error (attempt 1): …`. */
const AGENT_RETRY_NOTICE = /^\s*⚠\s*(?:Error:\s*)?API error \(attempt \d+\)/i;
// 识别上游返回的限流通知，结束当前请求。
export function reportsUpstream429(message) {
    return /(?:^|[\s:(])429\b|\b(?:http|status|code)[_=:]\s*429\b|\b(?:RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|too many requests)\b/i.test(message);
}
/** Extract a provider correlation ID only from failure diagnostics. */
export function upstreamRequestId(message) {
    return /\b(?:request_?id|trace_?id|x-(?:goog-)?request-id)"?\s*[:=]\s*"?([\w.:-]+)/i.exec(message)?.[1];
}
/** Prefix of `AGENT_RETRY_NOTICE` while its opening words arrive across chunks. */
const AGENT_RETRY_PREFIX = /^\s*⚠\s*(?:e(?:r(?:r(?:o(?:r:?)?)?)?)?\s*)?(?:a(?:p(?:i(?:\s+e(?:r(?:r(?:o(?:r(?:\s*\((?:a(?:t(?:t(?:e(?:m(?:p(?:t(?:\s*\d*)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?$/i;
/** Lone warning prefix (`⚠` or `⚠ Error:`) before the notice body arrives. */
const WARNING_PREFIX = /^\s*⚠(?:\s*e(?:r(?:r(?:o(?:r:?)?)?)?)?)?\s*$/i;
/** First sentence of the notice agy inserts when one generation hits its own output cap. */
const OUTPUT_LIMIT_HEAD = 'your previous response was cut off because it exceeded the output token limit';
/** Second sentence of that same notice. */
const OUTPUT_LIMIT_TAIL = 'please continue from where you left off, keeping your response shorter';
/** Terminal step error agy streams as message text when upstream connection attempts fail. */
const NETWORK_ISSUE_MESSAGE = 'There was a network issue connecting to the server, please try again.';
const NETWORK_ISSUE_HEAD = 'there was a network issue connecting to the server, please try again';
/** Terminal step error agy streams as message text when upstream rejects the turn for high traffic. */
const HIGH_TRAFFIC_MESSAGE = 'Our servers are experiencing high traffic right now, please try again in a minute.';
const RESOURCE_WARNING = 'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).';
const HIGH_TRAFFIC_HEAD = 'our servers are experiencing high traffic right now, please try again in a minute';
/** Collapse agy's warning mark and line breaks so the notice can be recognized across chunks. */
function noticeText(raw) {
    return raw.replace(/⚠/g, ' ').replace(/\bError:/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function matchTerminalNotice(raw, text, head, code, message, final) {
    const full = `${head}.`;
    const marked = raw.includes('⚠');
    if (text === full || (marked && text.startsWith(`${full} `))) {
        // Without `⚠`, hold until `final` so a model reply that quotes the sentence
        // and continues explaining it is emitted intact.
        return marked || final ? { kind: 'error', code, message } : { kind: 'hold' };
    }
    if (text === head) {
        return final ? { kind: 'error', code, message } : { kind: 'hold' };
    }
    if (!final && full.startsWith(text)) {
        return { kind: 'hold' };
    }
    return undefined;
}
/**
 * Classify text against agy's output-cap continuation notice.
 * `drop` is only that notice, `hold` is still a prefix of it, `emit` is model text.
 */
export function classifyOutputLimitNotice(raw) {
    const text = noticeText(raw);
    if (text.length === 0)
        return 'emit';
    const stripped = text.replace(/\s*retries remaining:\s*\d*\s*$/i, '').trim();
    const retry = text.slice(stripped.length).trim();
    if (retry.length > 0 && !/^retries remaining:\s*\d*$/i.test(retry))
        return 'emit';
    if (stripped.length === 0)
        return /^retries remaining:\s*\d+$/i.test(text) ? 'drop' : 'emit';
    const full = `${OUTPUT_LIMIT_HEAD} ${OUTPUT_LIMIT_TAIL}`;
    if (stripped === full || stripped === OUTPUT_LIMIT_HEAD || stripped === OUTPUT_LIMIT_TAIL)
        return 'drop';
    if (full.startsWith(stripped) && stripped.startsWith('your previous'))
        return 'hold';
    if (OUTPUT_LIMIT_TAIL.startsWith(stripped) && stripped.startsWith('please continue from where you left off'))
        return 'hold';
    if ('retries remaining:'.startsWith(text) && text.startsWith('retries'))
        return 'hold';
    return 'emit';
}
/**
 * Classify buffered `agent_message_chunk` text against agy's non-model notices.
 * @param raw - buffered message text since the last emitted or dropped chunk.
 * @param final - true when the message stream ended or switched away from text.
 * @returns how the turn should handle `raw`.
 */
export function classifyAgentNotice(raw, final = false) {
    const outputLimit = classifyOutputLimitNotice(raw);
    if (outputLimit === 'drop')
        return { kind: 'drop' };
    if (outputLimit === 'hold')
        return final ? { kind: 'emit' } : { kind: 'hold' };
    if (AGENT_RETRY_NOTICE.test(raw)) {
        const notice = raw.trimStart().split(/\r?\n/, 1)[0] ?? '';
        const detail = notice.replace(AGENT_RETRY_NOTICE, '');
        // Only inspect the CLI's retry envelope. A model can discuss these same codes in regular text.
        const code = /(?:\bHTTP(?:\/\d(?:\.\d)?)?\s+|\b(?:status(?:Code)?|code)["']?\s*[:=_ ]\s*["']?|^\s*:\s*)(401|403)\b/i.exec(detail)?.[1];
        if (code === '401' || /\bUNAUTHENTICATED\b/.test(detail))
            return { kind: 'upstream-retry', status: 401, message: notice };
        if (code === '403' || /\b(?:PERMISSION_DENIED|TOS_VIOLATION)\b/.test(detail))
            return { kind: 'upstream-retry', status: 403, message: notice };
        if (reportsUpstream429(detail))
            return { kind: 'upstream-retry', status: 429, message: notice };
        if (!final && !raw.trimStart().includes('\n') && !/\b(?:EOF|ECONNRESET|ETIMEDOUT)\b/i.test(notice))
            return { kind: 'hold' };
        return { kind: 'drop' };
    }
    if (!final && (WARNING_PREFIX.test(raw) || AGENT_RETRY_PREFIX.test(raw.trim()))) {
        return { kind: 'hold' };
    }
    const text = noticeText(raw);
    if (text.length === 0)
        return { kind: 'emit' };
    if (raw.trimStart().startsWith('\u26a0')) {
        const expected = RESOURCE_WARNING.toLowerCase();
        if (text === expected)
            return { kind: 'upstream-retry', status: 429, message: RESOURCE_WARNING };
        if (!final && expected.startsWith(text))
            return { kind: 'hold' };
    }
    const network = matchTerminalNotice(raw, text, NETWORK_ISSUE_HEAD, 'TRANSPORT', NETWORK_ISSUE_MESSAGE, final);
    if (network !== undefined)
        return network;
    const traffic = matchTerminalNotice(raw, text, HIGH_TRAFFIC_HEAD, 'RATE_LIMIT', HIGH_TRAFFIC_MESSAGE, final);
    if (traffic !== undefined)
        return traffic;
    return { kind: 'emit' };
}
/** Tool the agent calls to keep waiting on a relayed DSH tool result. */
export const AWAIT_TOOL_NAME = 'dsh_await_result';
/** MCP descriptor of {@link AWAIT_TOOL_NAME}. */
export const AWAIT_TOOL = {
    name: AWAIT_TOOL_NAME,
    description: 'Wait for the result of a harness tool call that reported it is still running. Call this only when a tool result tells you to, passing the call_id it gave.',
    inputSchema: {
        type: 'object',
        properties: { call_id: { type: 'string', description: 'The call id from the still-running notice.' } },
        required: ['call_id'],
    },
};
/** MCP descriptor of {@link CALL_TOOL_NAME} (~340B, stays below agy's lazy cutoff). */
export const CALL_TOOL = {
    name: CALL_TOOL_NAME,
    description: 'Invoke any harness tool by exact name when mcp_dsh_<name> is absent from your direct tool declarations.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Exact DSH tool name without mcp_dsh_ prefix.' },
            arguments: { type: 'object', description: 'Arguments object matching that tool schema.' },
        },
        required: ['name'],
    },
};
/** Maximum in-place continuation prompts sent per turn when `agy` ends a turn right after a native permission denial. */
export const MAX_PERMISSION_CONTINUATIONS = 2;
/**
 * Failure that ends one step as degraded, so the harness request-retry layer
 * asks for the identical request again about a second later and the plugin
 * re-answers inside the same ACP session.
 * @returns the tagged failure with the harness retry hint.
 */
export function degradedRouteError() {
    return new LlmError(labeled('DEGRADED_ROUTE', '上游把这次回答分到了降级线路，已在原会话重新生成。'), 'DEGRADED_ROUTE', { providerRetryAfterMs: 1_000 });
}
/**
 * Failure that ends a step whose degraded tool call never recovered within the
 * automatic re-answer budget; the tool was never executed.
 * @returns the terminal failure.
 */
export function degradedExhaustedError() {
    return new LlmError(labeled('DEGRADED_ROUTE_EXHAUSTED', '上游连续把这次回答分到了降级线路；本次工具调用没有执行，请稍后重试。'), 'DEGRADED_ROUTE_EXHAUSTED');
}
/**
 * Whether a failure asks for (or reports the end of) an automatic re-answer.
 * Neither is upstream quota: such failures must never cool an account down,
 * fail a step over to another account, or reset the ACP session.
 * @param error - the failure.
 * @returns true for {@link degradedRouteError} and {@link degradedExhaustedError}.
 */
export function isReanswerFailure(error) {
    const code = error?.code;
    return code === 'DEGRADED_ROUTE' || code === 'DEGRADED_ROUTE_EXHAUSTED';
}
const BRIDGE_TOOLS_MISSING = Symbol('bridgeToolsMissing');
/** Retryable failure raised when an `agy` worker runs a bridge turn without mounting DSH MCP tools. */
export function bridgeToolsMissingError() {
    const error = new LlmError(labeled('TRANSPORT', 'agy worker 未挂载 DSH MCP 工具，已关闭异常 worker 并自动重连。'), 'TRANSPORT', { providerRetryAfterMs: 1_000 });
    error[BRIDGE_TOOLS_MISSING] = true;
    return error;
}
/** Whether `error` was raised by {@link bridgeToolsMissingError}. */
export function isBridgeToolsMissingFailure(error) {
    return typeof error === 'object' && error !== null && error[BRIDGE_TOOLS_MISSING] === true;
}
export function idleError(message) {
    if ('fromFailure' in LlmError && typeof LlmError.fromFailure === 'function')
        return LlmError.fromFailure({ code: 'MODEL_IDLE', message });
    return new LlmError(message, 'MODEL_IDLE');
}
/** One running ACP prompt turn. */
export class AcpTurn {
    turnTag;
    nativeMode;
    events = new AsyncQueue();
    firstResponseTimer;
    onModelIdle;
    awaitingTools = 0;
    // 模型续接与用户的同一轮请求共享计数和已完成的调用。
    // 续接沿用本轮诊断。CHG-20261126-204000-agy-idle-cause-92b178e0
    idleRecovery = {
        startedAt: Date.now(),
        dbPath: undefined,
        notice: undefined,
        partialText: false,
        // CHG-20261127-132000-agy-idle-progress-340ca1ec：记录连续空转，重复查询结果不计进展。
        queryResults: new Set(),
        retries: 0,
        beforeRetry: 0,
        completed: [],
    };
    retryInput = [];
    modelSignal;
    watchModel(onIdle) {
        this.onModelIdle = onIdle;
        this.resumeModel();
    }
    // 普通回答与历史分片共用空闲预算，仅在 ACP 确认取消后重发。
    awaitingIdleCancel = false;
    watchIdleRecovery(isCurrent, cancel, interrupt) {
        this.awaitingIdleCancel = false;
        this.watchModel(() => {
            if (!isCurrent())
                return;
            if (this.agentFailure)
                return interrupt(this.agentFailure);
            if (this.idleRecovery.retries >= 5)
                return interrupt(this.exhaustedIdleError());
            this.awaitingIdleCancel = true;
            this.finished = true;
            this.stopWatching();
            cancel();
            this.waitForFirstResponse(() => interrupt(idleError('未收到上次请求的取消回执，自动续接已暂停。')));
        });
    }
    exhaustedIdleError() {
        const { dbPath, startedAt, notice, partialText, retries } = this.idleRecovery;
        const message = (dbPath && lastGenerationError(dbPath, notice?.time ?? startedAt)) ?? notice?.message;
        // 只显示诊断类别，避免把请求地址与响应体带入会话。
        const reason = message?.match(/\b(?:unexpected EOF|EOF|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|TLS handshake timeout|context deadline exceeded|connection reset by peer|connection refused|HTTP(?:\/[\d.]+)? [45]\d\d)\b/i)?.[0];
        const diagnostic = reason ? 'agy 最近一次生成请求错误为 ' + reason + '。' : message ? 'agy 记录过生成请求错误。' : '';
        return idleError((partialText ? '模型已返回部分正文。' : '') + diagnostic + '已连续自动续接 ' + retries + ' 次仍无新的工具成果，模型最后连续 3 分钟没有进展。已保留本轮进度，可发送“继续”。');
    }
    resumeAfterIdleCancel(result) {
        if (!this.awaitingIdleCancel || result.stopReason !== 'cancelled')
            return false;
        this.awaitingIdleCancel = false;
        this.stopWatching();
        this.finished = false;
        this.idleRecovery.retries++;
        this.idleRecovery.beforeRetry = this.idleRecovery.completed.length;
        return true;
    }
    noteModelProgress() {
        if (!this.firstResponseTimer)
            return;
        this.clearFirstResponseTimer();
        if (this.onModelIdle)
            this.waitForFirstResponse(this.onModelIdle);
    }
    resumeModel() {
        if (!this.onModelIdle || this.finished || this.awaitingTools || this.pendingCalls.size ||
            [...this.calls.values()].some(call => !call.result.settled))
            return;
        this.clearFirstResponseTimer();
        this.waitForFirstResponse(this.onModelIdle);
    }
    async duringTool(work) {
        this.awaitingTools++;
        this.clearFirstResponseTimer();
        try {
            return await work();
        }
        finally {
            this.awaitingTools--;
            this.resumeModel();
        }
    }
    stopWatching() {
        this.onModelIdle = undefined;
        this.clearFirstResponseTimer();
    }
    waitForFirstResponse(onTimeout) {
        this.firstResponseTimer = setTimeout(() => {
            this.firstResponseTimer = undefined;
            // An unfinished status prefix can still be real model text.
            const held = this.recoverNoticeHold();
            if (held.trim()) {
                this.events.push({ kind: 'text', text: held });
                this.resumeModel();
            }
            else
                onTimeout();
        }, 180_000);
    }
    clearFirstResponseTimer() {
        if (this.firstResponseTimer === undefined)
            return;
        clearTimeout(this.firstResponseTimer);
        this.firstResponseTimer = undefined;
    }
    /** Calls handed to DSH whose results have not arrived yet. */
    pendingCalls = new Map();
    /** Calls the agent issued during this turn. */
    calls = new Map();
    /** DSH steps this turn has ended with `tool-calls`. */
    toolSteps = 0;
    /** Long-decode continuations sent in this turn. */
    continuations = 0;
    /** In-place continuations sent after `agy` aborted `session/prompt` on a denied native built-in tool call. */
    permissionContinuations = 0;
    /** Unhandled native built-in permission denials since the last visible text or MCP tool park. */
    pendingNativeDenials = [];
    /** Most recent native built-in permission denial in this turn, used as visible fallback after continuation cap. */
    lastNativeDenial;
    /** The agent ended the prompt. */
    finished = false;
    /** A parked call was answered with a still-running notice and the agent has not resumed waiting yet. */
    relaying = false;
    /** The turn produced visible text or a tool call. */
    produced = false;
    /** Agent-side transport retry notices dropped from the output. */
    retryNotices = 0;
    /** Terminal transport or overload failure reported as message text by agy. */
    agentFailure;
    /** Observed an `unknown tool: "mcp_dsh_..."` rejection on this turn's ACP stream. */
    missingBridgeTools = false;
    upstreamStopped = false;
    cancelUpstreamRetry;
    onUpstreamRetry;
    upstreamFlushPending = false;
    /** Message text that may still be the start of an agy status notice. */
    noticeHold = '';
    /** Model calls inside this turn whose usage was already emitted per-step from SQLite. */
    emittedCalls = 0;
    /** Cumulative raw token counts already emitted per-step from SQLite during this turn. */
    emittedRaw = {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
    };
    /** Usage read from the session DB for the step that is ending, not yet reported. */
    stagedUsage;
    /** Built-in non-MCP toolCallIds already traced to `reasoning` in `native` mode. */
    tracedToolCallIds = new Set();
    nextCall = 0;
    /**
     * @param turnTag - unique per-turn hex tag used in synthesized call ids (`agy_<turnTag>_<n>`).
     * @param nativeMode - whether to emit concise `[agy]` reasoning traces for built-in tool calls.
     */
    constructor(turnTag, nativeMode = false) {
        this.turnTag = turnTag;
        this.nativeMode = nativeMode;
    }
    /**
     * Record one batch of per-step model usage read from the local session DB.
     * @param batch - per-step usage batch consumed since the previous cursor.
     */
    recordStepBatch(batch) {
        this.emittedCalls += batch.calls;
        this.emittedRaw.inputTokens += batch.usage.inputTokens ?? 0;
        this.emittedRaw.outputTokens += batch.usage.outputTokens ?? 0;
        this.emittedRaw.cachedReadTokens += batch.usage.cachedReadTokens ?? 0;
        this.emittedRaw.cachedWriteTokens += batch.usage.cachedWriteTokens ?? 0;
        this.emittedRaw.thoughtTokens += batch.usage.thoughtTokens ?? 0;
    }
    /**
     * Hold usage a read consumed for the step that is ending, so it is reported exactly
     * once: the degradation gate and the end-of-turn check read the same batch the step
     * reports, and a second read would find nothing left.
     * @param sample - usage of the model steps read so far in this step.
     */
    stageStepUsage(sample) {
        const staged = this.stagedUsage;
        if (staged === undefined) {
            this.stagedUsage = { calls: sample.calls, usage: { ...sample.usage }, steps: [...sample.steps] };
            return;
        }
        staged.calls += sample.calls;
        staged.steps.push(...sample.steps);
        staged.usage.inputTokens = (staged.usage.inputTokens ?? 0) + (sample.usage.inputTokens ?? 0);
        staged.usage.outputTokens = (staged.usage.outputTokens ?? 0) + (sample.usage.outputTokens ?? 0);
        staged.usage.cachedReadTokens = (staged.usage.cachedReadTokens ?? 0) + (sample.usage.cachedReadTokens ?? 0);
        staged.usage.cachedWriteTokens = (staged.usage.cachedWriteTokens ?? 0) + (sample.usage.cachedWriteTokens ?? 0);
        staged.usage.thoughtTokens = (staged.usage.thoughtTokens ?? 0) + (sample.usage.thoughtTokens ?? 0);
        staged.usage.totalTokens = (staged.usage.totalTokens ?? 0) + (sample.usage.totalTokens ?? 0);
    }
    /**
     * Take the usage staged for the step that is ending.
     * @returns the staged sample and clears it.
     */
    takeStepUsage() {
        const staged = this.stagedUsage;
        this.stagedUsage = undefined;
        return staged;
    }
    /**
     * Whether an earlier read already staged usage for the step that is ending: the
     * tool gate and the end-of-turn check read the generation this step reports.
     */
    hasStagedUsage() {
        return this.stagedUsage !== undefined;
    }
    /** Inspect staged usage without consuming it (used by end-of-turn guards). */
    peekStagedUsage() {
        return this.stagedUsage;
    }
    /**
     * Drop the usage staged for a step that will never be delivered, counting it as
     * already emitted so a later fallback subtraction never reports it twice.
     */
    discardStagedUsage() {
        const staged = this.takeStepUsage();
        if (staged !== undefined)
            this.recordStepBatch(staged);
    }
    /**
     * Record one denied native built-in tool call so an immediate zero-output
     * `end_turn` from `agy` can continue in-place instead of failing with `EMPTY_RESPONSE`.
     * @param denial - the refused native built-in call details.
     */
    noteNativeDenial(denial) {
        this.pendingNativeDenials.push(denial);
        this.lastNativeDenial = denial;
    }
    /**
     * Register one agent tool call.
     * @param name - DSH tool name.
     * @param args - parsed arguments.
     * @returns the parked call.
     */
    park(name, args) {
        const held = this.recoverNoticeHold();
        if (held.length > 0 && !this.relaying)
            this.events.push({ kind: 'text', text: held });
        this.agentFailure = undefined;
        this.pendingNativeDenials.length = 0;
        const call = {
            id: ToolCallId(`agy_${this.turnTag}_${++this.nextCall}`),
            name,
            argumentsJson: JSON.stringify(args),
            result: deferred(),
        };
        this.calls.set(call.id, call);
        this.events.push({ kind: 'park', call });
        return call;
    }
    /**
     * Route one ACP session update into the event queue.
     * @param update - the agent notification.
     */
    onUpdate(update) {
        if (this.finished && !(this.upstreamFlushPending && update.sessionUpdate === 'agent_message_chunk'))
            return;
        const text = update.content?.type === 'text' ? update.content.text ?? '' : '';
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
            || (update.sessionUpdate === 'plan' && Array.isArray(update.entries) && update.entries.length > 0)
            || (update.sessionUpdate === 'agent_thought_chunk' && text.trim())
            || (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type !== 'text')) {
            this.noteModelProgress();
        }
        if (update.sessionUpdate === 'agent_message_chunk' && text.length > 0) {
            this.consumeMessage(text);
            return;
        }
        if (update.sessionUpdate === 'agent_thought_chunk') {
            const held = this.recoverNoticeHold();
            if (held.length > 0 && !this.relaying)
                this.events.push({ kind: 'text', text: held });
            if (text.length > 0 && !this.relaying)
                this.events.push({ kind: 'thought', text });
            return;
        }
        if (update.sessionUpdate === 'tool_call_update' && update.status === 'failed') {
            const raw = [
                text,
                typeof update.title === 'string' ? update.title : '',
                typeof update['rawOutput'] === 'string' ? update['rawOutput'] : '',
            ].join('\n');
            if (/unknown tool:\s*"mcp_dsh_/i.test(raw))
                this.missingBridgeTools = true;
        }
        if (this.nativeMode
            && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
            && typeof update.toolCallId === 'string'
            && update.toolCallId.length > 0
            && !this.tracedToolCallIds.has(update.toolCallId)) {
            const summary = summarizeNativeBuiltinToolUpdate(update);
            if (summary !== undefined) {
                this.tracedToolCallIds.add(update.toolCallId);
                const held = this.recoverNoticeHold();
                if (held.length > 0 && !this.relaying)
                    this.events.push({ kind: 'text', text: held });
                if (!this.relaying)
                    this.events.push({ kind: 'thought', text: `\n[agy] ${summary}\n` });
            }
        }
    }
    /**
     * Keep a message chunk out of the chat while it matches or may still complete an agy status notice.
     * @param text - one streamed message chunk.
     */
    consumeMessage(text) {
        if (this.noticeHold.length === 0 && this.agentFailure !== undefined && text.trim().length === 0) {
            return;
        }
        const combined = this.noticeHold + text;
        const body = combined.trimStart();
        const newline = body.indexOf('\n');
        if (newline >= 0 && newline + 1 < body.length && AGENT_RETRY_NOTICE.test(body)) {
            this.noticeHold = '';
            this.consumeMessage(body.slice(0, newline + 1));
            if (!this.finished)
                this.consumeMessage(body.slice(newline + 1));
            return;
        }
        const verdict = classifyAgentNotice(combined, false);
        if (verdict.kind === 'hold') {
            this.noticeHold = combined;
            return;
        }
        this.noticeHold = '';
        if (verdict.kind === 'upstream-retry') {
            this.noticeHold = combined;
            this.upstreamStopped = true;
            if (!this.upstreamFlushPending) {
                this.upstreamFlushPending = true;
                this.finished = true;
                this.cancelUpstreamRetry?.();
                // 立即取消。换行或 RPC 结束就交付诊断；CLI 不回执时最多给在途错误尾部 100 ms。
                if (!body.includes('\n'))
                    setTimeout(() => {
                        if (this.upstreamFlushPending)
                            this.recoverNoticeHold();
                    }, 100).unref();
            }
            if (body.includes('\n'))
                this.recoverNoticeHold();
            return;
        }
        if (verdict.kind === 'drop') {
            if (AGENT_RETRY_NOTICE.test(combined))
                this.idleRecovery.notice = { time: Date.now(), message: combined };
            this.retryNotices++;
            return;
        }
        if (verdict.kind === 'error') {
            this.retryNotices++;
            this.agentFailure = new LlmError(labeled(verdict.code, verdict.message), verdict.code);
            return;
        }
        if (combined.trim().length > 0) {
            this.noteModelProgress();
            this.agentFailure = undefined;
            this.pendingNativeDenials.length = 0;
        }
        if (!this.relaying)
            this.events.push({ kind: 'text', text: combined });
    }
    /**
     * Release a held prefix once the message stream moves on.
     * A finished agy notice is counted and discarded (or recorded on `agentFailure`); anything else is returned for emission.
     * @returns model text to show, or an empty string.
     */
    recoverNoticeHold() {
        if (this.noticeHold.length === 0)
            return '';
        const held = this.noticeHold;
        this.noticeHold = '';
        const verdict = classifyAgentNotice(held, true);
        if (verdict.kind === 'upstream-retry') {
            this.upstreamFlushPending = false;
            const requestId = upstreamRequestId(verdict.message);
            const facts = { status: verdict.status, ...(requestId === undefined ? {} : { requestId: ProviderRequestId(requestId) }) };
            this.agentFailure = verdict.status === 429
                ? new LlmError(verdict.message, 'RATE_LIMIT')
                : new LlmError(verdict.message, 'AUTH', facts);
            this.onUpstreamRetry?.(this.agentFailure);
            return '';
        }
        if (verdict.kind === 'drop') {
            if (AGENT_RETRY_NOTICE.test(held))
                this.idleRecovery.notice = { time: Date.now(), message: held };
            this.retryNotices++;
            return '';
        }
        if (verdict.kind === 'error') {
            this.retryNotices++;
            this.agentFailure = new LlmError(labeled(verdict.code, verdict.message), verdict.code);
            return '';
        }
        if (this.agentFailure !== undefined && WARNING_PREFIX.test(held)) {
            return '';
        }
        if (held.trim().length > 0) {
            this.noteModelProgress();
            this.agentFailure = undefined;
            this.pendingNativeDenials.length = 0;
        }
        return this.relaying ? '' : held;
    }
    /**
     * Abandon every parked call with an error result.
     * @param reason - message delivered to the agent.
     */
    abandon(reason) {
        this.stopWatching();
        for (const call of this.calls.values()) {
            call.result.resolve({ content: [{ type: 'text', text: reason }], isError: true });
        }
        this.pendingCalls.clear();
    }
}
function summarizeNativeBuiltinToolUpdate(update) {
    const meta = update._meta;
    const mcpServer = update.mcpServerName ?? meta?.mcpServerName ?? meta?.serverName ?? meta?.server;
    if (typeof mcpServer === 'string' && mcpServer.length > 0)
        return undefined;
    if (typeof update.mcpToolName === 'string' && update.mcpToolName.length > 0)
        return undefined;
    if (typeof meta?.mcpToolName === 'string' && meta?.mcpToolName.length > 0)
        return undefined;
    const rawName = typeof update.name === 'string' && update.name.trim().length > 0
        ? update.name.trim()
        : (typeof meta?.name === 'string' && meta.name.trim().length > 0 ? meta.name.trim() : '');
    const rawTitle = typeof update.title === 'string' ? update.title.replace(/\s+/gu, ' ').trim() : '';
    if (rawName.startsWith('mcp_') || rawTitle.startsWith('mcp_'))
        return undefined;
    let detail = '';
    if (Array.isArray(update.locations) && typeof update.locations[0]?.path === 'string') {
        detail = update.locations[0].path.trim();
    }
    else if (update.rawInput !== null && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput)) {
        const rec = update.rawInput;
        const candidate = rec.Path ?? rec.path ?? rec.CommandLine ?? rec.command ?? rec.query;
        if (typeof candidate === 'string')
            detail = candidate.replace(/\s+/gu, ' ').trim();
    }
    if (detail.length > 100)
        detail = `${detail.slice(0, 99)}…`;
    const head = rawTitle.length > 0
        ? (rawName.length > 0 && rawTitle !== rawName && !rawTitle.includes(rawName) ? `${rawName}: ${rawTitle}` : rawTitle)
        : (rawName.length > 0 ? rawName : (typeof update.kind === 'string' && update.kind.length > 0 && update.kind !== 'other' ? update.kind : ''));
    if (head.length === 0)
        return undefined;
    const full = detail.length > 0 && !head.includes(detail) ? `${head} (${detail})` : head;
    return full.length > 160 ? `${full.slice(0, 159)}…` : full;
}
/**
 * Map one completed prompt or step sample to DSH token usage. When a single
 * sample spanned `calls` internal model steps (tool rounds or continuations),
 * prompt buckets are normalized by `calls` so DSH's native ContextMeter reflects
 * single-request context occupancy rather than the multi-step sum.
 *
 * `agy acp` reports `inputTokens` as uncached input only, disjoint from
 * `cachedReadTokens` and `cachedWriteTokens`, so every bucket is kept as
 * reported and the total is their sum.
 * @param usage - the agent's step or turn usage.
 * @param calls - model calls executed inside this sample (>= 1).
 * @returns DSH usage.
 */
export function toTokenUsage(usage, calls = 1) {
    if (usage === undefined)
        return undefined;
    const scale = Math.max(1, calls);
    const input = Math.max(0, Math.round((usage.inputTokens ?? 0) / scale));
    const cacheRead = Math.max(0, Math.round((usage.cachedReadTokens ?? 0) / scale));
    const cacheWrite = Math.max(0, Math.round((usage.cachedWriteTokens ?? 0) / scale));
    const output = Math.max(0, usage.outputTokens ?? 0);
    const reasoning = usage.thoughtTokens !== undefined && usage.thoughtTokens > 0
        ? Math.min(output, usage.thoughtTokens)
        : undefined;
    return {
        inputTokens: input,
        outputTokens: output,
        ...usage.cachedReadTokens !== undefined || cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
        ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
        ...reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {},
        totalTokens: input + cacheRead + cacheWrite + output,
    };
}
/**
 * Stream one DSH step out of the running turn.
 * @param turn - the running ACP turn.
 * @param host - owner effects.
 * @param signal - DSH cancellation.
 * @yields DSH stream chunks ending with one finish chunk.
 */
export async function* pumpStep(turn, host, signal) {
    let index = 0;
    let open;
    const close = function* () {
        if (open === undefined)
            return;
        const block = open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text };
        yield { type: 'block-end', index: open.index, block };
        open = undefined;
    };
    const append = function* (type, text) {
        if (open?.type !== type) {
            yield* close();
            open = { index: index++, type, text: '' };
            yield { type: 'block-start', index: open.index, blockType: type };
        }
        open.text += text;
        yield type === 'text' ? { type: 'text-delta', index: open.index, text } : { type: 'reasoning-delta', index: open.index, text };
    };
    let sawStepThought = false;
    let heldZeroThoughtText = '';
    let emittedVisibleText = false;
    const flushHeldText = function* () {
        if (heldZeroThoughtText.length === 0)
            return;
        const text = heldZeroThoughtText;
        heldZeroThoughtText = '';
        turn.produced = true;
        emittedVisibleText = true;
        yield* append('text', text);
    };
    for (;;) {
        const ready = await turn.events.wait(signal);
        if (!ready) {
            host.cancel();
            turn.abandon('The harness cancelled this request.');
            heldZeroThoughtText = '';
            yield* close();
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } };
            return;
        }
        if (turn.events.peek()?.kind !== 'text') {
            const held = turn.recoverNoticeHold();
            if (held.length > 0) {
                if (held.trim())
                    turn.idleRecovery.partialText = true;
                if (host.holdZeroThoughtText === true && !sawStepThought && !emittedVisibleText) {
                    heldZeroThoughtText += held;
                }
                else {
                    turn.produced = true;
                    emittedVisibleText = true;
                    yield* append('text', held);
                }
            }
        }
        const event = turn.events.shift();
        switch (event.kind) {
            case 'thought':
                sawStepThought = true;
                yield* flushHeldText();
                yield* append('reasoning', event.text);
                break;
            case 'text':
                if (event.text.trim())
                    turn.idleRecovery.partialText = true;
                if (host.holdZeroThoughtText === true && !sawStepThought && !emittedVisibleText) {
                    heldZeroThoughtText += event.text;
                }
                else {
                    turn.produced = true;
                    emittedVisibleText = true;
                    yield* append('text', event.text);
                }
                break;
            case 'park': {
                yield* flushHeldText();
                turn.produced = true;
                yield* close();
                const batch = [event.call];
                // Parallel calls of one model response arrive within a short window.
                while (await turn.events.wait(signal, host.parkSettleMs)) {
                    const next = turn.events.peek();
                    if (next?.kind !== 'park')
                        break;
                    turn.events.shift();
                    batch.push(next.call);
                }
                for (const call of batch) {
                    const blockIndex = index++;
                    turn.pendingCalls.set(call.id, call);
                    yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' };
                    yield { type: 'tool-call-delta', index: blockIndex, id: call.id, name: call.name, argumentsDelta: call.argumentsJson };
                    yield { type: 'block-end', index: blockIndex, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.argumentsJson } };
                }
                const stepSample = await host.consumeStepUsage?.({ final: false });
                if (stepSample !== undefined) {
                    const usage = toTokenUsage(stepSample.usage, stepSample.calls);
                    if (usage !== undefined)
                        yield { type: 'usage', usage };
                }
                turn.toolSteps++;
                yield { type: 'finish', reason: { kind: 'tool-calls' } };
                return;
            }
            case 'done': {
                if (turn.agentFailure !== undefined) {
                    heldZeroThoughtText = '';
                    turn.finished = true;
                    yield* close();
                    throw turn.agentFailure;
                }
                const stop = event.result.stopReason;
                if (stop === 'max_tokens' && turn.continuations < host.maxContinuations) {
                    yield* flushHeldText();
                    turn.continuations++;
                    host.continuePrompt();
                    break;
                }
                if (stop === 'end_turn' && turn.pendingNativeDenials.length > 0) {
                    const denials = turn.pendingNativeDenials.splice(0);
                    const maxPermCont = host.maxPermissionContinuations ?? MAX_PERMISSION_CONTINUATIONS;
                    if (host.continueAfterPermissionDenial !== undefined && turn.permissionContinuations < maxPermCont) {
                        yield* flushHeldText();
                        turn.permissionContinuations++;
                        host.continueAfterPermissionDenial(denials);
                        break;
                    }
                }
                if (stop === 'end_turn' && host.verifyEndTurn !== undefined) {
                    const hadZeroThoughtHold = !sawStepThought && heldZeroThoughtText.length > 0 && !emittedVisibleText;
                    const verdict = await host.verifyEndTurn(hadZeroThoughtHold);
                    if (verdict === 'degrade') {
                        // The degraded answer is discarded: held text never reaches the
                        // transcript, and the step fails so the harness re-asks the same
                        // request. Reasoning already streamed stays.
                        heldZeroThoughtText = '';
                        turn.finished = true;
                        yield* close();
                        throw degradedRouteError();
                    }
                    if (verdict === 'missing-tools') {
                        heldZeroThoughtText = '';
                        turn.finished = true;
                        yield* close();
                        throw bridgeToolsMissingError();
                    }
                }
                yield* flushHeldText();
                if (stop === 'end_turn' && !turn.produced && turn.lastNativeDenial !== undefined) {
                    const d = turn.lastNativeDenial;
                    const fallback = `Operation refused by DSH sandbox policy (${d.sandboxMode}): ${d.tool} (${d.reason}).`;
                    turn.produced = true;
                    emittedVisibleText = true;
                    yield* append('text', fallback);
                }
                turn.finished = true;
                yield* close();
                const calls = turn.toolSteps + turn.continuations + turn.permissionContinuations + 1;
                host.recordUsage(event.result.usage, calls);
                const finalSample = await host.consumeStepUsage?.({ final: true });
                let usage;
                if (finalSample !== undefined) {
                    usage = toTokenUsage(finalSample.usage, finalSample.calls);
                }
                else if (turn.emittedCalls > 0 && event.result.usage !== undefined) {
                    const total = event.result.usage;
                    const remInput = Math.max(0, (total.inputTokens ?? 0) - turn.emittedRaw.inputTokens);
                    const remOutput = Math.max(0, (total.outputTokens ?? 0) - turn.emittedRaw.outputTokens);
                    const remCacheRead = Math.max(0, (total.cachedReadTokens ?? 0) - turn.emittedRaw.cachedReadTokens);
                    const remCacheWrite = Math.max(0, (total.cachedWriteTokens ?? 0) - turn.emittedRaw.cachedWriteTokens);
                    const remThought = Math.max(0, (total.thoughtTokens ?? 0) - turn.emittedRaw.thoughtTokens);
                    const rem = {
                        inputTokens: remInput,
                        outputTokens: remOutput,
                        ...total.cachedReadTokens !== undefined ? { cachedReadTokens: remCacheRead } : {},
                        cachedWriteTokens: remCacheWrite,
                        thoughtTokens: remThought,
                        totalTokens: remInput + remCacheRead + remCacheWrite + remOutput,
                    };
                    const remCalls = Math.max(1, calls - turn.emittedCalls);
                    usage = toTokenUsage(rem, remCalls);
                }
                else {
                    usage = toTokenUsage(event.result.usage, calls);
                }
                if (usage !== undefined)
                    yield { type: 'usage', usage };
                if (stop === 'end_turn' && !turn.produced) {
                    throw new LlmError(labeled('EMPTY_RESPONSE', 'Antigravity ended the turn without visible output'), 'EMPTY_RESPONSE');
                }
                switch (stop) {
                    case 'end_turn':
                        yield { type: 'finish', reason: { kind: 'stop' } };
                        return;
                    case 'max_tokens':
                        yield { type: 'finish', reason: { kind: 'max-tokens' } };
                        return;
                    case 'cancelled':
                        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Antigravity cancelled the turn', code: 'ABORTED' } } };
                        return;
                    case 'refusal':
                        yield { type: 'finish', reason: { kind: 'error', failure: { message: labeled('REFUSAL', 'Antigravity refused the request'), code: 'REFUSAL' } } };
                        return;
                    default:
                        yield { type: 'finish', reason: { kind: 'error', failure: { message: `Antigravity stopped: ${stop}`, code: 'PROVIDER_ERROR' } } };
                        return;
                }
            }
            case 'error':
                turn.finished = true;
                if (event.error instanceof LlmError && event.error.code === 'MODEL_IDLE')
                    yield* flushHeldText();
                yield* close();
                throw turn.agentFailure ?? event.error;
        }
    }
}
/**
 * Notice returned to the agent when a DSH tool outlives the MCP call deadline.
 * @param call - the still-running call.
 * @returns MCP result instructing the agent to keep waiting.
 */
export function relayNotice(call) {
    return {
        content: [{
                type: 'text',
                text: `The harness is still running tool call ${call.id} (${call.name}). Call ${AGENT_TOOL_PREFIX}${AWAIT_TOOL_NAME} with {"call_id":"${call.id}"} now to receive its result. Do not repeat the original call and do not answer the user before the result arrives.`,
            }],
    };
}
