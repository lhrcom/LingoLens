# Privacy

Effective: August 16, 2026

LingoLens is a locally installed, bring-your-own-key Chrome extension. It has no LingoLens account, developer-operated backend, analytics, advertising, or telemetry.

## Data the extension handles

Depending on the feature you use, LingoLens handles:

- the canonical URL and video ID of the active YouTube video;
- transcript text and timestamps;
- video metadata such as title, channel, description, and duration;
- text you select in the transcript and nearby transcript context;
- an English text selection on a normal web page, held temporarily in that page until you dismiss the on-page control or explicitly click **译** to request translation;
- readable web-page body text, including inline code identifiers but excluding preformatted code blocks, when you explicitly request full-page translation;
- transcript context around a timestamped note;
- content you ask to translate;
- notes you save;
- Supadata, Deepgram, and DeepSeek configuration, including API keys;
- global subtitle overlay size, width, and relative screen position preferences;
- audio from the user-selected browser tab while live transcription is active;
- live and prefetched bilingual caption sessions; and
- cached transcript, digest, and translation results.

## Where data goes

### Supadata

LingoLens sends the canonical YouTube video URL to `https://api.supadata.ai` with your Supadata API key. Supadata returns the transcript and timestamps. A Supadata key is required for transcript retrieval.

### DeepSeek

The published version sends AI feature content to the DeepSeek V4 Flash or V4 Pro model you select at `https://api.deepseek.com`:

- transcript plus relevant title, channel, description, or duration for an overview;
- selected text plus nearby transcript context for an explanation;
- a selected web-page passage or bounded batches of readable page text, including inline code identifiers but excluding preformatted code blocks, when you explicitly request translation;
- small semantic transcript batches currently needed for progressive Chinese
  translation, or requested overview or explanation content;
- nearby transcript context and video metadata when polishing a saved note.

The endpoint is fixed. You provide one DeepSeek API key and choose `deepseek-v4-flash` or `deepseek-v4-pro` in Settings; that choice applies to every AI feature. To use another provider or model family, you must adapt your own local source copy and its permissions.

### Deepgram

When you explicitly start subtitles on a page without a complete timed English
subtitle track, the extension captures audio from that selected tab and streams
16 kHz mono PCM audio directly to `wss://api.deepgram.com`. Deepgram Nova-3
returns interim and final English transcripts. Capture stops when you click
Stop, close or navigate the tab, or the media stream ends. The extension does
not send video frames to Deepgram.

Requests go directly from the extension to Supadata, Deepgram, or DeepSeek.
They are authenticated with the keys you supply. LingoLens's developer
does not proxy or receive these requests.

Those services process data under their own terms, privacy policies, retention practices, and account settings. Do not send confidential, personal, or regulated content unless their terms and your obligations permit it.

## Local storage and retention

LingoLens uses Chrome's local extension storage, not a LingoLens cloud service.

- Supadata and DeepSeek settings and API keys remain on the device in Chrome's extension storage.
- Saved notes remain until you delete them or remove/clear the extension's data. The extension keeps up to 100 notes.
- Recent transcript, digest, and per-segment translation cache entries are stored
  locally. The cache is limited to 20 videos, and entries older than 30 days are
  removed when the side panel opens.
- Up to 20 recent bilingual caption sessions are stored locally for history and
  SRT, VTT, or Markdown export.

Chrome extension storage is not a password vault. Anyone with sufficient access to your browser profile or device may be able to recover locally stored keys or content. Use scoped keys where providers support them, set spending limits, and rotate or revoke a key if the device or browser profile is compromised.

To remove data:

- delete individual saved notes in LingoLens;
- use the Options page to clear cached digests, delete all notes, or reset all extension data;
- remove the extension or clear its stored data from Chrome to delete all local settings, keys, notes, and cache entries; and
- revoke keys in the Supadata, Deepgram, or DeepSeek dashboard to stop their future use.

Clearing local data does not delete information already processed or retained
by Supadata, Deepgram, or DeepSeek. Use each service's controls for service-side
requests.

## Permissions

LingoLens uses Chrome permissions for these purposes:

- `sidePanel`: display the LingoLens interface beside normal web pages and YouTube.
- `storage`: store settings, keys, notes, and cached results locally.
- `tabs`: identify and interact with the active web or YouTube tab.
- `scripting`: coordinate the extension's YouTube page controls.
- `activeTab`: inspect the selected page and inject the subtitle overlay only
  after the user opens or interacts with the extension.
- `tabCapture`: capture audio from the user-selected tab after a user click.
- `offscreen`: keep audio processing and the Deepgram connection alive while
  the side panel is closed.
- YouTube host access: read the active video's URL and metadata and provide timestamp controls.
- Supadata host access: retrieve transcripts.
- DeepSeek host access: provide AI overviews, explanations, page and subtitle translation, and note polishing through the selected DeepSeek V4 model.
- Deepgram host access: provide live English speech recognition through Nova-3.

The generic content script observes only the current page's selection and readable text needed for user-requested translation. Selecting text only displays an on-page **译** button; it does not send the selection. LingoLens does not send browsing activity or page text unless you click **译** or explicitly start another applicable feature.

## No sale or advertising use

LingoLens does not sell personal information, build advertising profiles, or share data with data brokers. It does not include analytics SDKs.

## Changes

Privacy-relevant changes will be documented in this file and in the repository history. Review updates before installing a new version.

## Questions

This repository does not provide a public support or issue channel. Review this policy, the source code, and each provider's documentation before using the extension. For a vulnerability or accidental secret exposure, follow the private process in [SECURITY.md](SECURITY.md).
