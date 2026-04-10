let currentMeetingId = getCurrentMeetingId();
const MEETING_CONTEXT_LOADING_TEXT = "Loading meeting context...";
const counterpartOptions = [
  "Recruiter",
  "HR Manager",
  "Hiring Manager",
  "Technical Lead",
  "VP / Director",
  "Founder / Exec"
];

const uiState = {
  provider: {
    label: "OpenAI",
    ready: false,
    model: ""
  },
  snapshot: {
    sessionActive: false,
    coachEnabled: true,
    totalCaptured: 0,
    quickContext: null,
    panelData: null,
    statusText: "Loading..."
  },
  joined: false,
  setupOpen: false,
  setupDismissed: false,
  recentCaptions: []
};

const transcriptCache = new Set();
let priorityKeySeed = 0;
let priorityDraft = [];
let lastCaptureAt = 0;
let bootstrapVersion = 0;

const dom = createInterface();
bindStaticEvents();
void bootstrap();

const observer = new MutationObserver(() => {
  harvestCaptions();
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}

setInterval(syncMeetingStage, 1200);
setInterval(harvestCaptions, 1800);
setInterval(updateCaptionHealth, 5000);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "STATE_UPDATE") {
    applySnapshot(message.snapshot);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "OPEN_SETUP") {
    fillSetupForm(uiState.snapshot.quickContext || defaultQuickSetup());
    uiState.setupDismissed = false;
    openSetupModal(true);
    sendResponse({ ok: true });
  }
});

async function bootstrap() {
  const meetingId = getCurrentMeetingId();
  currentMeetingId = meetingId;
  const version = (bootstrapVersion += 1);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_BOOTSTRAP",
      meetingId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to load NegotiateAI.");
    }

    if (version !== bootstrapVersion || meetingId !== currentMeetingId) {
      return;
    }

    uiState.provider = response.provider;
    applySnapshot(response.snapshot);
  } catch (error) {
    if (version !== bootstrapVersion || meetingId !== currentMeetingId) {
      return;
    }

    fillSetupForm(defaultQuickSetup());
    setMetaStatus(normalizeText(error.message, 120));
  } finally {
    if (version === bootstrapVersion && meetingId === currentMeetingId) {
      syncMeetingStage();
    }
  }
}

