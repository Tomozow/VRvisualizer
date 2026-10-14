# Resonance VR

Immersive music visualizer & player for **Meta Quest 2** (and any WebXR browser), built with three.js + WebXR + TypeScript.
No backend required — it is a static site.

| | |
|---|---|
| 🎧 **Sources** | local files · direct audio URLs · **YouTube** (official player + microphone loop-back analysis, or an optional self-hosted proxy for sample-accurate analysis) · microphone · built-in synthetic demo track |
| 🌌 **Scenes** | Spectrum Cathedral · Nebula · Wave Tunnel · Spectral Terrain · Pulse Core · Liquid Orbit, plus an aurora sky layer, seven palettes, Intensity / Speed / Glow, auto-cycle |
| 🎛 **VR UI** | world-space panel (laser pointer + trigger, hand-tracking pinch), thumbstick shortcuts, grab-to-move, auto-hide, recenter, mini-HUD |
| 🖥 **2D UI** | glass overlay for setup in the desktop or Quest 2D browser: drag & drop, paste links, mic, proxy test, scene grid, keyboard shortcuts |
| ⚡ **Quest 2 tuned** | instanced / GPU-side geometry, ≤ 8 draw calls per scene, no post-processing, runtime quality switch, fixed foveation |

Docs: [`docs/QUEST.md`](docs/QUEST.md) (using it on the headset) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (design & contracts) ·
[`docs/QUALITY_BAR.md`](docs/QUALITY_BAR.md) (review criteria) · [`server/README.md`](server/README.md) (optional YouTube audio proxy).

## Quick start
```bash
npm install
npm run dev        # http://localhost:5173 — desktop preview with mouse look; press 1-6 for scenes, Space to play the demo
npm run build      # static site in dist/
```
On the headset the page must be served over **HTTPS** (GitHub Pages works out of the box; locally use a tunnel such as
`cloudflared tunnel --url http://localhost:5173`).

### Deploy to GitHub Pages
The workflow in `.github/workflows/deploy.yml` builds and publishes `dist/` on every push to `main`
(enable *Settings → Pages → Source: GitHub Actions* once). The site is then available at `https://<user>.github.io/<repo>/`.

## Using it on Quest 2
1. Open the site in the Quest browser. Add music: choose files, paste a YouTube link / playlist or a direct audio URL, or turn on the microphone.
2. Press **Enter VR**. The control panel floats in front of you — point and pull the trigger.
3. Thumbstick ←/→ changes scene, ↑/↓ volume, A/X play-pause, B/Y hides the menu, hold grip to drag the panel.

**YouTube:** web pages are not allowed to read audio from YouTube's player (cross-origin), so the app plays the video with the
official player and listens through the headset microphone with echo cancellation off. For sample-accurate analysis run the
optional proxy on your LAN and enter its URL under *Sources → Advanced*.

## Tests
```bash
npm run typecheck          # TypeScript
npm test                   # build + headless Chromium: screenshots of every scene, an emulated Quest 2 XR session
                           # (IWER) with controller input, and a 60 Hz audio-feature sanity check → tests/out/
```

## Keyboard (desktop)
Space play/pause · ←/→ seek 10 s · Shift+←/→ track · ↑/↓ volume · N/P scene · 1-6 scene · C palette · A auto-cycle · M VR menu preview · H hide UI · ? help
