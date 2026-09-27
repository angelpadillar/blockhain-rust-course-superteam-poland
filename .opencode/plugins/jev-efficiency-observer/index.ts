/**
 * jev-efficiency-observer — OpenCode V2 adapter over the Agent Efficiency Runtime.
 *
 * Modes (options > JEV_OBSERVER_* env > project config > observe defaults):
 *   mode                 observe | off              master switch
 *   resultAdmissionMode  observe | deterministic    model-bound projection only
 *   shortlistMode        observe | soft             reorder + compact hint
 *   toolExposureMode     off | observe | gateway    lazy schema reduction with a
 *                                                   discover_tools fallback tool
 *   routerMode           observe | off              shadow-only AUTO
 *
 * Canonical persisted history is never modified. HARD tool filtering is not
 * implemented. AUTO never controls execution.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Plugin } from '@opencode/plugin';
import {
  AgentEfficiencyRuntime,
  DeterministicScorer,
  GATEWAY_TOOL_DESCRIPTION,
  GATEWAY_TOOL_NAME,
  StructuralTokenEstimator,
  ToolRegistry,
  applyToolExposure,
  contentToText,
  decideAutoRouterV2,
  estimateMessages,
  estimateToolSchemaTokens,
  expandToolRequest,
  groupByFamily,
  planShortlist,
  planToolExposure,
  projectToolResultsFailOpen,
  resolveToolFamily,
  RUNTIME_BUILD_ID,
  RUNTIME_VERSION,
  type AgentState,
  type CandidateAction,
  type GatewayState,
  type ScoringResult,
} from './runtime/dist/index.js';

const PLUGIN_VERSION = '1.0.0';
const OBSERVE_SUBDIR = '.jev-efficiency';
const PROJECT_CONFIG = join('.opencode', 'jev-efficiency.json');

interface SessionState {
  turn: number;
  lastUserText: string;
  recentActions: string[];
  gateway: GatewayState;
  gatewayExpansions: number;
  gatewayExpansionTurns: number;
  /** Evidence ids still referenced by this session's recent model projection. */
  recentEvidenceIds: string[];
  proposed: {
    shortlist: string[];
    candidateCount: number;
    schemaTokensBefore: number;
    schemaTokensAfter: number;
    top1: string | null;
    requiredToolPresent: boolean | null;
    router: { choice: string; reason: string };
  } | null;
}

const counters = {
  turns: 0,
  toolCalls: 0,
  toolResults: 0,
  compactions: 0,
  resultsReducible: 0,
  resultsProjected: 0,
  admissionRawTokens: 0,
  admissionProjectedTokens: 0,
  admissionSavedTokens: 0,
  admissionHookLatencyMs: 0,
  exposureFullTokens: 0,
  exposureSentTokens: 0,
  exposureTurns: 0,
  expansions: 0,
  expansionTurns: 0,
  routerProposals: 0,
  projectionFallbacks: 0,
  evidencePruned: 0,
  errors: 0,
};

/** Bounded maintenance cadence: attempt evidence retention every N results. */
let resultsSincePrune = 0;

const state = {
  sessions: new Map<string, SessionState>(),
  counters,
  dir: '',
  loadedAt: 0,
  firstCompactionAt: null as number | null,
  compactionRequests: new Map<string, { startedAt: number }>(),
  canonicalTools: [] as Array<{ name: string; description: string; kind: 'unknown'; tags: string[] }>,
  identity: {
    runtimeVersion: RUNTIME_VERSION,
    runtimeBuildId: RUNTIME_BUILD_ID,
    pluginVersion: PLUGIN_VERSION,
    policyPreset: 'custom',
    gitCommit: null as string | null,
  },
};