function createInterface() {
  const style = document.createElement("style");
  style.textContent = `
    #nai-root {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      color: #eef2ff;
      font-family: "Avenir Next", "Segoe UI Variable", "Helvetica Neue", sans-serif;
    }

    #nai-root *,
    #nai-root *::before,
    #nai-root *::after {
      box-sizing: border-box;
    }

    #nai-setup-backdrop {
      position: absolute;
      inset: 0;
      background:
        radial-gradient(circle at 18% 38%, rgba(111, 86, 255, 0.15), transparent 12%),
        radial-gradient(circle at 52% 95%, rgba(255, 88, 88, 0.1), transparent 16%),
        rgba(2, 6, 23, 0.6);
      backdrop-filter: blur(6px);
      opacity: 0;
      visibility: hidden;
      transition: opacity 160ms ease;
    }

    #nai-setup-backdrop.nai-open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    #nai-setup-card {
      position: absolute;
      top: 50%;
      left: 50%;
      width: min(640px, calc(100vw - 36px));
      max-height: calc(100vh - 48px);
      overflow: auto;
      transform: translate(-50%, -47%);
      padding: 22px;
      border-radius: 24px;
      border: 1px solid rgba(129, 140, 248, 0.14);
      background: #151822;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
      opacity: 0;
      visibility: hidden;
      transition: opacity 180ms ease, transform 180ms ease;
      pointer-events: none;
    }

    #nai-setup-card.nai-open {
      opacity: 1;
      visibility: visible;
      transform: translate(-50%, -50%);
      pointer-events: auto;
    }

    #nai-brand-word {
      font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
      font-size: clamp(36px, 5vw, 48px);
      font-weight: 800;
      letter-spacing: 0.02em;
      background: linear-gradient(90deg, #21e7c5, #7e7dff);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }

    .nai-kicker {
      margin: 6px 0 18px;
      color: rgba(184, 192, 221, 0.6);
      font-size: 13px;
      line-height: 1.45;
    }

    .nai-grid {
      display: grid;
      gap: 14px;
    }

    .nai-grid-2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .nai-label {
      margin: 0 0 8px;
      color: rgba(148, 163, 184, 0.68);
      font-family: "SFMono-Regular", "Menlo", monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }

    .nai-input,
    .nai-textarea,
    .nai-priority-entry {
      width: 100%;
      border: 1px solid rgba(99, 102, 241, 0.16);
      border-radius: 14px;
      background: #1d2130;
      color: #eef2ff;
      padding: 13px 15px;
      font-size: 14px;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }

    .nai-input:focus,
    .nai-textarea:focus,
    .nai-priority-entry:focus {
      border-color: rgba(16, 242, 179, 0.65);
      box-shadow: 0 0 0 1px rgba(16, 242, 179, 0.24);
    }

    .nai-textarea {
      min-height: 78px;
      resize: vertical;
    }

    .nai-chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .nai-chip {
      border: 1px solid rgba(99, 102, 241, 0.16);
      border-radius: 999px;
      padding: 10px 14px;
      background: #202433;
      color: rgba(198, 205, 230, 0.66);
      font-size: 14px;
      cursor: pointer;
      transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
    }

    .nai-chip.nai-active {
      border-color: rgba(16, 242, 179, 0.5);
      background: rgba(7, 54, 47, 0.9);
      color: #22f0c2;
    }

    #nai-priority-list {
      display: grid;
      gap: 8px;
      margin-bottom: 10px;
    }

    .nai-priority-item {
      display: flex;
      align-items: center;
      gap: 12px;
      border: 1px solid rgba(99, 102, 241, 0.16);
      border-radius: 14px;
      background: #1d2130;
      padding: 12px 14px;
      cursor: grab;
    }

    .nai-priority-item.nai-dragging {
      opacity: 0.6;
    }

    .nai-priority-handle,
    .nai-priority-rank {
      color: rgba(148, 163, 184, 0.56);
      font-family: "SFMono-Regular", "Menlo", monospace;
      font-size: 11px;
      letter-spacing: 0.18em;
    }

    .nai-priority-rank {
      color: #7e7dff;
      font-weight: 700;
    }

    .nai-priority-text {
      flex: 1;
      color: #eef2ff;
      font-size: 14px;
    }

    .nai-priority-remove {
      border: 0;
      background: transparent;
      color: rgba(148, 163, 184, 0.4);
      font-size: 18px;
      cursor: pointer;
    }

    .nai-priority-composer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }

    .nai-add-btn,
    .nai-ghost-btn,
    .nai-start-btn,
    .nai-link-btn {
      border: 0;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease;
    }

    .nai-add-btn:hover,
    .nai-ghost-btn:hover,
    .nai-start-btn:hover,
    .nai-link-btn:hover {
      transform: translateY(-1px);
    }

    .nai-add-btn {
      width: 46px;
      border-radius: 14px;
      background: #262b3b;
      color: #ffffff;
      font-size: 24px;
    }

    .nai-footer-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 18px;
    }

    .nai-helper {
      color: rgba(184, 192, 221, 0.58);
      font-size: 12px;
      line-height: 1.4;
    }

    .nai-start-btn {
      min-width: 208px;
      border-radius: 16px;
      background: linear-gradient(90deg, #12d8a2, #69efb1);
      color: #041019;
      font-size: 15px;
      font-weight: 800;
      padding: 14px 18px;
      text-align: center;
    }

    .nai-start-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
    }

    .nai-ghost-btn {
      background: transparent;
      color: rgba(184, 192, 221, 0.72);
      font-size: 13px;
      padding: 0;
    }

    .nai-link-btn {
      background: transparent;
      color: #22f0c2;
      font-size: 13px;
      padding: 0;
    }

    #nai-captions-panel,
    #nai-rail {
      position: absolute;
      pointer-events: auto;
    }

    #nai-captions-panel {
      top: 96px;
      left: 14px;
      width: min(250px, calc(100vw - 28px));
    }

    #nai-rail {
      top: 8px;
      bottom: 8px;
      right: 14px;
      width: min(292px, calc(100vw - 28px));
    }

    #nai-panel {
      height: 100%;
      max-height: 100%;
      overflow: auto;
    }

    .nai-sidecard {
      border: 1px solid rgba(99, 102, 241, 0.12);
      border-radius: 18px;
      overflow: hidden;
      background: rgba(10, 13, 22, 0.92);
      box-shadow: 0 18px 36px rgba(0, 0, 0, 0.28);
    }

    #nai-collapsed {
      display: none;
      width: 100%;
      border: 1px solid rgba(99, 102, 241, 0.12);
      border-radius: 16px;
      padding: 12px 14px;
      background: rgba(10, 13, 22, 0.92);
      color: rgba(184, 192, 221, 0.72);
      cursor: pointer;
      text-align: left;
    }

    #nai-collapsed strong {
      color: rgba(238, 242, 255, 0.96);
      margin-right: 8px;
    }

    .nai-panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 12px 11px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .nai-panel-brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .nai-logo-mark {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #22e9c5, #7e7dff);
      color: #051019;
      font-size: 12px;
      font-weight: 900;
    }

    .nai-panel-brand strong {
      display: block;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.03em;
    }

    .nai-live-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #12d8a2;
      font-size: 9px;
      font-family: "SFMono-Regular", "Menlo", monospace;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }

    .nai-live-tag::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: currentColor;
    }

    .nai-toggle-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      color: rgba(184, 192, 221, 0.72);
      font-size: 11px;
    }

    .nai-toggle {
      position: relative;
      width: 40px;
      height: 24px;
      border-radius: 999px;
      background: #1f2432;
      border: 1px solid rgba(99, 102, 241, 0.14);
      cursor: pointer;
    }

    .nai-toggle input {
      display: none;
    }

    .nai-toggle span {
      position: absolute;
      inset: 2px auto 2px 2px;
      width: 18px;
      border-radius: 999px;
      background: #ffffff;
      transition: transform 140ms ease;
    }

    .nai-toggle input:checked + span {
      transform: translateX(16px);
    }

    .nai-toggle.nai-on {
      background: linear-gradient(90deg, #12d8a2, #14f5c0);
    }

    .nai-section {
      padding: 11px 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.04);
    }

    .nai-section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 9px;
      color: rgba(148, 163, 184, 0.62);
      font-family: "SFMono-Regular", "Menlo", monospace;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }

    .nai-progress {
      color: rgba(184, 192, 221, 0.82);
    }

    .nai-section-card {
      border: 1px solid rgba(99, 102, 241, 0.12);
      border-radius: 14px;
      background: #141925;
      padding: 11px;
    }

    .nai-strategy-card {
      border-color: rgba(94, 66, 255, 0.25);
      background: linear-gradient(180deg, rgba(33, 18, 60, 0.62), rgba(23, 20, 44, 0.9));
    }

    .nai-strategy-label,
    .nai-captions-empty {
      color: #7e7dff;
      font-family: "SFMono-Regular", "Menlo", monospace;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    .nai-strategy-summary {
      color: rgba(238, 242, 255, 0.96);
      font-size: 13px;
      line-height: 1.4;
      margin: 9px 0;
    }

    .nai-market-headline,
    .nai-headline {
      color: #ffb31d;
      font-size: 16px;
      font-weight: 800;
      line-height: 1.15;
    }

    .nai-list {
      display: grid;
      gap: 7px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .nai-list li {
      display: flex;
      gap: 8px;
      color: rgba(212, 219, 243, 0.82);
      font-size: 12px;
      line-height: 1.35;
    }

    .nai-list li::before {
      content: ">";
      color: #7e7dff;
      font-weight: 800;
    }

    .nai-market-list li::before {
      content: "•";
      color: #f6b21a;
    }

    .nai-path-list li::before {
      content: "+";
      color: #20efc4;
    }

    .nai-goal-list {
      display: grid;
      gap: 8px;
    }

    .nai-goal-item {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      gap: 9px;
      align-items: start;
      border: 1px solid rgba(99, 102, 241, 0.12);
      border-radius: 12px;
      background: #141925;
      padding: 10px;
    }

    .nai-goal-item.nai-done {
      border-color: rgba(16, 242, 179, 0.26);
      background: rgba(5, 44, 38, 0.62);
    }

    .nai-goal-item.nai-active {
      border-color: rgba(250, 204, 21, 0.28);
      background: rgba(56, 40, 7, 0.42);
    }

    .nai-goal-dot {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      border: 2px solid rgba(148, 163, 184, 0.5);
      margin-top: 1px;
    }

    .nai-goal-item.nai-done .nai-goal-dot {
      border-color: #20efc4;
      background: #20efc4;
      box-shadow: inset 0 0 0 3px rgba(5, 44, 38, 0.92);
    }

    .nai-goal-item.nai-active .nai-goal-dot {
      border-color: #f6b21a;
    }

    .nai-goal-label {
      color: rgba(238, 242, 255, 0.94);
      font-size: 13px;
      line-height: 1.3;
    }

    .nai-goal-note {
      margin-top: 3px;
      color: rgba(148, 163, 184, 0.74);
      font-size: 11px;
      line-height: 1.3;
    }

    .nai-terms-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .nai-term-card {
      border: 1px solid rgba(99, 102, 241, 0.12);
      border-radius: 12px;
      background: #141925;
      padding: 10px;
      min-height: 74px;
    }

    .nai-term-label {
      color: rgba(148, 163, 184, 0.62);
      font-family: "SFMono-Regular", "Menlo", monospace;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .nai-term-value {
      color: rgba(238, 242, 255, 0.96);
      font-size: 15px;
      font-weight: 800;
      line-height: 1.12;
    }

    .nai-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px 12px;
      color: rgba(148, 163, 184, 0.68);
      font-size: 11px;
      line-height: 1.3;
    }

    .nai-meta-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .nai-caption-list {
      display: grid;
      gap: 8px;
      max-height: 320px;
      overflow: auto;
    }

    .nai-caption-row {
      border: 1px solid rgba(99, 102, 241, 0.12);
      border-radius: 12px;
      background: #141925;
      padding: 9px 10px;
    }

    .nai-caption-speaker {
      color: #c9d3ff;
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .nai-caption-text {
      color: rgba(232, 237, 255, 0.92);
      font-size: 12px;
      line-height: 1.35;
    }

    @media (max-width: 980px) {
      #nai-captions-panel {
        left: 10px;
        width: min(220px, calc(50vw - 16px));
      }

      #nai-rail {
        right: 10px;
        width: min(268px, calc(50vw - 16px));
      }

      .nai-grid-2 {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 760px) {
      #nai-captions-panel {
        display: none !important;
      }

      #nai-rail {
        top: auto;
        bottom: 84px;
        left: 10px;
        right: 10px;
        width: auto;
      }

      #nai-setup-card {
        width: calc(100vw - 18px);
        padding: 18px;
      }
    }
  `;

  const root = document.createElement("div");
  root.id = "nai-root";
  root.innerHTML = `
    <div id="nai-setup-backdrop"></div>

    <section id="nai-setup-card" aria-label="NegotiateAI setup">
      <div id="nai-brand-word">NegotiateAI</div>
      <div class="nai-kicker">Quick context before the meeting. Keep it short.</div>

      <div class="nai-grid nai-grid-2">
        <div>
          <div class="nai-label">Your field / industry</div>
          <input id="nai-industry" class="nai-input" type="text" placeholder="Software engineering" />
        </div>
        <div>
          <div class="nai-label">Your role / title</div>
          <input id="nai-role-title" class="nai-input" type="text" placeholder="Senior engineer" />
        </div>
      </div>

      <div style="margin-top: 14px;">
        <div class="nai-label">Company you're negotiating with</div>
        <input id="nai-company" class="nai-input" type="text" placeholder="Databricks" />
      </div>

      <div style="margin-top: 16px;">
        <div class="nai-label">Who are you speaking with?</div>
        <div id="nai-counterpart-row" class="nai-chip-row"></div>
      </div>

      <div style="margin-top: 12px;">
        <input id="nai-counterpart-notes" class="nai-input" type="text" placeholder="Any notes, e.g. seems eager to close" />
      </div>

      <div style="margin-top: 16px;">
        <div class="nai-label">Your priorities</div>
        <div id="nai-priority-list"></div>
        <div class="nai-priority-composer">
          <input id="nai-priority-input" class="nai-priority-entry" type="text" placeholder="Add a priority and press +" />
          <button id="nai-priority-add" class="nai-add-btn" type="button">+</button>
        </div>
      </div>

      <div style="margin-top: 16px;">
        <div class="nai-label">Additional context</div>
        <textarea id="nai-additional-context" class="nai-textarea" placeholder="Competing offer, constraints, range, flexibility."></textarea>
      </div>

      <div class="nai-footer-row">
        <div>
          <div id="nai-setup-status" class="nai-helper"></div>
          <div style="margin-top: 5px;">
            <button id="nai-open-settings" class="nai-link-btn" type="button">Open API settings</button>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <button id="nai-hide-setup" class="nai-ghost-btn" type="button">Hide</button>
          <button id="nai-start-session" class="nai-start-btn" type="button">Start live session</button>
        </div>
      </div>
    </section>

    <aside id="nai-captions-panel">
      <div class="nai-sidecard">
        <div class="nai-panel-head">
          <div class="nai-panel-brand">
            <div class="nai-logo-mark">C</div>
            <div>
              <strong>Captions</strong>
              <div class="nai-live-tag">Live</div>
            </div>
          </div>
        </div>
        <section class="nai-section">
          <div id="nai-caption-list" class="nai-caption-list"></div>
          <div id="nai-captions-empty" class="nai-captions-empty">Waiting for captions</div>
        </section>
      </div>
    </aside>

    <aside id="nai-rail" aria-label="NegotiateAI panel">
      <button id="nai-collapsed" type="button"><strong>NegotiateAI</strong> paused - click to resume</button>
      <div id="nai-panel" class="nai-sidecard">
        <div class="nai-panel-head">
          <div class="nai-panel-brand">
            <div class="nai-logo-mark">N</div>
            <div>
              <strong>NegotiateAI</strong>
              <div class="nai-live-tag">Live</div>
            </div>
          </div>
          <div class="nai-toggle-wrap">
            <span id="nai-toggle-label">ON</span>
            <label id="nai-toggle-shell" class="nai-toggle nai-on">
              <input id="nai-live-toggle" type="checkbox" checked />
              <span></span>
            </label>
          </div>
        </div>

        <section class="nai-section">
          <div class="nai-section-head">Strategy</div>
          <div class="nai-section-card nai-strategy-card">
            <div id="nai-strategy-label" class="nai-strategy-label">Waiting</div>
            <div id="nai-strategy-summary" class="nai-strategy-summary">Join the call to start.</div>
            <ul id="nai-strategy-bullets" class="nai-list"></ul>
            <ul id="nai-strategy-paths" class="nai-list nai-path-list" style="margin-top: 8px;"></ul>
            <ul id="nai-phrasing-list" class="nai-list" style="margin-top: 8px;"></ul>
          </div>
        </section>

        <section class="nai-section" id="nai-market-section">
          <div class="nai-section-head">Market research</div>
          <div class="nai-section-card">
            <div id="nai-market-headline" class="nai-market-headline">Quick market view</div>
            <ul id="nai-market-list" class="nai-list nai-market-list" style="margin-top: 9px;"></ul>
          </div>
        </section>

        <section class="nai-section" id="nai-leverage-section">
          <div class="nai-section-head">Leverage</div>
          <div class="nai-section-card">
            <div id="nai-leverage-headline" class="nai-headline">--</div>
            <ul id="nai-leverage-bullets" class="nai-list" style="margin-top: 9px;"></ul>
          </div>
        </section>

        <section class="nai-section">
          <div class="nai-section-head">
            <span>Goals</span>
            <span id="nai-goal-progress" class="nai-progress">0 / 0</span>
          </div>
          <div id="nai-goal-list" class="nai-goal-list"></div>
        </section>

        <section class="nai-section">
          <div class="nai-section-head">Offer terms</div>
          <div id="nai-terms-grid" class="nai-terms-grid"></div>
        </section>

        <section class="nai-section" id="nai-watchouts-section">
          <div class="nai-section-head">Watchouts</div>
          <ul id="nai-watchouts" class="nai-list"></ul>
        </section>

        <div class="nai-meta">
          <div id="nai-meta-status">Waiting...</div>
          <div class="nai-meta-actions">
            <button id="nai-edit-session" class="nai-ghost-btn" type="button">Edit</button>
            <button id="nai-reset-session" class="nai-ghost-btn" type="button">Reset</button>
          </div>
        </div>
      </div>
    </aside>
  `;

  document.documentElement.appendChild(style);
  document.documentElement.appendChild(root);

  counterpartOptions.forEach((label) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "nai-chip";
    chip.dataset.value = label;
    chip.textContent = label;
    root.querySelector("#nai-counterpart-row").appendChild(chip);
  });

  return {
    root,
    setupBackdrop: root.querySelector("#nai-setup-backdrop"),
    setupCard: root.querySelector("#nai-setup-card"),
    captionsPanel: root.querySelector("#nai-captions-panel"),
    captionsList: root.querySelector("#nai-caption-list"),
    captionsEmpty: root.querySelector("#nai-captions-empty"),
    industry: root.querySelector("#nai-industry"),
    roleTitle: root.querySelector("#nai-role-title"),
    company: root.querySelector("#nai-company"),
    counterpartRow: root.querySelector("#nai-counterpart-row"),
    counterpartNotes: root.querySelector("#nai-counterpart-notes"),
    priorityList: root.querySelector("#nai-priority-list"),
    priorityInput: root.querySelector("#nai-priority-input"),
    priorityAdd: root.querySelector("#nai-priority-add"),
    additionalContext: root.querySelector("#nai-additional-context"),
    setupStatus: root.querySelector("#nai-setup-status"),
    startSession: root.querySelector("#nai-start-session"),
    hideSetup: root.querySelector("#nai-hide-setup"),
    openSettings: root.querySelector("#nai-open-settings"),
    rail: root.querySelector("#nai-rail"),
    collapsed: root.querySelector("#nai-collapsed"),
    panel: root.querySelector("#nai-panel"),
    toggleShell: root.querySelector("#nai-toggle-shell"),
    liveToggle: root.querySelector("#nai-live-toggle"),
    toggleLabel: root.querySelector("#nai-toggle-label"),
    strategyLabel: root.querySelector("#nai-strategy-label"),
    strategySummary: root.querySelector("#nai-strategy-summary"),
    strategyBullets: root.querySelector("#nai-strategy-bullets"),
    strategyPaths: root.querySelector("#nai-strategy-paths"),
    phrasingList: root.querySelector("#nai-phrasing-list"),
    marketSection: root.querySelector("#nai-market-section"),
    marketHeadline: root.querySelector("#nai-market-headline"),
    marketList: root.querySelector("#nai-market-list"),
    leverageSection: root.querySelector("#nai-leverage-section"),
    leverageHeadline: root.querySelector("#nai-leverage-headline"),
    leverageBullets: root.querySelector("#nai-leverage-bullets"),
    goalProgress: root.querySelector("#nai-goal-progress"),
    goalList: root.querySelector("#nai-goal-list"),
    termsGrid: root.querySelector("#nai-terms-grid"),
    watchoutsSection: root.querySelector("#nai-watchouts-section"),
    watchouts: root.querySelector("#nai-watchouts"),
    metaStatus: root.querySelector("#nai-meta-status"),
    editSession: root.querySelector("#nai-edit-session"),
    resetSession: root.querySelector("#nai-reset-session")
  };
}

