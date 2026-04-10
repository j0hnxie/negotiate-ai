const tabStateCache = new Map();

const TRANSCRIPT_STORAGE_PREFIX = "negotiation_tab_state_";
const MEETING_CONTEXT_STORAGE_PREFIX = "negotiation_meeting_context_";
const UPDATE_MIN_INTERVAL_MS = 4500;
const CAPTION_STALE_MS = 20000;
const MAX_TRANSCRIPT_LINES = 700;
const MAX_LINES_PER_PROMPT = 160;
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const GOAL_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "your",
  "their",
  "this",
  "that",
  "role",
  "offer",
  "package",
  "level"
]);

const SYSTEM_INSTRUCTIONS = [
  "You are NegotiateAI, a live negotiation copilot for Google Meet.",
  "Return raw JSON only.",
  "Do not wrap JSON in markdown fences.",
  "Keep text scan-friendly and short.",
  "Do not write paragraphs longer than 18 words.",
  "Focus on tactics, next moves, and concise phrasing.",
  "Only mark a goal as done if the transcript clearly indicates it was achieved or explicitly agreed.",
  "Do not invent offer terms. Keep an existing term if the transcript does not update it.",
  "If data is uncertain, keep it conservative.",
  "In strategy, focus on closing the gap between the current offer and the user's target.",
  "If a lever sounds fixed, pivot to the next best lever instead of re-confirming old facts."
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

  if (message?.type === "OPEN_SETTINGS_PAGE") {
    void chrome.tabs.create({
      url: chrome.runtime.getURL("options.html"),
      active: true
    });
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
  state.goals = makeGoalsFromQuickSetup(quickContext);
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
    state.lastCaptionAt = 0;
    state.marketCache = {};
    state.strategyTopic = "general";
    state.marketTopic = "general";
    state.lastStrategyTranscriptLength = 0;
    state.lastMarketTranscriptLength = 0;
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

  state.lastCaptionAt = Date.now();
  state.offerTerms = extractOfferTermsFromTranscript(state.transcript, state.offerTerms);
  state.goals = reconcileGoalsWithTranscript(state.goals, state.transcript, state.offerTerms);
  state.statusText = "Listening live...";
  const detectedTopic = detectCurrentTopic(state.transcript, state.goals, state.offerTerms);
  state.currentTopic = detectedTopic;
  const refreshPlan = buildPanelRefreshPlan(state);
  state.panelData = {
    ...(state.panelData || makeInitialPanelData(state.goals)),
    goals: state.goals.map((goal) => ({ ...goal })),
    offerTerms: { ...state.offerTerms },
    watchouts: buildWatchouts(state.transcript[state.transcript.length - 1] || null),
    generatedAt: new Date().toISOString()
  };
  await persistTabState(tabId);
  sendStateToTab(tabId, state);

  const now = Date.now();
  if (state.coachEnabled && !state.generating && refreshPlan.shouldRefresh && (refreshPlan.topicChanged || now - state.lastAdviceAt >= UPDATE_MIN_INTERVAL_MS)) {
    await generateAdviceForTab(tabId, refreshPlan);
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
  state.lastCaptionAt = 0;
  state.marketCache = {};
  state.goals = state.goals.map((goal) => ({
    ...goal,
    status: "pending",
    note: ""
  }));
  state.panelData = makeInitialPanelData(state.goals);
  state.currentTopic = "general";
  state.statusText = "Transcript cleared.";

  await persistTabState(tabId);
  sendStateToTab(tabId, state);
  return buildSnapshot(state);
}

async function generateAdviceForTab(tabId, precomputedPlan = null) {
  const state = await getOrCreateTabState(tabId, "unknown");
  if (!state.sessionActive || !state.coachEnabled || !state.transcript.length || state.generating) {
    return;
  }
  if (!state.lastCaptionAt || Date.now() - state.lastCaptionAt > CAPTION_STALE_MS) {
    return;
  }
  const refreshPlan = precomputedPlan || buildPanelRefreshPlan(state);
  if (!refreshPlan.shouldRefresh) {
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
    const promptState = { ...state, currentTopic: refreshPlan.strategyTopic };
    const prompt = buildPrompt(promptState, settings.contextLibrary, refreshPlan.strategyTopic);
    const rawText = await callProvider(settings, prompt);
    const parsed = parseJsonFromModel(rawText);
    const panelData = normalizePanelData(parsed, promptState, settings.contextLibrary, refreshPlan);

    state.goals = panelData.goals.map((goal) => ({ ...goal }));
    state.offerTerms = { ...panelData.offerTerms };
    state.panelData = panelData;
    state.currentTopic = detectCurrentTopic(state.transcript, state.goals, state.offerTerms);
    if (refreshPlan.strategyShouldRefresh) {
      state.strategyTopic = refreshPlan.strategyTopic;
      state.lastStrategyTranscriptLength = state.transcript.length;
    }
    if (refreshPlan.marketShouldRefresh) {
      state.marketTopic = refreshPlan.marketTopic;
      state.lastMarketTranscriptLength = state.transcript.length;
    }
    state.lastAdviceAt = Date.now();
    state.statusText = `Updated ${new Date(state.lastAdviceAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    })}`;

    await persistTabState(tabId);
    sendStateToTab(tabId, state);
  } catch (error) {
    const fallbackPanel = buildHeuristicPanelData(
      { ...state, currentTopic: refreshPlan.strategyTopic },
      settings.contextLibrary,
      refreshPlan
    );
    state.goals = fallbackPanel.goals.map((goal) => ({ ...goal }));
    state.offerTerms = { ...fallbackPanel.offerTerms };
    state.panelData = fallbackPanel;
    state.currentTopic = detectCurrentTopic(state.transcript, state.goals, state.offerTerms);
    if (refreshPlan.strategyShouldRefresh) {
      state.strategyTopic = refreshPlan.strategyTopic;
      state.lastStrategyTranscriptLength = state.transcript.length;
    }
    if (refreshPlan.marketShouldRefresh) {
      state.marketTopic = refreshPlan.marketTopic;
      state.lastMarketTranscriptLength = state.transcript.length;
    }
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

function buildPrompt(state, libraryContext, strategyTopicOverride = "") {
  const transcriptText = state.transcript
    .slice(-MAX_LINES_PER_PROMPT)
    .map((line) => `[${new Date(line.at).toLocaleTimeString()}] ${line.speaker}: ${line.text}`)
    .join("\n");
  const currentTopic = normalizeShortText(strategyTopicOverride || state.currentTopic || "", 24) ||
    detectCurrentTopic(state.transcript, state.goals, state.offerTerms);

  const goalPayload = state.goals.map((goal) => ({
    id: goal.id,
    label: goal.label,
    target: goal.target,
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
      goal_targets: state.quickContext.goalTargets,
      legacy_priorities: state.quickContext.priorities,
      additional_context: state.quickContext.additionalContext
    },
    background_context: {
      previous_emails: trimForPrompt(libraryContext.previousEmails, 2400),
      previous_documents: trimForPrompt(libraryContext.previousDocs, 2400),
      personal_experience: trimForPrompt(libraryContext.personalExperience, 1800)
    },
    current_topic: currentTopic,
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
    '    "summary": "max 12 words",',
    '    "bullets": ["clear next move", "clear next move", "clear next move"]',
    "  },",
    '  "market_research": {',
    '    "headline": "bold numeric expectation or policy anchor",',
    '    "bullets": ["market expectation for this topic", "how current discussion compares"]',
    "  },",
    '  "goals": [{"id": "goal-1", "status": "pending|discussed|active|done", "note": "short note"}],',
    '  "offer_terms": {',
    '    "base_salary": "short value",',
    '    "signing_bonus": "short value",',
    '    "equity": "short value",',
    '    "location": "short value",',
    '    "pto": "short value",',
    '    "team": "short value"',
    "  },",
    '  "watchouts": ["short warning", "short warning"]',
    "}",
    "",
    "Rules:",
    "- Keep all text minimal and easy to scan.",
    "- No paragraphs. Use fragments.",
    "- Strategy bullets must be concrete next moves, not observations or recaps.",
    "- Keep strategy bullets to 2-3 items.",
    "- Focus on how to close the gap between the current term and the user's target.",
    "- If a lever sounds fixed, stop re-confirming it and pivot to the next best tradeoff.",
    "- If the counterpart is a recruiter, prefer questions about band, flexibility, approvals, timeline, and tradeoffs.",
    "- Offer terms should stay unchanged if the transcript does not change them.",
    "- Use only the provided goal ids.",
    "- Mark a goal as discussed when it came up but the target or policy was not reached yet.",
    "- Mark a goal as active only for the current live topic.",
    "- Keep market numbers stable for the same topic within a meeting.",
    "- Use market_research for one stable numeric anchor and one topic-relevant comparison bullet.",
    "",
    "Data:",
    JSON.stringify(promptBody, null, 2)
  ].join("\n");
}

function normalizePanelData(raw, state, contextLibrary, refreshPlan = null) {
  const goalUpdates = Array.isArray(raw?.goals) ? raw.goals : [];
  const mergedOfferTerms = mergeOfferTerms(state.offerTerms, {});
  const draftGoals = state.goals.map((goal, index) => {
    const update =
      goalUpdates.find((item) => String(item?.id || "") === goal.id) ||
      goalUpdates[index] ||
      {};
    return {
      id: goal.id,
      label: goal.label,
      category: goal.category,
      target: goal.target,
      status: normalizeGoalStatus(update.status || goal.status),
      note: normalizeShortText(update.note || "", 80)
    };
  });
  const nextGoals = reconcileGoalsWithTranscript(draftGoals, state.transcript, mergedOfferTerms);
  const currentTopic = normalizeShortText(refreshPlan?.strategyTopic || state.currentTopic || "", 24) ||
    detectCurrentTopic(state.transcript, nextGoals, mergedOfferTerms);
  const activeGoal = pickActiveGoal(nextGoals, currentTopic);
  const strategyState = {
    ...state,
    offerTerms: mergedOfferTerms,
    goals: nextGoals,
    currentTopic
  };

  return {
    strategy:
      refreshPlan?.strategyShouldRefresh === false
        ? state.panelData?.strategy || makeInitialPanelData(nextGoals).strategy
        : buildStrategyPanel(strategyState, activeGoal, currentTopic),
    marketResearch:
      refreshPlan?.marketShouldRefresh === false
        ? state.panelData?.marketResearch || makeInitialPanelData(nextGoals).marketResearch
        : buildStableMarketResearch(
            { ...strategyState, currentTopic: refreshPlan?.marketTopic || currentTopic },
            contextLibrary,
            mergedOfferTerms,
            raw?.market_research || raw?.marketResearch || {},
            state.panelData?.marketResearch,
            refreshPlan?.marketTopic || currentTopic
          ),
    goals: nextGoals,
    offerTerms: mergedOfferTerms,
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
    location: "location",
    remote: "location",
    pto: "pto",
    team: "team"
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
      summary: "Start the session to unlock live guidance.",
      context: "",
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

function makeGoalsFromQuickSetup(quickContext) {
  const goalTargets = normalizeGoalTargets(quickContext?.goalTargets);
  const goals = [];
  const orderedCategories = ["baseSalary", "signingBonus", "equity", "location", "pto", "team"];

  orderedCategories.forEach((category) => {
    const targetValue = goalTargets[category];
    if (!targetValue) {
      return;
    }

    goals.push({
      id: `goal-${goals.length + 1}`,
      label: `${goalLabelForCategory(category)}: ${targetValue}`,
      category,
      target: targetValue,
      status: "pending",
      note: ""
    });
  });

  if (goals.length) {
    return goals;
  }

  return normalizePriorityList(quickContext?.priorities).map((label, index) => ({
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
    location: "--",
    pto: "--",
    team: "--"
  };
}

function defaultQuickSetup() {
  return {
    industry: "",
    roleTitle: "",
    company: "",
    counterpartRole: "Recruiter",
    counterpartNotes: "",
    goalTargets: defaultGoalTargets(),
    priorities: [],
    additionalContext: ""
  };
}

function defaultGoalTargets() {
  return {
    baseSalary: "150k",
    signingBonus: "20k",
    equity: "160k of RSUs over 4 years",
    location: "NY",
    pto: "Unlimited PTO",
    team: "ML Infra"
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
      marketCache: state.marketCache,
      currentTopic: state.currentTopic,
      strategyTopic: state.strategyTopic,
      marketTopic: state.marketTopic,
      lastStrategyTranscriptLength: state.lastStrategyTranscriptLength,
      lastMarketTranscriptLength: state.lastMarketTranscriptLength,
      lastAdviceAt: state.lastAdviceAt,
      lastCaptionAt: state.lastCaptionAt,
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
  const goals = Array.isArray(raw?.goals) && raw.goals.length ? raw.goals.map(normalizeGoalObject) : makeGoalsFromQuickSetup(quickContext);
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
    marketCache: normalizeMarketCache(raw?.marketCache),
    currentTopic: normalizeShortText(raw?.currentTopic || "", 24) || "general",
    strategyTopic: normalizeShortText(raw?.strategyTopic || "", 24) || "general",
    marketTopic: normalizeShortText(raw?.marketTopic || "", 24) || "general",
    lastStrategyTranscriptLength: Number(raw?.lastStrategyTranscriptLength || 0),
    lastMarketTranscriptLength: Number(raw?.lastMarketTranscriptLength || 0),
    lastAdviceAt: Number(raw?.lastAdviceAt || 0),
    lastCaptionAt: Number(raw?.lastCaptionAt || 0),
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
  state.goals = makeGoalsFromQuickSetup(state.quickContext);
  state.offerTerms = defaultOfferTerms();
  state.panelData = makeInitialPanelData(state.goals);
  state.marketCache = {};
  state.currentTopic = "general";
  state.strategyTopic = "general";
  state.marketTopic = "general";
  state.lastStrategyTranscriptLength = 0;
  state.lastMarketTranscriptLength = 0;
  state.lastAdviceAt = 0;
  state.lastCaptionAt = 0;
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
    counterpartRole: normalizeShortText(safe.counterpartRole || "Recruiter", 40) || "Recruiter",
    counterpartNotes: normalizeShortText(safe.counterpartNotes || "", 200),
    goalTargets: normalizeGoalTargets(safe.goalTargets || safe.goals || {}),
    priorities: normalizePriorityList(safe.priorities),
    additionalContext: normalizeShortText(safe.additionalContext || "", 350)
  };
}

function normalizeGoalTargets(rawTargets) {
  const safe = rawTargets || {};
  const normalized = defaultGoalTargets();

  for (const key of Object.keys(normalized)) {
    normalized[key] = normalizeShortText(safe[key] || "", 80);
  }

  return normalized;
}

function normalizeMarketCache(rawCache) {
  const cache = rawCache && typeof rawCache === "object" ? rawCache : {};
  const normalized = {};

  for (const [topic, value] of Object.entries(cache)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const headline = normalizeShortText(value.headline || "", 52);
    const expectation = normalizeShortText(value.expectation || "", 100);
    if (!headline && !expectation) {
      continue;
    }

    normalized[normalizeShortText(topic, 24) || "general"] = {
      headline,
      expectation
    };
  }

  return normalized;
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

  return cleaned.slice(0, 6);
}

function normalizeGoalObject(goal) {
  return {
    id: typeof goal?.id === "string" ? goal.id : `goal-${Math.random().toString(36).slice(2, 8)}`,
    label: normalizeShortText(goal?.label || "Goal", 80),
    category: normalizeShortText(goal?.category || classifyGoalLabel(goal?.label || ""), 24),
    target: normalizeShortText(goal?.target || extractGoalTargetFromLabel(goal?.label || ""), 80),
    status: normalizeGoalStatus(goal?.status || "pending"),
    note: normalizeShortText(goal?.note || "", 80)
  };
}

function normalizeGoalStatus(status) {
  if (status === "done" || status === "active" || status === "discussed") {
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

function buildHeuristicPanelData(state, contextLibrary, refreshPlan = null) {
  const extractedTerms = extractOfferTermsFromTranscript(state.transcript, state.offerTerms);
  const nextGoals = reconcileGoalsWithTranscript(state.goals, state.transcript, extractedTerms);
  const currentTopic = normalizeShortText(refreshPlan?.strategyTopic || state.currentTopic || "", 24) ||
    detectCurrentTopic(state.transcript, nextGoals, extractedTerms);
  const nextActiveGoal = pickActiveGoal(nextGoals, currentTopic);
  const strategyState = {
    ...state,
    offerTerms: extractedTerms,
    goals: nextGoals,
    currentTopic
  };

  return {
    strategy:
      refreshPlan?.strategyShouldRefresh === false
        ? state.panelData?.strategy || makeInitialPanelData(nextGoals).strategy
        : buildStrategyPanel(strategyState, nextActiveGoal, currentTopic),
    marketResearch:
      refreshPlan?.marketShouldRefresh === false
        ? state.panelData?.marketResearch || makeInitialPanelData(nextGoals).marketResearch
        : buildStableMarketResearch(
            { ...strategyState, currentTopic: refreshPlan?.marketTopic || currentTopic },
            contextLibrary,
            extractedTerms,
            {},
            state.panelData?.marketResearch,
            refreshPlan?.marketTopic || currentTopic
          ),
    goals: nextGoals,
    offerTerms: extractedTerms,
    watchouts: buildWatchouts(state.transcript[state.transcript.length - 1] || null),
    generatedAt: new Date().toISOString()
  };
}

function buildStrategyPanel(state, activeGoal, currentTopic) {
  return {
    label: buildStrategyLabel(currentTopic, activeGoal),
    summary: buildStrategySummary(state, activeGoal, currentTopic),
    context: buildStrategyContext(state),
    bullets: buildHeuristicBullets(state, activeGoal, currentTopic)
  };
}

function buildHeuristicBullets(state, activeGoal, currentTopic) {
  const bullets = [
    buildAskNextBullet(state, activeGoal, currentTopic),
    buildGapBridgeBullet(state, activeGoal, currentTopic),
    buildPivotBullet(state, activeGoal, currentTopic)
  ];
  return dedupeTextArray(bullets).slice(0, 3);
}

function buildStrategyLabel(currentTopic, activeGoal) {
  if (currentTopic && currentTopic !== "general") {
    return `${goalLabelForCategory(currentTopic)} next`;
  }
  if (activeGoal) {
    return "Move next";
  }
  return "Listen";
}

function buildStrategySummary(state, activeGoal, currentTopic) {
  const currentValue = getGoalCurrentValue(activeGoal, state.offerTerms);
  const target = normalizeShortText(activeGoal?.target || "", 42);

  if (currentValue && target && !didGoalReachTarget(activeGoal, currentValue)) {
    return `Close ${describeGap(activeGoal, currentValue) || "the gap"} before switching.`;
  }
  if (activeGoal?.target) {
    return `Push toward ${normalizeShortText(activeGoal.target, 42)} next.`;
  }
  if (currentTopic && currentTopic !== "general") {
    return `Advance ${goalLabelForCategory(currentTopic).toLowerCase()} now.`;
  }
  return "Use one concrete ask at a time.";
}

function buildAskNextBullet(state, activeGoal, currentTopic) {
  const recruiterAudience = isRecruiterAudience(state);
  const hardConstraint = isTopicHoldingFirm(state.transcript, currentTopic);

  if (currentTopic === "baseSalary") {
    if (hardConstraint) {
      return recruiterAudience
        ? "Ask: If base is capped, which approval path or alternate lever can close the gap?"
        : "Ask: If base is fixed, which comp lever can still move meaningfully?";
    }
    return recruiterAudience
      ? "Ask: What is the highest base you can approve for this level?"
      : "Ask: What flexibility is still left on base salary here?";
  }
  if (currentTopic === "signingBonus") {
    return "Ask: What sign-on range can you approve if base stays where it is?";
  }
  if (currentTopic === "equity") {
    return recruiterAudience
      ? "Ask: What equity range is normal for this level, and can this grant move up?"
      : "Ask: Can we improve the grant size before we trade on base?";
  }
  if (currentTopic === "location") {
    return "Ask: What location policy applies to this role, and who can approve an exception?";
  }
  if (currentTopic === "pto") {
    return "Ask: Is PTO fixed policy at this level, or is there any exception path?";
  }
  if (currentTopic === "team") {
    return "Ask: Which team and reporting line would be on the final offer?";
  }
  if (activeGoal) {
    return `Ask: Can we come back to ${normalizeShortText(activeGoal.label, 48)} before we wrap?`;
  }
  return recruiterAudience
    ? "Ask: Which part of the package can still move today?"
    : "Ask: Which package lever has the most room left right now?";
}

function buildGapBridgeBullet(state, activeGoal, currentTopic) {
  const currentValue = getGoalCurrentValue(activeGoal, state.offerTerms);
  const target = normalizeShortText(activeGoal?.target || "", 48);

  if (!activeGoal || !target) {
    return currentTopic === "general" ? "Keep the next ask on one unresolved lever only." : "";
  }

  if (!currentValue || isUnknownValue(currentValue)) {
    return `Anchor clearly at ${target} before you trade on another lever.`;
  }

  if (didGoalReachTarget(activeGoal, currentValue)) {
    return `That target looks covered at ${currentValue}. Move to the next open goal.`;
  }

  const gapText = describeGap(activeGoal, currentValue);
  if (gapText) {
    return `Bridge ${gapText}. Ask what gets you from ${currentValue} to ${target}.`;
  }

  return `Current term is ${currentValue}. Restate ${target} and ask how close they can get.`;
}

function buildPivotBullet(state, activeGoal, currentTopic) {
  const hardConstraint = isTopicHoldingFirm(state.transcript, currentTopic);
  if (hardConstraint) {
    if (currentTopic === "baseSalary" || currentTopic === "signingBonus" || currentTopic === "equity") {
      return "If they hold firm, trade one comp lever only. Do not reopen settled facts.";
    }
    return "If policy sounds fixed, confirm it once and move to the next strongest goal.";
  }

  if (activeGoal?.target) {
    return "Stay on this topic until they name a cap, policy, or approval owner.";
  }

  return "Do not trade two items away to win one.";
}

function buildHeuristicPaths(state, activeGoal, currentTopic) {
  const recruiterAudience = isRecruiterAudience(state);

  if (currentTopic === "baseSalary" || currentTopic === "equity" || currentTopic === "signingBonus") {
    return [
      {
        label: recruiterAudience ? "Push approvals" : "Hold one lever",
        tradeoff: recruiterAudience
          ? "If that lever is capped, ask which compensating lever can move."
          : "Keep pressure on the current compensation topic first."
      }
    ];
  }

  if (currentTopic === "location" || currentTopic === "team") {
    return [
      {
        label: "Clarify first",
        tradeoff: "Lock down expectations before you trade on comp."
      }
    ];
  }

  if (activeGoal) {
    return [{ label: "Move next", tradeoff: `Advance ${normalizeShortText(activeGoal.label, 30)} before switching topics.` }];
  }

  return [{ label: "Clarify", tradeoff: "Pick one package lever and make it explicit." }];
}

function buildHeuristicPhrasing(state, activeGoal, currentTopic) {
  const recruiterAudience = isRecruiterAudience(state);
  const goalCategory = currentTopic !== "general" ? currentTopic : classifyGoalLabel(activeGoal?.label || "");

  if (!activeGoal && goalCategory === "custom") {
    return recruiterAudience
      ? ["Which part of the package can still move on your side?", "What approvals would be needed to improve it?"]
      : ["Which package lever should we focus on next?", "Where is there still room to improve the offer?"];
  }

  if (goalCategory === "baseSalary") {
    return recruiterAudience
      ? ["What is the highest base you can get approved for this level?", "If base is capped, which lever can still move today?"]
      : ["Can we stay on base salary for a minute?", "What flexibility is left on base if we close this soon?"];
  }

  if (goalCategory === "equity") {
    return recruiterAudience
      ? ["What is the normal equity range for this level?", "If base is fixed, can the equity grant move meaningfully?"]
      : ["Can we go deeper on the equity piece?", "Is there room to improve the grant size here?"];
  }

  if (goalCategory === "signingBonus") {
    return ["If base is fixed, can sign-on bridge the gap?", "What sign-on range is realistic for this role?"];
  }

  if (goalCategory === "location") {
    return ["What is the actual location expectation for this role?", "Is remote or hybrid still an option for this team?"];
  }

  if (goalCategory === "pto") {
    return ["Is PTO fixed policy for this level?", "Is there any flexibility on time off in this offer?"];
  }

  if (goalCategory === "team") {
    return ["Which team would I actually be joining?", "How fixed is that team assignment right now?"];
  }

  return [
    `Can we spend a minute on ${normalizeShortText(activeGoal?.label || "that topic", 40)} specifically?`,
    recruiterAudience ? "What flexibility do you still have there today?" : "What room is left on that item?"
  ];
}

function goalLabelForCategory(category) {
  const labels = {
    baseSalary: "Base salary",
    signingBonus: "Signing bonus",
    equity: "Equity",
    location: "Location",
    pto: "PTO",
    team: "Team"
  };

  return labels[category] || "Goal";
}

function extractGoalTargetFromLabel(label) {
  const text = String(label || "");
  const parts = text.split(":");
  return parts.length > 1 ? normalizeShortText(parts.slice(1).join(":").trim(), 80) : "";
}

function pickActiveGoal(goals, currentTopic) {
  if (currentTopic && currentTopic !== "general") {
    const topicGoal = goals.find((goal) => normalizeGoalStatus(goal.status) !== "done" && classifyGoalLabel(goal.label) === currentTopic);
    if (topicGoal) {
      return topicGoal;
    }
  }

  return goals.find((goal) => normalizeGoalStatus(goal.status) !== "done") || goals[0] || null;
}

function detectCurrentTopic(transcript, goals, offerTerms) {
  const recentLines = transcript.slice(-16);

  for (let index = recentLines.length - 1; index >= 0; index -= 1) {
    const detected = detectTopicFromText(recentLines[index].text);
    if (detected !== "general") {
      return detected;
    }
  }

  const activeGoal = pickActiveGoal(goals || [], "general");
  if (activeGoal) {
    return classifyGoalLabel(activeGoal.label);
  }

  if (!isUnknownValue(offerTerms?.team || "")) {
    return "team";
  }

  return "general";
}

function detectTopicFromText(text) {
  const lowered = String(text || "").toLowerCase();

  if (/\b(signing|sign-on|bonus)\b/.test(lowered)) {
    return "signingBonus";
  }
  if (/\b(equity|rsu|rsus|stock|shares|options)\b/.test(lowered)) {
    return "equity";
  }
  if (/\b(location|remote|hybrid|onsite|on-site|office|relocation)\b/.test(lowered)) {
    return "location";
  }
  if (/\b(team|org|organization|group|manager|reporting line)\b/.test(lowered)) {
    return "team";
  }
  if (/\b(pto|vacation|time off|days off)\b/.test(lowered)) {
    return "pto";
  }
  if (/\b(base|salary|compensation|comp|cash|band)\b/.test(lowered)) {
    return "baseSalary";
  }

  return "general";
}

function isTopicHoldingFirm(transcript, currentTopic) {
  const recentText = transcript
    .slice(-8)
    .map((line) => String(line.text || "").toLowerCase())
    .join(" ");

  return /\b(policy|fixed|firm|capped|cap|final|best and final|no room|no flexibility|cannot|can't|unable|standard)\b/.test(
    recentText
  );
}

function getGoalCurrentValue(goal, offerTerms) {
  const category = normalizeShortText(goal?.category || classifyGoalLabel(goal?.label || ""), 24);
  const valueByCategory = {
    baseSalary: offerTerms?.baseSalary,
    signingBonus: offerTerms?.signingBonus,
    equity: offerTerms?.equity,
    location: offerTerms?.location,
    pto: offerTerms?.pto,
    team: offerTerms?.team
  };

  return normalizeShortText(valueByCategory[category] || "", 48);
}

function didGoalReachTarget(goal, currentValue) {
  const target = normalizeShortText(goal?.target || "", 80);
  if (!target || !currentValue || isUnknownValue(currentValue)) {
    return false;
  }

  const category = normalizeShortText(goal?.category || classifyGoalLabel(goal?.label || ""), 24);
  if (category === "baseSalary" || category === "signingBonus" || category === "equity") {
    const targetAmount = parseMoneyAmount(target);
    const currentAmount = parseMoneyAmount(currentValue);
    if (targetAmount !== null && currentAmount !== null) {
      return currentAmount >= targetAmount;
    }
  }

  if (category === "pto") {
    const targetDays = parsePtoDays(target);
    const currentDays = parsePtoDays(currentValue);
    if (targetDays !== null && currentDays !== null) {
      return currentDays >= targetDays;
    }
  }

  const normalizedTarget = normalizeComparableText(target);
  const normalizedCurrent = normalizeComparableText(currentValue);
  return Boolean(normalizedTarget && normalizedCurrent) &&
    (normalizedCurrent.includes(normalizedTarget) || normalizedTarget.includes(normalizedCurrent));
}

function describeGap(goal, currentValue) {
  const target = normalizeShortText(goal?.target || "", 80);
  const category = normalizeShortText(goal?.category || classifyGoalLabel(goal?.label || ""), 24);

  if (!target || !currentValue || isUnknownValue(currentValue)) {
    return "";
  }

  if (category === "baseSalary" || category === "signingBonus" || category === "equity") {
    const targetAmount = parseMoneyAmount(target);
    const currentAmount = parseMoneyAmount(currentValue);
    if (targetAmount !== null && currentAmount !== null && targetAmount > currentAmount) {
      return `${formatCompactMoney(targetAmount - currentAmount)} gap`;
    }
  }

  if (category === "pto") {
    const targetDays = parsePtoDays(target);
    const currentDays = parsePtoDays(currentValue);
    if (targetDays !== null && currentDays !== null && targetDays > currentDays && Number.isFinite(targetDays)) {
      return `${targetDays - currentDays} day gap`;
    }
  }

  return `${currentValue} vs ${target}`;
}

function parseMoneyAmount(value) {
  const match = String(value || "").match(/\$?\s*([\d,.]+)\s*([kKmM])?/);
  if (!match) {
    return null;
  }

  const numeric = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const suffix = (match[2] || "").toLowerCase();
  if (suffix === "m") {
    return numeric * 1000000;
  }
  if (suffix === "k") {
    return numeric * 1000;
  }
  if (numeric < 1000) {
    return numeric * 1000;
  }
  return numeric;
}

function parsePtoDays(value) {
  const lower = String(value || "").toLowerCase();
  if (!lower) {
    return null;
  }
  if (lower.includes("unlimited")) {
    return Number.POSITIVE_INFINITY;
  }

  const match = lower.match(/(\d+(?:\.\d+)?)\s*(day|days|week|weeks)/);
  if (!match) {
    return null;
  }

  const numeric = Number.parseFloat(match[1]);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return /week/.test(match[2]) ? numeric * 5 : numeric;
}

function normalizeComparableText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\bnyc\b/g, "new york")
    .replace(/\bny\b/g, "new york")
    .replace(/\bon-site\b/g, "onsite")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function formatCompactMoney(amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return "";
  }

  if (amount >= 1000) {
    const thousands = amount / 1000;
    const rounded = Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1).replace(/\.0$/, "");
    return `$${rounded}k`;
  }

  return `$${Math.round(amount)}`;
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

function buildPanelRefreshPlan(state) {
  const detectedTopic = normalizeShortText(state.currentTopic || "", 24) ||
    detectCurrentTopic(state.transcript, state.goals, state.offerTerms);
  const currentStrategyTopic = normalizeShortText(state.strategyTopic || "", 24) || detectedTopic || "general";
  const currentMarketTopic = normalizeShortText(state.marketTopic || "", 24) || currentStrategyTopic;
  const missingStrategy = !(state.panelData?.strategy?.bullets || []).length;
  const missingMarket = !normalizeShortText(state.panelData?.marketResearch?.headline || "", 52) &&
    !((state.panelData?.marketResearch?.bullets || []).length);
  const topicChanged = shouldSwitchDisplayedTopic(state.transcript, currentStrategyTopic, detectedTopic);
  const strategyTermChanged = didRelevantOfferTermChange(state.panelData?.offerTerms, state.offerTerms, currentStrategyTopic);
  const marketTermChanged = didRelevantOfferTermChange(state.panelData?.offerTerms, state.offerTerms, currentMarketTopic);
  const strategyProgressed = hasStrategyProgressSince(state, currentStrategyTopic);
  const initialTopic = detectedTopic && detectedTopic !== "general" ? detectedTopic : currentStrategyTopic;

  return {
    shouldRefresh: missingStrategy || missingMarket || topicChanged || strategyTermChanged || marketTermChanged || strategyProgressed,
    strategyShouldRefresh: missingStrategy || topicChanged || strategyTermChanged || strategyProgressed,
    marketShouldRefresh: missingMarket || topicChanged || marketTermChanged,
    topicChanged,
    strategyTopic: topicChanged ? detectedTopic : (missingStrategy ? initialTopic : currentStrategyTopic),
    marketTopic: topicChanged ? detectedTopic : (missingMarket ? initialTopic : currentMarketTopic)
  };
}

function shouldSwitchDisplayedTopic(transcript, currentTopic, detectedTopic) {
  if (!detectedTopic || detectedTopic === "general" || detectedTopic === currentTopic) {
    return false;
  }

  const recentTopics = transcript
    .slice(-6)
    .map((line) => detectTopicFromText(line.text))
    .filter((topic) => topic !== "general");

  if (!recentTopics.length) {
    return false;
  }

  return recentTopics.filter((topic) => topic === detectedTopic).length >= 2 && recentTopics.slice(-3).includes(detectedTopic);
}

function hasStrategyProgressSince(state, topic) {
  const sinceIndex = Math.max(0, Number(state.lastStrategyTranscriptLength || 0));
  const newLines = state.transcript.slice(sinceIndex);
  if (newLines.length < 3) {
    return false;
  }

  return hasTopicProgressSignal(newLines, topic);
}

function hasTopicProgressSignal(lines, topic) {
  const text = lines.map((line) => String(line.text || "").toLowerCase()).join(" ");

  if (topic === "baseSalary" || topic === "signingBonus" || topic === "equity") {
    return /\$[\d,.]+|\b(band|range|approve|approval|cap|capped|final|offer|package|can do|could do|would be|will be|highest|flexibility)\b/.test(
      text
    );
  }
  if (topic === "location") {
    return /\b(location|based|office|policy|remote|hybrid|onsite|on-site|sf|san francisco|new york|nyc|relocation)\b/.test(text);
  }
  if (topic === "team") {
    return /\b(team|org|group|joining|distributed|infra|platform|core|would be|will be)\b/.test(text);
  }
  if (topic === "pto") {
    return /\b(pto|vacation|time off|unlimited|days|weeks|policy)\b/.test(text);
  }

  return lines.length >= 6 && /\b(offer|package|approval|policy|team|location|salary|equity|bonus)\b/.test(text);
}

function didRelevantOfferTermChange(previousTerms, nextTerms, topic) {
  const previous = previousTerms || {};
  const next = nextTerms || {};
  const field = getOfferFieldForTopic(topic);

  if (field) {
    const previousValue = normalizeShortText(previous[field] || "", 48);
    const nextValue = normalizeShortText(next[field] || "", 48);
    return nextValue && !isUnknownValue(nextValue) && previousValue !== nextValue;
  }

  return ["baseSalary", "signingBonus", "equity", "location", "pto", "team"].some((key) => {
    const previousValue = normalizeShortText(previous[key] || "", 48);
    const nextValue = normalizeShortText(next[key] || "", 48);
    return nextValue && !isUnknownValue(nextValue) && previousValue !== nextValue;
  });
}

function getOfferFieldForTopic(topic) {
  const mapping = {
    baseSalary: "baseSalary",
    signingBonus: "signingBonus",
    equity: "equity",
    location: "location",
    pto: "pto",
    team: "team"
  };

  return mapping[topic] || "";
}

function reconcileGoalsWithTranscript(goals, transcript, offerTerms) {
  const currentTopic = detectCurrentTopic(transcript, goals, offerTerms);
  return goals.map((goal) => {
    const coverage = assessGoalCoverage(goal, transcript, offerTerms, currentTopic);
    if (goal.status === "done" || coverage.status === "done") {
      return {
        ...goal,
        status: "done",
        note: normalizeShortText(coverage.note || goal.note || "Covered in call", 80)
      };
    }
    if (coverage.status === "active") {
      return {
        ...goal,
        status: "active",
        note: normalizeShortText(coverage.note || goal.note || "", 80)
      };
    }
    if (coverage.status === "discussed") {
      return {
        ...goal,
        status: "discussed",
        note: normalizeShortText(coverage.note || goal.note || "", 80)
      };
    }
    return {
      ...goal,
      status: "pending",
      note: ""
    };
  });
}

function assessGoalCoverage(goal, transcript, offerTerms, currentTopic) {
  const signal = getGoalSignal(goal.label);
  const termCoverage = getOfferTermCoverage(goal, signal.category, offerTerms);
  if (termCoverage.status === "done") {
    return termCoverage;
  }

  const recentTranscript = transcript.slice(-80);
  const liveTranscript = transcript.slice(-14);
  const mentionedLine = recentTranscript.find((line) => matchesGoalLine(line.text, signal));
  const liveMatch = liveTranscript.find((line) => matchesGoalLine(line.text, signal));
  if (signal.category !== "custom" && currentTopic === signal.category && (liveMatch || termCoverage.status === "discussed")) {
    return {
      status: "active",
      note: normalizeShortText(
        termCoverage.note || `Live topic with ${normalizeShortText((liveMatch || mentionedLine)?.speaker || "them", 22)}`,
        80
      )
    };
  }
  if (termCoverage.status === "discussed") {
    return {
      status: "discussed",
      note: termCoverage.note
    };
  }
  if (mentionedLine) {
    return {
      status: liveMatch ? "active" : "discussed",
      note: `${liveMatch ? "Live with" : "Discussed with"} ${normalizeShortText(mentionedLine.speaker, 22)}`
    };
  }

  return { status: "pending", note: "" };
}

function getGoalSignal(goalLabel) {
  const lowered = normalizeShortText(goalLabel, 80).toLowerCase();
  const keywords = lowered
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !GOAL_STOP_WORDS.has(word));

  if (/(salary|base|compensation|cash|pay|band)/.test(lowered)) {
    return {
      category: "baseSalary",
      patterns: [/\bsalary\b/, /\bbase\b/, /\bcompensation\b/, /\bcomp\b/, /\bcash\b/, /\bband\b/],
      keywords
    };
  }

  if (/(equity|rsu|stock|shares|options)/.test(lowered)) {
    return {
      category: "equity",
      patterns: [/\bequity\b/, /\brsu\b/, /\brsus\b/, /\bstock\b/, /\bshares\b/, /\boptions\b/],
      keywords
    };
  }

  if (/(bonus|signing|sign-on)/.test(lowered)) {
    return {
      category: "signingBonus",
      patterns: [/\bbonus\b/, /\bsigning\b/, /\bsign-on\b/, /\bsignon\b/],
      keywords
    };
  }

  if (/(location|remote|hybrid|onsite|on-site|relocation|office)/.test(lowered)) {
    return {
      category: "location",
      patterns: [/\blocation\b/, /\bremote\b/, /\bhybrid\b/, /\bonsite\b/, /\bon-site\b/, /\boffice\b/, /\brelocation\b/],
      keywords
    };
  }

  if (/(pto|vacation|time off|days off)/.test(lowered)) {
    return {
      category: "pto",
      patterns: [/\bpto\b/, /\bvacation\b/, /\btime off\b/, /\bdays off\b/],
      keywords
    };
  }

  if (/(team|org|organization|group|manager|reporting line)/.test(lowered)) {
    return {
      category: "team",
      patterns: [/\bteam\b/, /\borg\b/, /\borganization\b/, /\bgroup\b/, /\bmanager\b/, /\breporting line\b/],
      keywords
    };
  }

  return {
    category: "custom",
    patterns: [],
    keywords
  };
}

function classifyGoalLabel(goalLabel) {
  return getGoalSignal(goalLabel).category;
}

function matchesGoalLine(text, signal) {
  const lowered = String(text || "").toLowerCase();

  if (signal.patterns.some((pattern) => pattern.test(lowered))) {
    return true;
  }

  if (!signal.keywords.length) {
    return false;
  }

  const matchedKeywordCount = signal.keywords.filter((keyword) => lowered.includes(keyword)).length;
  const threshold = signal.keywords.length <= 2 ? signal.keywords.length : 2;
  return matchedKeywordCount >= threshold;
}

function getOfferTermCoverage(goal, goalCategory, offerTerms) {
  const valueByCategory = {
    baseSalary: offerTerms.baseSalary,
    signingBonus: offerTerms.signingBonus,
    equity: offerTerms.equity,
    location: offerTerms.location,
    pto: offerTerms.pto,
    team: offerTerms.team
  };

  const value = normalizeShortText(valueByCategory[goalCategory] || "", 40);
  if (value && !isUnknownValue(value)) {
    return {
      status: didGoalReachTarget(goal, value) ? "done" : "discussed",
      note: `${didGoalReachTarget(goal, value) ? "On table" : "Current"}: ${value}`
    };
  }

  return {
    status: "pending",
    note: ""
  };
}

function buildStrategyContext(state) {
  if (!state.quickContext.additionalContext) {
    return "";
  }
  return normalizeShortText(state.quickContext.additionalContext, 110);
}

function buildStrategyQuestions(state, activeGoal, suggestedQuestions) {
  const normalizedSuggested = normalizeStringArray(suggestedQuestions, 2, 96).map(ensureQuestionText);
  const fallbackQuestions = buildHeuristicPhrasing(state, activeGoal, classifyGoalLabel(activeGoal?.label || "")).map(ensureQuestionText);
  const merged = dedupeTextArray([...normalizedSuggested, ...fallbackQuestions]);
  return merged.slice(0, 2);
}

function ensureQuestionText(text) {
  const normalized = normalizeShortText(text, 96).replace(/[.!]+$/, "");
  if (!normalized) {
    return "";
  }
  return normalized.endsWith("?") ? normalized : `${normalized}?`;
}

function dedupeTextArray(items) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const normalized = normalizeShortText(item, 110);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function isRecruiterAudience(state) {
  return /recruiter/i.test(state.quickContext.counterpartRole || "");
}

function buildStableMarketResearch(state, contextLibrary, offerTerms, rawMarketResearch, previousMarketResearch, topicOverride = "") {
  const anchors = extractContextAnchors(state, contextLibrary);
  const topic = normalizeShortText(topicOverride || state.currentTopic || "", 24) ||
    detectCurrentTopic(state.transcript, state.goals, offerTerms);
  const topicKey = normalizeShortText(topic || "general", 24) || "general";
  const cached = state.marketCache?.[topicKey] || {};
  const modelHeadline = normalizeShortText(rawMarketResearch?.headline || "", 52);
  const modelBullets = normalizeStringArray(rawMarketResearch?.bullets, 2, 100);

  let headline = cached.headline || modelHeadline || buildStableMarketHeadline(state, anchors, topic, offerTerms);
  let expectation = cached.expectation || modelBullets[0] || buildTopicExpectationBullet(topic, state, anchors);

  if (!cached.headline && !cached.expectation && (modelHeadline || modelBullets[0])) {
    state.marketCache = {
      ...(state.marketCache || {}),
      [topicKey]: {
        headline,
        expectation
      }
    };
  }

  if (!headline) {
    headline = normalizeShortText(previousMarketResearch?.headline || "", 52) || "Market anchor";
  }

  return {
    headline,
    bullets: dedupeTextArray([
      expectation,
      modelBullets[1] || buildOfferGapMarketBullet(topic, state, offerTerms, anchors)
    ]).slice(0, 2)
  };
}

function extractContextAnchors(state, contextLibrary) {
  const sources = [
    state.quickContext.additionalContext,
    contextLibrary.previousEmails,
    contextLibrary.previousDocs
  ].filter(Boolean);

  const anchors = {
    salary: "",
    equity: ""
  };

  for (const source of sources) {
    if (!anchors.salary) {
      const salaryMatch = source.match(/\$[\d,.]+\s?[kK]?/);
      if (salaryMatch) {
        anchors.salary = normalizeShortText(salaryMatch[0].replace(/\s+/g, ""), 24);
      }
    }

    if (!anchors.equity && /(rsu|equity|stock|shares)/i.test(source)) {
      const equityMatch = source.match(/\$[\d,.]+\s?[kK]?|\d[\d,.]*\s?(rsus|shares)/i);
      if (equityMatch) {
        anchors.equity = normalizeShortText(equityMatch[0], 24);
      }
    }
  }

  return anchors;
}

function buildStableMarketHeadline(state, anchors, topic, offerTerms) {
  if (topic === "baseSalary" && anchors.salary) {
    return `${anchors.salary} base anchor`;
  }
  if (topic === "equity" && anchors.equity) {
    return `${anchors.equity} equity anchor`;
  }
  if (topic === "signingBonus") {
    return normalizeShortText(state.quickContext.goalTargets?.signingBonus || offerTerms.signingBonus || "Sign-on range", 52);
  }
  if (topic === "location") {
    return normalizeShortText(state.quickContext.goalTargets?.location || offerTerms.location || "Location policy", 52);
  }
  if (topic === "pto") {
    return normalizeShortText(state.quickContext.goalTargets?.pto || offerTerms.pto || "PTO policy", 52);
  }
  if (topic === "team") {
    return normalizeShortText(state.quickContext.goalTargets?.team || offerTerms.team || "Team placement", 52);
  }
  if (anchors.salary) {
    return `${anchors.salary} comp anchor`;
  }
  if (state.quickContext.roleTitle) {
    return `${normalizeShortText(state.quickContext.roleTitle, 22)} market`;
  }
  if (state.quickContext.industry) {
    return `${normalizeShortText(state.quickContext.industry, 22)} market`;
  }
  return "Market anchor";
}

function buildTopicExpectationBullet(topic, state, anchors) {
  if (topic === "baseSalary") {
    return anchors.salary
      ? `Expected base should center around ${anchors.salary} for this conversation context.`
      : `Expected base should match ${normalizeShortText(state.quickContext.roleTitle || "this level", 28)} in ${normalizeShortText(state.quickContext.industry || "this industry", 28)}.`;
  }
  if (topic === "signingBonus") {
    return "Expected sign-on usually depends on band limits and close risk, not title alone.";
  }
  if (topic === "equity") {
    return anchors.equity
      ? `Expected equity should be measured against ${anchors.equity} style grants.`
      : "Expected equity should line up with level, refresh cadence, and growth profile.";
  }
  if (topic === "location") {
    return "Location expectations should reflect office cadence, exception policy, and relocation rules.";
  }
  if (topic === "pto") {
    return "PTO expectations should reflect level policy and any executive exception path.";
  }
  if (topic === "team") {
    return "Team expectations should match scope, org maturity, and manager fit.";
  }
  return "Expected package should match level, scope, and market context.";
}

function buildOfferGapMarketBullet(topic, state, offerTerms, anchors) {
  const activeGoal = pickActiveGoal(state.goals, topic);
  const currentValue = getGoalCurrentValue(activeGoal, offerTerms);
  const target = normalizeShortText(activeGoal?.target || "", 48);

  if (activeGoal && currentValue && !isUnknownValue(currentValue) && target && !didGoalReachTarget(activeGoal, currentValue)) {
    return `Current discussion is at ${currentValue}; your target is ${target}.`;
  }

  const topicOrder = {
    baseSalary: [
      ["baseSalary", anchors.salary ? `Base on table: ${offerTerms.baseSalary} against ${anchors.salary} anchor.` : `Current base discussed: ${offerTerms.baseSalary}.`],
      ["signingBonus", `Current sign-on discussed: ${offerTerms.signingBonus}.`],
      ["equity", `Current equity discussed: ${offerTerms.equity}.`]
    ],
    signingBonus: [
      ["signingBonus", `Current sign-on discussed: ${offerTerms.signingBonus}.`],
      ["baseSalary", anchors.salary ? `Base on table: ${offerTerms.baseSalary} against ${anchors.salary} anchor.` : `Current base discussed: ${offerTerms.baseSalary}.`]
    ],
    equity: [
      ["equity", `Current equity discussed: ${offerTerms.equity}.`],
      ["baseSalary", anchors.salary ? `Base on table: ${offerTerms.baseSalary} against ${anchors.salary} anchor.` : `Current base discussed: ${offerTerms.baseSalary}.`]
    ],
    location: [
      ["location", `Location discussed: ${offerTerms.location}.`],
      ["team", `Team discussed: ${offerTerms.team}.`]
    ],
    team: [
      ["team", `Team discussed: ${offerTerms.team}.`],
      ["location", `Location discussed: ${offerTerms.location}.`]
    ],
    pto: [["pto", `Current PTO discussed: ${offerTerms.pto}.`]]
  };

  const orderedCandidates = topicOrder[topic] || [
    ["baseSalary", anchors.salary ? `Base on table: ${offerTerms.baseSalary} against ${anchors.salary} anchor.` : `Current base discussed: ${offerTerms.baseSalary}.`],
    ["equity", `Current equity discussed: ${offerTerms.equity}.`],
    ["location", `Location discussed: ${offerTerms.location}.`],
    ["team", `Team discussed: ${offerTerms.team}.`]
  ];

  for (const [key, message] of orderedCandidates) {
    if (!isUnknownValue(offerTerms[key])) {
      return message;
    }
  }

  return "Market expectation is stable; use the latest conversation only to size the remaining gap.";
}

function extractOfferTermsFromTranscript(transcript, currentTerms) {
  const next = { ...defaultOfferTerms(), ...(currentTerms || {}) };
  const buckets = {
    baseSalary: new Map(),
    signingBonus: new Map(),
    equity: new Map(),
    location: new Map(),
    pto: new Map(),
    team: new Map()
  };

  transcript.slice(-140).forEach((line, index) => {
    const candidates = extractOfferTermCandidatesFromLine(line.text);
    candidates.forEach((candidate) => {
      addOfferCandidate(buckets[candidate.field], candidate.field, candidate.value, candidate.score, index);
    });
  });

  for (const field of Object.keys(buckets)) {
    const confirmed = pickConfirmedOfferCandidate(field, buckets[field], next[field]);
    if (confirmed) {
      next[field] = confirmed;
    }
  }

  return next;
}

function extractOfferTermCandidatesFromLine(text) {
  const original = normalizeShortText(text || "", 220);
  const lower = original.toLowerCase();
  if (!original || isQuestionLikeLine(lower)) {
    return [];
  }

  const confidence = getOfferLineConfidence(lower);
  const candidates = [];

  collectAmountCandidates(
    candidates,
    "baseSalary",
    original,
    confidence,
    [
      /\b(?:base(?: salary)?|salary|cash comp(?:ensation)?)\s*(?:would be|will be|is|at|of|around|about|to|=)?\s*\$?\s*([\d,.]+)\s*([kKmM])?\b/i,
      /\$?\s*([\d,.]+)\s*([kKmM])?\s*(?:base(?: salary)?|salary|cash comp(?:ensation)?)/i
    ]
  );
  collectAmountCandidates(
    candidates,
    "signingBonus",
    original,
    confidence,
    [
      /\b(?:sign(?:ing)?(?: |-)?bonus|sign(?: |-)?on)\s*(?:would be|will be|is|at|of|around|about|to|=)?\s*\$?\s*([\d,.]+)\s*([kKmM])?\b/i,
      /\$?\s*([\d,.]+)\s*([kKmM])?\s*(?:sign(?:ing)?(?: |-)?bonus|sign(?: |-)?on)/i
    ]
  );

  const equityMatch =
    original.match(/\b(?:equity|rsus?|stock|shares?)\s*(?:would be|will be|is|at|of|around|about|to|=)?\s*(\$?\s*[\d,.]+\s*[kKmM]?|\d[\d,.]*\s*(?:rsus|shares))/i) ||
    original.match(/(\$?\s*[\d,.]+\s*[kKmM]?|\d[\d,.]*\s*(?:rsus|shares))\s*(?:in\s+)?(?:equity|rsus?|stock|shares)/i);
  if (equityMatch) {
    candidates.push({
      field: "equity",
      value: normalizeEquityValue(equityMatch[1] || equityMatch[0], original),
      score: confidence + 1
    });
  }

  if (/\b(pto|vacation|time off)\b/i.test(original)) {
    const ptoMatch = original.match(/\b(unlimited(?:\s+pto)?|\d+\s*(?:days?|weeks?))\b/i);
    if (ptoMatch) {
      candidates.push({
        field: "pto",
        value: normalizePtoValue(ptoMatch[1]),
        score: confidence + 1
      });
    }
  }

  if (/\b(location|based|office|remote|hybrid|onsite|on-site|relocation|work from)\b/.test(lower)) {
    const locationCandidate = extractLocationCandidate(original, lower);
    if (locationCandidate) {
      candidates.push({
        field: "location",
        value: locationCandidate,
        score: confidence + 1
      });
    }
  }

  if (/\b(team|org|organization|group|joining|join)\b/.test(lower)) {
    const teamCandidate = extractTeamCandidate(original);
    if (teamCandidate) {
      candidates.push({
        field: "team",
        value: teamCandidate,
        score: confidence + 1
      });
    }
  }

  return candidates;
}

function collectAmountCandidates(candidates, field, text, confidence, patterns) {
  patterns.forEach((pattern) => {
    const match = text.match(pattern);
    if (!match) {
      return;
    }

    candidates.push({
      field,
      value: formatMoneyValue(match[1], match[2]),
      score: confidence + 1
    });
  });
}

function getOfferLineConfidence(lower) {
  let score = 1;

  if (/\b(offer|package|comes with|includes|approved|approval|we can do|could do|would be|will be|the role is|team is|location is|based in)\b/.test(lower)) {
    score += 2;
  } else if (/\b(can do|range|band|policy|highest|flexibility|for this role|for the role)\b/.test(lower)) {
    score += 1;
  }

  return score;
}

function isQuestionLikeLine(lower) {
  return /\?$/.test(lower) || /^(what|which|is|are|can|could|would|will|do|does|did|where|when|how)\b/.test(lower);
}

function addOfferCandidate(bucket, field, rawValue, score, index) {
  const value = normalizeOfferTermValue(field, rawValue);
  if (!value) {
    return;
  }

  const existing = bucket.get(value) || { score: 0, count: 0, lastSeen: -1 };
  existing.score += score;
  existing.count += 1;
  existing.lastSeen = index;
  bucket.set(value, existing);
}

function pickConfirmedOfferCandidate(field, bucket, currentValue) {
  const entries = [...bucket.entries()]
    .map(([value, meta]) => ({ value, ...meta }))
    .sort((left, right) => right.score - left.score || right.lastSeen - left.lastSeen || right.count - left.count);

  if (!entries.length) {
    return "";
  }

  const currentNormalized = normalizeOfferTermValue(field, currentValue);
  const best = entries[0];
  const second = entries[1];
  const threshold = field === "team" || field === "location" ? 4 : 3;

  if (currentNormalized && best.value === currentNormalized) {
    return currentValue;
  }
  if (best.score < threshold) {
    return currentValue;
  }
  if (second && best.value !== currentNormalized && best.score <= second.score) {
    return currentValue;
  }

  return best.value;
}

function normalizeOfferTermValue(field, value) {
  const text = normalizeShortText(value || "", 60);
  if (!text || isUnknownValue(text)) {
    return "";
  }

  if (field === "baseSalary" || field === "signingBonus") {
    const parsed = parseMoneyAmount(text);
    return parsed !== null ? formatCompactMoney(parsed) : normalizeShortText(text, 24);
  }

  if (field === "equity") {
    return normalizeEquityValue(text, text);
  }

  if (field === "location") {
    const lower = text.toLowerCase();
    if (/\bsan francisco\b|\bsf\b|\bbay area\b/.test(lower)) {
      return "SF";
    }
    if (/\bnew york\b|\bnyc\b|\bny\b/.test(lower)) {
      return "NY";
    }
    if (/\bremote\b/.test(lower)) {
      return "Remote";
    }
    if (/\bhybrid\b/.test(lower)) {
      return "Hybrid";
    }
    if (/\bon-?site\b/.test(lower)) {
      return "On-site";
    }
    return titleCaseValue(text);
  }

  if (field === "pto") {
    return normalizePtoValue(text);
  }

  if (field === "team") {
    return normalizeTeamValue(text);
  }

  return text;
}

function normalizeEquityValue(value, lineText) {
  const compact = normalizeShortText(String(value || "").replace(/\s+/g, " "), 36);
  const lowerLine = String(lineText || "").toLowerCase();
  const parsedMoney = parseMoneyAmount(compact);

  if (parsedMoney !== null && /\brsu|rsus|equity|stock|shares\b/.test(lowerLine)) {
    if (/\brsu|rsus\b/.test(lowerLine)) {
      return `${formatCompactMoney(parsedMoney)} RSUs`;
    }
    return `${formatCompactMoney(parsedMoney)} equity`;
  }

  return compact.replace(/\bRsus\b/, "RSUs");
}

function normalizePtoValue(value) {
  const lower = String(value || "").toLowerCase();
  if (lower.includes("unlimited")) {
    return "Unlimited PTO";
  }
  const match = lower.match(/(\d+\s*(?:days?|weeks?))/);
  return match ? titleCaseValue(match[1]) : titleCaseValue(value);
}

function extractLocationCandidate(text, lower) {
  const cityMatch =
    text.match(/\b(?:based in|location is|role is in|office is in|working from|work from|located in)\s+(san francisco|sf|bay area|new york|nyc|seattle|austin|boston|chicago|los angeles)\b/i) ||
    text.match(/\b(?:san francisco|sf|bay area|new york|nyc|seattle|austin|boston|chicago|los angeles)\b/i);

  if (cityMatch) {
    return normalizeOfferTermValue("location", cityMatch[1] || cityMatch[0]);
  }
  if (/\bremote\b/.test(lower)) {
    return "Remote";
  }
  if (/\bhybrid\b/.test(lower)) {
    return "Hybrid";
  }
  if (/\bon-?site\b/.test(lower)) {
    return "On-site";
  }
  return "";
}

function extractTeamCandidate(text) {
  const teamMatch =
    text.match(/(?:join|joining|on|within)\s+(?:the\s+)?([A-Za-z][A-Za-z/& -]{2,40})\s+(?:team|org|group)\b/i) ||
    text.match(/(?:team|org|group)\s+(?:would be|will be|is)\s+([A-Za-z][A-Za-z/& -]{2,40})\b/i);

  if (!teamMatch) {
    return "";
  }

  return normalizeTeamValue(teamMatch[1]);
}

function normalizeTeamValue(value) {
  const cleaned = normalizeShortText(String(value || ""), 32)
    .replace(/\bcourt distributed\b/i, "Core Distributed")
    .replace(/\bml infrastructure\b/i, "ML Infra");
  const lower = cleaned.toLowerCase();

  if (!cleaned || /\b(hr|recruiter|manager|hiring manager|director|exec)\b/.test(lower)) {
    return "";
  }

  return titleCaseValue(cleaned).replace(/\bMl\b/g, "ML").replace(/\bInfra\b/g, "Infra");
}

function titleCaseValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bSf\b/g, "SF")
    .replace(/\bNy\b/g, "NY")
    .replace(/\bRsus\b/g, "RSUs")
    .trim();
}

function formatMoneyValue(numberPart, suffixPart) {
  const parsed = parseMoneyAmount(`${numberPart}${suffixPart || ""}`);
  return parsed !== null ? formatCompactMoney(parsed) : "";
}