/** Best-effort git commit for comparable passive telemetry; null when unavailable. */
function gitCommit(directory: string): string | null {
  try {
    const out = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: directory, encoding: 'utf8', timeout: 5000 });
    const value = String(out.stdout ?? '').trim();
    return out.status === 0 && /^[0-9a-f]{4,40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function record(kind: string, payload: Record<string, unknown>): void {
  try {
    if (!state.dir) return;
    mkdirSync(state.dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), kind, plugin: `jev-efficiency-observer@${PLUGIN_VERSION}`, ...payload });
    appendFileSync(join(state.dir, 'telemetry.jsonl'), `${line}\n`, 'utf8');
    writeFileSync(join(state.dir, 'summary.json'), `${JSON.stringify(observabilitySummary(), null, 2)}\n`, 'utf8');
  } catch {
    // Telemetry must never break a hook.
  }
}

/** Compact, model-context-free session observability summary. */
function observabilitySummary(): Record<string, unknown> {
  return {
    updatedAt: new Date().toISOString(),
    ...state.identity,
    resultAdmission: {
      reductions: counters.resultsProjected,
      rawTokens: counters.admissionRawTokens,
      projectedTokens: counters.admissionProjectedTokens,
      savedTokens: counters.admissionSavedTokens,
      hookLatencyMs: counters.admissionHookLatencyMs,
    },
    toolExposure: {
      registryTools: state.canonicalTools.length,
      initiallyExposedTools: null,
      expansions: counters.expansions,
      expansionTurns: counters.expansionTurns,
      schemaTokensFull: counters.exposureFullTokens,
      schemaTokensActuallySent: counters.exposureSentTokens,
      schemaTokensAvoided: counters.exposureFullTokens - counters.exposureSentTokens,
    },
    compaction: {
      nativeCompactions: counters.compactions,
      firstCompactionAt: state.firstCompactionAt ? new Date(state.firstCompactionAt).toISOString() : null,
    },
    counters,
  };
}

function bound(text: string, max = 1200): string {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) {
    return record.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
          if (p.type === 'tool-result' && p.result && typeof p.result === 'object') {
            const r = p.result as { type?: string; value?: unknown };
            if (r.type === 'text') return String(r.value ?? '');
            if (r.type === 'content' && Array.isArray(r.value)) return r.value.map((x) => (x && typeof x === 'object' ? String((x as { text?: string }).text ?? '') : '')).join('\n');
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(message);
  } catch {
    return '';
  }
}

function lastUserText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = message && typeof message === 'object' ? (message as Record<string, unknown>).role : null;
    const text = messageText(message);
    if (text && (role === 'user' || role === undefined)) return bound(text, 1500);
  }
  return '';
}

function sessionState(sessionID: string): SessionState {
  let s = state.sessions.get(sessionID);
  if (!s) {
    s = {
      turn: 0,
      lastUserText: '',
      recentActions: [],
      gateway: { preferredTools: [], expandedFamilies: [], expandedTools: [] },
      gatewayExpansions: 0,
      gatewayExpansionTurns: 0,
      recentEvidenceIds: [],
      proposed: null,
    };
    state.sessions.set(sessionID, s);
  }
  return s;
}

