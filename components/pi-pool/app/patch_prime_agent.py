#!/usr/bin/env python3
"""pi-pool patch: put the account pool inside the Prime Agent TUI.

Prime Agent executes dist/bundle/*.js. The maintained replacements add the
pool display, command-first credentials, native request-auth recovery, fresh
compaction credentials, and account-specific Codex WebSocket cache entries.
Reapply them after `prime-agent update`. Running processes retain their loaded
code; this command does not restart a daemon.

    pi-pool patch            apply (idempotent; a no-op when already applied)
    pi-pool patch --check    report state, exit 0 patched / 1 not / 2 anchors missing
    pi-pool unpatch          restore every backed-up chunk, remove the helper module

What it changes in dist/bundle/chunk-*.js (the TUI chunk), all marked `/* pi-pool */`:
  1. imports dist/bundle/pi-pool-status.js (copied from this source directory)
  2. tray line: account and usage after the model label, for this session
  3. chat splash header: `account` row, for this session
  4. agents view header: `account` and `pool` rows, for the selected row's root session
  5. agents view notices: pool problems, for the selected row's root session
  6. model registry: a models.json "!command" apiKey wins over a stored /login,
     so a login can no longer bypass the pool. The login stays the fallback
     when the hook yields nothing.
  7. startup passes the model provider to the agents view

What it changes in dist/bundle/openai-codex-responses-*.js:
  8. the WebSocket cache key widens to `sessionId:accountId`, so a credential
     switch gets a fresh socket and fresh cached context instead of reusing
     the previous account's
  9. closeOpenAICodexWebSocketSessions matches every widened key by prefix

It also symlinks <agent dir>/extensions/pi-pool to this source extension.
The event log stays under PI_POOL_DIR or ~/.config/pi-pool.
--bundle-only skips every extension lookup and change for the generated service runtime.

Every target is normalized through known replacements and compared with its
original backup. All anchors and staged JavaScript must pass before any
bundle is replaced. Apply installs exports before imports; unpatch reverses
that order. Interrupted operations can run again. Unknown changes or
mismatched backups stop without replacing a bundle.
"""
import json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.realpath(__file__))
CODE_ROOT = os.path.dirname(HERE)
POOL_DIR = os.environ.get("PI_POOL_DIR") or os.path.join(os.path.expanduser("~"), ".config", "pi-pool")
if os.path.commonpath([CODE_ROOT, os.path.realpath(POOL_DIR)]) == CODE_ROOT:
    raise SystemExit("PI_POOL_DIR must be outside the pi-pool source directory")
HELPER_SRC = os.path.join(HERE, "pi-pool-status.js")
HELPER_NAME = "pi-pool-status.js"
EXTENSION_SRC = os.path.join(HERE, "extension")
MARK = "/* pi-pool */"
LOG = os.path.join(POOL_DIR, "pi-pool.log")


def log(event, **kw):
    try:
        os.makedirs(POOL_DIR, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": event, **kw}) + "\n")
    except Exception:
        pass


def package_root():
    override = os.environ.get("PI_POOL_PRIME_AGENT_ROOT")
    if override:
        return override
    exe = shutil.which("prime-agent")
    if not exe:
        r = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True)
        cand = os.path.join(r.stdout.strip(), "prime-agent")
        if r.returncode == 0 and os.path.isdir(cand):
            return cand
        raise SystemExit("prime-agent not found on PATH and `npm root -g` has no prime-agent")
    real = os.path.realpath(exe)  # .../prime-agent/dist/bundle/cli.js
    root = os.path.dirname(os.path.dirname(os.path.dirname(real)))
    if not os.path.exists(os.path.join(root, "package.json")):
        raise SystemExit(f"cannot locate the prime-agent package from {real}")
    return root


def package_version(root):
    try:
        with open(os.path.join(root, "package.json")) as f:
            return json.load(f).get("version", "?")
    except Exception:
        return "?"


def agent_dir():
    env = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or os.environ.get("PI_CODING_AGENT_DIR")
    if env:
        return os.path.join(os.path.expanduser("~"), env[2:]) if env.startswith("~/") else env
    return os.path.join(os.path.expanduser("~"), ".prime", "agent")


def find_chunk(bundle_dir, needle):
    hits = []
    for name in sorted(os.listdir(bundle_dir)):
        if not name.endswith(".js") or name == HELPER_NAME:
            continue
        path = os.path.join(bundle_dir, name)
        with open(path, encoding="utf8") as f:
            if needle in f.read():
                hits.append(path)
    return hits


