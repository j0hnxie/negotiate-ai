const tabStateCache = new Map();

const TRANSCRIPT_STORAGE_PREFIX = "negotiation_tab_state_";
const MEETING_CONTEXT_STORAGE_PREFIX = "negotiation_meeting_context_";
const UPDATE_MIN_INTERVAL_MS = 8000;
const MAX_TRANSCRIPT_LINES = 700;
const MAX_LINES_PER_PROMPT = 160;
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

const SYSTEM_INSTRUCTIONS = [
  "You are NegotiateAI, a live negotiation copilot for Google Meet.",
  "Return raw JSON only.",
  "Do not wrap JSON in markdown fences.",
  "Keep text scan-friendly and short.",
  "Do not write paragraphs longer than 18 words.",
  "Focus on tactics, options, leverage, and concise phrasing.",
  "Only mark a goal as done if the transcript clearly indicates it was achieved or explicitly agreed.",
  "Do not invent offer terms. Keep an existing term if the transcript does not update it.",
  "If data is uncertain, keep it conservative."
].join("\n");

chrome.runtime.onInstalled.addListener(() => {
  void seedDefaults();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTabState(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_BOOTSTRAP") {
    void handleGetBootstrap(sender, message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_TAB_STATE") {
    void handleGetTabState(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "START_SESSION") {
    void handleStartSession(sender, message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TRANSCRIPT_CHUNK") {
    void handleTranscriptChunk(sender, message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SET_TAB_COACH_ENABLED") {
    void handleSetCoachEnabled(message.tabId, message.enabled)
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SET_COACH_ENABLED") {
    const tabId = sender.tab?.id;
    void handleSetCoachEnabled(tabId, message.enabled)
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RESET_SESSION_FOR_TAB") {
    void handleResetSession(message.tabId)
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RESET_TAB_TRANSCRIPT") {
    const tabId = sender.tab?.id;
    void handleResetSession(tabId)
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OPEN_SETUP_IN_TAB") {
    const tabId = message.tabId;
    if (typeof tabId === "number") {
      chrome.tabs.sendMessage(tabId, { type: "OPEN_SETUP" }, () => {
        void chrome.runtime.lastError;
      });
    }
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "PING") {
    sendResponse({ ok: true, service: "background" });
  }
});

async function handleGetBootstrap(sender, message) {
  await seedDefaults();

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    throw new Error("No active Meet tab found.");
  }

  const settings = await getSettings();
  const state = await getOrCreateTabState(tabId, message.meetingId || "unknown");
  syncBootstrapStatus(state, settings);
  await persistTabState(tabId);

  return {
    provider: buildProviderSummary(settings),
    snapshot: buildSnapshot(state)
  };
}

async function handleGetTabState(message) {
  await seedDefaults();

  if (typeof message.tabId !== "number") {
    throw new Error("Missing tab id.");
  }

  const settings = await getSettings();
  const state = await getOrCreateTabState(message.tabId, message.meetingId || "unknown");
  return {
    provider: buildProviderSummary(settings),
    snapshot: buildSnapshot(state)
  };
}

async function handleStartSession(sender, message) {
  await seedDefaults();

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    throw new Error("No active Meet tab found.");
  }

  const settings = await getSettings();
  const state = await getOrCreateTabState(tabId, message.meetingId || "unknown");
  const quickContext = normalizeQuickSetup(message.payload);

  state.quickContext = quickContext;
  state.goals = makeGoalsFromPriorities(quickContext.priorities);
  state.panelData = makeInitialPanelData(state.goals);
  state.sessionActive = true;
  state.coachEnabled = true;
  state.statusText = buildProviderSummary(settings).ready
    ? "Live session started. Waiting for captions."
    : `Add a ${buildProviderSummary(settings).label} API key in settings.`;

  if (!message.preserveTranscript) {
    state.transcript = [];
    state.seen = new Set();
    state.offerTerms = defaultOfferTerms();
    state.lastAdviceAt = 0;
  } else {
    state.offerTerms = mergeOfferTerms(defaultOfferTerms(), state.offerTerms);
  }

  state.panelData.offerTerms = { ...state.offerTerms };
  state.panelData.goals = state.goals.map((goal) => ({ ...goal }));
  await saveMeetingContext(state.meetingId, quickContext);
  await persistTabState(tabId);
  sendStateToTab(tabId, state);

  if (state.transcript.length) {
    void generateAdviceForTab(tabId);
  }

  return {
    provider: buildProviderSummary(settings),
    snapshot: buildSnapshot(state)
  };
}

async function handleTranscriptChunk(sender, message) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    throw new Error("No sender tab.");
  }

  const state = await getOrCreateTabState(tabId, message.meetingId || "unknown");
  if (!state.sessionActive) {
    return;
  }

  let added = 0;
  for (const line of message.lines || []) {
    const speaker = normalizeShortText(line.speaker || "Unknown", 80);
    const text = normalizeShortText(line.text || "", 500);
    const at = typeof line.at === "string" ? line.at : new Date().toISOString();

    if (!text) {
      continue;
    }

    const dedupeKey = `${speaker}|${text}`;
    if (state.seen.has(dedupeKey)) {
      continue;
    }

    state.seen.add(dedupeKey);
    state.transcript.push({ speaker, text, at });
    added += 1;
  }

  if (!added) {
    return;
  }

  if (state.transcript.length > MAX_TRANSCRIPT_LINES) {
    state.transcript = state.transcript.slice(-MAX_TRANSCRIPT_LINES);
    state.seen = new Set(state.transcript.map((line) => `${line.speaker}|${line.text}`));
  }

  state.statusText = "Listening live...";
  await persistTabState(tabId);

  const now = Date.now();
  if (state.coachEnabled && !state.generating && now - state.lastAdviceAt >= UPDATE_MIN_INTERVAL_MS) {
    await generateAdviceForTab(tabId);
  } else {
    sendStateToTab(tabId, state);
  }
}

