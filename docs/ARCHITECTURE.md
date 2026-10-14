# Resonance VR — Architecture & Contributor Spec

Target: **Meta Quest 2 browser (WebXR, 72 Hz)** first, desktop Chrome second. Static site (Vite + three.js r186 + TypeScript),
deployable to GitHub Pages. No framework.

## Product goals
* Professional "Synesthesia / Milkdrop in VR" quality: dense, luminous, smooth, musical. Nothing should look like a tech demo.
* Audio sources: local files, direct audio URLs, **YouTube** (IFrame player + microphone loop-back analysis, or an optional
  self-hosted CORS proxy for precise analysis), microphone, and a synthetic demo signal.
* Visuals are 3D and surround the user: spectrum pillars, particles, waveform tunnels, terrain, a reacting core.
* Intuitive UI: a world-space panel in VR (laser pointer + trigger, thumbstick shortcuts, hand tracking pinch) and a 2D overlay
  for setup on desktop / in the 2D Quest browser window.

## Layout
```
src/main.ts                 bootstrap
src/app/App.ts              orchestrator (renderer, XR session, loop, Actions impl)   [owner: lead]
src/app/Store.ts            AppState + Actions contracts                             [owner: lead]
src/audio/types.ts          AudioFeatures / Track / PlaybackState / AudioEngineApi    [owner: lead]
src/audio/AudioEngine.ts    export class AudioEngine implements AudioEngineApi        [owner: audio agent]
src/audio/**                analysis, sources, youtube wrapper, demo generator        [owner: audio agent]
src/viz/types.ts            Preset / PresetContext / AudioTextures / Palette          [owner: lead]
src/viz/VisualizerManager.ts crossfades presets, owns textures/palette/env            [owner: lead]
src/viz/shared/*            AudioTextures (GPU history), Palettes, Environment        [owner: lead]
src/viz/presets/index.ts    registry (ids + names)                                    [owner: lead]
src/viz/presets/*.ts        one file per preset                                       [owner: viz agents]
src/ui/vr/VRUI.ts           export class VRUI — controllers, hands, panel             [owner: vr-ui agent]
src/ui/dom/Overlay.ts       export class DomOverlay — 2D HTML UI (+ overlay.css)      [owner: dom-ui agent]
server/                     optional YouTube audio proxy (Node)                       [owner: audio agent]
tests/                      Playwright screenshot / smoke scripts                     [owner: lead]
```
Path alias `@/` → `src/`. three.js addons: `import { X } from 'three/addons/.../X.js'`.

## Frame loop (App.frame)
`engine.update()` → `viz.update(features, dt, t, params)` (writes GPU history textures, palette easing, environment,
background layer, active presets) → `vrui.update(dt, t)` → `renderer.render`.

## Audio engine contract (src/audio/types.ts)
* ONE `AudioFeatures` object, mutated in place every frame. Everything in 0..1 after **auto gain control** so a quiet
  YouTube stream through the mic animates as strongly as a loud local file. Attack fast (≈30 ms), release slow (≈300–600 ms)
  for bands; beat detection = bass-band energy vs. running mean/variance (≈1 s window) with 120 ms refractory, plus
  spectral-flux onset; BPM via inter-beat interval histogram (60–180 BPM); `beatPhase` predicted from bpm.
* 128 log-spaced bands 30 Hz → 16 kHz from a 2048-FFT analyser (smoothingTimeConstant 0.5, our own smoothing on top);
  `waveform` = 256 samples down-sampled from the 2048 time-domain buffer.
* Graph: `source → gain(volume) → analyser → destination`; mic: `mediaStream → analyser` (never to destination).
* Demo generator: a synthetic "track" (kick 4/4 at ~124 BPM, bass line, hats, pad) built from oscillators / noise so the
  app is never silent in tests and demos (`?demo=1` starts it on load without a gesture requirement on desktop autoplay-allowed contexts, else on first click).
* YouTube: IFrame API (`https://www.youtube.com/iframe_api`) in a host element the DOM overlay provides. Playback controls
  (play/pause/seek/volume/time/duration/title) go through the player API, which keeps working while the page is in an
  immersive session. Analysis uses the microphone automatically (`analysisInput = 'mic'`) unless a proxy URL is set,
  in which case the proxied stream plays through an `<audio>` element and the iframe is not used.
  Accept: watch URLs, youtu.be, shorts, `v=` ids, bare 11-char ids, playlist URLs (`list=`): load via player API
  `loadPlaylist` / `cuePlaylist` and expose entries as queue items when `getPlaylist()` becomes available.
* Proxy (optional, `server/`): `GET /stream?v=<id>` → audio stream with CORS headers (yt-dlp → ffmpeg → audio/webm or mp3);
  `GET /info?v=<id>` → `{title, duration}`. Document clearly that it is self-hosted and for personal use.

## Visualizer contract (src/viz/types.ts)
* Presets put everything inside `group`, never touch the camera, keep a 1 m sphere around (0, 1.6, 0) free, implement
  `setOpacity` by fading uniforms (not by toggling visibility), and `dispose()` resources.