# --------------------------------------------------------------------- patches
# Each patch: (id, anchor, replacement). Anchors are exact substrings of the
# unpatched bundle; the replacement carries MARK so a patched file is
# recognised without a manifest.
TUI_PATCHES = [
    (
        "tray",
        '    return [agentsHint, depthLabel, modelLabel, shortcutsHint].filter((label) => label !== void 0).join("  ");\n',
        '    const accountLabel = __piPool.trayAccountLabel(this.getCurrentModel()?.provider, this.connectionState?.activeSessionId, this.connectionState?.sessionId); ' + MARK + '\n'
        '    return [agentsHint, depthLabel, modelLabel, accountLabel, shortcutsHint].filter((label) => label !== void 0).join("  ");\n',
    ),
    (
        "chat-splash",
        '      this.builtInHeader = new BrandSplashHeader(this.version, () => this.getCurrentModelId(), () => this.getCurrentCwd(), verboseInstructions, {\n'
        '        topPadding: true,\n'
        '        getHideStartHint: () => !this.isNewChat(),\n',
        '      this.builtInHeader = new BrandSplashHeader(this.version, () => this.getCurrentModelId(), () => this.getCurrentCwd(), verboseInstructions, {\n'
        '        topPadding: true,\n'
        '        getExtraMetadata: () => __piPool.splashMetadata(this.getCurrentModel()?.provider, this.connectionState?.activeSessionId, this.connectionState?.sessionId), ' + MARK + '\n'
        '        getHideStartHint: () => !this.isNewChat(),\n',
    ),
    (
        "agents-header",
        '        const root = this.scopeRootSummary;\n'
        '        return [\n'
        '          { label: "agents", value: this.getAgentCountsText() },\n'
        '          { label: "scope", value: root ? getAgentsViewSessionTitle(root) : "global" },\n'
        '          { label: "depth", value: String(getAgentsViewDepth(root)) }\n'
        '        ];\n',
        '        const root = this.scopeRootSummary;\n'
        '        const headerSelectedRow = this.rows[this.selectedIndex]; ' + MARK + '\n'
        '        const headerRootRow = headerSelectedRow === void 0 ? void 0 : headerSelectedRow.parentIdentity === void 0 ? headerSelectedRow : this.findSubagentRootRow(headerSelectedRow); '
        '/* pi-pool. Session records are keyed by the root uuid, so a child row must resolve its root first. */\n'
        '        return [\n'
        '          { label: "agents", value: this.getAgentCountsText() },\n'
        '          { label: "scope", value: root ? getAgentsViewSessionTitle(root) : "global" },\n'
        '          { label: "depth", value: String(getAgentsViewDepth(root)) },\n'
        '          ...__piPool.splashMetadata(headerSelectedRow?.summary.model?.provider ?? this.options.startupModelProvider, headerRootRow?.summary.activeSessionId ?? headerRootRow?.summary.id, headerRootRow?.summary.sessionId) ' + MARK + '\n'
        '        ];\n',
    ),
    (
        "agents-notices",
        '    const notices = this.persistentState.startupNotices;\n'
        '    if (!notices) {\n'
        '      return [];\n'
        '    }\n'
        '    const formatted = [];\n'
        '    if (notices.newVersion) {\n',
        '    const notices = this.persistentState.startupNotices ?? { packageUpdates: [] }; ' + MARK + '\n'
        '    const noticesSelectedRow = this.rows[this.selectedIndex]; ' + MARK + '\n'
        '    const noticesRootRow = noticesSelectedRow === void 0 ? void 0 : noticesSelectedRow.parentIdentity === void 0 ? noticesSelectedRow : this.findSubagentRootRow(noticesSelectedRow); '
        '/* pi-pool. Same root guard as the agents header, so a child row looks up its session-tree pin, not its own. */\n'
        '    const formatted = __piPool.noticeLines(this.selectedActiveSessionId, noticesRootRow?.summary.sessionId).map((line) => theme.fg("warning", line));\n'
        '    if (notices.newVersion) {\n',
    ),
    (
        "agents-startup-provider",
        '        startupModelId: startupModel.model?.id,\n'
        '        initialSession,\n',
        '        startupModelId: startupModel.model?.id,\n'
        '        startupModelProvider: startupModel.model?.provider, ' + MARK + '\n'
        '        initialSession,\n',
    ),
    (
        "auth-precedence",
        '      let apiKey = authStorageAuth.apiKey;\n'
        '      let authSourceToken = authStorageAuth.sourceToken;\n'
        '      if (apiKey === void 0 && providerConfig?.apiKey) {\n'
        '        const resolvedApiKey = resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`);\n',
        '      let apiKey = authStorageAuth.apiKey;\n'
        '      let authSourceToken = authStorageAuth.sourceToken;\n'
        '      ' + MARK + ' // A "!command" apiKey in models.json is the operator\'s account pool. It wins over a stored\n'
        '      // /login so a login cannot bypass the pool; the login stays the fallback when the hook yields nothing.\n'
        '      const poolCommand = typeof providerConfig?.apiKey === "string" && providerConfig.apiKey.startsWith("!");\n'
        '      if (poolCommand) {\n'
        '        try {\n'
        '          const pooledApiKey = resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`);\n'
        '          const pooledSource = this.getProviderRequestAuthSource(model.provider, { resolvedApiKey: pooledApiKey });\n'
        '          if (pooledSource && !this.isProviderRequestAuthStale(model.provider, pooledSource)) {\n'
        '            this.clearStaleProviderRequestAuthSource(model.provider, pooledSource);\n'
        '            apiKey = pooledApiKey;\n'
        '            authSourceToken = this.getProviderRequestAuthSourceToken(model.provider, pooledSource);\n'
        '          }\n'
        '        } catch (error) {\n'
        '          if (apiKey === void 0) throw error;\n'
        '        }\n'
        '      }\n'
        '      if (apiKey === void 0 && providerConfig?.apiKey && !poolCommand) {\n'
        '        const resolvedApiKey = resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`);\n',
    ),
]

