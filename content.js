let coachEnabled = true;
const meetingId = location.pathname.replace(/^\//, "") || "unknown";

const transcriptCache = new Set();
let totalCaptured = 0;
let lastCaptureAt = 0;

const panel = createPanel();
setStatus("Waiting for live captions...");

const observer = new MutationObserver(() => {
  harvestCaptions();
});

observer.observe(document.body, { childList: true, subtree: true });
setInterval(harvestCaptions, 2000);
setInterval(updateCaptionHealth, 5000);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ADVICE_UPDATE") {
    renderAdvice(message.advice, message.generatedAt);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "ADVICE_STATUS") {
    setStatus(message.status || "Status update");
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "SET_COACH_ENABLED") {
    coachEnabled = Boolean(message.enabled);
    updateToggleUI();
    setStatus(coachEnabled ? "Coach resumed." : "Coach paused.");
    sendResponse({ ok: true, enabled: coachEnabled });
    return;
  }

  if (message?.type === "GET_COACH_STATE") {
    sendResponse({
      ok: true,
      enabled: coachEnabled,
      totalCaptured
    });
    return;
  }

  if (message?.type === "RESET_TRANSCRIPT") {
    transcriptCache.clear();
    totalCaptured = 0;
    updateCounters();
    chrome.runtime.sendMessage({ type: "RESET_TAB_TRANSCRIPT", meetingId });
    sendResponse({ ok: true });
  }
});

function createPanel() {
  const container = document.createElement("section");
  container.id = "negotiation-copilot-panel";
  container.innerHTML = `
    <header>
      <strong>Negotiation Copilot</strong>
      <button id="copilot-toggle" type="button">Pause</button>
    </header>
    <div id="copilot-meta">
      <span id="copilot-counters">Captured: 0 lines</span>
      <span id="copilot-status">Starting...</span>
    </div>
    <div id="copilot-advice">Advice will appear here as the call progresses.</div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #negotiation-copilot-panel {
      position: fixed;
      top: 88px;
      right: 20px;
      z-index: 2147483647;
      width: 360px;
      max-height: calc(100vh - 120px);
      border-radius: 14px;
      overflow: hidden;
      background: #0f172a;
      color: #e5e7eb;
      border: 1px solid #334155;
      box-shadow: 0 14px 30px rgba(2, 6, 23, 0.45);
      font: 13px/1.4 "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
    }

    #negotiation-copilot-panel header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid #334155;
      background: #111827;
    }

    #copilot-toggle {
      border: 1px solid #475569;
      background: #1e293b;
      color: #f8fafc;
      border-radius: 8px;
      padding: 5px 10px;
      cursor: pointer;
      font: inherit;
    }

    #copilot-meta {
      display: grid;
      gap: 2px;
      padding: 8px 12px;
      border-bottom: 1px solid #334155;
      color: #cbd5e1;
      font-size: 12px;
    }

    #copilot-advice {
      padding: 12px;
      overflow-y: auto;
      white-space: pre-wrap;
    }

    #copilot-advice h1,
    #copilot-advice h2,
    #copilot-advice h3,
    #copilot-advice h4,
    #copilot-advice p {
      margin: 0 0 8px;
    }

    #copilot-advice ul,
    #copilot-advice ol {
      margin: 0 0 8px 16px;
      padding: 0;
    }
  `;

  document.documentElement.appendChild(style);
  document.documentElement.appendChild(container);

  container.querySelector("#copilot-toggle").addEventListener("click", () => {
    coachEnabled = !coachEnabled;
    updateToggleUI();
    setStatus(coachEnabled ? "Coach resumed." : "Coach paused.");
  });

  updateToggleUI();
  return container;
}

function updateToggleUI() {
  const button = panel.querySelector("#copilot-toggle");
  if (!button) {
    return;
  }

  button.textContent = coachEnabled ? "Pause" : "Resume";
}

function updateCounters() {
  const counters = panel.querySelector("#copilot-counters");
  if (counters) {
    counters.textContent = `Captured: ${totalCaptured} lines`;
  }
}

function setStatus(text) {
  const status = panel.querySelector("#copilot-status");
  if (status) {
    status.textContent = text;
  }
}

function renderAdvice(markdown, generatedAtISO) {
  const adviceNode = panel.querySelector("#copilot-advice");
  if (!adviceNode) {
    return;
  }

  adviceNode.textContent = markdown;
  const generatedAt = new Date(generatedAtISO).toLocaleTimeString();
  setStatus(`Advice updated at ${generatedAt}`);
}

function updateCaptionHealth() {
  if (!coachEnabled) {
    return;
  }

  const secondsSinceCapture = (Date.now() - lastCaptureAt) / 1000;
  if (!lastCaptureAt || secondsSinceCapture > 20) {
    setStatus("No new captions detected. Turn on Meet captions to capture transcript.");
  }
}

function harvestCaptions() {
  if (!coachEnabled) {
    return;
  }

  const found = new Map();

  for (const block of document.querySelectorAll("div.TBMuR")) {
    const speaker = block.querySelector(".ZTmjQb")?.textContent?.trim() || "Unknown";
    for (const line of block.querySelectorAll(".iTTPOb")) {
      const text = line.textContent?.trim();
      if (!text) {
        continue;
      }
      found.set(`${speaker}|${text}`, { speaker, text });
    }
  }

  for (const row of document.querySelectorAll("[data-sender-name][data-message-text]")) {
    const speaker = row.getAttribute("data-sender-name") || "Unknown";
    const text = row.getAttribute("data-message-text") || "";
    if (text.trim()) {
      found.set(`${speaker}|${text.trim()}`, { speaker: speaker.trim(), text: text.trim() });
    }
  }

  const newLines = [];

  for (const [key, item] of found.entries()) {
    if (transcriptCache.has(key)) {
      continue;
    }
    transcriptCache.add(key);
    newLines.push({
      speaker: item.speaker,
      text: item.text,
      at: new Date().toISOString()
    });
  }

  if (!newLines.length) {
    return;
  }

  totalCaptured += newLines.length;
  lastCaptureAt = Date.now();
  updateCounters();
  setStatus("Capturing transcript and requesting guidance...");

  chrome.runtime.sendMessage({
    type: "TRANSCRIPT_CHUNK",
    meetingId,
    lines: newLines
  });
}
