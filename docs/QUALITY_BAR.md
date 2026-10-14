# Quality bar (what "professional" means here)

Reviewers score every scene and both UIs against this list. Anything below "good" blocks release.

## Visuals (per scene)
1. **Depth & enclosure** — content exists in every direction; parallax layers (near / mid / far); the floor and ceiling are not empty voids.
2. **Luminance design** — dark background (≤ 5 % luminance), accents that bloom (additive, soft edges, bright cores); no flat untextured fills, no default-material grey.
3. **Musicality** — bass drives large slow motion, beats produce a clear accent (≤ 350 ms), highs add sparkle; visible response within 50 ms; nothing sits still during music and nothing jitters during silence.
4. **Motion quality** — eased, continuous motion; no popping, no per-frame flicker, no z-fighting; crossfades between scenes are clean.
5. **Composition** — a focal point in front of the user at eye height, symmetry or deliberate asymmetry, scale that feels monumental (5–20 m), nothing clipping the head.
6. **Colour** — every palette reads well; gradients used across depth/energy; no muddy mid-greys.
7. **Comfort** — no camera motion, no full-field strobe, world motion ≤ 1.5 m/s, no large objects closer than 1 m.

## Performance (Quest 2, quality 'medium')
* ≤ 25 draw calls total, ≤ 400 k triangles, ≤ 150 k points, no post-processing, no shadow maps.
* Per-frame JS ≤ 2 ms (engine update + UI), no per-frame allocations in hot paths.
* Shaders: ≤ 4 noise octaves in full-screen passes; texture fetches ≤ 8 per fragment.

## VR UI
* Readable text (≥ 1.2° angular size at 1.4 m), clear hover and pressed states, haptic click, hit targets ≥ 4 cm.
* All functions reachable without the 2D UI except typing URLs. Panel never obstructs the focal scene when hidden.
* Thumbstick shortcuts, grab-to-move, recenter, auto-hide — all working after session restarts.

## 2D UI
* First-time user understands what to do within 5 s (welcome hint). Drag-and-drop works. Touch targets ≥ 44 px. Responsive.
* YouTube flow: paste → plays → mic auto-enabled → visuals react; clear messaging about loop-back and the optional proxy.

## Status (last art-director re-score, headless SwiftShader stills, demo track)
Cells below 7 went from 12 to 5 across the last fix round; none is below 6.

| Scene | Depth | Lum | Music | Motion | Comp | Colour | Comfort | Verdict |
|---|---|---|---|---|---|---|---|---|
| Spectrum Cathedral | 7 | 7 | 8 | 7 | 7 | 7 | 7 | ships |
| Nebula | 7 | 8 | 7 | 8 | 8 | 8 | 8 | ships |
| Pulse Core | 7 | 7 | 8 | 7 | 8 | 7 | 7 | ships |
| Wave Tunnel | 8 | 7 | 7 | 6 | 7 | 6 | 7 | not yet |
| Spectral Terrain | 7 | 6 | 7 | 7 | 6 | 7 | 7 | not yet |
| Liquid Orbit | 7 | 7 | 7 | 7 | 6 | 7 | 7 | not yet |

Remaining fixes on record (one line each, not yet applied):
* Tunnel motion: fade the ring-ripple amplitude with depth beyond ≈12 m so inner rings stay round (sawtooth / moiré crawl).
* Tunnel colour: extend the far end of the gradient ramp to the magenta→violet stops in Neon Sunset; avoid the murky red centre.
* Terrain luminance: drop the ceiling's flat base fill to ≈0.1 alpha and keep only the glowing grid lines.
* Terrain composition: cap crest height to ≈1 m in the sector in front of the sun; soften the V crease at the mirror centre.
* Orbit composition: thin/dim ribbons below the horizon and in the near field; enlarge the core ≈1.5×.
* Set-wide: the shared floor grid + pool arcs make scenes look alike and read khaki under orange ribbons — consider per-scene floor tinting.

Not verified in this environment: real Quest 2 GPU timing, hand tracking, microphone loop-back with a real YouTube stream, and
motion/musicality on real audio (stills cannot prove them).