* GPU audio history: `ctx.textures.uniforms` (spread into your `uniforms`) + `HISTORY_GLSL` helpers
  (`histFreq(u, age)`, `histWave(u, age)`) from `src/viz/shared/AudioTextures.ts`. 256 rows ≈ 3.5 s at 72 fps.
* Palette: sample `uGradient` (`ctx.palette.gradient`, 256×1) with a 0..1 value; `ctx.palette.primary/secondary/accent/background`
  are live `THREE.Color`s — reference them directly in uniforms, they ease automatically.
* `VizParams`: `intensity` (0..2) scales amplitudes / reactivity, `speed` scales time, `glow` scales brightness/alpha.
* Comfort: no camera motion; large slow motion only; avoid full-screen strobing (max flash contribution ≈ beatEnv*0.35).
* Performance budget per preset on Quest 2 (quality 'medium'): ≤ 3 draw calls, ≤ 120k vertices, no post-processing,
  no per-frame geometry re-upload beyond ~64 KB, no `MeshStandardMaterial` with many lights. Use `ShaderMaterial`,
  `InstancedMesh`, `Points`, additive blending, soft sprites (fake bloom), `depthWrite:false` for additive layers.
  Use `ctx.quality` to scale counts ('low' ×0.5, 'medium' ×1, 'high' ×2).
* Tone mapping is ACES; emissive values above 1.0 bloom-ish naturally. Dark backgrounds, bright accents.

## UI contract (src/app/Store.ts)
UIs read `store.state`, subscribe for changes (`changed: Set<keyof AppState>`), and call `Actions`. Never mutate state
directly. `playback` is replaced by reference on every engine change.

### VR UI (src/ui/vr)
* World-space panel ≈ 1.4 m × 0.89 m, 1.4 m in front of the head at ≈1.3 m height, slight downward tilt toward the face.
  Rendered with a CanvasTexture (2048×1304) redrawn only when state changes; hover, sliders and live readouts are GPU overlay quads.
  Body text ≥ 44 px (≈1.2° at 1.4 m), hit targets ≥ 4 cm.
  Tabs: Player (now playing, progress/seek, transport, volume, queue), Scenes (preset tiles + palette chips + intensity/
  speed/glow sliders + auto-cycle), Sources (Mic on/off, Demo, YouTube/queue info, hint text), Settings (recenter, fps,
  background toggle, exit VR).
* Interaction: ray from each controller (and index-finger pinch for hands) → raycast against the panel → hover highlight;
  trigger/pinch = click, drag on sliders. Thumbstick: left/right = prev/next preset, up/down = volume; A/X = play/pause;
  B/Y = toggle menu; grip held = grab & move the panel. Haptic pulse on click (`gamepad.hapticActuators`).
* Panel hides automatically after 12 s without interaction while playing (configurable); any button press shows it again.
  A small always-visible mini-HUD (track title + beat dot) can live at the bottom edge, fading out after 4 s.
* Controllers: `XRControllerModelFactory` models + a thin glowing ray that shortens to the hit point; hands via
  `XRHandModelFactory` ('mesh'). Everything must survive sessions starting/ending repeatedly.
* `recenter()` re-places the panel in front of the current head pose (use `renderer.xr.getCamera()` world position/direction
  projected on the horizontal plane).

### DOM overlay (src/ui/dom)
* Beautiful dark glass UI (CSS only, no framework): header with logo + "Enter VR" (disabled with reason if unsupported),
  a source card (drop zone + file input, URL/YouTube input, Mic, Demo), a player bar (title, progress, transport, volume),
  a scene strip (presets, palettes, sliders), toast area, and the YouTube host element (`youtubeHost`, 320×180,
  visible when a YouTube track is active). Keyboard shortcuts legend. Hidden with `h` / a toggle (`toggleHidden()`),
  auto-collapsed in XR mode. Must work in the Quest 2D browser (touch / laser pointer) — large hit targets, no hover-only.

## Quest-specific notes
* WebXR needs HTTPS (GitHub Pages is fine). `optionalFeatures: ['local-floor','bounded-floor','hand-tracking','layers']`.
* Keep `renderer.setPixelRatio(1)` in XR (the XR framebuffer scale is separate), foveation 1.
* Quest Browser supports `getUserMedia({audio:true})`; echo cancellation must be **disabled** for loop-back analysis:
  `{ echoCancellation:false, noiseSuppression:false, autoGainControl:false }`.
* Page audio (including the YouTube iframe) keeps playing while in an immersive session.
* No DOM is visible in immersive mode, so every control must exist on the VR panel.

## Test hooks (query params)
`?demo=1` start demo signal on load · `?preset=<id>` · `?palette=<id>` · `?nomenu=1` hide VR menu · `?quality=low|medium|high`
· `?seed=123` deterministic randomness (presets should use `ctx`-independent `Math.random` only at init) · `?t=<seconds>` (tests may step the clock).

## Code style
TypeScript strict, no `any` leaks in public APIs, small modules, comments only where the "why" is non-obvious, no dead code,
no console noise in the loop. `npm run typecheck && npm run build` must pass.
