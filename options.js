const ids = {
  providerInputs: Array.from(document.querySelectorAll('input[name="provider"]')),
  openaiApiKey: document.getElementById("openaiApiKey"),
  openaiModel: document.getElementById("openaiModel"),
  anthropicApiKey: document.getElementById("anthropicApiKey"),
  anthropicModel: document.getElementById("anthropicModel"),
  previousEmails: document.getElementById("previousEmails"),
  previousDocs: document.getElementById("previousDocs"),
  personalExperience: document.getElementById("personalExperience"),
  emailsFile: document.getElementById("emailsFile"),
  docsFile: document.getElementById("docsFile"),
  experienceFile: document.getElementById("experienceFile"),
  saveBtn: document.getElementById("saveBtn"),
  status: document.getElementById("status")
};

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "provider",
    "openaiApiKey",
    "openaiModel",
    "anthropicApiKey",
    "anthropicModel",
    "contextLibrary"
  ]);

  const provider = data.provider || "openai";
  ids.providerInputs.forEach((input) => {
    input.checked = input.value === provider;
  });

  ids.openaiApiKey.value = data.openaiApiKey || "";
  ids.openaiModel.value = data.openaiModel || "gpt-5.4-mini";
  ids.anthropicApiKey.value = data.anthropicApiKey || "";
  ids.anthropicModel.value = data.anthropicModel || "claude-sonnet-4-20250514";
  ids.previousEmails.value = data.contextLibrary?.previousEmails || "";
  ids.previousDocs.value = data.contextLibrary?.previousDocs || "";
  ids.personalExperience.value = data.contextLibrary?.personalExperience || "";
}

async function saveSettings() {
  const provider = ids.providerInputs.find((input) => input.checked)?.value || "openai";

  await chrome.storage.local.set({
    provider,
    openaiApiKey: ids.openaiApiKey.value.trim(),
    openaiModel: ids.openaiModel.value.trim() || "gpt-5.4-mini",
    anthropicApiKey: ids.anthropicApiKey.value.trim(),
    anthropicModel: ids.anthropicModel.value.trim() || "claude-sonnet-4-20250514",
    contextLibrary: {
      previousEmails: ids.previousEmails.value.trim(),
      previousDocs: ids.previousDocs.value.trim(),
      personalExperience: ids.personalExperience.value.trim()
    }
  });

  ids.status.textContent = "Saved";
  window.setTimeout(() => {
    ids.status.textContent = "";
  }, 1600);
}

function bindFileImport(inputEl, textareaEl) {
  inputEl.addEventListener("change", async () => {
    const file = inputEl.files?.[0];
    if (!file) {
      return;
    }

    const text = (await file.text()).trim();
    if (!text) {
      inputEl.value = "";
      return;
    }

    textareaEl.value = textareaEl.value.trim() ? `${textareaEl.value.trim()}\n\n---\n${text}` : text;
    inputEl.value = "";
  });
}

ids.saveBtn.addEventListener("click", () => {
  void saveSettings();
});

bindFileImport(ids.emailsFile, ids.previousEmails);
bindFileImport(ids.docsFile, ids.previousDocs);
bindFileImport(ids.experienceFile, ids.personalExperience);

void loadSettings();
