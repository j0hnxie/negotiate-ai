# NegotiateAI

NegotiateAI is a Chrome extension prototype for Google Meet. It watches live Meet captions, combines them with your negotiation context, sends that rolling state to OpenAI or Claude, and shows a compact in-call overlay with:

- negotiation strategy
- market research
- goal tracking
- live offer terms
- recent captions

This project is a prototype. It is useful for demos and local testing, but it is not production-hardened.

## What You Need

Before using the extension, make sure you have:

1. Google Chrome
2. A Google Meet call to test with
3. An API key for one provider:
   - OpenAI
   - Anthropic / Claude
4. Google Meet captions enabled during the call

Default models in this prototype:

- OpenAI: `gpt-5.4-mini`
- Claude: `claude-sonnet-4-20250514`

## Project Files

Main extension files:

- `/Users/johnxie/Documents/College/594/594-final-project/manifest.json`
- `/Users/johnxie/Documents/College/594/594-final-project/background.js`
- `/Users/johnxie/Documents/College/594/594-final-project/content.js`
- `/Users/johnxie/Documents/College/594/594-final-project/options.html`
- `/Users/johnxie/Documents/College/594/594-final-project/options.css`
- `/Users/johnxie/Documents/College/594/594-final-project/options.js`
- `/Users/johnxie/Documents/College/594/594-final-project/popup.html`
- `/Users/johnxie/Documents/College/594/594-final-project/popup.js`

## Install The Extension In Chrome

Follow these steps exactly:

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on `Developer mode` in the top-right.
4. Click `Load unpacked`.
5. Select this folder:
   `/Users/johnxie/Documents/College/594/594-final-project`
6. Confirm that the extension named `NegotiateAI` appears in the extensions list.
7. Click the pin icon in Chrome if you want quick access from the toolbar.

If you change the code later:

1. Go back to `chrome://extensions`
2. Click `Reload` on `NegotiateAI`
3. Refresh the Google Meet tab

## Configure API Access

NegotiateAI will not generate advice until you add an API key.

### Option 1: Open settings from Chrome extensions page

1. Open `chrome://extensions`
2. Find `NegotiateAI`
3. Click `Details`
4. Open the extension options page

### Option 2: Open settings from the extension itself

1. Click the NegotiateAI toolbar icon
2. Open the popup
3. Use the settings action

### In the settings page

1. Choose a provider:
   - `OpenAI`
   - `Claude`
2. Paste your API key
3. Leave the default model or enter a different model name
4. Click `Save`

Optional background context you can preload in settings:

- previous email threads
- previous negotiation documents
- your own notes or past experience

That saved context is automatically included when the extension generates live advice.

## First-Time Meeting Setup

When you join a Google Meet call for a new Meet link, the extension will show a setup popup.

Fill in the context briefly:

- your field / industry
- your title
- company
- who you are speaking with
- optional target values for:
  - base salary
  - signing bonus
  - equity
  - location
  - PTO
  - team
- additional context

Default target values in the popup:

- Base salary: `150k`
- Signing bonus: `20k`
- Equity: `160k of RSUs over 4 years`
- Location: `NY`
- PTO: `Unlimited PTO`
- Team: `ML Infra`

If you click `Hide`, the draft is saved for that Meet link so you can reopen it later with `Open NegotiateAI`.

If you open a different Meet link, the extension treats it as a new meeting and asks for fresh context.

## How To Use NegotiateAI In A Meeting

1. Join a Google Meet call
2. Turn on Meet captions
3. Wait for the NegotiateAI setup popup
4. Enter or confirm your context
5. Click `Start live session`

Once the session is running, you will see:

- Left panel:
  - recent Google Meet captions
- Right panel:
  - strategy
  - market research
  - goals
  - offer terms
  - watchouts

### What the panels mean

`Strategy`

- tells you what to discuss next
- stays focused on bridging the gap between the current offer and your target
- should not change until the conversation has actually progressed

`Market Research`

- shows a stable topic-specific anchor
- should only change when the topic changes or the conversation materially advances

`Goals`

- `pending`: not discussed yet
- `discussed`: it came up, but your target or policy is not met yet
- `active`: this is the live topic right now
- `done`: the term appears to have been reached or confirmed

`Offer Terms`

- shows the currently confirmed offer details
- should not change from a single noisy caption line

## Pause, Resume, Hide

You can control the extension during the call:

- pause suggestions from the right-panel toggle
- resume from the collapsed pill
- hide captions from the captions panel
- bring captions back with `Show captions`
- reopen hidden setup with `Open NegotiateAI`

## Important Usage Notes

NegotiateAI depends on Meet captions. If captions are off, the assistant has no transcript and should not generate advice.

The extension uses the current meeting context plus your saved provider settings. That means:

- the better your context, the better the advice
- caption quality affects accuracy
- noisy captions can still produce extraction mistakes

## Troubleshooting

### The extension does not appear in Meet

Check:

1. You loaded the unpacked extension from `/Users/johnxie/Documents/College/594/594-final-project`
2. The extension is enabled in `chrome://extensions`
3. You refreshed the Meet tab after loading or reloading the extension
4. You have actually joined the call, not just opened the Meet lobby

### The setup popup does not appear

Check:

1. You already joined the meeting
2. The Meet link is new or the prior session was reset
3. You did not hide it already

If you hid it, use `Open NegotiateAI`.

### The strategy panel says it is waiting

Check:

1. Your API key is saved
2. Your provider is selected correctly
3. Meet captions are enabled
4. Captions are actually appearing on screen

### Captions are not being picked up

Check:

1. Meet captions are turned on
2. People are actively speaking
3. The Meet tab was refreshed after reloading the extension

Important limitation:

- this prototype scrapes Google Meet caption DOM elements
- if Google changes the Meet caption markup, selectors in `/Users/johnxie/Documents/College/594/594-final-project/content.js` may need updates

### Offer terms look wrong

This can still happen because caption text can be noisy. Reload the extension, continue the call, and let more confirming lines accumulate. The latest version is designed to be more conservative, but it is still a prototype.

## Security And Privacy

This version is a client-side prototype.

That means:

1. transcript text is sent from the extension directly to the configured model provider
2. API keys are stored in Chrome extension local storage
3. there is no backend, audit log, or admin control layer

That is acceptable for a demo, but not for production.

## Known Limitations

- The extension listens to Meet captions, not raw audio.
- No captions means no live transcript input.
- Accuracy depends on caption quality.
- Speaker detection depends on the current Meet DOM.
- Offer-term extraction is conservative, but still imperfect.
- The UI and selectors may need updates if Google Meet changes.

## Recommended Next Steps For A Production Version

1. Move model calls to a backend
2. Stop storing production API keys in extension storage
3. Replace DOM caption scraping with a stronger transcription pipeline
4. Add structured validation for offer-term extraction
5. Add explicit consent and policy controls for meeting transcription

## Provider References

- OpenAI Responses API: [platform.openai.com/docs/api-reference/responses/compact?api-mode=responses](https://platform.openai.com/docs/api-reference/responses/compact?api-mode=responses)
- OpenAI authentication: [platform.openai.com/docs/api-reference/authentication?api-mode=responses](https://platform.openai.com/docs/api-reference/authentication?api-mode=responses)
- Anthropic Messages API: [docs.anthropic.com/en/api/messages-examples](https://docs.anthropic.com/en/api/messages-examples)
- Anthropic getting started: [docs.anthropic.com/en/api/getting-started](https://docs.anthropic.com/en/api/getting-started)
