# Captions browser workflow — September 18, 2026

## Current result

**Velocity AI Edit rendered successfully. Export is blocked by the account’s subscription entitlement.** Download opened “Subscribe to download your video.” The user is checking the existing trial. No purchase was made. **Verified live exports: 0/1.**

[Saved video](https://captions.ai/projects/mUalhOmXOSiSR51R0tBn/videos/qI3HZkvVHAGJFipY2dVT) · [Private desktop](http://100.121.5.10:6093/vnc.html?autoconnect=1&resize=scale)

The browser is signed in. The last agent export attempt displayed the subscription screen; the user subsequently opened the share dialog and created a share link. Leave this saved edit intact: **do not click Create project again**. Export entitlement is still unverified.

## What is working

- Isolated Camoufox revision `0.1.29-7` with a persistent profile, private TypeSafe key, and Tailscale desktop.
- Verified source attachment and server upload, Velocity selection, settings, one render submission, and completed preview.
- Voiceover Only, Auto trim, and Generate media were all confirmed off before rendering.
- Real TypeSafe switch selection: 1/1 correct, 616.55 ms. Static selection cases: 15/15, median 233 ms, p95 673 ms.
- Adapter: 40 application tests; final offline browser regression: 27/27 checks in 6.302 seconds.
- Saved receipts retain the failed upload and two unchanged toggle failures. Fixed hidden-input metadata, switch identification, unique selectors, and delayed navigation.

The exact render duration is not exposed. The completed preview was observed within approximately 3 minutes 19 seconds of the single render click. The first workflow included about 29 minutes of calibration and repairs before reaching the download screen; this is not steady-state throughput.

## Source and verification

`buena-original-drama3-14s.mp4`: 14.333 seconds, 1080×1920, actual original Fish Drama 3 recording. SHA256 `17eb40b4b6b3b72b43e81dfcb521fa2067837eecca595fa4aa92b6bc997dd6fe`.

Hypit library: [original-voice video](http://100.121.5.10:5179/media/507e00ff-1146-46c8-9776-a5173e0a50be), [Fish WAV](http://100.121.5.10:5179/media/1ff76900-9100-4a1c-aa38-0d818bfb6513).

The earlier 20.064-second generated video used recreated speech. Its actual Fish recording was shorter, so picture timing was adapted before upload. Approximate speech timing does not prove mouth-shape accuracy.

The deployed preparation coordinator separately completed a real existing job: original-voice mastering, full decoding, 1080×1920, 14.333 seconds, and waveform correlation 0.999983. That separately prepared asset is staged; it is not the same byte-for-byte file used in the current browser proof.

The export verifier is ready for full decoding, dimensions, frame rate, duration, sampled caption evidence, and an independent waveform comparison. No output quality or retained voice claim can be made for the Captions result until the actual MP4 is downloaded and checked.

The bounded sequential coordinator is now installed with its matching helper (33 coordinator tests and 6 helper tests passed). It waits for readiness, preserves action IDs, and stops at subscription requirements or uncertainty. It was installed without running another edit; the current saved manual proof remains separate.

## Remaining limitations

- Export entitlement: the web screen offers Max at $24.99/month and Scale at $69.99/month. Actual credit consumption for this render is unknown. Full AI Edit is separate from API captions priced per minute.
- The current browser viewport is 1440×900 inside a maximized 1440×1000 desktop. Fully fluid resizing and adopting arbitrary user-opened tabs remain unsupported.
- The newer Nora portrait is still a draft. Both Gemini 3 Pro generations through fal.ai looked older than the requested youthful adult. The correction was not promoted. This proof uses the earlier copper-haired character.
- No scheduled generation or social publishing was activated.

## Authorization

The user authorized this existing Captions account, its trial credits, the approved source video upload, and the Google storage connection required by Captions. Purchases, upgrades, new trials and publishing remain excluded. The frozen payments adapter and unrelated production services are untouched.

Detailed evidence and limitations are recorded in `../buena-video-workflow/PROOF.md` and `../buena-video-workflow/artifacts/`.


## Shared clipboard

A visible **Copy / Paste** panel was added to the noVNC page as a static update, without restarting the signed-in browser. Send to VPS places entered text on the remote clipboard; use Ctrl+V inside Linux. Copy remote text with Ctrl+C or the page's Copy button, then choose Copy to device and paste normally on the local device. The panel uses the existing authenticated VNC connection and explicit user actions.

The user reported that selecting part of a URL replaced the full copied link in the panel. The live x11vnc setting `noprimary=1` now ignores ordinary text highlighting, and that flag is persisted in `src/display.mjs`. An isolated test with separate remote and local displays passed 7/7 checks in 31.387 seconds, including full URL Copy followed by highlighting only a fragment. No active user clipboard was read or replaced. A proposed resend of the live clipboard was rejected by automatic approval review and did not run.

The user then confirmed right-click Copy link works and explicitly stopped further clipboard development. Leave this feature as it is; focus on the reusable character-hook and real-product-demo video format.

## Shared preview check

The user supplied `https://captions.ai/share/M_K8Srd49Y-PUgdpB_hdhQ/8965d6a9-98c0-4921-ab20-c6f727a09219` and asked whether their generated video can be saved without a subscription. Public HTML returned an app shell, with no video or download element. Opening the interactive player through the browser tool was blocked because the admin-enforced security check could not be verified. No indirect workaround was attempted after that block. The share page's download availability, media resolution and export entitlement remain unknown; no Captions MP4 has been saved.