async function handleSetCoachEnabled(tabId, enabled) {
  if (typeof tabId !== "number") {
    throw new Error("Missing tab id.");
  }

  const state = await getOrCreateTabState(tabId, "unknown");
  state.coachEnabled = Boolean(enabled);
  state.statusText = state.coachEnabled ? "Live suggestions enabled." : "Suggestions paused.";
  await persistTabState(tabId);
  sendStateToTab(tabId, state);

  if (state.coachEnabled && state.sessionActive && state.transcript.length) {
    void generateAdviceForTab(tabId);
  }

  return buildSnapshot(state);
}

async function handleResetSession(tabId) {
  if (typeof tabId !== "number") {
    throw new Error("Missing tab id.");
  }

  const state = await getOrCreateTabState(tabId, "unknown");
  state.transcript = [];
  state.seen = new Set();
  state.offerTerms = defaultOfferTerms();
  state.lastAdviceAt = 0;
  state.goals = state.goals.map((goal) => ({
    ...goal,
    status: "pending",
    note: ""
  }));
  state.panelData = makeInitialPanelData(state.goals);
  state.statusText = "Transcript cleared.";

  await persistTabState(tabId);
  sendStateToTab(tabId, state);
  return buildSnapshot(state);
}

async function generateAdviceForTab(tabId) {
  const state = await getOrCreateTabState(tabId, "unknown");
  if (!state.sessionActive || !state.coachEnabled || !state.transcript.length || state.generating) {
    return;
  }

  const settings = await getSettings();
  const provider = buildProviderSummary(settings);
  if (!provider.ready) {
    state.statusText = `Add a ${provider.label} API key in settings.`;
    await persistTabState(tabId);
    sendStateToTab(tabId, state);
    return;
  }

  state.generating = true;
  state.statusText = "Updating suggestions...";
  sendStateToTab(tabId, state);

  try {
    const prompt = buildPrompt(state, settings.contextLibrary);
    const rawText = await callProvider(settings, prompt);
    const parsed = parseJsonFromModel(rawText);
    const panelData = normalizePanelData(parsed, state, settings.contextLibrary);

    state.goals = panelData.goals.map((goal) => ({ ...goal }));
    state.offerTerms = { ...panelData.offerTerms };
    state.panelData = panelData;
    state.lastAdviceAt = Date.now();
    state.statusText = `Updated ${new Date(state.lastAdviceAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    })}`;

    await persistTabState(tabId);
    sendStateToTab(tabId, state);
  } catch (error) {
    const fallbackPanel = buildHeuristicPanelData(state, settings.contextLibrary);
    state.goals = fallbackPanel.goals.map((goal) => ({ ...goal }));
    state.offerTerms = { ...fallbackPanel.offerTerms };
    state.panelData = fallbackPanel;
    state.statusText = `Fallback mode: ${normalizeShortText(error.message, 100)}`;
    await persistTabState(tabId);
    sendStateToTab(tabId, state);
  } finally {
    state.generating = false;
  }
}

async function callProvider(settings, prompt) {
  if (settings.provider === "anthropic") {
    return callAnthropic(settings, prompt);
  }
  return callOpenAI(settings, prompt);
}

