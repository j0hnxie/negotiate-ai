const ids = {
  apiKey: document.getElementById("apiKey"),
  goals: document.getElementById("goals"),
  counterpartProfile: document.getElementById("counterpartProfile"),
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
  const data = await chrome.storage.local.get(["openaiApiKey", "negotiationContext"]);
  const context = data.negotiationContext || {};

  ids.apiKey.value = data.openaiApiKey || "";
  ids.goals.value = context.goals || "";
  ids.counterpartProfile.value = context.counterpartProfile || "";
  ids.previousEmails.value = context.previousEmails || "";
  ids.previousDocs.value = context.previousDocs || "";
  ids.personalExperience.value = context.personalExperience || "";
}

async function saveSettings() {
  const payload = {
    openaiApiKey: ids.apiKey.value.trim(),
    negotiationContext: {
      goals: ids.goals.value.trim(),
      counterpartProfile: ids.counterpartProfile.value.trim(),
      previousEmails: ids.previousEmails.value.trim(),
      previousDocs: ids.previousDocs.value.trim(),
      personalExperience: ids.personalExperience.value.trim()
    }
  };

  await chrome.storage.local.set(payload);
  ids.status.textContent = "Saved";
  setTimeout(() => {
    ids.status.textContent = "";
  }, 1500);
}

function bindFileImport(inputEl, textareaEl) {
  inputEl.addEventListener("change", async () => {
    const file = inputEl.files?.[0];
    if (!file) {
      return;
    }

    const text = await file.text();
    const existing = textareaEl.value.trim();
    textareaEl.value = existing ? `${existing}\n\n---\n${text.trim()}` : text.trim();
    inputEl.value = "";
  });
}

ids.saveBtn.addEventListener("click", saveSettings);
bindFileImport(ids.emailsFile, ids.previousEmails);
bindFileImport(ids.docsFile, ids.previousDocs);
bindFileImport(ids.experienceFile, ids.personalExperience);

loadSettings();