function bindStaticEvents() {
  dom.counterpartRow.addEventListener("click", (event) => {
    const button = event.target.closest(".nai-chip");
    if (!button) {
      return;
    }

    for (const chip of dom.counterpartRow.querySelectorAll(".nai-chip")) {
      chip.classList.toggle("nai-active", chip === button);
    }
  });

  dom.priorityAdd.addEventListener("click", addPriorityFromInput);
  dom.priorityInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addPriorityFromInput();
    }
  });

  dom.startSession.addEventListener("click", async () => {
    const payload = collectSetupForm();
    dom.startSession.disabled = true;
    setSetupStatus("Starting session...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_SESSION",
        meetingId: currentMeetingId,
        payload,
        preserveTranscript: false
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not start the session.");
      }

      uiState.provider = response.provider;
      uiState.setupDismissed = false;
      applySnapshot(response.snapshot);
      closeSetupModal();
    } catch (error) {
      setSetupStatus(normalizeText(error.message, 120));
    } finally {
      dom.startSession.disabled = false;
    }
  });

  dom.hideSetup.addEventListener("click", () => {
    uiState.setupDismissed = true;
    closeSetupModal();
    setMetaStatus("Setup hidden. Use the extension popup to reopen it.");
  });

  dom.openSettings.addEventListener("click", () => {
    window.open(chrome.runtime.getURL("options.html"), "_blank", "noopener,noreferrer");
  });

  dom.liveToggle.addEventListener("change", async () => {
    await setCoachEnabled(dom.liveToggle.checked);
  });

  dom.collapsed.addEventListener("click", async () => {
    await setCoachEnabled(true);
  });

  dom.editSession.addEventListener("click", () => {
    fillSetupForm(uiState.snapshot.quickContext || defaultQuickSetup());
    uiState.setupDismissed = false;
    openSetupModal(true);
  });

  dom.resetSession.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: "RESET_TAB_TRANSCRIPT" });
    if (response?.ok) {
      transcriptCache.clear();
      uiState.recentCaptions = [];
      lastCaptureAt = 0;
      renderCaptions();
      applySnapshot(response.snapshot);
    }
  });
}