CODEX_PATCHES = [
    (
        "codex-websocket-cache-key",
        'async function processWebSocketStream(url, body, headers, output, stream, model, onStart, options) {\n'
        '  const { socket, entry, reused, release } = await acquireWebSocket(url, headers, options?.sessionId, options?.signal);\n',
        'async function processWebSocketStream(url, body, headers, output, stream, model, onStart, options) {\n'
        '  const websocketCacheKey = options?.sessionId ? `${options.sessionId}:${headers.get("chatgpt-account-id") ?? ""}` : options?.sessionId; '
        '/* pi-pool. A credential switch must not reuse the old account\'s socket or its cached server-side context. */\n'
        '  const { socket, entry, reused, release } = await acquireWebSocket(url, headers, websocketCacheKey, options?.signal);\n',
    ),
    (
        "codex-close-sessions",
        'function closeOpenAICodexWebSocketSessions(sessionId) {\n'
        '  const closeEntry = (entry) => {\n'
        '    if (entry.idleTimer) clearTimeout(entry.idleTimer);\n'
        '    closeWebSocketSilently(entry.socket, 1e3, "debug_close");\n'
        '  };\n'
        '  if (sessionId) {\n'
        '    const entry = websocketSessionCache.get(sessionId);\n'
        '    if (entry) closeEntry(entry);\n'
        '    websocketSessionCache.delete(sessionId);\n'
        '    return;\n'
        '  }\n',
        'function closeOpenAICodexWebSocketSessions(sessionId) {\n'
        '  const closeEntry = (entry) => {\n'
        '    if (entry.idleTimer) clearTimeout(entry.idleTimer);\n'
        '    closeWebSocketSilently(entry.socket, 1e3, "debug_close");\n'
        '  };\n'
        '  if (sessionId) {\n'
        '    ' + MARK + ' // the cache key widened to sessionId:accountId, so a close by sessionId must match every key with this prefix too\n'
        '    const prefix = `${sessionId}:`;\n'
        '    for (const key of [...websocketSessionCache.keys()]) {\n'
        '      if (key === sessionId || key.startsWith(prefix)) {\n'
        '        closeEntry(websocketSessionCache.get(key));\n'
        '        websocketSessionCache.delete(key);\n'
        '      }\n'
        '    }\n'
        '    return;\n'
        '  }\n',
    ),
]

