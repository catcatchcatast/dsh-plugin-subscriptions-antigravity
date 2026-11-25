/**
 * Startup preparation: locate the official `agy` binary, verify (and when
 * allowed, apply) the local context-window unlock, and lay out the isolated
 * Antigravity home that ACP sessions use.
 *
 * The isolated home keeps the user's global Antigravity rules, skills, and
 * MCP servers out of DSH sessions. Bridge sessions use a dedicated scoped agent;
 * the previous generated agent is retired without overwriting its remaining rules.
 * @module dsh-llm-antigravity-acp/preflight
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
/** Dedicated scoped agent used by bridge-mode ACP processes. */
export const BRIDGE_AGENT = 'dsh-bridge-scoped';
/** Previous plugin-generated agent id retained only for safe retirement. */
const LEGACY_BRIDGE_AGENT = 'dsh-bridge';
/** Minimum official CLI version supporting `agy acp --process-per-session`. */
export const MIN_AGY_VERSION = [1, 4, 12];
/** Default model display name pre-seeded into isolated `settings.json` files. */
export const DEFAULT_SEEDED_MODEL = 'Gemini 4 Argon (High)';
/** Default context-window label aligned with `~/.gemini/antigravity-cli/settings.json`. */
export const DEFAULT_SEEDED_CONTEXT_WINDOW = '512K';
/** Context window the official binary enforces without the unlock. */
export const LOCKED_CONTEXT_WINDOW = 256_000;
/** Physical context window of the Gemini 4, Gemini 3.8, and Claude 5.5 families. */
export const UNLOCKED_CONTEXT_WINDOW = 1_048_576;
/** GPT-OSS 120B keeps its own 128K-class window and is not covered by the unlock. */
export const GPT_OSS_CONTEXT_WINDOW = 131_072;
/** Clear ambient auth overrides only for the spawned process. */
export function agyChildEnv(base) {
    return { ...base, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, AGY_ADC_AUTH: undefined, DSH_AGY_LOCAL_KEY: undefined };
}
function splitPathDirs(env, platform) {
    const raw = env.PATH ?? env.Path ?? '';
    const sep = platform === 'win32' ? ';' : delimiter;
    const dirs = [];
    for (const part of raw.split(sep)) {
        const cleaned = part.trim().replace(/^"(.*)"$/, '$1');
        if (cleaned.length > 0)
            dirs.push(cleaned);
    }
    return dirs;
}
/**
 * Locate the `agy` executable.
 * @param configured - configured absolute path, or empty.
 * @param options - optional platform/env overrides for testing.
 * @returns the executable path.
 */
