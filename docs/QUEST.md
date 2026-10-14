# Using Resonance VR on Meta Quest 2

## 1. Open the app
Open the deployed HTTPS URL in the Quest browser (GitHub Pages works). The 2D page shows the visualizer with the control
overlay. WebXR only works over HTTPS; a `http://` LAN address will show "Enter VR" disabled.

## 2. Add music (in the 2D window)
| Source | How | Analysis |
| --- | --- | --- |
| Local files | **Choose audio files** (the Quest file picker opens) or drag & drop on desktop | Direct, sample-accurate |
| Direct audio URL | Paste an `.mp3/.ogg/.m4a` or stream URL (the server must send CORS headers) | Direct |
| YouTube | Paste a video, Shorts, youtu.be or playlist link and press **Add** | Microphone loop-back (automatic) |
| YouTube + proxy | Run `server/proxy.mjs` on your LAN and enter its URL under *Advanced* | Direct |
| Microphone | Toggle **Microphone** — visualize anything playing on the headset or in the room | Live |
| Demo | **Play demo track** — a built-in synthetic track | Direct |

YouTube: web pages are not allowed to read audio from YouTube's player (cross-origin), so the app plays the video with the
official player and *listens* through the headset microphone with echo cancellation disabled. Keep the headset volume
above ~50 % and allow the microphone when asked. The microphone is never recorded or played back.

## 3. Enter VR
Press **Enter VR**. The control panel floats in front of you.

| Input | Action |
| --- | --- |
| Point + trigger (or hand pinch) | Click buttons, drag sliders, seek |
| Hold grip while pointing at the panel | Move the panel |
| Thumbstick ← / → | Previous / next scene |
| Thumbstick ↑ / ↓ | Volume |
| A / X | Play / pause |
| B / Y | Show / hide the panel |
| Settings → Recenter | Bring the panel back in front of you |

The panel auto-hides after 12 s while music plays (toggle in Settings). A small HUD shows the track title when it changes.

## 4. Scenes
Spectrum Cathedral · Nebula · Wave Tunnel · Spectral Terrain · Pulse Core · Liquid Orbit, with seven palettes and
Intensity / Speed / Glow sliders. **Auto-cycle** changes the scene every 45 s.

## Troubleshooting
* **Visuals do not react to YouTube** → the microphone is off or blocked. Open Sources → Microphone; check the browser's
  site permissions. Raise the headset volume.
* **"Enter VR" disabled** → not HTTPS, or the page is open in a non-WebXR browser.
* **Low frame rate** → add `?quality=low` to the URL, disable the Background layer in Scenes, or lower Glow.
* **No sound after entering VR** → press play on the panel once (browsers require a gesture to start audio).