LEGACY_TUI_PATCHES = TUI_PATCHES.copy()
TUI_PATCHES = [entry for entry in TUI_PATCHES if entry[0] != "auth-precedence"] + [
    (
        "agents-session-width",
        '  const modelWidth = Math.min(desiredModelWidth, 32, Math.max(0, available - 12));\n'
        '  const nameWidth = Math.min(28, Math.max(0, available - modelWidth));\n',
        '  const nameWidth = Math.min(Math.floor(width * 0.65), available); ' + MARK + '\n'
        '  const modelWidth = Math.min(desiredModelWidth, 32, Math.max(0, available - nameWidth));\n',
    ),
    ('auth-precedence', r'''  async getApiKeyAndHeaders(model) {
    try {
      const providerConfig = this.providerRequestConfigs.get(model.provider);
      const authStorageAuth = await this.authStorage.getApiKeyWithSourceToken(model.provider, {
        includeFallback: false
      });
      let apiKey = authStorageAuth.apiKey;
      let authSourceToken = authStorageAuth.sourceToken;
      if (apiKey === void 0 && providerConfig?.apiKey) {
        const resolvedApiKey = resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`);
        const providerRequestAuthSource = this.getProviderRequestAuthSource(model.provider, { resolvedApiKey });
        if (providerRequestAuthSource && !this.isProviderRequestAuthStale(model.provider, providerRequestAuthSource)) {
          this.clearStaleProviderRequestAuthSource(model.provider, providerRequestAuthSource);
          apiKey = resolvedApiKey;
          authSourceToken = this.getProviderRequestAuthSourceToken(model.provider, providerRequestAuthSource);
        }
      }
      this.setLastProviderAuthSourceToken(model.provider, apiKey === void 0 ? void 0 : authSourceToken);
      const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
      const authStorageHeaders = this.authStorage.getProviderHeaders(model.provider);
      const modelHeaders = resolveHeadersOrThrow(this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)), `model "${model.provider}/${model.id}"`);
      let headers = model.headers || authStorageHeaders || providerHeaders || modelHeaders ? { ...model.headers, ...authStorageHeaders, ...providerHeaders, ...modelHeaders } : void 0;
      if (providerConfig?.authHeader) {
        if (!apiKey) {
          return { ok: false, error: `No API key found for "${model.provider}"` };
        }
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }
      return {
        ok: true,
        apiKey,
        headers: headers && Object.keys(headers).length > 0 ? headers : void 0
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
''', r'''  async getApiKeyAndHeaders(model, options) {
    /* pi-pool */
    try {
      if (options?.signal?.aborted) return { ok: false, reason: "cancelled", error: "Request was aborted" };
      const providerConfig = this.providerRequestConfigs.get(model.provider);
      const poolCommand = typeof providerConfig?.apiKey === "string" && providerConfig.apiKey.startsWith("!");
      let apiKey;
      let authSourceToken;
      let commandStale = false;
      if (poolCommand) {
        const pooledApiKey = await resolveRequestCredentialCommand(providerConfig.apiKey);
        if (options?.signal?.aborted) return { ok: false, reason: "cancelled", error: "Request was aborted" };
        if (pooledApiKey !== void 0) {
          const pooledSource = this.getProviderRequestAuthSource(model.provider, { resolvedApiKey: pooledApiKey });
          commandStale = pooledSource && this.isProviderRequestAuthStale(model.provider, pooledSource);
          if (pooledSource && !commandStale) {
            this.clearStaleProviderRequestAuthSource(model.provider, pooledSource);
            apiKey = pooledApiKey;
            authSourceToken = this.getProviderRequestAuthSourceToken(model.provider, pooledSource);
          }
        }
      }
      if (apiKey === void 0) {
        const nativeAuth = await this.authStorage.getApiKeyWithSourceToken(model.provider, { includeFallback: false });
        if (options?.signal?.aborted) return { ok: false, reason: "cancelled", error: "Request was aborted" };
        apiKey = nativeAuth.apiKey;
        authSourceToken = nativeAuth.sourceToken;
      }
      if (apiKey === void 0 && poolCommand) {
        this.setLastProviderAuthSourceToken(model.provider, void 0);
        const nativeCandidates = this.authStorage.getAvailableAuthCandidate(model.provider, { includeFallback: false });
        const loginRequired = commandStale || !nativeCandidates.candidate && nativeCandidates.hasStaleCandidate;
        return {
          ok: false,
          reason: loginRequired ? "login_required" : "command_unavailable",
          error: loginRequired
            ? `Authentication for "${model.provider}" needs a new login. Use /login.`
            : `Credentials for "${model.provider}" are unavailable. Check the credential command or use /login if recovery fails.`
        };
      }
      if (apiKey === void 0 && providerConfig?.apiKey && !poolCommand) {
        const resolvedApiKey = resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`);
        const providerRequestAuthSource = this.getProviderRequestAuthSource(model.provider, { resolvedApiKey });
        if (providerRequestAuthSource && !this.isProviderRequestAuthStale(model.provider, providerRequestAuthSource)) {
          this.clearStaleProviderRequestAuthSource(model.provider, providerRequestAuthSource);
          apiKey = resolvedApiKey;
          authSourceToken = this.getProviderRequestAuthSourceToken(model.provider, providerRequestAuthSource);
        }
      }
      this.setLastProviderAuthSourceToken(model.provider, apiKey === void 0 ? void 0 : authSourceToken);
      const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
      const authStorageHeaders = this.authStorage.getProviderHeaders(model.provider);
      const modelHeaders = resolveHeadersOrThrow(this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)), `model "${model.provider}/${model.id}"`);
      let headers = model.headers || authStorageHeaders || providerHeaders || modelHeaders ? { ...model.headers, ...authStorageHeaders, ...providerHeaders, ...modelHeaders } : void 0;
      if (providerConfig?.authHeader) {
        if (!apiKey) {
          return { ok: false, error: `No API key found for "${model.provider}"` };
        }
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }
      return {
        ok: true,
        apiKey,
        headers: headers && Object.keys(headers).length > 0 ? headers : void 0
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
'''),
    ('request-auth-stream', r'''      const auth = await modelRegistry.getApiKeyAndHeaders(model2);
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      const providerRetrySettings = settingsManager.getProviderRetrySettings();''', r'''      const auth = await modelRegistry.getApiKeyAndHeaders(model2, { signal: options2?.signal });
      if (options2?.signal?.aborted) return requestAuthFailureStream(model2, { reason: "cancelled", error: "Request was aborted" }, options2.signal); /* pi-pool */
      if (!auth.ok) {
        if (auth.reason === "command_unavailable" || auth.reason === "login_required") {
          return requestAuthFailureStream(model2, auth, options2?.signal);
        }
        throw new Error(auth.error);
      }
      const providerRetrySettings = settingsManager.getProviderRetrySettings();'''),
    ('request-auth-import', r'''  providerRetryPolicy,
''', r'''  providerRetryPolicy,
  requestAuthFailureStream, /* pi-pool */
  resolveRequestCredentialCommand, /* pi-pool */
'''),
]