function syncMeetingStage() {
  const latestMeetingId = getCurrentMeetingId();
  if (latestMeetingId !== currentMeetingId) {
    handleMeetingLinkChange(latestMeetingId);
  }

  const joinedNow = isMeetingJoined();
  if (joinedNow === uiState.joined) {
    renderVisibility();
    return;
  }

  uiState.joined = joinedNow;

  if (!joinedNow) {
    closeSetupModal();
    setMetaStatus("Join the Google Meet call to start NegotiateAI.");
  } else if (!uiState.snapshot.sessionActive && !uiState.setupDismissed && uiState.snapshot.statusText !== MEETING_CONTEXT_LOADING_TEXT) {
    fillSetupForm(uiState.snapshot.quickContext || defaultQuickSetup());
    openSetupModal(false);
  }

  renderVisibility();
}

function isMeetingJoined() {
  const selectors = [
    'button[aria-label*="Leave call" i]',
    'button[aria-label*="End call" i]',
    'button[aria-label*="Hang up" i]',
    '[role="button"][aria-label*="Leave call" i]',
    '[role="button"][aria-label*="End call" i]',
    '[role="button"][aria-label*="Hang up" i]'
  ];

  return selectors.some((selector) => document.querySelector(selector));
}

async function setCoachEnabled(enabled) {
  const response = await chrome.runtime.sendMessage({
    type: "SET_COACH_ENABLED",
    enabled
  });

  if (response?.ok) {
    applySnapshot(response.snapshot);
  }
}

function applySnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  uiState.snapshot = snapshot;
  dom.liveToggle.checked = Boolean(snapshot.coachEnabled);
  dom.toggleShell.classList.toggle("nai-on", Boolean(snapshot.coachEnabled));
  dom.toggleLabel.textContent = snapshot.coachEnabled ? "ON" : "OFF";

  if (!snapshot.sessionActive || snapshot.statusText === "Transcript cleared." || snapshot.statusText === "New meeting detected. Add fresh context.") {
    transcriptCache.clear();
    uiState.recentCaptions = [];
    lastCaptureAt = 0;
    renderCaptions();
  }

  if (snapshot.quickContext && !uiState.setupOpen) {
    fillSetupForm(snapshot.quickContext);
  }

  if (uiState.joined && !snapshot.sessionActive && !uiState.setupDismissed && snapshot.statusText !== MEETING_CONTEXT_LOADING_TEXT) {
    openSetupModal(false);
  }

  renderPanel(snapshot.panelData);
  setMetaStatus(snapshot.statusText || "Listening...");
  renderVisibility();
}

function renderVisibility() {
  const showSetup = uiState.joined && uiState.setupOpen;
  const showSessionPanels = uiState.joined && uiState.snapshot.sessionActive;

  dom.setupBackdrop.classList.toggle("nai-open", showSetup);
  dom.setupCard.classList.toggle("nai-open", showSetup);
  dom.captionsPanel.style.display = showSessionPanels ? "block" : "none";
  dom.rail.style.display = showSessionPanels ? "block" : "none";

  if (!showSessionPanels) {
    dom.panel.style.display = "none";
    dom.collapsed.style.display = "none";
    return;
  }

  dom.panel.style.display = uiState.snapshot.coachEnabled ? "block" : "none";
  dom.collapsed.style.display = uiState.snapshot.coachEnabled ? "none" : "block";
}