async function callOpenAI(settings, prompt) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openaiApiKey}`
    },
    body: JSON.stringify({
      model: settings.openaiModel || DEFAULT_OPENAI_MODEL,
      instructions: SYSTEM_INSTRUCTIONS,
      input: prompt,
      text: {
        format: {
          type: "json_object"
        }
      },
      temperature: 0.3,
      max_output_tokens: 1200
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error ${response.status}`);
  }

  const payload = await response.json();
  const outputText = extractOpenAIText(payload);
  if (!outputText) {
    throw new Error("OpenAI API returned no text.");
  }
  return outputText;
}

async function callAnthropic(settings, prompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.anthropicApiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: settings.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      system: SYSTEM_INSTRUCTIONS,
      max_tokens: 1200,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}`);
  }

  const payload = await response.json();
  const outputText = extractAnthropicText(payload);
  if (!outputText) {
    throw new Error("Anthropic API returned no text.");
  }
  return outputText;
}

function buildPrompt(state, libraryContext) {
  const transcriptText = state.transcript
    .slice(-MAX_LINES_PER_PROMPT)
    .map((line) => `[${new Date(line.at).toLocaleTimeString()}] ${line.speaker}: ${line.text}`)
    .join("\n");

  const goalPayload = state.goals.map((goal) => ({
    id: goal.id,
    label: goal.label,
    current_status: goal.status
  }));

  const promptBody = {
    meeting_id: state.meetingId,
    quick_setup: {
      industry: state.quickContext.industry,
      role_title: state.quickContext.roleTitle,
      company: state.quickContext.company,
      speaking_with: state.quickContext.counterpartRole,
      counterpart_notes: state.quickContext.counterpartNotes,
      priorities: state.quickContext.priorities,
      additional_context: state.quickContext.additionalContext
    },
    background_context: {
      previous_emails: trimForPrompt(libraryContext.previousEmails, 2400),
      previous_documents: trimForPrompt(libraryContext.previousDocs, 2400),
      personal_experience: trimForPrompt(libraryContext.personalExperience, 1800)
    },
    current_goals: goalPayload,
    current_offer_terms: state.offerTerms,
    recent_transcript: transcriptText
  };

  return [
    "Update the live negotiation panel.",
    "",
    "Return JSON with exactly this shape:",
    "{",
    '  "strategy": {',
    '    "label": "2-4 words",',
    '    "stance": "Hold firm | Probe | Concede small | Close | Listen",',
    '    "summary": "max 12 words",',
    '    "bullets": ["short bullet", "short bullet"],',
    '    "paths": [{"label": "short option", "tradeoff": "short tradeoff"}],',
    '    "phrasing": ["short phrase", "short phrase"]',
    "  },",
    '  "leverage": {',
    '    "label": "short label",',
    '    "headline": "short headline or value",',
    '    "bullets": ["short bullet", "short bullet", "short bullet"]',
    "  },",
    '  "market_research": {',
    '    "headline": "short headline",',
    '    "bullets": ["short bullet", "short bullet", "short bullet"]',
    "  },",
    '  "goals": [{"id": "goal-1", "status": "pending|active|done", "note": "short note"}],',
    '  "offer_terms": {',
    '    "base_salary": "short value",',
    '    "signing_bonus": "short value",',
    '    "equity": "short value",',
    '    "remote": "short value",',
    '    "pto": "short value",',
    '    "start_date": "short value"',
    "  },",
    '  "watchouts": ["short warning", "short warning"]',
    "}",
    "",
    "Rules:",
    "- Keep all text minimal and easy to scan.",
    "- No paragraphs. Use fragments.",
    "- Offer terms should stay unchanged if the transcript does not change them.",
    "- Use only the provided goal ids.",
    "- Mark a goal as active only if it is currently being negotiated.",
    "- Mark a goal as done only if it appears secured, accepted, or clearly covered.",
    "- Use market_research for quick external anchors, precedent, or compensation context.",
    "",
    "Data:",
    JSON.stringify(promptBody, null, 2)
  ].join("\n");
}

function normalizePanelData(raw, state, contextLibrary) {
  const base = makeInitialPanelData(state.goals);
  const strategy = raw?.strategy || {};
  const leverage = raw?.leverage || {};
  const marketResearch = raw?.market_research || raw?.marketResearch || {};
  const goalUpdates = Array.isArray(raw?.goals) ? raw.goals : [];
  const offerTerms = raw?.offer_terms || raw?.offerTerms || {};
  const nextGoals = state.goals.map((goal, index) => {
    const update =
      goalUpdates.find((item) => String(item?.id || "") === goal.id) ||
      goalUpdates[index] ||
      {};
    return {
      id: goal.id,
      label: goal.label,
      status: normalizeGoalStatus(update.status || goal.status),
      note: normalizeShortText(update.note || "", 80)
    };
  });

  return {
    strategy: {
      label: normalizeShortText(strategy.label || base.strategy.label, 40),
      stance: normalizeShortText(strategy.stance || base.strategy.stance, 24),
      summary: normalizeShortText(strategy.summary || base.strategy.summary, 80),
      bullets: normalizeStringArray(strategy.bullets, 3, 90),
      paths: normalizePathArray(strategy.paths, 2),
      phrasing: normalizeStringArray(strategy.phrasing, 2, 90)
    },
    leverage: {
      label: normalizeShortText(leverage.label || "Leverage", 28),
      headline: normalizeShortText(leverage.headline || "", 48),
      bullets: normalizeStringArray(leverage.bullets, 3, 100)
    },
    marketResearch: {
      headline: normalizeShortText(marketResearch.headline || buildMarketHeadline(state, contextLibrary), 52),
      bullets: normalizeStringArray(marketResearch.bullets, 3, 100)
    },
    goals: nextGoals,
    offerTerms: mergeOfferTerms(state.offerTerms, offerTerms),
    watchouts: normalizeStringArray(raw?.watchouts, 2, 90),
    generatedAt: new Date().toISOString()
  };
}

function mergeOfferTerms(currentTerms, updateTerms) {
  const next = { ...defaultOfferTerms(), ...(currentTerms || {}) };
  const mapping = {
    base_salary: "baseSalary",
    signing_bonus: "signingBonus",
    equity: "equity",
    remote: "remote",
    pto: "pto",
    start_date: "startDate"
  };

  for (const [inputKey, stateKey] of Object.entries(mapping)) {
    const rawValue = normalizeShortText(updateTerms?.[inputKey] || updateTerms?.[stateKey] || "", 60);
    if (rawValue && !isUnknownValue(rawValue)) {
      next[stateKey] = rawValue;
    }
  }

  return next;
}

function makeInitialPanelData(goals) {
  return {
    strategy: {
      label: "Waiting",
      stance: "Listen",
      summary: "Start the session to unlock live guidance.",
      bullets: [],
      paths: [],
      phrasing: []
    },
    leverage: {
      label: "Leverage",
      headline: "",
      bullets: []
    },
    marketResearch: {
      headline: "",
      bullets: []
    },
    goals: goals.map((goal) => ({ ...goal })),
    offerTerms: defaultOfferTerms(),
    watchouts: [],
    generatedAt: new Date().toISOString()
  };
}

function makeGoalsFromPriorities(priorities) {
  return normalizePriorityList(priorities).map((label, index) => ({
    id: `goal-${index + 1}`,
    label,
    status: "pending",
    note: ""
  }));
}

function defaultOfferTerms() {
  return {
    baseSalary: "--",
    signingBonus: "--",
    equity: "--",
    remote: "--",
    pto: "--",
    startDate: "--"
  };
}

function defaultQuickSetup() {
  return {
    industry: "",
    roleTitle: "",
    company: "",
    counterpartRole: "Hiring Manager",
    counterpartNotes: "",
    priorities: ["Base salary", "Equity", "Flexibility"],
    additionalContext: ""
  };
}

function defaultContextLibrary() {
  return {
    previousEmails: "",
    previousDocs: "",
    personalExperience: ""
  };
}

async function seedDefaults() {
  const current = await chrome.storage.local.get([
    "provider",
    "openaiApiKey",
    "openaiModel",
    "anthropicApiKey",
    "anthropicModel",
    "contextLibrary"
  ]);

  const patch = {};

  if (!current.provider) {
    patch.provider = "openai";
  }
  if (typeof current.openaiModel !== "string") {
    patch.openaiModel = DEFAULT_OPENAI_MODEL;
  }
  if (typeof current.anthropicModel !== "string") {
    patch.anthropicModel = DEFAULT_ANTHROPIC_MODEL;
  }
  if (typeof current.contextLibrary !== "object" || current.contextLibrary === null) {
    patch.contextLibrary = defaultContextLibrary();
  }

  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }
}

async function getSettings() {
  const raw = await chrome.storage.local.get([
    "provider",
    "openaiApiKey",
    "openaiModel",
    "anthropicApiKey",
    "anthropicModel",
    "contextLibrary"
  ]);

  return {
    provider: raw.provider || "openai",
    openaiApiKey: typeof raw.openaiApiKey === "string" ? raw.openaiApiKey.trim() : "",
    openaiModel: typeof raw.openaiModel === "string" ? raw.openaiModel.trim() || DEFAULT_OPENAI_MODEL : DEFAULT_OPENAI_MODEL,
    anthropicApiKey: typeof raw.anthropicApiKey === "string" ? raw.anthropicApiKey.trim() : "",
    anthropicModel:
      typeof raw.anthropicModel === "string" ? raw.anthropicModel.trim() || DEFAULT_ANTHROPIC_MODEL : DEFAULT_ANTHROPIC_MODEL,
    contextLibrary: {
      ...defaultContextLibrary(),
      ...(raw.contextLibrary || {})
    }
  };
}

function buildProviderSummary(settings) {
  if (settings.provider === "anthropic") {
    return {
      id: "anthropic",
      label: "Claude",
      model: settings.anthropicModel,
      ready: Boolean(settings.anthropicApiKey)
    };
  }

  return {
    id: "openai",
    label: "OpenAI",
    model: settings.openaiModel,
    ready: Boolean(settings.openaiApiKey)
  };
}

async function getOrCreateTabState(tabId, meetingId) {
  const normalizedMeetingId = normalizeMeetingId(meetingId);

  if (tabStateCache.has(tabId)) {
    const cached = tabStateCache.get(tabId);
    if (normalizedMeetingId !== "unknown" && cached.meetingId !== normalizedMeetingId) {
      const savedContext = await getSavedMeetingContext(normalizedMeetingId);
      resetStateForMeeting(cached, normalizedMeetingId, savedContext);
      await persistTabState(tabId);
    } else if (normalizedMeetingId !== "unknown" && !cached.sessionActive) {
      const savedContext = await getSavedMeetingContext(normalizedMeetingId);
      if (savedContext) {
        restoreSavedMeetingContext(cached, normalizedMeetingId, savedContext);
        await persistTabState(tabId);
      } else {
        cached.meetingId = normalizedMeetingId;
      }
    }
    return cached;
  }

  const key = getTabStorageKey(tabId);
  const stored = await chrome.storage.local.get([key]);
  const hydrated = hydrateTabState(stored[key], normalizedMeetingId);
  let shouldPersist = false;

  if (normalizedMeetingId !== "unknown") {
    const savedContext = await getSavedMeetingContext(normalizedMeetingId);

    if (hydrated.meetingId !== normalizedMeetingId) {
      resetStateForMeeting(hydrated, normalizedMeetingId, savedContext);
      shouldPersist = true;
    } else if (!hydrated.sessionActive && savedContext) {
      restoreSavedMeetingContext(hydrated, normalizedMeetingId, savedContext);
      shouldPersist = true;
    } else {
      hydrated.meetingId = normalizedMeetingId;
    }
  }

  tabStateCache.set(tabId, hydrated);
  if (shouldPersist) {
    await persistTabState(tabId);
  }
  return hydrated;
}

async function persistTabState(tabId) {
  const state = tabStateCache.get(tabId);
  if (!state) {
    return;
  }

  await chrome.storage.local.set({
    [getTabStorageKey(tabId)]: {
      meetingId: state.meetingId,
      transcript: state.transcript,
      sessionActive: state.sessionActive,
      coachEnabled: state.coachEnabled,
      quickContext: state.quickContext,
      goals: state.goals,
      offerTerms: state.offerTerms,
      panelData: state.panelData,
      lastAdviceAt: state.lastAdviceAt,
      statusText: state.statusText
    }
  });
}

async function removeTabState(tabId) {
  tabStateCache.delete(tabId);
  await chrome.storage.local.remove(getTabStorageKey(tabId));
}

function hydrateTabState(raw, meetingId) {
  const quickContext = normalizeQuickSetup(raw?.quickContext || defaultQuickSetup());
  const goals = Array.isArray(raw?.goals) && raw.goals.length ? raw.goals.map(normalizeGoalObject) : makeGoalsFromPriorities(quickContext.priorities);
  const transcript = Array.isArray(raw?.transcript)
    ? raw.transcript
        .slice(-MAX_TRANSCRIPT_LINES)
        .map((line) => ({
          speaker: normalizeShortText(line?.speaker || "Unknown", 80),
          text: normalizeShortText(line?.text || "", 500),
          at: typeof line?.at === "string" ? line.at : new Date().toISOString()
        }))
    : [];

  const state = {
    meetingId: normalizeMeetingId(meetingId || raw?.meetingId || "unknown"),
    transcript,
    seen: new Set(transcript.map((line) => `${line.speaker}|${line.text}`)),
    sessionActive: Boolean(raw?.sessionActive),
    coachEnabled: raw?.coachEnabled !== false,
    quickContext,
    goals,
    offerTerms: mergeOfferTerms(defaultOfferTerms(), raw?.offerTerms || {}),
    panelData: makeInitialPanelData(goals),
    lastAdviceAt: Number(raw?.lastAdviceAt || 0),
    generating: false,
    statusText: normalizeShortText(raw?.statusText || "", 120)
  };

  state.panelData = normalizePanelData(raw?.panelData || {}, state, defaultContextLibrary());
  return state;
}

function resetStateForMeeting(state, meetingId, savedQuickContext = null) {
  state.meetingId = normalizeMeetingId(meetingId || "unknown");
  state.transcript = [];
  state.seen = new Set();
  state.coachEnabled = true;
  state.quickContext = normalizeQuickSetup(savedQuickContext || defaultQuickSetup());
  state.goals = makeGoalsFromPriorities(state.quickContext.priorities);
  state.offerTerms = defaultOfferTerms();
  state.panelData = makeInitialPanelData(state.goals);
  state.lastAdviceAt = 0;
  state.generating = false;
  state.sessionActive = Boolean(savedQuickContext);
  state.statusText = savedQuickContext
    ? "Context loaded for this meeting. Waiting for captions."
    : "New meeting detected. Add fresh context.";
}

function restoreSavedMeetingContext(state, meetingId, savedQuickContext) {
  resetStateForMeeting(state, meetingId, savedQuickContext);
}

function syncBootstrapStatus(state, settings) {
  const provider = buildProviderSummary(settings);

  if (!state.sessionActive) {
    state.statusText = "Add fresh context for this meeting.";
    return;
  }

  if (!provider.ready) {
    state.statusText = `Add a ${provider.label} API key in settings.`;
    return;
  }

  if (!state.transcript.length) {
    state.statusText = "Context loaded for this meeting. Waiting for captions.";
  }
}

function buildSnapshot(state) {
  return {
    sessionActive: state.sessionActive,
    coachEnabled: state.coachEnabled,
    totalCaptured: state.transcript.length,
    quickContext: state.quickContext,
    panelData: state.panelData,
    statusText: state.statusText
  };
}

function sendStateToTab(tabId, state) {
  chrome.tabs.sendMessage(
    tabId,
    {
      type: "STATE_UPDATE",
      snapshot: buildSnapshot(state)
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function getTabStorageKey(tabId) {
  return `${TRANSCRIPT_STORAGE_PREFIX}${tabId}`;
}

function getMeetingContextStorageKey(meetingId) {
  return `${MEETING_CONTEXT_STORAGE_PREFIX}${encodeURIComponent(meetingId)}`;
}

async function getSavedMeetingContext(meetingId) {
  const normalizedMeetingId = normalizeMeetingId(meetingId);
  if (normalizedMeetingId === "unknown") {
    return null;
  }

  const key = getMeetingContextStorageKey(normalizedMeetingId);
  const stored = await chrome.storage.local.get([key]);
  const raw = stored[key];
  if (!raw) {
    return null;
  }

  return normalizeQuickSetup(raw.quickContext || raw);
}

async function saveMeetingContext(meetingId, quickContext) {
  const normalizedMeetingId = normalizeMeetingId(meetingId);
  if (normalizedMeetingId === "unknown") {
    return;
  }

  await chrome.storage.local.set({
    [getMeetingContextStorageKey(normalizedMeetingId)]: {
      quickContext: normalizeQuickSetup(quickContext),
      savedAt: new Date().toISOString()
    }
  });
}

function normalizeMeetingId(meetingId) {
  if (typeof meetingId !== "string") {
    return "unknown";
  }

  const normalized = meetingId.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  return normalized || "unknown";
}

function normalizeQuickSetup(input) {
  const safe = input || {};
  return {
    industry: normalizeShortText(safe.industry || "", 80),
    roleTitle: normalizeShortText(safe.roleTitle || "", 80),
    company: normalizeShortText(safe.company || "", 80),
    counterpartRole: normalizeShortText(safe.counterpartRole || "Hiring Manager", 40) || "Hiring Manager",
    counterpartNotes: normalizeShortText(safe.counterpartNotes || "", 200),
    priorities: normalizePriorityList(safe.priorities),
    additionalContext: normalizeShortText(safe.additionalContext || "", 350)
  };
}

function normalizePriorityList(priorities) {
  const list = Array.isArray(priorities) ? priorities : [];
  const cleaned = [];

  for (const item of list) {
    const value = normalizeShortText(item, 80);
    if (value && !cleaned.includes(value)) {
      cleaned.push(value);
    }
  }

  if (!cleaned.length) {
    cleaned.push("Base salary");
  }

  return cleaned.slice(0, 6);
}

function normalizeGoalObject(goal) {
  return {
    id: typeof goal?.id === "string" ? goal.id : `goal-${Math.random().toString(36).slice(2, 8)}`,
    label: normalizeShortText(goal?.label || "Goal", 80),
    status: normalizeGoalStatus(goal?.status || "pending"),
    note: normalizeShortText(goal?.note || "", 80)
  };
}

function normalizeGoalStatus(status) {
  if (status === "done" || status === "active") {
    return status;
  }
  return "pending";
}

function normalizePathArray(paths, maxItems) {
  if (!Array.isArray(paths)) {
    return [];
  }

  return paths
    .slice(0, maxItems)
    .map((item) => ({
      label: normalizeShortText(item?.label || "", 36),
      tradeoff: normalizeShortText(item?.tradeoff || "", 72)
    }))
    .filter((item) => item.label || item.tradeoff);
}

function normalizeStringArray(values, maxItems, maxLength) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .slice(0, maxItems)
    .map((value) => normalizeShortText(value, maxLength))
    .filter(Boolean);
}

function normalizeShortText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function trimForPrompt(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

function isUnknownValue(value) {
  const lowered = value.toLowerCase();
  return lowered === "--" || lowered === "-" || lowered === "unknown" || lowered === "not mentioned" || lowered === "n/a";
}

function extractOpenAIText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const items = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];

  for (const item of items) {
    for (const block of item?.content || []) {
      if ((block?.type === "output_text" || block?.type === "text") && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function extractAnthropicText(payload) {
  const items = Array.isArray(payload?.content) ? payload.content : [];
  return items
    .map((item) => (item?.type === "text" ? item.text : ""))
    .join("\n")
    .trim();
}

function parseJsonFromModel(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (_error) {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("Model response was not valid JSON.");
    }
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  }
}

function buildHeuristicPanelData(state, contextLibrary) {
  const recentTranscript = state.transcript.slice(-8);
  const latestLine = recentTranscript[recentTranscript.length - 1] || null;
  const activeGoal = state.goals.find((goal) => goal.status !== "done") || state.goals[0] || null;
  const extractedTerms = extractOfferTermsFromTranscript(state.transcript, state.offerTerms);
  const nextGoals = state.goals.map((goal) => {
    const normalizedGoal = goal.label.toLowerCase();
    const matchedLine = recentTranscript.find((line) => line.text.toLowerCase().includes(normalizedGoal));
    return {
      ...goal,
      status: goal.status === "done" ? "done" : matchedLine ? "active" : "pending",
      note: goal.status === "done" ? goal.note : matchedLine ? `Mentioned by ${matchedLine.speaker}` : ""
    };
  });

  return {
    strategy: {
      label: activeGoal ? "Track next ask" : "Listen",
      stance: activeGoal ? "Probe" : "Listen",
      summary: latestLine
        ? `React to ${normalizeShortText(latestLine.speaker, 20)}'s latest point.`
        : "Waiting on live captions.",
      bullets: buildHeuristicBullets(state, latestLine, activeGoal),
      paths: buildHeuristicPaths(activeGoal),
      phrasing: buildHeuristicPhrasing(activeGoal)
    },
    leverage: {
      label: "Leverage",
      headline: buildLeverageHeadline(state, contextLibrary),
      bullets: buildLeverageBullets(state, contextLibrary)
    },
    marketResearch: {
      headline: buildMarketHeadline(state, contextLibrary),
      bullets: buildMarketResearchBullets(state, contextLibrary, extractedTerms)
    },
    goals: nextGoals,
    offerTerms: extractedTerms,
    watchouts: buildWatchouts(latestLine),
    generatedAt: new Date().toISOString()
  };
}