RECOVERY_PATCHES = [
    ('request-auth-failure', r'''function providerRetryPolicy(settingsManager) {''', r'''/* pi-pool */
function requestAuthFailureMessage(model, failure2, signal) {
  const aborted = signal?.aborted;
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: emptyUsage(), stopReason: aborted ? "aborted" : "error",
    errorMessage: aborted ? "Request was aborted" : failure2.error,
    timestamp: Date.now(),
    diagnostics: [{ type: "request_auth_failure", timestamp: Date.now(), details: { kind: failure2.reason } }]
  };
}
function requestAuthFailureStream(model, failure2, signal) {
  const stream2 = createAssistantMessageEventStream();
  const message = requestAuthFailureMessage(model, failure2, signal);
  stream2.push({ type: "error", reason: message.stopReason, error: message });
  stream2.end(message);
  return stream2;
}
function isTerminalRequestAuthFailure(message) {
  return message.diagnostics?.some((entry) => entry.type === "request_auth_failure" && entry.details?.kind === "login_required") ?? false;
}
function providerRetryPolicy(settingsManager) {'''),
    ('request-auth-export', r'''  providerRetryPolicy,
''', r'''  providerRetryPolicy,
  requestAuthFailureStream, /* pi-pool */
  resolveRequestCredentialCommand, /* pi-pool */
'''),
    ('request-auth-terminal', r'''    if (this._isAgentLifecycleFailure(message)) {
      return false;
    }
''', r'''    if (this._isAgentLifecycleFailure(message) || isTerminalRequestAuthFailure(message)) { /* pi-pool */
      return false;
    }
'''),
]

RECOVERY_PATCHES += [
    ('compaction-attempt-auth', r'''async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, retry) {
  const maxTokens = Math.floor(0.8 * reserveTokens);
  const basePrompt = buildSummarizationPrompt(customInstructions, previousSummary);
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);
  let promptText = `<conversation>
${conversationText}
</conversation>

`;
  if (previousSummary) {
    promptText += `<previous-summary>
${previousSummary}
</previous-summary>

`;
  }
  promptText += basePrompt;
  const summarizationMessages = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now()
    }
  ];
  const completionOptions = model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel } : { maxTokens, signal, apiKey, headers };
  const response = await completeWithProviderRetry(() => completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, completionOptions), { policy: retry, signal });
  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  const textContent = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { summary: textContent, usage: response.usage };
}''', r'''/* pi-pool */
class RequestAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "RequestAuthError";
  }
}
async function completeCompactionAttempt(model, context, options, requestAuth) {
  const cancelled = () => requestAuthFailureMessage(model, { reason: "cancelled", error: "Request was aborted" }, options.signal);
  if (options.signal?.aborted) return cancelled();
  const auth = typeof requestAuth === "function" ? await requestAuth() : { ok: true, apiKey: requestAuth };
  if (options.signal?.aborted) return cancelled();
  if (!auth.ok) {
    if (auth.reason === "command_unavailable" || auth.reason === "login_required") return requestAuthFailureMessage(model, auth, options.signal);
    throw new Error(auth.error);
  }
  if (!auth.apiKey) return requestAuthFailureMessage(model, { reason: "login_required", error: `No credentials for "${model.provider}". Use /login.` }, options.signal);
  return completeSimple(model, context, {
    ...options,
    apiKey: auth.apiKey,
    headers: auth.headers || options.headers ? { ...auth.headers, ...options.headers } : void 0
  });
}
function checkCompactionResponse(response, label) {
  if (response.stopReason === "aborted") throw new Error("Compaction cancelled");
  if (response.stopReason !== "error") return;
  const message = `${label}: ${response.errorMessage || "Unknown error"}`;
  if (response.diagnostics?.some((entry) => entry.type === "request_auth_failure") || providerStreamFailureKind(response) === "auth") {
    throw new RequestAuthError(message);
  }
  throw new Error(message);
}
async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, retry) {
  const maxTokens = Math.floor(0.8 * reserveTokens);
  const basePrompt = buildSummarizationPrompt(customInstructions, previousSummary);
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);
  let promptText = `<conversation>
${conversationText}
</conversation>

`;
  if (previousSummary) {
    promptText += `<previous-summary>
${previousSummary}
</previous-summary>

`;
  }
  promptText += basePrompt;
  const summarizationMessages = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now()
    }
  ];
  const completionOptions = model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel } : { maxTokens, signal, apiKey, headers };
  const response = await completeWithProviderRetry(() => completeCompactionAttempt(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, completionOptions, apiKey), { policy: retry, signal });
  checkCompactionResponse(response, "Summarization failed");
  const textContent = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { summary: textContent, usage: response.usage };
}'''),
    ('compaction-prefix-auth', r'''async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, signal, thinkingLevel, retry) {
  const maxTokens = Math.floor(0.5 * reserveTokens);
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  const promptText = `<conversation>
${conversationText}
</conversation>

${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const summarizationMessages = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now()
    }
  ];
  const response = await completeWithProviderRetry(() => completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel } : { maxTokens, signal, apiKey, headers }), { policy: retry, signal });
  if (response.stopReason === "error") {
    throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return {
    summary: response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
    usage: response.usage
  };
}''', r'''/* pi-pool */
async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, signal, thinkingLevel, retry) {
  const maxTokens = Math.floor(0.5 * reserveTokens);
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  const promptText = `<conversation>
${conversationText}
</conversation>

${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const summarizationMessages = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now()
    }
  ];
  const response = await completeWithProviderRetry(() => completeCompactionAttempt(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel } : { maxTokens, signal, apiKey, headers }, apiKey), { policy: retry, signal });
  checkCompactionResponse(response, "Turn prefix summarization failed");
  return {
    summary: response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
    usage: response.usage
  };
}'''),
    ('compaction-manual-auth', r'''      const { apiKey, headers } = await this._getRequiredRequestAuth(this.model);
      const result = await this._performCompaction({
        model: this.model,
        apiKey,
        headers,
        customInstructions,
        signal: this._compactionAbortController.signal
      });
''', r'''      /* pi-pool */
      const result = await this._performCompaction({
        model: this.model,
        customInstructions,
        signal: this._compactionAbortController.signal
      });
'''),
    ('compaction-auto-auth', r'''      const authResult = this.model ? await this._modelRegistry.getApiKeyAndHeaders(this.model) : void 0;
      if (!this.model || !authResult || !authResult.ok || !authResult.apiKey) {
        const detail = !this.model || !authResult ? "no model is selected" : authResult.ok ? "no API key is available" : authResult.error;
        this._endCompactionUnsuccessfully(reason, "failed", `Compaction failed: ${detail}`);
        this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(reason === "threshold" && shouldContinueAfterCompaction, queuedAutonomousContinuationsForThisCompaction);
        resumeAfterFailure();
        return false;
      }
      const result = await this._performCompaction({
        model: this.model,
        apiKey: authResult.apiKey,
        headers: authResult.headers,
        customInstructions,
        signal: this._autoCompactionAbortController.signal
      });
''', r'''      /* pi-pool */
      if (!this.model) {
        this._endCompactionUnsuccessfully(reason, "failed", "Compaction failed: no model is selected");
        this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(reason === "threshold" && shouldContinueAfterCompaction, queuedAutonomousContinuationsForThisCompaction);
        resumeAfterFailure();
        return false;
      }
      const result = await this._performCompaction({
        model: this.model,
        customInstructions,
        signal: this._autoCompactionAbortController.signal
      });
'''),
    ('compaction-auth-reader', r'''    const { model, apiKey, headers, customInstructions, signal } = options;
    const pathEntries = this.sessionManager.getBranch();''', r'''    const { model, customInstructions, signal } = options; /* pi-pool */
    const apiKey = () => this._modelRegistry.getApiKeyAndHeaders(model, { signal });
    const headers = void 0;
    const pathEntries = this.sessionManager.getBranch();'''),
    ('compaction-terminal-auth', r'''      this._endCompactionUnsuccessfully(reason, "failed", reason === "overflow" ? `Context overflow recovery failed: ${errorMessage4}` : reason === "requested" ? `Requested compaction failed: ${errorMessage4}` : `Auto-compaction failed: ${errorMessage4}`, { customInstructions });
      resumeAfterFailure();''', r'''      this._endCompactionUnsuccessfully(reason, "failed", reason === "overflow" ? `Context overflow recovery failed: ${errorMessage4}` : reason === "requested" ? `Requested compaction failed: ${errorMessage4}` : `Auto-compaction failed: ${errorMessage4}`, { customInstructions });
      if (error instanceof RequestAuthError) return false; /* pi-pool */
      resumeAfterFailure();'''),
    ('completion-terminal-auth', r'''    if (retriesPerformed >= maxRetries || isAgentLifecycleFailure(message) || isFauxProviderQueueExhausted(message)) {''', r'''    if (retriesPerformed >= maxRetries || isAgentLifecycleFailure(message) || isFauxProviderQueueExhausted(message) || isTerminalRequestAuthFailure(message)) { /* pi-pool */'''),
]