function renderPanel(panelData) {
  const data = panelData || {};
  const strategy = data.strategy || {};
  const marketResearch = data.marketResearch || {};
  const leverage = data.leverage || {};
  const goals = Array.isArray(data.goals) ? data.goals : [];
  const terms = data.offerTerms || {};
  const watchouts = Array.isArray(data.watchouts) ? data.watchouts : [];

  dom.strategyLabel.textContent = normalizeText(strategy.label || "Waiting", 32);
  dom.strategySummary.textContent = normalizeText(strategy.summary || "Join the call to start.", 92);
  renderSimpleList(dom.strategyBullets, Array.isArray(strategy.bullets) ? strategy.bullets : []);
  renderSimpleList(
    dom.strategyPaths,
    Array.isArray(strategy.paths)
      ? strategy.paths.map((item) => {
          const label = normalizeText(item.label || "", 28);
          const tradeoff = normalizeText(item.tradeoff || "", 60);
          return tradeoff ? `${label} - ${tradeoff}` : label;
        })
      : []
  );
  renderSimpleList(dom.phrasingList, Array.isArray(strategy.phrasing) ? strategy.phrasing : []);

  dom.marketHeadline.textContent = normalizeText(marketResearch.headline || "Quick market view", 52);
  renderSimpleList(dom.marketList, Array.isArray(marketResearch.bullets) ? marketResearch.bullets : []);
  dom.marketSection.style.display =
    dom.marketList.childElementCount || (marketResearch.headline && marketResearch.headline !== "Quick market view") ? "block" : "none";

  dom.leverageHeadline.textContent = normalizeText(leverage.headline || "--", 40);
  renderSimpleList(dom.leverageBullets, Array.isArray(leverage.bullets) ? leverage.bullets : []);
  dom.leverageSection.style.display =
    (leverage.headline && leverage.headline !== "--") || dom.leverageBullets.childElementCount ? "block" : "none";

  const completed = goals.filter((goal) => goal.status === "done").length;
  dom.goalProgress.textContent = `${completed} / ${goals.length}`;
  dom.goalList.innerHTML = "";

  goals.forEach((goal) => {
    const item = document.createElement("div");
    item.className = `nai-goal-item nai-${goal.status || "pending"}`;

    const dot = document.createElement("div");
    dot.className = "nai-goal-dot";

    const copy = document.createElement("div");
    const label = document.createElement("div");
    label.className = "nai-goal-label";
    label.textContent = normalizeText(goal.label || "Goal", 72);
    copy.appendChild(label);

    if (goal.note) {
      const note = document.createElement("div");
      note.className = "nai-goal-note";
      note.textContent = normalizeText(goal.note, 72);
      copy.appendChild(note);
    }

    item.appendChild(dot);
    item.appendChild(copy);
    dom.goalList.appendChild(item);
  });

  const termCards = [
    ["Base salary", terms.baseSalary || "--"],
    ["Signing bonus", terms.signingBonus || "--"],
    ["Equity", terms.equity || "--"],
    ["Remote", terms.remote || "--"],
    ["PTO", terms.pto || "--"],
    ["Start date", terms.startDate || "--"]
  ];

  dom.termsGrid.innerHTML = "";
  termCards.forEach(([labelText, valueText]) => {
    const card = document.createElement("div");
    card.className = "nai-term-card";

    const label = document.createElement("div");
    label.className = "nai-term-label";
    label.textContent = labelText;

    const value = document.createElement("div");
    value.className = "nai-term-value";
    value.textContent = normalizeText(valueText, 36) || "--";

    card.appendChild(label);
    card.appendChild(value);
    dom.termsGrid.appendChild(card);
  });

  renderSimpleList(dom.watchouts, watchouts);
  dom.watchoutsSection.style.display = dom.watchouts.childElementCount ? "block" : "none";
}

function renderCaptions() {
  dom.captionsList.innerHTML = "";
  const recent = uiState.recentCaptions.slice(-8);

  recent.forEach((line) => {
    const row = document.createElement("div");
    row.className = "nai-caption-row";

    const speaker = document.createElement("div");
    speaker.className = "nai-caption-speaker";
    speaker.textContent = normalizeText(line.speaker || "Unknown", 24);

    const text = document.createElement("div");
    text.className = "nai-caption-text";
    text.textContent = normalizeText(line.text || "", 120);

    row.appendChild(speaker);
    row.appendChild(text);
    dom.captionsList.appendChild(row);
  });

  dom.captionsEmpty.style.display = recent.length ? "none" : "block";
}

