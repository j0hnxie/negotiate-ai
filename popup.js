const setupBtn = document.getElementById("setupBtn");
const toggleBtn = document.getElementById("toggleBtn");
const resetBtn = document.getElementById("resetBtn");
const settingsBtn = document.getElementById("settingsBtn");
const sessionState = document.getElementById("sessionState");
const providerState = document.getElementById("providerState");
const detailState = document.getElementById("detailState");

let activeTabId = null;
let coachEnabled = true;

settingsBtn.addEventListener("click", () => {
  void chrome.tabs.create({
    url: chrome.runtime.getURL("options.html"),
    active: true
  });
});

setupBtn.addEventListener("click", async () => {
  if (activeTabId === null) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "OPEN_SETUP_IN_TAB",
    tabId: activeTabId
  });
});

toggleBtn.addEventListener("click", async () => {
  if (activeTabId === null) {
    return;
  }

  coachEnabled = !coachEnabled;
  await chrome.runtime.sendMessage({
    type: "SET_TAB_COACH_ENABLED",
    tabId: activeTabId,
    enabled: coachEnabled
  });
  renderToggle();
});

resetBtn.addEventListener("click", async () => {
  if (activeTabId === null) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "RESET_SESSION_FOR_TAB",
    tabId: activeTabId
  });
  detailState.textContent = "Transcript cleared for this Meet tab.";
});

async function init() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id || !activeTab.url || !activeTab.url.startsWith("https://meet.google.com/")) {
    sessionState.textContent = "No active Google Meet tab.";
    providerState.textContent = "Open Meet, then reopen this popup.";
    return;
  }

  activeTabId = activeTab.id;

  const response = await chrome.runtime.sendMessage({
    type: "GET_TAB_STATE",
    tabId: activeTabId
  });

  if (!response?.ok) {
    sessionState.textContent = "Could not load tab state.";
    providerState.textContent = response?.error || "";
    return;
  }

  const { provider, snapshot } = response;
  coachEnabled = Boolean(snapshot?.coachEnabled);

  sessionState.textContent = snapshot?.sessionActive ? "Live session ready." : "Quick setup not started.";
  providerState.textContent = provider.ready
    ? `${provider.label} ready - ${provider.model}`
    : `${provider.label} key missing`;
  detailState.textContent = snapshot?.sessionActive
    ? `${snapshot.totalCaptured || 0} transcript lines captured.`
    : "Open quick setup in Meet to define goals.";

  setupBtn.disabled = false;
  toggleBtn.disabled = !snapshot?.sessionActive;
  resetBtn.disabled = !snapshot?.sessionActive;
  renderToggle();
}

function renderToggle() {
  toggleBtn.textContent = coachEnabled ? "Pause suggestions" : "Resume suggestions";
}

void init();