RECOVERY_PATCHES += [
    ('request-auth-async', r'''function executeCommandUncached(commandConfig) {''', r'''/* pi-pool */
async function resolveRequestCredentialCommand(config) {
  return new Promise((resolve18) => {
    let child;
    try {
      const command = config.slice(1);
      const configured = process.platform === "win32" ? getShellConfig() : { shell: "/bin/sh", args: ["-c"] };
      child = spawnHidden(configured.shell, [...configured.args, command], {
        timeout: 10000, stdio: ["ignore", "pipe", "ignore"], shell: false
      });
    } catch {
      resolve18(void 0);
      return;
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        if (!overflow) child.kill();
        overflow = true;
      } else {
        chunks.push(chunk);
      }
    });
    child.once("error", () => resolve18(void 0));
    child.once("close", (code) => {
      resolve18(code === 0 && !overflow ? Buffer.concat(chunks).toString("utf8").trim() || void 0 : void 0);
    });
  });
}
function executeCommandUncached(commandConfig) {'''),
]

IMPORT_LINE = 'import * as __piPool from "./' + HELPER_NAME + '"; ' + MARK + '\n'

TARGETS = [
    {"id": "recovery", "needle": "function providerRetryPolicy(settingsManager) {", "patches": RECOVERY_PATCHES, "helper": False},
    {"id": "tui", "needle": "getTrayLocationLabel() {", "patches": TUI_PATCHES, "legacy_patches": LEGACY_TUI_PATCHES, "helper": True},
    {"id": "codex-websocket", "needle": "function closeOpenAICodexWebSocketSessions(sessionId) {",
     "patches": CODEX_PATCHES, "helper": False},
]


