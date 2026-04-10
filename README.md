# NegotiateAI

NegotiateAI is a Chrome extension prototype for Google Meet that:

- shows a compact live negotiation rail on the right
- shows a compact live captions rail on the left
- captures Google Meet captions as the conversation happens
- sends rolling context to OpenAI or Claude
- renders short tactical guidance, market research, goal progress, and live offer terms

## What changed

- Rebranded the extension to `NegotiateAI`
- Added a centered quick-setup modal in Meet that matches the reference UI direction
- Replaced raw markdown advice with a structured panel:
  - strategy
  - market research
  - leverage
  - goal checklist
  - offer terms
  - watchouts
- Added provider selection for `OpenAI` or `Claude`
- Added a paused state that collapses the overlay into a small resume pill
- Added a left-side captions panel
- Changed the UI so it only appears after you actually join the call
- Reset per-meeting context when a new Meet link is opened

## Files

- [manifest.json](/Users/johnxie/Documents/College/594/594-final-project/manifest.json)
- [background.js](/Users/johnxie/Documents/College/594/594-final-project/background.js)
- [content.js](/Users/johnxie/Documents/College/594/594-final-project/content.js)
- [options.html](/Users/johnxie/Documents/College/594/594-final-project/options.html)
- [options.css](/Users/johnxie/Documents/College/594/594-final-project/options.css)
- [options.js](/Users/johnxie/Documents/College/594/594-final-project/options.js)
- [popup.html](/Users/johnxie/Documents/College/594/594-final-project/popup.html)
- [popup.js](/Users/johnxie/Documents/College/594/594-final-project/popup.js)

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:
   `/Users/johnxie/Documents/College/594/594-final-project`
5. Pin the extension if you want quick access from the Chrome toolbar.

## Configure the model provider

1. Open the extension settings page.
2. Choose one provider:
   - `OpenAI`
   - `Claude`
3. Add the matching API key.
4. Optionally change the model name.
5. Save settings.

Default prototype models:

- OpenAI: `gpt-5.4-mini`
- Claude: `claude-sonnet-4-20250514`

## Start a live session

1. Join a Google Meet call.
2. Turn on Google Meet captions.
3. After you are fully in the call, the `NegotiateAI` quick-setup modal will appear over Meet.
4. Enter the short context:
   - your field / industry
   - your title
   - company
   - who you are negotiating with
   - ranked priorities
   - any short extra context
5. Click `Start live session`.

After that, the live UI will show:

- a left captions panel with recent Meet captions
- a concise strategy card
- a market research panel
- short phrasing suggestions
- goal checklist progress
- live offer term cards
- watchouts

You can pause suggestions at any time from:

- the overlay toggle
- the extension popup

When paused, the strategy rail collapses into a small resume pill, while caption capture can continue locally.

If you join a different Google Meet link, NegotiateAI treats it as a new meeting and asks for fresh context again.

## Extra context you can preload

In settings you can optionally paste or import:

- previous email threads
- prior negotiation documents
- your personal negotiation notes

That background context is added automatically to the live prompt.

## What still needs to be done

This prototype is usable, but a production version still needs more work:

1. Move API calls off the client.
   Right now the browser extension sends transcript text directly to the provider API using the key stored in extension storage. That is acceptable for a prototype, but not the right security model for production.
2. Replace DOM-based caption scraping with a more robust transcription pipeline.
   The current implementation depends on Google Meet caption DOM selectors, so UI changes from Google can break transcript capture.
3. Add stronger structured extraction for compensation terms.
   The current term tracker is model-driven and conservative, but it should be backed by stronger validation if accuracy is critical.
4. Add consent, policy, and audit controls.
   If this is used in real meetings, you need explicit consent and policy review for transcription and AI assistance.

## Known limitations

- The extension listens through Google Meet captions, not raw audio.
- No captions means no transcript input.
- Provider responses are only as strong as the context and transcript quality.
- Join detection relies on Google Meet control labels, so unusual Meet UI variants may need selector updates.

## Provider references

- OpenAI Responses API: [platform.openai.com/docs/api-reference/responses/compact?api-mode=responses](https://platform.openai.com/docs/api-reference/responses/compact?api-mode=responses)
- OpenAI auth guidance: [platform.openai.com/docs/api-reference/authentication?api-mode=responses](https://platform.openai.com/docs/api-reference/authentication?api-mode=responses)
- Anthropic Messages API: [docs.anthropic.com/en/api/messages-examples](https://docs.anthropic.com/en/api/messages-examples)
- Anthropic API overview: [docs.anthropic.com/en/api/getting-started](https://docs.anthropic.com/en/api/getting-started)