export function resolveAgyBinary(configured, options = {}) {
    if (configured.length > 0) {
        if (!isAbsolute(configured))
            throw new Error(`antigravity-acp: command must be an absolute path, got ${configured}`);
        if (!existsSync(configured))
            throw new Error(`antigravity-acp: configured agy binary not found at ${configured}`);
        return configured;
    }
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const exeName = platform === 'win32' ? 'agy.exe' : 'agy';
    const candidates = [];
    if (platform === 'win32') {
        const localAppData = env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0
            ? env.LOCALAPPDATA
            : join(home, 'AppData', 'Local');
        candidates.push(join(localAppData, 'agy', 'bin', 'agy.exe'));
        candidates.push(join(home, '.local', 'bin', 'agy.exe'));
    }
    else {
        candidates.push(join(home, '.local', 'bin', 'agy'));
    }
    for (const dir of splitPathDirs(env, platform)) {
        candidates.push(join(dir, exeName));
    }
    if (platform === 'darwin' || platform === 'linux') {
        candidates.push(join(home, '.antigravity', 'bin', 'agy'));
        if (platform === 'darwin') {
            candidates.push(join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin', 'agy'), '/Applications/Antigravity.app/Contents/Resources/app/bin/agy', '/opt/homebrew/bin/agy');
        }
        candidates.push('/usr/local/bin/agy');
        if (platform === 'linux')
            candidates.push('/usr/bin/agy');
    }
    const found = candidates.find(candidate => existsSync(candidate));
    if (found === undefined) {
        throw new Error('antigravity-acp: the Antigravity CLI (agy) was not found; install it from https://antigravity.google/docs/install?tab=cli and sign in once with `agy`');
    }
    return found;
}
/**
 * Locate a working Python 3 command for `agy-patch.py`, skipping Windows Store
 * zero-byte `WindowsApps\python*.exe` alias stubs.
 * @param options - optional platform/env overrides for testing.
 * @returns command argv prefix (e.g. `['D:\\Python\\python.exe']` or `['C:\\Windows\\py.exe', '-3']`).
 */
export function resolvePythonArgv(options = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') {
        return [existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3'];
    }
    const env = options.env ?? process.env;
    for (const dir of splitPathDirs(env, platform)) {
        if (/[/\\]Microsoft[/\\]WindowsApps(?:[/\\]|$)/i.test(dir))
            continue;
        for (const name of ['python.exe', 'python3.exe']) {
            const candidate = join(dir, name);
            try {
                if (statSync(candidate).size > 0)
                    return [candidate];
            }
            catch (_missingPython) {
                // Candidate does not exist in this PATH entry.
            }
        }
    }
    const sysRoot = env.SystemRoot && env.SystemRoot.length > 0 ? env.SystemRoot : 'C:\\Windows';
    const pyLauncher = join(sysRoot, 'py.exe');
    if (existsSync(pyLauncher))
        return [pyLauncher, '-3'];
    return ['python'];
}
/**
 * Reject outdated official `agy` binaries that predate ACP multi-session support.
 * Non-semver diagnostic strings (`unknown`, test doubles) pass through.
 * @param version - version string from `readVersion`.
 * @param binary - resolved executable path.
 */
export function assertSupportedAgyVersion(version, binary) {
    const match = /^(?:antigravity(?:\s+cli)?\s+)?v?(\d+)\.(\d+)\.(\d+)\b/i.exec(version.trim());
    if (match === null)
        return;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const [minMajor, minMinor, minPatch] = MIN_AGY_VERSION;
    const supported = major > minMajor
        || (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
    if (!supported) {
        throw new Error(`antigravity-acp: Antigravity CLI ${version.trim()} at ${binary} is too old (requires >= 1.5.0); run \`agy update\` to upgrade`);
    }
}
/**
 * Default isolated home.
 * @returns `$DSH_HOME/cache/antigravity-acp`, or `~/.dsh/cache/antigravity-acp`.
 */
export function defaultHome() {
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
    return join(dshHome, 'cache', 'antigravity-acp');
}
/**
 * Write the isolated Antigravity home: bridge agent, ACP settings, the default
 * CLI project record, and completed onboarding state.
 * @param home - absolute home directory used as `--gemini-dir`.
 * @param userHome - user home for CLI settings.
 * @returns the empty workspace directory used as every session's cwd.
 */
export function prepareHome(home, userHome = homedir()) {
    prepareScopedBridgeAgent(home);
    retireLegacyBridgeMainAgent(home);
    const appData = join(home, 'agy');
    mkdirSync(join(appData, 'conversations'), { recursive: true });
    mkdirSync(join(home, 'antigravity', 'conversations'), { recursive: true });
    const hostUseAiCredits = readHostUseAiCredits(userHome);
    seedHostAiCreditsConfig(join(home, 'config', 'config.json'), hostUseAiCredits);
    seedCliSettingsFile(join(appData, 'settings.json'), userHome, hostUseAiCredits);
    const defaultCliAppData = join(home, 'antigravity-cli');
    mkdirSync(defaultCliAppData, { recursive: true });
    seedCliSettingsFile(join(defaultCliAppData, 'settings.json'), userHome, hostUseAiCredits);
    seedDefaultCliProject(join(home, 'config', 'projects', `${DEFAULT_CLI_PROJECT_ID}.json`));
    seedOnboardingFile(join(appData, 'cache', 'onboarding.json'));
    seedOnboardingFile(join(defaultCliAppData, 'cache', 'onboarding.json'));
    const workspace = join(home, 'workspace');
    mkdirSync(workspace, { recursive: true });
    return workspace;
}
/** Retire the prior generated bridge agent while preserving its rules and permissions. */
function retireLegacyBridgeMainAgent(home) {
    const agentPath = join(home, 'config', 'plugins', LEGACY_BRIDGE_AGENT, 'agents', `${LEGACY_BRIDGE_AGENT}.md`);
    if (!existsSync(agentPath))
        return;
    const content = readFileSync(agentPath, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (frontmatter?.[1] === undefined)
        return;
    const fields = frontmatter[1].split(/\r?\n/);
    const generatedAgent = [
        `name: ${LEGACY_BRIDGE_AGENT}`,
        'description: "Primary-model bridge: no built-in tools, harness tools only"',
        'tools: []',
        'excludeDefaultComponents: true',
    ].every(field => fields.includes(field));
    if (!generatedAgent)
        return;
    const mainAgentIndex = fields.findIndex(field => /^mainAgent:\s*/.test(field));
    const subagentIndex = fields.findIndex(field => /^subagent:\s*/.test(field));
    if (fields[mainAgentIndex] === 'mainAgent: false' && fields[subagentIndex] === 'subagent: false')
        return;
    if (mainAgentIndex >= 0)
        fields[mainAgentIndex] = 'mainAgent: false';
    else
        fields.push('mainAgent: false');
    if (subagentIndex >= 0)
        fields[subagentIndex] = 'subagent: false';
    else
        fields.push('subagent: false');
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const newHeader = fields.join(lineEnding);
    const updated = content.slice(0, frontmatter.index + frontmatter[0].indexOf(frontmatter[1]))
        + newHeader
        + content.slice(frontmatter.index + frontmatter[0].indexOf(frontmatter[1]) + frontmatter[1].length);
    if (updated !== content)
        writeFileSync(agentPath, updated);
}
function prepareScopedBridgeAgent(home) {
    const pluginDir = join(home, 'config', 'plugins', BRIDGE_AGENT);
    const agentDir = join(pluginDir, 'agents');
    const pluginPath = join(pluginDir, 'plugin.json');
    const agentPath = join(agentDir, `${BRIDGE_AGENT}.md`);
    const plugin = `${JSON.stringify({ name: BRIDGE_AGENT }, null, 2)}\n`;
    const agent = [
        '---',
        `name: ${BRIDGE_AGENT}`,
        'description: "DSH ACP bridge with built-in tools disabled"',
        'tools: []',
        'mainAgent: true',
        'subagent: false',
        '---',
        '',
    ].join('\n');
    for (const [path, expected] of [[pluginPath, plugin], [agentPath, agent]]) {
        if (existsSync(path) && readFileSync(path, 'utf8') !== expected) {
            throw new Error(`antigravity-acp: refusing to overwrite user-owned scoped agent file at ${path}`);
        }
    }
    mkdirSync(agentDir, { recursive: true });
    writeIfChanged(pluginPath, plugin);
    writeIfChanged(agentPath, agent);
}
/** Project id `agy` resolves for every CLI conversation that names no project. */
export const DEFAULT_CLI_PROJECT_ID = 'default-cli-project';
/** Onboarding state seeded into both isolated app-data directories. */
export const SEEDED_ONBOARDING = { consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true };
/**
 * Seed the default CLI project record that `agy` reads on every step; a missing
 * file logs `project_store_get_file_missing`. A valid record already on disk is
 * kept, because `agy` owns its `projectResources`.
 */
function seedDefaultCliProject(projectPath) {
    if (readJson(projectPath).id === DEFAULT_CLI_PROJECT_ID)
        return;
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, `${JSON.stringify({ id: DEFAULT_CLI_PROJECT_ID, name: 'CLI Project', projectResources: {} }, null, 2)}\n`);
}
/** Mark onboarding complete so the isolated CLI never waits on its interactive onboarding flow. */
function seedOnboardingFile(onboardingPath) {
    const existing = readJson(onboardingPath);
    if (existing.consumerOnboardingComplete === true && existing.onboardingComplete === true)
        return;
    mkdirSync(dirname(onboardingPath), { recursive: true });
    writeFileSync(onboardingPath, `${JSON.stringify({
        ...existing,
        consumerOnboardingComplete: true,
        enterpriseOnboardingComplete: typeof existing.enterpriseOnboardingComplete === 'boolean'
            ? existing.enterpriseOnboardingComplete
            : SEEDED_ONBOARDING.enterpriseOnboardingComplete,
        onboardingComplete: true,
    })}\n`);
}
function readHostUseAiCredits(userHome) {
    const hostConfig = readJson(join(userHome, '.gemini', 'config', 'config.json'));
    const userSettings = hostConfig.userSettings;
    if (userSettings !== null && typeof userSettings === 'object' && !Array.isArray(userSettings)) {
        const flag = userSettings.useAiCredits;
        if (typeof flag === 'boolean')
            return flag;
    }
    return undefined;
}
function seedHostAiCreditsConfig(configPath, useAiCredits) {
    if (useAiCredits === undefined)
        return;
    const existing = readJson(configPath);
    const rawSettings = existing.userSettings;
    const existingSettings = rawSettings !== null && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
        ? rawSettings
        : {};
    mkdirSync(dirname(configPath), { recursive: true });
    writeIfChanged(configPath, `${JSON.stringify({
        ...existing,
        userSettings: {
            ...existingSettings,
            useAiCredits,
        },
    }, null, 2)}\n`);
}
function seedCliSettingsFile(settingsPath, userHome = homedir(), hostUseAiCredits) {
    const settings = readJson(settingsPath);
    const hostCliSettings = readJson(join(userHome, '.gemini', 'antigravity-cli', 'settings.json'));
    const rawModel = typeof settings.model === 'string' ? settings.model.trim() : '';
    const model = rawModel.length > 0 && rawModel !== 'Gemini 4 Argon (Medium)'
        ? rawModel
        : DEFAULT_SEEDED_MODEL;
    const contextWindow = typeof settings.contextWindow === 'string' && settings.contextWindow.trim().length > 0
        ? settings.contextWindow
        : DEFAULT_SEEDED_CONTEXT_WINDOW;
    const useG1Credits = typeof settings.useG1Credits === 'boolean'
        ? settings.useG1Credits
        : typeof hostCliSettings.useG1Credits === 'boolean'
            ? hostCliSettings.useG1Credits
            : hostUseAiCredits;
    writeIfChanged(settingsPath, `${JSON.stringify({
        ...settings,
        ...(useG1Credits !== undefined ? { useG1Credits } : {}),
        contextWindow,
        model,
        toolPermission: 'request-review',
        agentMode: '',
    }, null, 2)}\n`);
}
/**
 * Check the context-window unlock and apply it when allowed.
 * @param binary - agy executable.
 * @param script - unlock script path.
 * @param apply - whether to patch a locked binary.
 * @param run - helper command runner.
 * @param options - optional platform/env overrides for testing.
 * @returns the unlock state.
 */
export async function checkUnlock(binary, script, apply, run, options = {}) {
    if (!script)
        return { status: 'unknown', applied: false, detail: 'Using the default context window' };
    if (!existsSync(script)) {
        return { status: 'unknown', applied: false, detail: `unlock script not found at ${script}; the 256K default applies` };
    }
    const python = resolvePythonArgv(options);
    const dry = await run([...python, script, '--binary', binary, '--dry-run'], 120_000);
    const text = `${dry.stdout}\n${dry.stderr}`;
    if (/all gates already unlocked/i.test(text))
        return { status: 'unlocked', applied: false, detail: 'context gates already unlocked' };
    if (!/dry run complete/i.test(text)) {
        return { status: 'unknown', applied: false, detail: `unlock check inconclusive (exit ${dry.code ?? 'null'})` };
    }
    if (!apply)
        return { status: 'locked', applied: false, detail: 'binary is locked to 256K and autoPatch is off' };
    const patched = await run([...python, script, '--binary', binary, '--in-place'], 300_000);
    if (patched.code !== 0) {
        return { status: 'locked', applied: false, detail: `unlock failed (exit ${patched.code ?? 'null'}): ${patched.stderr.trim().split('\n').slice(-2).join(' ')}` };
    }
    const verify = await run([...python, script, '--binary', binary, '--dry-run'], 120_000);
    return /all gates already unlocked/i.test(`${verify.stdout}\n${verify.stderr}`)
        ? { status: 'unlocked', applied: true, detail: 'context gates unlocked by this preflight' }
        : { status: 'unknown', applied: true, detail: 'unlock applied but verification was inconclusive' };
}
/**
 * Read the agy version.
 * @param binary - agy executable.
 * @param run - helper command runner.
 * @returns the version text, or `unknown`.
 */
export async function readVersion(binary, run) {
    try {
        const result = await run([binary, '--version'], 30_000);
        return (result.stdout.trim() || result.stderr.trim()).split('\n')[0] ?? 'unknown';
    }
    catch (_versionFailure) {
        // The version is diagnostic only.
        return 'unknown';
    }
}
function writeIfChanged(path, content) {
    if (existsSync(path) && readFileSync(path, 'utf8') === content)
        return;
    writeFileSync(path, content);
}
function readJson(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch (_missingSettings) {
        // A missing or unreadable settings file starts empty.
        return {};
    }
}