function buildHeuristicBullets(state, latestLine, activeGoal) {
  const bullets = [];
  if (latestLine) {
    bullets.push(`Latest point: ${normalizeShortText(latestLine.text, 82)}`);
  }
  if (activeGoal) {
    bullets.push(`Bring conversation back to ${normalizeShortText(activeGoal.label, 32)}.`);
  }
  bullets.push("Ask one concrete follow-up before you concede.");
  return bullets.slice(0, 3);
}

function buildHeuristicPaths(activeGoal) {
  if (!activeGoal) {
    return [{ label: "Clarify", tradeoff: "Get specifics before taking a position." }];
  }

  return [
    { label: "Anchor", tradeoff: `Push directly on ${normalizeShortText(activeGoal.label, 28)}.` },
    { label: "Trade", tradeoff: "Concede small only for a measurable gain." }
  ];
}

function buildHeuristicPhrasing(activeGoal) {
  if (!activeGoal) {
    return ["Can you walk me through the current package details?"];
  }

  return [
    `Can we spend a minute on ${normalizeShortText(activeGoal.label, 36)} specifically?`,
    "What room do you have if we solve this today?"
  ];
}

function buildLeverageHeadline(state, contextLibrary) {
  const sources = [
    state.quickContext.additionalContext,
    contextLibrary.previousDocs,
    contextLibrary.previousEmails
  ].filter(Boolean);

  for (const source of sources) {
    const amount = source.match(/\$[\d,.]+k?/i);
    if (amount) {
      return normalizeShortText(amount[0], 36);
    }
  }

  return state.quickContext.company ? `${normalizeShortText(state.quickContext.company, 22)} context` : "Use your priorities";
}

