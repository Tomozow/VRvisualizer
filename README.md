# Resonance VR

Immersive music visualizer & player for **Meta Quest 2** (and any WebXR browser), built with three.js + WebXR.

* 🎧 Sources: local files, direct audio URLs, **YouTube** (IFrame player + mic loop-back analysis, or an optional self-hosted proxy), microphone, synthetic demo track
* 🌌 Six 3D scenes that surround you: Spectrum Cathedral, Nebula, Wave Tunnel, Spectral Terrain, Pulse Core, Liquid Orbit — plus an aurora sky layer
* 🎛 World-space VR panel (laser pointer, thumbsticks, hand tracking) and a 2D overlay for setup
* ⚡ Tuned for Quest 2: instanced / GPU-side geometry, ≤ a handful of draw calls per scene, no post-processing

Docs: `docs/QUEST.md` (how to use it on the headset) · `docs/ARCHITECTURE.md` (design & contracts) ·
`docs/QUALITY_BAR.md` (review criteria) · `server/README.md` (optional YouTube audio proxy).

## Quick start
```bash
npm install
npm run dev        # http://localhost:5173 (desktop preview with mouse look)
npm run build      # static site in dist/
```
On the headset the page must be served over **HTTPS** (GitHub Pages works out of the box; locally use a tunnel such as
`cloudflared tunnel --url http://localhost:5173` or `vite --https` with a trusted certificate).

## Tests
```bash
npm run typecheck          # TypeScript
npm test                   # build + headless Chromium: screenshots of every scene, emulated Quest 2 XR session
                           # (IWER) with controller input, and a 60 Hz audio-feature sanity check → tests/out/
```

## Using it on Quest 2
1. Open the site in the Quest browser. Add music: drop files, paste a YouTube link / playlist or a direct audio URL, or turn on the microphone.
2. Press **Enter VR**. The control panel floats in front of you — point and pull the trigger.
3. Thumbstick ←/→ changes scene, ↑/↓ volume, A/X play-pause, B/Y hides the menu, hold grip to drag the panel.

YouTube audio cannot be read directly by web pages (cross-origin), so the app plays the video with the official player and
listens through the microphone with echo-cancellation off. For sample-accurate analysis run the optional proxy on your LAN.