def locate():
    root = package_root()
    bundle = os.path.join(root, "dist", "bundle")
    if os.path.commonpath([CODE_ROOT, os.path.realpath(bundle)]) == CODE_ROOT:
        raise SystemExit("Prime Agent bundle must be outside the pi-pool source directory")
    if not os.path.isdir(bundle):
        raise SystemExit(f"no dist/bundle under {root}")
    return root, bundle


def locate_target(bundle, target):
    hits = find_chunk(bundle, target["needle"])
    if len(hits) != 1:
        raise SystemExit(f"expected one file with {target['needle']!r} for target {target['id']}, found {len(hits)}: {hits}")
    return hits[0]


def target_state(bundle, target, path):
    with open(path, encoding="utf8") as f:
        src = f.read()
    patches = target["patches"]
    applied = [pid for pid, _anchor, repl in patches if repl in src]
    missing_anchor = [pid for pid, anchor, repl in patches if repl not in src and anchor not in src]
    pending = [pid for pid, anchor, repl in patches if repl not in src and anchor in src]
    st = {"id": target["id"], "path": path, "applied": applied, "pending": pending, "missing_anchor": missing_anchor}
    if target["helper"]:
        helper = os.path.exists(os.path.join(os.path.dirname(path), HELPER_NAME))
        imported = IMPORT_LINE in src
        st["helper"] = helper
        st["imported"] = imported
        if helper:
            st["helper_matches"] = _same_file(HELPER_SRC, os.path.join(os.path.dirname(path), HELPER_NAME))
    return st


def all_target_state(bundle):
    out = []
    for target in TARGETS:
        path = locate_target(bundle, target)
        out.append(target_state(bundle, target, path))
    return out


def _target_complete(st):
    complete = not st["pending"] and not st["missing_anchor"]
    if "helper" in st:
        complete = complete and st["helper"] and st["imported"] and st.get("helper_matches", False)
    return complete


def extension_paths():
    return EXTENSION_SRC, os.path.join(agent_dir(), "extensions", "pi-pool")


def extension_state():
    src, link = extension_paths()
    if not os.path.islink(link):
        return "blocked" if os.path.exists(link) else "absent"
    try:
        return "correct" if os.path.realpath(link) == os.path.realpath(src) else "wrong"
    except OSError:
        return "wrong"


def ensure_extension_link():
    src, link = extension_paths()
    st = extension_state()
    if st == "correct":
        return "unchanged"
    if st == "blocked":
        raise SystemExit(f"{link} exists and is not a symlink pi-pool owns; refusing to touch it")
    os.makedirs(os.path.dirname(link), exist_ok=True)
    if st == "wrong":
        os.remove(link)
    os.symlink(src, link, target_is_directory=True)
    return "installed" if st == "absent" else "replaced"


def remove_extension_link():
    src, link = extension_paths()
    if os.path.islink(link):
        try:
            if os.path.realpath(link) == os.path.realpath(src):
                os.remove(link)
                return True
        except OSError:
            pass
    return False


def check(quiet=False, bundle_only=False):
    root, bundle = locate()
    try:
        for target in TARGETS:
            _plan_target(bundle, target)
        states = all_target_state(bundle)
    except SystemExit as error:
        if not quiet:
            print(str(error))
        return 2
    complete = all(_target_complete(st) for st in states)
    ext = None if bundle_only else extension_state()
    complete = complete and (bundle_only or ext == "correct")
    missing = any(st["missing_anchor"] for st in states)
    if not quiet:
        print(f"prime-agent {package_version(root)} at {root}")
        for st in states:
            extra = ""
            if "helper" in st:
                extra = (f", helper {'present' if st['helper'] else 'absent'}"
                         f", import {'present' if st['imported'] else 'absent'}"
                         + (f", helper matches source ({'yes' if st.get('helper_matches') else 'NO'})" if st["helper"] else ""))
            print(f"{st['id']} ({os.path.basename(st['path'])}): applied {st['applied']}, pending {st['pending']}, "
                  f"missing anchors {st['missing_anchor']}{extra}")
        if bundle_only:
            print("extension: skipped (bundle-only)")
        else:
            print(f"extension symlink ({os.path.join(agent_dir(), 'extensions', 'pi-pool')}): {ext}")
        print("state:", "patched" if complete else ("anchors missing" if missing else "not patched"))
    if complete:
        return 0
    return 2 if missing else 1


def _same_file(a, b):
    try:
        with open(a, "rb") as fa, open(b, "rb") as fb:
            return fa.read() == fb.read()
    except OSError:
        return False


def _check_esm(path):
    """`node --check <file>` parses a .js file as CommonJS regardless of package.json; feed it as a module."""
    with open(path, "rb") as f:
        return subprocess.run(["node", "--input-type=module", "--check"], stdin=f, capture_output=True, text=True)


