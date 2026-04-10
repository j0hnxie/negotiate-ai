# Meet Negotiation Copilot (Chrome Extension)

A Manifest V3 Chrome extension that acts as an AI negotiation assistant during Google Meet calls.

## What it does

- Captures live transcript lines from Google Meet captions.
- Continuously sends rolling transcript + preloaded context to OpenAI.
- Shows live strategic guidance in a floating side panel inside Meet.
- Focuses on negotiation approaches and options rather than verbatim scripts.

## Setup

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose this folder:
   - `/Users/johnxie/Documents/College/594/594-final-project`
4. Open extension **Options** and set:
   - OpenAI API key
   - Negotiation goals
   - Counterpart profile
   - Previous email/document context
   - Your personal experience notes

## Usage

1. Join a Google Meet call.
2. Turn on Meet captions.
3. The right-side panel (`Negotiation Copilot`) will start capturing transcript lines.
4. Advice refreshes continuously as new transcript chunks arrive.
5. Use the popup to pause/resume or reset transcript.

## Important limitations

- Transcript capture currently relies on Google Meet caption DOM. If Google changes UI selectors, capture may need updates.
- Advice quality depends on caption quality and context you provide.
- API key is stored in `chrome.storage.local` (local to your browser profile, not encrypted by this extension).

## Privacy and consent

This extension sends call transcript excerpts and your context to OpenAI for generation. Ensure legal and policy compliance, including participant consent for transcription/AI assistance.