function buildLeverageBullets(state, contextLibrary) {
  const bullets = [];
  if (state.quickContext.additionalContext) {
    bullets.push(normalizeShortText(state.quickContext.additionalContext, 92));
  }
  if (contextLibrary.previousEmails) {
    bullets.push("Use earlier written commitments as anchors.");
  }
  if (state.quickContext.counterpartRole) {
    bullets.push(`Frame asks for a ${normalizeShortText(state.quickContext.counterpartRole, 26)} audience.`);
  }
  return bullets.slice(0, 3);
}

function buildMarketHeadline(state, contextLibrary) {
  if (state.quickContext.industry) {
    return `${normalizeShortText(state.quickContext.industry, 22)} market`;
  }
  if (contextLibrary.previousDocs) {
    return "Reference notes loaded";
  }
  return "Quick market view";
}

function buildMarketResearchBullets(state, contextLibrary, offerTerms) {
  const bullets = [];
  if (offerTerms.baseSalary && offerTerms.baseSalary !== "--") {
    bullets.push(`Base currently at ${normalizeShortText(offerTerms.baseSalary, 24)}.`);
  }
  if (offerTerms.equity && offerTerms.equity !== "--") {
    bullets.push(`Equity currently at ${normalizeShortText(offerTerms.equity, 24)}.`);
  }
  if (state.quickContext.additionalContext) {
    bullets.push("Compare current offer against your outside options.");
  } else if (contextLibrary.previousDocs || contextLibrary.previousEmails) {
    bullets.push("Use imported docs as your nearest market anchor.");
  } else {
    bullets.push("Add competing offer or comp notes for sharper market guidance.");
  }
  return bullets.slice(0, 3);
}

