const toggleBtn = document.getElementById("toggleBtn");
const resetBtn = document.getElementById("resetBtn");
const settingsBtn = document.getElementById("settingsBtn");
const statusNode = document.getElementById("status");
const blurb = document.getElementById("blurb");

let activeTabId = null;
let enabled = true;

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

toggleBtn.addEventListener("click", async () => {
  if (activeTabId === null) {
    return;
  }

  enabled = !enabled;
  await chrome.tabs.sendMessage(activeTabId, { type: "SET_COACH_ENABLED", enabled });
  render();
});

resetBtn.addEventListener("click", async () => {
  if (activeTabId === null) {
    return;
  }

  await chrome.tabs.sendMessage(activeTabId, { type: "RESET_TRANSCRIPT" });
  statusNode.textContent = "Transcript reset for current tab.";
});

async function init() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id || !activeTab.url || !activeTab.url.startsWith("https://meet.google.com/")) {
    blurb.textContent = "Navigate to a Google Meet tab, then reopen this popup.";
    return;
  }

  activeTabId = activeTab.id;

  try {
    const state = await chrome.tabs.sendMessage(activeTabId, { type: "GET_COACH_STATE" });
    enabled = Boolean(state?.enabled);
    statusNode.textContent = `Captured lines: ${state?.totalCaptured || 0}`;
    toggleBtn.disabled = false;
    resetBtn.disabled = false;
    render();
  } catch (_error) {
    blurb.textContent = "Reload the Meet tab to initialize the content script.";
  }
}

function render() {
  toggleBtn.textContent = enabled ? "Pause coach" : "Resume coach";
}

init();
