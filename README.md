# LingoLens

[English](README.md) | [简体中文](README.zh-CN.md)

Translate ordinary web pages. Turn every YouTube video into a resource for deep learning. LingoLens combines on-page selection translation with full-page bilingual reading, transcripts, live captions, AI overviews, explanations, and timestamped notes in its Chrome side panel.

- Turn captions into a readable, searchable learning resource.
- Learn languages with the original transcript, a Simplified Chinese translation, or an aligned bilingual view.
- Build understanding with an AI overview, chapters, key quotes, and selected-text explanations.
- Navigate long videos by clicking timestamps in the transcript, overview, or notes.
- Save polished timestamped notes for later study.
- Translate an English selection from a small on-page card, or insert Simplified Chinese below the readable English body of any normal web page.
- Keep control of your data with your own API keys, local Chrome storage, and no analytics or telemetry.

LingoLens is a bring-your-own-key project installed locally from this generated folder or its ZIP package. It is not available through the Chrome Web Store, does not include API credits, and does not run a developer-operated server.

## Project origin

LingoLens is an independently maintained improvement based on [YouTube Digest](https://github.com/zarazhangrui/youtube-digest) by zarazhangrui, which is released under the MIT License. It preserves the original YouTube learning workflow and adds on-page selection translation, full-page bilingual translation, live bilingual subtitles with Deepgram fallback, shared DeepSeek Flash/Pro model settings, and related interface and reliability improvements. LingoLens is not an official release of the upstream project.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Keep this generated LingoLens project, or extract its ZIP, into a permanent folder I choose. Tell me its exact full path and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/lingolens` on macOS or Linux, or `%USERPROFILE%\Documents\lingolens` on Windows, but do not assume either path. Walk me through installation and setup in simple terms.

Your agent should:

1. Ask where you want to keep the generated project or extracted ZIP and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/lingolens` on macOS or Linux, or `%USERPROFILE%\Documents\lingolens` on Windows.
2. Open the official Supadata and DeepSeek pages below and help you create your own accounts.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Show you where to enter your API keys in the extension's **Settings** page.
5. Open a YouTube video with captions and confirm the transcript and translation work.

Keep this folder in the same place after installation. If you move or delete it, Chrome's unpacked extension stops working until you load the extension again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the LingoLens Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Locate `lingolens-v1.3.2.zip`, or use the generated `lingolens-v1.3.2` project folder directly.
2. If using the ZIP, choose a permanent folder and extract it there. Optional suggestions are `~/Documents/lingolens` on macOS or Linux, or `%USERPROFILE%\Documents\lingolens` on Windows. You may use a different folder.
3. In Chrome, open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the exact project folder you chose, which must contain `manifest.json`.
7. Pin LingoLens from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the LingoLens card at `chrome://extensions`, then refresh open YouTube tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your API keys

LingoLens uses keys under your own provider accounts:

1. A **Supadata API key** to retrieve YouTube transcripts.
2. A **DeepSeek API key** for web and subtitle translation, overviews, explanations, and automatic note polishing.
3. An optional **Deepgram API key** for live transcription when a page has no complete subtitle track.

### Get a Supadata API key

1. Open the official [Supadata sign-up page](https://dash.supadata.ai/auth/sign-up).
2. Create an account and complete the short onboarding flow.
3. Supadata generates an API key automatically during onboarding.
4. Open the [Supadata dashboard](https://dash.supadata.ai/) whenever you need to find or manage the key.
5. Copy the key and paste it into **Supadata API key** in LingoLens Settings.

See the [official Supadata documentation](https://docs.supadata.ai/) if the dashboard flow changes.

### Get a DeepSeek API key

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys).
2. Sign in or create a DeepSeek Platform account when prompted.
3. Choose **Create new API key**, give it a recognizable name such as `LingoLens`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Paste it into **DeepSeek API key** in LingoLens Settings.
6. If DeepSeek reports insufficient balance, add credit in your DeepSeek Platform account and try again.

See the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for current account and API details.

Open **Settings** from the side panel. You can also open the LingoLens **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste keys only into these Settings fields. Never paste a key into an AI chat, repository file, screenshot, or public message.

The published version supports DeepSeek as its AI provider and lets you choose V4 Flash or V4 Pro:

```text
Base URL: https://api.deepseek.com
Models: deepseek-v4-flash, deepseek-v4-pro
```

LingoLens sends every DeepSeek request in non-thinking mode for responsive, predictable interactions. All features share the one DeepSeek key and the Flash or Pro model selected in Settings. To use another provider or model family, copy the safe customization prompt in Settings and give it to a coding agent for your local copy. Never add an API key to that prompt or chat.

Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Use LingoLens

### Translate a web page

1. Open a normal HTTP or HTTPS page. Select English text with the mouse or keyboard to show a nearby **译** button. Selecting text alone does not make an API request.
2. Click **译** to send only that selection to DeepSeek. The on-page translation card lets you copy the result, retry a failure, or close the card.
3. Open the extension side panel and click **Translate page** to insert Simplified Chinese below readable English headings, paragraphs, lists, quotes, captions, and table cells. Use **Stop** or **Remove** at any time.

Full-page translation keeps inline code identifiers such as `a.shape`, function names, and keyboard or sample-output terms in their surrounding sentence. Preformatted code blocks are excluded and are not sent for translation.

On YouTube, the web translation card stays collapsed by default so the Digest remains primary. Browser pages, the Chrome Web Store, PDF viewer content, cross-origin frames, canvas text, and image text are not supported.

### Study a YouTube video

1. Open a standard YouTube watch page with captions.
2. Click the LingoLens extension icon to open the side panel.
3. Read the timestamped transcript, or choose **Original**, **中文**, or **双语**.
4. Open **Overview** when you want AI-generated chapters and key quotes.
5. Select transcript text when you want an AI explanation.
6. Save a note from the player or a key quote, then revisit it from **Notes**.

## What works today

### Live bilingual subtitles on web videos

Version 1.2 adds an English to Simplified Chinese subtitle mode for normal HTTP
and HTTPS tabs. Open a page with an HTML5 video, open the side panel, and choose
**Start subtitles**.

- If a complete timed subtitle track is available, LingoLens reads it
  first, builds whole-transcript topic and terminology context, translates the
  current three-minute window first, and completes the rest in the background.
- YouTube native captions continue to come from Supadata when available.
- If no complete subtitle track is available, the extension captures audio from
  the selected tab and streams it directly to Deepgram Nova-3. Final English
  utterances are sent to DeepSeek for contextual Simplified Chinese translation.
- The page overlay and side-panel history share the same bilingual segments.
  Sessions are saved locally and can be exported as SRT, VTT, or Markdown.
- The compact page overlay can be dragged anywhere on screen. Hover or focus it
  to change subtitle size, cycle between narrow, standard, and wide layouts,
  hide it, stop the session, or reset the layout. Display preferences are reused
  across websites in the current Chrome profile.

Live fallback requires your own Deepgram API key. Starting capture always
requires a user click. Chrome internal pages, protected DRM media, and overlay
placement inside some cross-origin fullscreen players are not supported. The
side-panel history remains available when an overlay cannot be placed.

- Google Chrome 116 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages.
- Native subtitle tracks returned by Supadata. LingoLens prefers English when available, but may show another native language.
- Original, Simplified Chinese, and aligned bilingual transcript views.
- AI overviews, selected-text explanations, translation, and automatic note polishing.
- Local notes and a local cache for recent transcript and digest results.
- DeepSeek V4 Flash or V4 Pro for all published AI features. Other providers require a local code adaptation.

YouTube study features still require a standard accessible watch page and a
native transcript. Live caption fallback can handle many streams and videos
without native subtitles, but private, protected, or access-restricted media
may block capture or overlays. Firefox, Safari, mobile browsers, and other
Chromium browsers are not currently tested or supported.

LingoLens forces Supadata's `mode=native`. It does not request AI-generated transcripts or perform local audio transcription when native captions are unavailable.

## Supadata free tier and request costs

Current as of August 9, 2026, the [Supadata pricing page](https://supadata.ai/pricing) lists a free tier with **100 credits per month**, no credit card required. Unused credits do not roll over. Supadata pricing can change, so check the current page before relying on these numbers.

The [Supadata transcript documentation](https://docs.supadata.ai/get-transcript) describes the transcript request modes and credit behavior:

- A native transcript request uses **1 credit**, regardless of video duration.
- A generated transcript costs **2 credits per video minute**. LingoLens does not use this path because it forces `mode=native`.
- An unavailable native lookup returned as HTTP `206` still uses **1 credit**.

With the current native-only behavior, the free tier can cover roughly 100 transcript lookups per month when each request succeeds once. Retries and unavailable-caption lookups also consume credits, so actual successful-video coverage can be lower.

DeepSeek usage is separate from Supadata. DeepSeek may apply its own free quota, rate limits, or charges. LingoLens does not collect payments or resell access. Set spending limits and monitor both accounts. The estimate below explains the current DeepSeek translation cost.

## DeepSeek V4 Flash translation cost estimate

Current as of August 10, 2026, DeepSeek lists the following prices per 1 million tokens on its official [pricing page](https://api-docs.deepseek.com/quick_start/pricing/):

- Cache-hit input: **$0.0028 USD**.
- Cache-miss input: **$0.14 USD**.
- Output: **$0.28 USD**.

DeepSeek says these prices may increase soon, so check the current pricing page before relying on this estimate. Its official [token usage guide](https://api-docs.deepseek.com/quick_start/token_usage/) estimates about 0.3 token per English character and about 0.6 token per Chinese character. Its [context caching guide](https://api-docs.deepseek.com/guides/kv_cache/) explains the automatic best-effort disk cache used for repeated prefixes.

A measured 20-minute English talk contained **2,935 spoken English words** and 15,433 transcript characters. With LingoLens's current grouping, it became 128 semantic segments and 43 requests of three segments each. Repeated prompts and JSON brought the rendered input to about 108,528 English characters, or **about 32,600 input tokens** using DeepSeek's 0.3 token per English character heuristic. The translated Chinese JSON output is estimated at about 3,500 to 4,500 tokens using the 0.6 token per Chinese character heuristic, plus JSON and ID overhead.

If all input is billed as cache miss, input costs about $0.0046 and output costs about $0.0010 to $0.0013, for a total of about $0.0056 to $0.0059. When much of the repeated system prompt hits DeepSeek's automatic best-effort cache, a realistic lower end is about $0.002 to $0.003. A practical estimate for fully translating this talk is therefore **$0.002 to $0.006 USD, about ¥0.02 to ¥0.04**.

Translation is lazy and progressive. Cached segments are reused, and only rows you request by scrolling into them incur calls. Retries, provider behavior, and pricing changes can increase the final cost.

## Remix it with your coding agent

This is a personal remix project. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

LingoLens uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose a learning language.
- Create customized summary templates for lectures, interviews, tutorials, reviews, or research talks.
- Build a vocabulary notebook that saves a word, its sentence, meaning, and video timestamp.
- Export notes and vocabulary to Markdown, CSV, Anki, or another study tool.
- Add personal topic filters that highlight the chapters most relevant to a goal.
- Add optional local-model support for a different privacy and cost tradeoff.
- Improve accessibility with keyboard navigation, font controls, and higher-contrast themes.

Ask your agent to preserve the bring-your-own-key model, keep secrets out of source files, run the checks below, and test the remix on real videos.

If you want another AI provider or model, first open the exact LingoLens project folder that Chrome loaded through **Load unpacked** in your coding agent. Then open LingoLens Settings and use **Copy customization prompt**. Replace the `[PROVIDER]` and `[MODEL]` placeholders before sending it. Do not include any API key in the prompt or chat. After the agent updates your local copy, enter the key yourself in the Settings field it identifies.

## Privacy and data flow

LingoLens makes provider requests directly from the extension:

1. It sends a canonical YouTube watch URL to Supadata to request the native transcript.
2. It sends the transcript and relevant video metadata to DeepSeek when you request AI features.
3. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
4. It stores keys, settings, notes, and recent cache entries locally in Chrome.

There is no LingoLens account system, advertising, analytics, or telemetry. Supadata and DeepSeek still receive data under their own terms and privacy policies. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

### The Digest button is missing on a YouTube video

- At `chrome://extensions`, find LingoLens and click **Reload**, then refresh the YouTube tab.
- Confirm that you are on a standard `https://www.youtube.com/watch?...` page, not a Short, embed, or live page.
- The current version automatically follows YouTube when its responsive action bar changes. Wait a moment after the page finishes loading.
- If you have an older downloaded copy, resizing the YouTube window horizontally once may reveal the button. Then download the latest version so resizing is no longer required.
- If it is still missing, ask your coding agent to inspect the content script on that exact video page.

### The side panel does not open

- Confirm that you are on a standard `https://www.youtube.com/watch?...` page.
- At `chrome://extensions`, confirm LingoLens is enabled and click **Reload**.
- Refresh the YouTube tab after reloading the extension.
- Ask your coding agent to inspect the extension if the problem continues.

### LingoLens asks for setup

- Open **Settings** and save both a Supadata key and a DeepSeek key.
- This published version uses the fixed DeepSeek endpoint. Choose V4 Flash or V4 Pro in Settings.
- If Settings says a legacy custom provider was removed, enter a DeepSeek key. The old AI key was cleared so it could not be reused with the wrong service.

### No transcript is found

- Confirm the video is public and has native captions.
- Check your Supadata key, remaining credits, rate limit, and account status.
- Remember that unavailable native lookups and manual retries may still consume credits.

LingoLens will not fall back to generated transcription.

### AI requests fail

- A `401` or `403` usually means the DeepSeek key or account access is invalid.
- A `429` usually means a DeepSeek rate or spending limit was reached.
- Confirm the key was created in the DeepSeek Platform account linked above and that the account has available credit.
- If you adapted a local copy for another model, use the Settings customization prompt again and ask your coding agent to inspect that local implementation.

Never share API keys, private transcripts, or personal notes in chats, screenshots, or logs.

## Checks for coding agents

Ask your coding agent to run these commands after changing the project:

```bash
npm test
npm run check
npm run package
```

The agent should also reload the unpacked extension in Chrome and test several real YouTube videos. Automated checks do not prove that live provider requests and YouTube interactions work.

## License

MIT. See [LICENSE](LICENSE).