function buildWatchouts(latestLine) {
  const text = latestLine?.text?.toLowerCase?.() || "";
  const warnings = [];
  if (text.includes("policy") || text.includes("budget")) {
    warnings.push("Budget framing can shut down range. Ask about exceptions.");
  }
  if (text.includes("final") || text.includes("best")) {
    warnings.push("Treat 'final' as a probe until confirmed twice.");
  }
  if (!warnings.length) {
    warnings.push("Do not trade away multiple items at once.");
  }
  return warnings.slice(0, 2);
}

function extractOfferTermsFromTranscript(transcript, currentTerms) {
  const next = { ...defaultOfferTerms(), ...(currentTerms || {}) };
  const recent = transcript.slice(-40);

  for (const line of recent) {
    const text = line.text;
    const lower = text.toLowerCase();

    const salaryMatch = text.match(/\$[\d,.]+\s?[kK]?/);
    if (salaryMatch && /(salary|base|compensation|cash)/i.test(text)) {
      next.baseSalary = salaryMatch[0].replace(/\s+/g, "");
    }
    if (salaryMatch && /(signing|sign-on|bonus)/i.test(text)) {
      next.signingBonus = salaryMatch[0].replace(/\s+/g, "");
    }
    if (/(rsu|stock|equity|shares)/i.test(text)) {
      const equityMatch = text.match(/\$[\d,.]+\s?[kK]?|\d[\d,.]*\s?(rsus|shares)/i);
      if (equityMatch) {
        next.equity = normalizeShortText(equityMatch[0], 24);
      }
    }
    if (/(remote|hybrid|onsite|on-site)/i.test(lower)) {
      const remoteValue = ["remote", "hybrid", "onsite", "on-site"].find((item) => lower.includes(item));
      if (remoteValue) {
        next.remote = remoteValue === "on-site" ? "On-site" : remoteValue[0].toUpperCase() + remoteValue.slice(1);
      }
    }
    if (/(pto|vacation|days off)/i.test(lower)) {
      const ptoMatch = text.match(/\d+\s?(days|day|weeks|week)/i);
      if (ptoMatch) {
        next.pto = normalizeShortText(ptoMatch[0], 18);
      }
    }
    if (/(start date|start|begin)/i.test(lower)) {
      const dateMatch = text.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i);
      if (dateMatch) {
        next.startDate = normalizeShortText(dateMatch[0], 24);
      } else if (/flexible/i.test(text)) {
        next.startDate = "Flexible";
      }
    }
  }

  return next;
}