function renderSimpleList(container, values) {
  const items = values
    .map((value) => normalizeText(String(value || ""), 90))
    .filter(Boolean);

  container.innerHTML = "";
  container.style.display = items.length ? "grid" : "none";

  items.forEach((value) => {
    const li = document.createElement("li");
    li.textContent = value;
    container.appendChild(li);
  });
}

function setMetaStatus(text) {
  dom.metaStatus.textContent = text;
}

function setSetupStatus(text) {
  const providerText = uiState.provider.ready
    ? `${uiState.provider.label} ready${uiState.provider.model ? ` - ${uiState.provider.model}` : ""}`
    : `${uiState.provider.label} key missing - open settings`;
  dom.setupStatus.textContent = `${providerText}. ${text}`;
}

function openSetupModal(isEdit) {
  if (!uiState.joined) {
    return;
  }

  uiState.setupOpen = true;
  dom.startSession.textContent = isEdit || uiState.snapshot.sessionActive ? "Update session" : "Start live session";
  setSetupStatus("Saved docs and notes from settings are applied automatically.");
  renderVisibility();
}

function closeSetupModal() {
  uiState.setupOpen = false;
  renderVisibility();
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

function fillSetupForm(data) {
  const safe = {
    ...defaultQuickSetup(),
    ...(data || {})
  };

  dom.industry.value = safe.industry || "";
  dom.roleTitle.value = safe.roleTitle || "";
  dom.company.value = safe.company || "";
  dom.counterpartNotes.value = safe.counterpartNotes || "";
  dom.additionalContext.value = safe.additionalContext || "";

  for (const chip of dom.counterpartRow.querySelectorAll(".nai-chip")) {
    chip.classList.toggle("nai-active", chip.dataset.value === safe.counterpartRole);
  }

  priorityDraft = (Array.isArray(safe.priorities) ? safe.priorities : defaultQuickSetup().priorities).map((label) => ({
    id: `priority-${priorityKeySeed += 1}`,
    label: normalizeText(label, 72)
  }));
  renderPriorityList();
}

function collectSetupForm() {
  const activeChip = dom.counterpartRow.querySelector(".nai-chip.nai-active");

  return {
    industry: dom.industry.value.trim(),
    roleTitle: dom.roleTitle.value.trim(),
    company: dom.company.value.trim(),
    counterpartRole: activeChip?.dataset.value || "Hiring Manager",
    counterpartNotes: dom.counterpartNotes.value.trim(),
    priorities: priorityDraft.map((item) => item.label).filter(Boolean),
    additionalContext: dom.additionalContext.value.trim()
  };
}

function addPriorityFromInput() {
  const value = normalizeText(dom.priorityInput.value, 72);
  if (!value) {
    return;
  }

  priorityDraft.push({
    id: `priority-${priorityKeySeed += 1}`,
    label: value
  });
  dom.priorityInput.value = "";
  renderPriorityList();
}

function renderPriorityList() {
  dom.priorityList.innerHTML = "";

  priorityDraft.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "nai-priority-item";
    row.draggable = true;
    row.dataset.id = item.id;
    row.innerHTML = `
      <div class="nai-priority-handle">::</div>
      <div class="nai-priority-rank">#${index + 1}</div>
      <div class="nai-priority-text"></div>
      <button class="nai-priority-remove" type="button">x</button>
    `;

    row.querySelector(".nai-priority-text").textContent = item.label;
    row.querySelector(".nai-priority-remove").addEventListener("click", () => {
      priorityDraft = priorityDraft.filter((entry) => entry.id !== item.id);
      renderPriorityList();
    });

    row.addEventListener("dragstart", (event) => {
      row.classList.add("nai-dragging");
      event.dataTransfer.setData("text/plain", item.id);
    });

    row.addEventListener("dragend", () => {
      row.classList.remove("nai-dragging");
    });

    row.addEventListener("dragover", (event) => {
      event.preventDefault();
    });

    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const sourceId = event.dataTransfer.getData("text/plain");
      reorderPriority(sourceId, item.id);
    });

    dom.priorityList.appendChild(row);
  });
}

function reorderPriority(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) {
    return;
  }

  const sourceIndex = priorityDraft.findIndex((item) => item.id === sourceId);
  const targetIndex = priorityDraft.findIndex((item) => item.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return;
  }

  const [moved] = priorityDraft.splice(sourceIndex, 1);
  priorityDraft.splice(targetIndex, 0, moved);
  renderPriorityList();
}

function harvestCaptions() {
  if (!uiState.joined || !uiState.snapshot.sessionActive) {
    return;
  }

  const found = collectCaptionRows();

  const newLines = [];
  for (const [key, item] of found.entries()) {
    if (transcriptCache.has(key)) {
      continue;
    }

    transcriptCache.add(key);
    const line = {
      speaker: item.speaker,
      text: item.text,
      at: new Date().toISOString()
    };
    newLines.push(line);
    uiState.recentCaptions.push(line);
  }

  if (!newLines.length) {
    return;
  }

  uiState.recentCaptions = uiState.recentCaptions.slice(-8);
  renderCaptions();
  lastCaptureAt = Date.now();

  void chrome.runtime.sendMessage({
    type: "TRANSCRIPT_CHUNK",
    meetingId: currentMeetingId,
    lines: newLines
  });
}