def _original_source(src, target):
    patches = target["patches"] + target.get("legacy_patches", [])
    seen = set()
    for pid, anchor, replacement in patches:
        if replacement in seen:
            continue
        seen.add(replacement)
        count = src.count(replacement)
        if count > 1:
            raise SystemExit(f"{target['id']}/{pid}: duplicate replacement")
        if count == 1:
            src = src.replace(replacement, anchor, 1)
    if target["helper"]:
        if src.count(IMPORT_LINE) > 1:
            raise SystemExit(f"{target['id']}: duplicate helper import")
        src = src.replace(IMPORT_LINE, "")
    if MARK in src:
        raise SystemExit(f"{target['id']}: unknown pi-pool changes")
    for pid, anchor, _replacement in target["patches"]:
        if src.count(anchor) != 1:
            raise SystemExit(f"{target['id']}/{pid}: expected one anchor, found {src.count(anchor)}")
    return src


def _plan_target(bundle, target):
    path = locate_target(bundle, target)
    with open(path, encoding="utf8") as f:
        current = f.read()
    original = _original_source(current, target)
    backup = path + ".bak-pi-pool"
    if os.path.exists(backup):
        with open(backup, encoding="utf8") as f:
            saved = f.read()
        if saved != original:
            raise SystemExit(f"{target['id']}: backup does not match the original bundle; nothing written")
    patched = original
    for pid, anchor, replacement in target["patches"]:
        if patched.count(anchor) != 1:
            raise SystemExit(f"{target['id']}/{pid}: overlapping or duplicate anchor")
        patched = patched.replace(anchor, replacement, 1)
    if target["helper"]:
        if patched.startswith("#!"):
            first, rest = patched.split("\n", 1)
            patched = first + "\n" + IMPORT_LINE + rest
        else:
            patched = IMPORT_LINE + patched
    return {"target": target, "path": path, "backup": backup,
            "original": original, "current": current, "patched": patched}


def _stage(path, content):
    temporary = path + ".pi-pool-tmp"
    with open(temporary, "w", encoding="utf8") as f:
        f.write(content)
    result = _check_esm(temporary)
    if result.returncode != 0:
        os.remove(temporary)
        raise SystemExit(f"{path}: staged JavaScript failed syntax check; nothing written\n{result.stderr[-500:]}")
    return temporary


def apply(bundle_only=False):
    root, bundle = locate()
    version = package_version(root)
    plans = [_plan_target(bundle, target) for target in TARGETS]
    if not bundle_only and extension_state() == "blocked":
        raise SystemExit("extension path is not a symlink pi-pool owns; nothing written")
    staged = []
    changed = []
    try:
        for plan in plans:
            if plan["current"] != plan["patched"]:
                staged.append((_stage(plan["path"], plan["patched"]), plan["path"]))
                changed.append(plan["target"]["id"])
        helper_dst = os.path.join(bundle, HELPER_NAME)
        if any(target["helper"] for target in TARGETS) and not _same_file(HELPER_SRC, helper_dst):
            with open(HELPER_SRC, encoding="utf8") as f:
                helper_content = f.read()
            staged.insert(0, (_stage(helper_dst, helper_content), helper_dst))
        for plan in plans:
            if not os.path.exists(plan["backup"]):
                temporary = plan["backup"] + ".tmp"
                with open(temporary, "w", encoding="utf8") as f:
                    f.write(plan["original"])
                os.replace(temporary, plan["backup"])
        for temporary, destination in staged:
            os.replace(temporary, destination)
    finally:
        for temporary, _destination in staged:
            if os.path.exists(temporary):
                os.remove(temporary)
    ext_result = "skipped (bundle-only)" if bundle_only else ensure_extension_link()
    log("patched", version=version, changed=changed, extension=ext_result)
    print(f"prime-agent {version}: patched {changed or '(unchanged)'}, extension {ext_result}. "
          "Running processes keep their loaded code; no restart was requested.")
    return 0


def revert(bundle_only=False):
    root, bundle = locate()
    plans = [_plan_target(bundle, target) for target in TARGETS]
    staged = []
    reverted = []
    try:
        for plan in reversed(plans):
            if os.path.exists(plan["backup"]):
                staged.append((_stage(plan["path"], plan["original"]), plan["path"]))
                reverted.append(plan["target"]["id"])
        for temporary, destination in staged:
            os.replace(temporary, destination)
        for plan in plans:
            if os.path.exists(plan["backup"]):
                os.remove(plan["backup"])
        helper = os.path.join(bundle, HELPER_NAME)
        if any(target["helper"] for target in TARGETS) and os.path.exists(helper):
            os.remove(helper)
    finally:
        for temporary, _destination in staged:
            if os.path.exists(temporary):
                os.remove(temporary)
    ext_removed = False if bundle_only else remove_extension_link()
    log("unpatched", version=package_version(root), reverted=reverted, extension_removed=ext_removed)
    print(f"restored {reverted}, extension symlink removed: {ext_removed}")
    return 0 if reverted or ext_removed else 1


def main(argv):
    bundle_only = "--bundle-only" in argv
    argv = [arg for arg in argv if arg != "--bundle-only"]
    if not argv or argv[0] == "apply":
        return apply(bundle_only=bundle_only)
    if argv[0] == "--check" or argv[0] == "check":
        return check(bundle_only=bundle_only)
    if argv[0] in ("revert", "unpatch"):
        return revert(bundle_only=bundle_only)
    raise SystemExit(__doc__)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
