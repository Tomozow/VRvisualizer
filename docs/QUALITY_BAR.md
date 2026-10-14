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