function handleMeetingLinkChange(nextMeetingId) {
  currentMeetingId = nextMeetingId;
  bootstrapVersion += 1;
  transcriptCache.clear();
  uiState.recentCaptions = [];
  lastCaptureAt = 0;
  uiState.setupDismissed = false;
  uiState.setupOpen = false;
  uiState.snapshot = {
    ...uiState.snapshot,
    sessionActive: false,
    quickContext: null,
    statusText: MEETING_CONTEXT_LOADING_TEXT
  };
  renderCaptions();
  setMetaStatus(MEETING_CONTEXT_LOADING_TEXT);
  renderVisibility();
  void bootstrap();
}

function updateCaptionHealth() {
  if (!uiState.joined || !uiState.snapshot.sessionActive) {
    return;
  }

  const secondsSinceCapture = lastCaptureAt ? (Date.now() - lastCaptureAt) / 1000 : Infinity;
  if (secondsSinceCapture > 20) {
    setMetaStatus("No captions detected yet. Turn on Meet captions.");
  }
}

function collectCaptionRows() {
  const found = new Map();

  addRowsFromMeetBlocks(found);
  addRowsFromDataAttributes(found);
  addRowsFromAccessibilityRegions(found);
  addRowsFromCaptionLikeSelectors(found);

  return found;
}

function addRowsFromMeetBlocks(found) {
  for (const block of document.querySelectorAll("div.TBMuR")) {
    if (!isElementVisible(block)) {
      continue;
    }

    const speaker = normalizeCaptionSpeaker(block.querySelector(".ZTmjQb")?.textContent || "Unknown");
    for (const line of block.querySelectorAll(".iTTPOb")) {
      pushCaptionRow(found, speaker, line.textContent || "");
    }
  }
}

function addRowsFromDataAttributes(found) {
  for (const row of document.querySelectorAll("[data-sender-name][data-message-text]")) {
    pushCaptionRow(found, row.getAttribute("data-sender-name") || "Unknown", row.getAttribute("data-message-text") || "");
  }
}

function addRowsFromAccessibilityRegions(found) {
  const regions = document.querySelectorAll(
    '[aria-live="polite"], [aria-live="assertive"], [role="alert"], [role="status"], [role="log"]'
  );

  for (const region of regions) {
    if (!isElementVisible(region)) {
      continue;
    }

    for (const line of extractRowsFromTextBlock(region.innerText || "")) {
      pushCaptionRow(found, line.speaker, line.text);
    }
  }
}

function addRowsFromCaptionLikeSelectors(found) {
  const selectors = [
    '[class*="caption" i]',
    '[class*="subtitle" i]',
    '[class*="transcript" i]',
    '[data-panel-container-id*="caption" i]',
    '[aria-label*="caption" i]'
  ];

  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (!isElementVisible(node)) {
        continue;
      }

      for (const line of extractRowsFromTextBlock(node.innerText || "")) {
        pushCaptionRow(found, line.speaker, line.text);
      }
    }
  }
}

function extractRowsFromTextBlock(rawText) {
  const normalizedLines = String(rawText || "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => isLikelyCaptionText(line));

  const rows = [];
  for (const line of normalizedLines) {
    const parsed = parseCaptionLine(line);
    if (parsed) {
      rows.push(parsed);
    }
  }

  return rows;
}

function parseCaptionLine(line) {
  const colonMatch = line.match(/^([^:]{1,40}):\s+(.+)$/);
  if (colonMatch) {
    return {
      speaker: normalizeCaptionSpeaker(colonMatch[1]),
      text: normalizeCaptionText(colonMatch[2])
    };
  }

  const dashMatch = line.match(/^([^-\u2013\u2014]{1,40})\s+[\u2013\u2014-]\s+(.+)$/);
  if (dashMatch) {
    return {
      speaker: normalizeCaptionSpeaker(dashMatch[1]),
      text: normalizeCaptionText(dashMatch[2])
    };
  }

  return {
    speaker: "Unknown",
    text: normalizeCaptionText(line)
  };
}

function pushCaptionRow(found, speakerRaw, textRaw) {
  const speaker = normalizeCaptionSpeaker(speakerRaw || "Unknown");
  const text = normalizeCaptionText(textRaw || "");

  if (!isLikelyCaptionText(text)) {
    return;
  }

  const key = `${speaker}|${text}`;
  found.set(key, { speaker, text });
}

function normalizeCaptionSpeaker(value) {
  const cleaned = normalizeText(value || "Unknown", 36);
  if (!cleaned) {
    return "Unknown";
  }
  return cleaned;
}

function normalizeCaptionText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function isLikelyCaptionText(text) {
  const value = normalizeCaptionText(text);
  if (!value || value.length < 2) {
    return false;
  }

  const lower = value.toLowerCase();
  const blockedPhrases = [
    "waiting for captions",
    "captions",
    "turn on captions",
    "translated captions",
    "present now",
    "raise hand",
    "meeting details",
    "view all",
    "leave call",
    "end call",
    "hang up",
    "more options",
    "microphone",
    "camera",
    "share screen",
    "you are presenting",
    "chat with everyone"
  ];

  if (blockedPhrases.includes(lower)) {
    return false;
  }

  if (blockedPhrases.some((phrase) => lower.startsWith(phrase))) {
    return false;
  }

  const onlySymbols = /^[^a-zA-Z0-9]+$/.test(value);
  if (onlySymbols) {
    return false;
  }

  return true;
}

function isElementVisible(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
}

function normalizeText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getCurrentMeetingId() {
  const path = location.pathname.replace(/^\/+|\/+$/g, "");
  const segments = path.split("/").filter(Boolean);
  const explicitCode = [...segments].reverse().find((segment) => /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(segment));

  if (explicitCode) {
    return explicitCode.toLowerCase();
  }

  return (segments.join("/") || "unknown").toLowerCase();
}
