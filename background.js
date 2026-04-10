const tabState = new Map();

const ADVICE_MIN_INTERVAL_MS = 10000;
const MAX_TRANSCRIPT_LINES = 600;
const MAX_LINES_PER_PROMPT = 140;

const SYSTEM_PROMPT = [
  "You are a live negotiation strategy coach.",
  "You must provide tactical guidance and options, not a script to read verbatim.",
  "Prioritize practical moves, questions to ask, fallback paths, and risk warnings.",
  "Keep advice concise, structured, and immediately actionable.",
  "Output markdown with these sections:",
  "1) Situation Read",
  "2) Best Next Move",
  "3) Negotiation Paths (3 distinct options with tradeoffs)",
  "4) Questions To Ask Next (2-4)",
  "5) Risks / Watchouts"
].join("\n");

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["negotiationContext"]);
  if (!current.negotiationContext) {
    await chrome.storage.local.set({
      negotiationContext: {
        goals: "",
        counterpartProfile: "",
        previousEmails: "",
        previousDocs: "",
        personalExperience: ""
      }
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TRANSCRIPT_CHUNK") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "No sender tab." });
      return;
    }

    processTranscriptChunk(tabId, message.lines || [], message.meetingId || "unknown")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "RESET_TAB_TRANSCRIPT") {
    const tabId = sender.tab?.id;
    if (typeof tabId === "number") {
      const state = getOrCreateTabState(tabId, message.meetingId || "unknown");
      state.transcript = [];
      state.seen = new Set();
      state.lastAdviceAt = 0;
      sendStatusToTab(tabId, "Transcript cleared.");
    }
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "PING") {
    sendResponse({ ok: true, service: "background" });
  }
});

function getOrCreateTabState(tabId, meetingId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, {
      meetingId,
      transcript: [],
      seen: new Set(),
      lastAdviceAt: 0,
      generating: false
    });
  }

  const state = tabState.get(tabId);
  state.meetingId = meetingId || state.meetingId;
  return state;
}

async function processTranscriptChunk(tabId, lines, meetingId) {
  const state = getOrCreateTabState(tabId, meetingId);

  let added = 0;
  for (const line of lines) {
    const speaker = (line.speaker || "Unknown").trim();
    const text = (line.text || "").trim();
    const at = line.at || new Date().toISOString();

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

  const now = Date.now();
  const elapsed = now - state.lastAdviceAt;

  if (state.generating || elapsed < ADVICE_MIN_INTERVAL_MS) {
    return;
  }

  await generateAdviceForTab(tabId);
}

function buildContextText(context) {
  const safe = context || {};
  return [
    `Negotiation goals: ${safe.goals || "(none provided)"}`,
    `Counterpart profile: ${safe.counterpartProfile || "(none provided)"}`,
    `Previous emails: ${safe.previousEmails || "(none provided)"}`,
    `Previous documents: ${safe.previousDocs || "(none provided)"}`,
    `Personal experience: ${safe.personalExperience || "(none provided)"}`
  ].join("\n\n");
}

function buildTranscriptText(transcript) {
  const recent = transcript.slice(-MAX_LINES_PER_PROMPT);
  return recent
    .map((line) => {
      const time = new Date(line.at).toLocaleTimeString();
      return `[${time}] ${line.speaker}: ${line.text}`;
    })
    .join("\n");
}

async function generateAdviceForTab(tabId) {
  const state = tabState.get(tabId);
  if (!state || state.generating) {
    return;
  }

  const { openaiApiKey, negotiationContext } = await chrome.storage.local.get([
    "openaiApiKey",
    "negotiationContext"
  ]);

  if (!openaiApiKey) {
    sendStatusToTab(tabId, "Missing OpenAI API key. Add it in extension settings.");
    return;
  }

  if (!state.transcript.length) {
    return;
  }

  state.generating = true;
  sendStatusToTab(tabId, "Generating negotiation guidance...");

  const contextText = buildContextText(negotiationContext);
  const transcriptText = buildTranscriptText(state.transcript);

  const userPrompt = [
    `Meeting ID: ${state.meetingId}`,
    "",
    "Preloaded context:",
    contextText,
    "",
    "Live transcript (most recent portion):",
    transcriptText,
    "",
    "Task: Provide strategic coaching for the next 2-5 minutes of negotiation.",
    "Focus on choices and framing, not a script to read word-for-word."
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.6,
        max_output_tokens: 700,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: SYSTEM_PROMPT }]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: userPrompt }]
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const json = await response.json();
    const advice = extractResponseText(json);

    if (!advice) {
      throw new Error("OpenAI API returned an empty response.");
    }

    state.lastAdviceAt = Date.now();
    sendAdviceToTab(tabId, advice);
  } catch (error) {
    sendStatusToTab(tabId, `Advice update failed: ${error.message}`);
  } finally {
    state.generating = false;
  }
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const items = payload?.output || [];
  const parts = [];

  for (const item of items) {
    const content = item?.content || [];
    for (const block of content) {
      if (block?.type === "output_text" && block?.text) {
        parts.push(block.text);
      }
      if (block?.type === "text" && block?.text) {
        parts.push(block.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function sendAdviceToTab(tabId, advice) {
  chrome.tabs.sendMessage(
    tabId,
    {
      type: "ADVICE_UPDATE",
      advice,
      generatedAt: new Date().toISOString()
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function sendStatusToTab(tabId, status) {
  chrome.tabs.sendMessage(
    tabId,
    {
      type: "ADVICE_STATUS",
      status
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}