/** Project-local config: <location>/.opencode/jev-efficiency.json (never global). */
function readProjectConfig(directory: string): Record<string, unknown> {
  try {
    const path = join(directory, PROJECT_CONFIG);
    if (!existsSync(path)) return {};
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

export default Plugin.define({
  id: 'jev-efficiency-observer',
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Record<string, unknown>;
    const projectConfig = readProjectConfig(ctx.location.directory ?? process.cwd());
    const pick = (key: string, env: string): unknown =>
      options[key] !== undefined ? options[key] : process.env[env] !== undefined ? process.env[env] : projectConfig[key];

    const enabled = String(pick('enabled', 'JEV_OBSERVER_ENABLED') ?? '1') !== '0';    const mode = String(pick('mode', 'JEV_OBSERVER_MODE') ?? 'observe');
    if (!enabled || mode === 'off') return; // disabled: no hooks, no telemetry

    const resultAdmissionMode = String(pick('resultAdmissionMode', 'JEV_OBSERVER_RESULT_MODE') ?? 'observe');
    const toolShortlistingMode = String(pick('shortlistMode', 'JEV_OBSERVER_SHORTLIST_MODE') ?? 'observe');
    const toolExposureMode = String(pick('toolExposureMode', 'JEV_OBSERVER_TOOL_EXPOSURE') ?? 'off');
    const routerMode = String(pick('routerMode', 'JEV_OBSERVER_ROUTER_MODE') ?? 'observe');
    const shortlistThreshold = Number(pick('routerThreshold', 'JEV_OBSERVER_ROUTER_THRESHOLD') ?? 0.6);
    const singleActionThreshold = Number(pick('singleActionThreshold', 'JEV_OBSERVER_SINGLE_ACTION_THRESHOLD') ?? 0);
    const maxTools = Number(pick('maxTools', 'JEV_OBSERVER_MAX_TOOLS') ?? 3);
    const gatewayPreferred = String(pick('gatewayPreferredTools', 'JEV_OBSERVER_GATEWAY_PREFERRED') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const requiredTools = String(pick('requiredTools', 'JEV_OBSERVER_REQUIRED_TOOLS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const evidenceMaxEntries = Number(pick('evidenceMaxEntries', 'JEV_OBSERVER_EVIDENCE_MAX_ENTRIES') ?? 2000);
    const evidenceMaxAgeMs = Number(pick('evidenceMaxAgeMs', 'JEV_OBSERVER_EVIDENCE_MAX_AGE_MS') ?? 0) || null;
    const evidencePruneDryRun = String(pick('evidencePruneDryRun', 'JEV_OBSERVER_EVIDENCE_PRUNE_DRY_RUN') ?? '0') === '1';
    const clmBaseUrl = typeof options.clmBaseUrl === 'string' ? options.clmBaseUrl : process.env.CLM_BASE_URL;
    const clmUsdPerCall = typeof options.clmUsdPerCall === 'number' ? options.clmUsdPerCall : null;
    const jevUsdPerCall = typeof options.jevUsdPerCall === 'number' ? options.jevUsdPerCall : null;
    const jevConfigured = typeof options.jevApiKey === 'string' || Boolean(process.env.TYPESAFE_API_KEY);

    const explicitTelemetryDir = pick('telemetryDir', 'JEV_OBSERVER_TELEMETRY_DIR');
    state.dir = typeof explicitTelemetryDir === 'string' ? explicitTelemetryDir : join(ctx.location.directory ?? process.cwd(), OBSERVE_SUBDIR);
    state.sessions.clear();
    state.compactionRequests.clear();
    state.loadedAt = Date.now();
    state.firstCompactionAt = null;
    state.identity = {
      runtimeVersion: RUNTIME_VERSION,
      runtimeBuildId: RUNTIME_BUILD_ID,
      pluginVersion: PLUGIN_VERSION,
      policyPreset: String(projectConfig.preset ?? 'custom'),
      gitCommit: gitCommit(ctx.location.directory ?? process.cwd()),
    };
    for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;

    const estimator = new StructuralTokenEstimator();
    const runtime = new AgentEfficiencyRuntime({ runId: 'opencode-observer' });
    const routingScorer = new DeterministicScorer();

    record('loaded', {
      pluginEnabled: true,
      mode,
      resultAdmissionMode,
      toolShortlistingMode,
      toolExposureMode,
      routerMode,
      ...state.identity,
      shortlistThreshold,
      singleActionThreshold,
      maxTools,
      requiredTools,
      evidenceMaxEntries,
      evidenceMaxAgeMs,
      evidencePruneDryRun,
      directory: ctx.location.directory,
      telemetryDir: state.dir,
      projectConfigPath: join(ctx.location.directory ?? '', PROJECT_CONFIG),
      projectConfigPresent: existsSync(join(ctx.location.directory ?? '', PROJECT_CONFIG)),
      clmConfigured: Boolean(clmBaseUrl),
      jevConfigured,
    });

    // ---- gateway tool registration (canonical registry; exact executors) ----
    let gatewayToolDef: { description?: string; input?: unknown } | null = null;
    if (toolExposureMode === 'gateway') {
      await ctx.tool.transform((editor) => {
        editor.add({          name: GATEWAY_TOOL_NAME,
          description: GATEWAY_TOOL_DESCRIPTION,
          input: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Tool family id, tool name, or a short query.' },
            },
            required: [],
            additionalProperties: false,
          },
          execute: async (input: unknown, toolContext: { sessionID?: string }) => {
            try {
              const q =
                typeof input === 'string'
                  ? input
                  : String((input as { query?: unknown; family?: unknown; tool?: unknown; name?: unknown })?.query ??
                      (input as { family?: unknown })?.family ??
                      (input as { tool?: unknown })?.tool ??
                      (input as { name?: unknown })?.name ??
                      '');
              const sessionID = String(toolContext?.sessionID ?? 'unknown');
              const session = sessionState(sessionID);
              const before = session.gateway;
              const result = expandToolRequest(state.canonicalTools, before, { query: q });
              session.gateway = result.nextState;
              session.gatewayExpansions += 1;
              counters.expansions += 1;
              if (!result.cached) {
                session.gatewayExpansionTurns += 1;
                counters.expansionTurns += 1;
              }
              record('tool_expansion', {
                sessionID,
                requested: result.requested,
                ok: result.ok,
                cached: result.cached,
                families: result.matchedFamilies,
                tools: state.canonicalTools.filter((t) => result.nextState.expandedFamilies.includes(resolveToolFamily(t))).map((t) => t.name),
                message: bound(result.message, 500),
              });
              return { content: result.message };
            } catch (error) {
              counters.errors += 1;
              return { content: `discover_tools failed safely: ${String((error as Error).message ?? error).slice(0, 200)}` };
            }
          },
        });
      });
      try {
        const registered = await ctx.tool.list();
        const names = registered.map((t) => t.name);
        gatewayToolDef = registered.find((t) => t.name === GATEWAY_TOOL_NAME) ?? null;
        record('gateway_registered', {
          registered: names,
          includesGateway: names.includes(GATEWAY_TOOL_NAME),
        });
      } catch (error) {
        record('gateway_registered', { error: String((error as Error).message ?? error).slice(0, 200) });
      }
    }

    // ---------------------------------------------------------------- context
    await ctx.session.hook('context', async (event) => {
      const started = Date.now();
      try {
        const sessionID = String(event.sessionID);
        const session = sessionState(sessionID);
        session.turn += 1;
        counters.turns += 1;

        const toolEntries = Object.entries(event.tools ?? {});
        state.canonicalTools = toolEntries.map(([name, info]) => ({
          name,
          description: bound(String((info as { description?: string })?.description ?? ''), 400),
          kind: 'unknown' as const,
          tags: [] as string[],
        }));
        if (toolExposureMode === 'gateway' && gatewayToolDef && !state.canonicalTools.some((t) => t.name === GATEWAY_TOOL_NAME)) {
          state.canonicalTools = [
            ...state.canonicalTools,
            { name: GATEWAY_TOOL_NAME, description: gatewayToolDef.description ?? GATEWAY_TOOL_DESCRIPTION, kind: 'unknown' as const, tags: ['control', 'discover'] },
          ];
        }
        const registry = new ToolRegistry().registerMany(state.canonicalTools);
        const userText = lastUserText(event.messages ?? []);
        const goal = userText || session.lastUserText || '(no user text)';
        const stateInput: AgentState = { goal, recentActions: session.recentActions };

        const beforeTokens = estimateMessages(estimator, [...(event.system ?? []).map((s) => messageText(s)), ...(event.messages ?? []).map((m) => messageText(m))]);
        const schemaTokensFull = estimateToolSchemaTokens(estimator, state.canonicalTools);
        const plan = planShortlist(registry, goal, {
          mode: toolShortlistingMode === 'soft' ? 'soft' : 'observe',
          hierarchy: true,
          maxFamilies: 3,
          maxTools,
          measuredRequiredToolRecall: 1.0,
        });
        const preferredTools = (gatewayPreferred.length > 0 && toolExposureMode === 'gateway'
          ? gatewayPreferred
          : plan.proposed.map((t) => t.name)
        ).filter((n) => n !== GATEWAY_TOOL_NAME);

        // ---- APPLY: soft shortlist (reorder + hint, never remove) ----
        let shortlistApplied = false;
        if (toolShortlistingMode === 'soft' && event.tools && preferredTools.length > 0 && toolExposureMode !== 'gateway') {
          const entries = Object.entries(event.tools as Record<string, unknown>);
          const preferredSet = new Set(preferredTools);
          const reordered: Record<string, unknown> = {};
          for (const name of preferredTools) if (event.tools[name]) reordered[name] = event.tools[name];
          for (const [name, value] of entries) if (!preferredSet.has(name)) reordered[name] = value;
          event.tools = reordered as typeof event.tools;
          shortlistApplied = Object.keys(event.tools)[0] === preferredTools[0];
          const hint = `Preferred tools for this task: ${preferredTools.join(', ')}. All other tools remain available.`;
          const system = Array.isArray(event.system) ? event.system : [];
          if (!system.some((part) => typeof (part as { text?: string })?.text === 'string' && (part as { text: string }).text.startsWith('Preferred tools for this task:'))) {
            event.system = [...system, { type: 'text', text: hint }] as typeof event.system;
          }
        }

        // ---- APPLY: lazy tool exposure (gateway) ----
        let exposure: Record<string, unknown> | null = null;
        if (toolExposureMode === 'gateway' && event.tools) {
          // The plugin tool is registered in the canonical registry but is not in
          // the agent's effective tool map; inject its canonical schema so the
          // model can actually call it while everything else stays narrowed.
          if (!event.tools[GATEWAY_TOOL_NAME] && gatewayToolDef) {
            event.tools = {
              ...(event.tools as Record<string, unknown>),
              [GATEWAY_TOOL_NAME]: {
                description: GATEWAY_TOOL_DESCRIPTION,
                input: {
                  type: 'object',
                  properties: { query: { type: 'string', description: 'Tool family id, tool name, or a short query.' } },
                  required: [],
                  additionalProperties: false,
                },
              },
            } as typeof event.tools;
          }
          session.gateway = { ...session.gateway, preferredTools };
          const planExposure = planToolExposure(state.canonicalTools, session.gateway, { mode: 'gateway', gatewayName: GATEWAY_TOOL_NAME });
          event.tools = applyToolExposure(event.tools as Record<string, unknown>, planExposure) as typeof event.tools;
          const sentTokens = estimateToolSchemaTokens(estimator, state.canonicalTools.filter((t) => planExposure.exposed.includes(t.name)));
          counters.exposureTurns += 1;
          counters.exposureFullTokens += schemaTokensFull;
          counters.exposureSentTokens += sentTokens;
          exposure = {
            registryTools: state.canonicalTools.length,
            initiallyExposedTools: preferredTools.length,
            exposedNow: planExposure.exposed.length,
            hiddenTools: planExposure.hidden,
            expandedFamilies: planExposure.expandedFamilies,
            expansions: session.gatewayExpansions,
            schemaTokensFull,
            schemaTokensSent: sentTokens,
          };
        }

        // ---- APPLY: deterministic result admission on the model projection ----
        let projectionRecords: unknown[] = [];
        let resultTokensAvoided = 0;
        if (resultAdmissionMode === 'deterministic' && Array.isArray(event.messages)) {
          const projection = projectToolResultsFailOpen(event.messages, {
            policy: runtime.policy,
            estimator,
            recover: (id) => runtime.recoverEvidence(id),
          });
          if (projection.fellBack) {
            counters.projectionFallbacks += 1;
            record('projection_fallback', {
              sessionID,
              reason: projection.fallbackReason,
              messageCount: event.messages.length,
            });
          } else if (projection.records.length > 0) {
            event.messages = projection.messages as typeof event.messages;
            projectionRecords = projection.records.map((r) => ({
              toolName: r.toolName,
              rawTokens: r.rawTokens,
              projectedTokens: r.projectedTokens,
              tokensAvoided: r.tokensAvoided,
              classification: r.classification,
              strategy: r.strategy,
              evidenceId: r.evidencePointer?.evidenceId ?? null,
              evidenceRecoveryExact: r.evidenceRecoveryExact,
            }));
            resultTokensAvoided = projection.tokensAvoided;
            const evidenceIds = projection.records
              .map((r) => r.evidencePointer?.evidenceId)
              .filter((id): id is string => typeof id === 'string');
            session.recentEvidenceIds = [...session.recentEvidenceIds, ...evidenceIds].slice(-300);
            counters.resultsProjected += projection.records.length;
            counters.admissionRawTokens += projection.rawTokens;
            counters.admissionProjectedTokens += projection.projectedTokens;
            counters.admissionSavedTokens += projection.tokensAvoided;
            counters.admissionHookLatencyMs += Date.now() - started;
          }
        }

        const afterTokens = estimateMessages(estimator, [...(event.system ?? []).map((s) => messageText(s)), ...(event.messages ?? []).map((m) => messageText(m))]);

        // ---- SHADOW: AUTO router (never controls execution) ----
        const candidateActions: CandidateAction[] = plan.proposed.map((tool) => ({ id: tool.name, toolName: tool.name, description: tool.description, tags: tool.tags }));
        let deterministic: ScoringResult | null = null;
        if (candidateActions.length > 0) {
          deterministic = await routingScorer.score({ state: stateInput, candidates: candidateActions, context: { decisionType: 'tool-routing' } });
        }
        const economics = {
          clmUsdPerCall,
          jevUsdPerCall,
          expectedClmLatencyMs: 129,
          expectedJevLatencyMs: 240,
          marginUsd: 0.00001,
          maxRouterLatencyMs: 500,
          expectedMainModelTokensSaved: Math.max(0, schemaTokensFull - plan.schemaTokensAfter) + resultTokensAvoided,
        } as const;
        const commonRouterInput = {
          candidateCount: state.canonicalTools.length,
          deterministic: deterministic ?? { ranked: [], confidence: null },
          candidateSetId: 'opencode-tools',
          candidateSetStable: true,
          candidateSetWarm: null,
          clmAvailable: Boolean(clmBaseUrl),
          jevAvailable: jevConfigured,
          expectedMainModelTokensSaved: economics.expectedMainModelTokensSaved,
          expectedTurnsSaved: 0,
          expectedWrongToolCallsAvoided: 0,
          costs: economics,
        };
        const singleAction = decideAutoRouterV2({ ...commonRouterInput, calibratedMargin: singleActionThreshold });
        const shortlistDecision = decideAutoRouterV2({ ...commonRouterInput, calibratedMargin: shortlistThreshold });
        counters.routerProposals += 1;

        const top1 = deterministic?.ranked[0]?.id ?? null;
        const preferredSet = new Set(preferredTools);
        const requiredToolPresent = requiredTools.length > 0 ? requiredTools.every((t) => preferredSet.has(t)) : null;
        session.lastUserText = goal;
        session.proposed = {
          shortlist: preferredTools,
          candidateCount: plan.candidateCount,
          schemaTokensBefore: schemaTokensFull,
          schemaTokensAfter: plan.schemaTokensAfter,
          top1,
          requiredToolPresent,
          router: { choice: singleAction.choice, reason: singleAction.reason },
        };

        record('turn', {
          sessionID,
          pluginEnabled: true,
          ...state.identity,
          mode,
          resultAdmissionMode,
          toolShortlistingMode,
          toolExposureMode,
          routerMode,
          modelCallIndex: session.turn,
          providerID: event.model?.providerID ?? null,
          modelID: event.model?.id ?? null,
          agent: event.agent ?? null,
          estimatedContextTokensBefore: beforeTokens,
          estimatedContextTokensAfter: afterTokens,
          estimatedContextTokens:
            estimateMessages(estimator, [...(event.system ?? []).map((s) => messageText(s)), ...(event.messages ?? []).map((m) => messageText(m))]),
          fullToolCount: state.canonicalTools.length,
          preferredToolCount: preferredTools.length,
          fullToolSchemaTokens: schemaTokensFull,
          preferredSchemaTokens: plan.schemaTokensAfter,
          preferredTools,
          fallbackTools: state.canonicalTools.map((t) => t.name).filter((n) => !preferredSet.has(n)),
          requiredTools,
          requiredToolPresent,
          shortlistApplied,
          shortlistMode: plan.mode,
          toolExposure: exposure,
          resultProjectionApplied: projectionRecords.length > 0,
          resultProjectionRecords: projectionRecords,
          resultTokensAvoided,
          deterministicTop1: top1,
          candidateCount: plan.candidateCount,
          proposedAutoRouterSingleAction: { choice: singleAction.choice, reason: singleAction.reason },
          proposedAutoRouterShortlist: { choice: shortlistDecision.choice, reason: shortlistDecision.reason },
          clmCacheWouldBeWarm: null,
          proposedRankedTools: deterministic?.ranked.map((r) => r.id) ?? [],
          hookLatencyMs: Date.now() - started,
        });
      } catch (error) {
        counters.errors += 1;
        record('error', { hook: 'context', message: String((error as Error).message ?? error).slice(0, 300) });
      }
    });

    // ------------------------------------------------------------ compaction
    await ctx.session.hook('compaction', async (event) => {
      const started = Date.now();
      try {
        counters.compactions += 1;
        if (state.firstCompactionAt === null) state.firstCompactionAt = Date.now();
        const session = sessionState(String(event.sessionID));
        const messages = event.messages ?? [];
        const messageTokens = estimateMessages(estimator, messages.map((m) => messageText(m)));
        const systemTokens = estimateMessages(estimator, (event.system ?? []).map((s) => messageText(s)));
        record('compaction', {
          sessionID: String(event.sessionID),
          pluginEnabled: true,
          resultAdmissionMode,
          toolShortlistingMode,
          toolExposureMode,
          providerID: event.model?.providerID ?? null,
          modelID: event.model?.id ?? null,
          callIndex: session.turn,
          messageCount: messages.length,
          estimatedMessagesTokens: messageTokens,
          estimatedSystemTokens: systemTokens,
          estimatedTotalTokens: messageTokens + systemTokens,
          msSinceLoad: Date.now() - state.loadedAt,
          replaceWithResult: Boolean((event as { result?: unknown }).result),
          hookLatencyMs: Date.now() - started,
        });
      } catch (error) {
        counters.errors += 1;
        record('error', { hook: 'compaction', message: String((error as Error).message ?? error).slice(0, 300) });
      }
    });

    // --------------------------------------------- compaction HTTP duration
    await ctx.session.hook('http.request', async (event) => {
      try {
        if (event.kind !== 'compaction') return;
        state.compactionRequests.set(String(event.sessionID), { startedAt: Date.now() });
      } catch {
        // ignore
      }
    });
    await ctx.session.hook('http.response', async (event) => {
      try {
        if (event.kind !== 'compaction') return;
        const pending = state.compactionRequests.get(String(event.sessionID));
        if (!pending) return;
        state.compactionRequests.delete(String(event.sessionID));
        record('compaction_http', {
          sessionID: String(event.sessionID),
          durationMs: Date.now() - pending.startedAt,
          status: event.response.status,
        });
      } catch {
        // ignore
      }
    });

    // ------------------------------------------------------- tool execution
    await ctx.tool.hook('execute.before', async (event) => {
      try {
        counters.toolCalls += 1;
        const session = state.sessions.get(String(event.sessionID));
        const chosen = String(event.tool);
        if (session) session.recentActions = [...session.recentActions.slice(-5), chosen];
        const proposedTop1 = session?.proposed?.top1 ?? null;
        record('tool_call', {
          sessionID: String(event.sessionID),
          pluginEnabled: true,
          tool: chosen,
          family: resolveToolFamily({ name: chosen, description: '', kind: 'unknown', tags: [] }),
          inputSummary: bound(messageText(event.input), 400),
          proposedShortlist: session?.proposed?.shortlist ?? null,
          shortlistContainedActual: session?.proposed ? session.proposed.shortlist.includes(chosen) : null,
          deterministicTop1: proposedTop1,
          proposalAgreed: proposedTop1 !== null && proposedTop1 === chosen,
          proposedRouterChoice: session?.proposed?.router.choice ?? null,
        });
      } catch (error) {
        counters.errors += 1;
        record('error', { hook: 'tool.execute.before', message: String((error as Error).message ?? error).slice(0, 300) });
      }
    });

    await ctx.tool.hook('execute.after', async (event) => {
      const started = Date.now();
      try {
        counters.toolResults += 1;
        const text = contentToText(event.status === 'completed' ? (event.result as unknown) : (event.error as unknown));
        const rawTokens = estimator.estimate(text);
        let decision: ReturnType<typeof runtime.processToolResult> | null = null;
        try {
          decision = runtime.processToolResult({ toolName: String(event.tool), text });
        } catch (error) {
          // Fail-open: classification/reduction errors never reach the model.
          record('classifier_fallback', {
            sessionID: String(event.sessionID),
            tool: String(event.tool),
            reason: String((error as Error).message ?? error).slice(0, 240),
          });
        }
        const evidenceOk = decision?.evidence ? runtime.recoverEvidence(decision.evidence.evidenceId) === text : null;
        if (decision?.action === 'reduce') counters.resultsReducible += 1;
        record('tool_result', {
          sessionID: String(event.sessionID),
          pluginEnabled: true,
          mode,
          resultAdmissionMode,
          toolExposureMode,
          tool: String(event.tool),
          status: event.status,
          rawTokens,
          projectedTokens: decision?.admittedTokenEstimate ?? null,
          tokensAvoided: decision?.tokensAvoided ?? null,
          wouldReduce: decision ? decision.action === 'reduce' : null,
          applied: resultAdmissionMode === 'deterministic' && decision?.action === 'reduce',
          classification: decision?.resultClass ?? null,
          strategy: decision?.strategy ?? null,
          evidenceId: decision?.evidence?.evidenceId ?? null,
          evidenceRecoveryExact: evidenceOk,
          classifierOk: decision !== null,
          hookLatencyMs: Date.now() - started,
        });

        // ---- evidence lifecycle: bounded, dedupe-preserving, reference-aware --
        resultsSincePrune += 1;
        if (resultsSincePrune >= 50 && (evidenceMaxEntries > 0 || evidenceMaxAgeMs !== null)) {
          resultsSincePrune = 0;
          const protectedIds = new Set<string>();
          for (const session of state.sessions.values()) for (const id of session.recentEvidenceIds) protectedIds.add(id);
          const prune = runtime.evidence.prune({
            ...(evidenceMaxEntries > 0 ? { maxEntries: evidenceMaxEntries } : {}),
            ...(evidenceMaxAgeMs !== null ? { maxAgeMs: evidenceMaxAgeMs } : {}),
            protectedIds,
            dryRun: evidencePruneDryRun,
          });
          if (prune.removed.length > 0 || prune.dryRun) {
            counters.evidencePruned += prune.removed.length;
            record('evidence_pruned', {
              sessionID: String(event.sessionID),
              dryRun: prune.dryRun,
              removedCount: prune.removed.length,
              removedSample: prune.removed.slice(0, 10),
              removedBytes: prune.removedBytes,
              kept: prune.kept,
              protectedSkipped: prune.protectedSkipped,
              protectedCount: protectedIds.size,
            });
          }
        }
      } catch (error) {
        counters.errors += 1;
        record('error', { hook: 'tool.execute.after', message: String((error as Error).message ?? error).slice(0, 300) });
      }
    });

    return () => {
      record('unloaded', { counters, pluginEnabled: true });
      state.sessions.clear();
    };
  },
});
