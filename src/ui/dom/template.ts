import { ICONS } from './icons';

export const SERVER_README_URL = 'https://github.com/Tomozow/VRvisualizer/blob/main/server/README.md';

/** Scene sliders: [param key, label, max]. Shared by the template and the Overlay logic. */
export const SLIDERS = [
  ['intensity', 'Intensity', 2],
  ['speed', 'Speed', 2],
  ['glow', 'Glow', 1],
] as const;

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['Space', 'play/pause'], ['←/→', 'seek'], ['Shift+←/→', 'track'], ['↑/↓', 'volume'],
  ['N/P', 'scene'], ['C', 'palette'], ['M', 'menu'], ['H', 'hide UI'], ['1-9', 'scene'],
];

const iconBtn = (act: string, id: string, label: string, icon: string, extra = '', cls = ''): string =>
  `<button class="icon-btn ${cls}" id="${id}" data-act="${act}" aria-label="${label}" title="${label}" ${extra}>${icon}</button>`;

const slider = ([key, label, max]: (typeof SLIDERS)[number]): string =>
  `<div class="slider"><label for="param-${key}">${label}</label><output id="out-${key}"></output>` +
  `<input type="range" id="param-${key}" data-param="${key}" min="0" max="${max}" step="0.01" /></div>`;

const sw = (id: string, label: string, note = ''): string =>
  `<button class="switch" id="${id}" data-act="${id}" role="switch" aria-checked="false"><span class="sw"></span>` +
  `<span class="lbl">${label}${note ? `<small id="${id}-note"></small>` : ''}</span></button>`;

/** Static markup only: all dynamic text is written later through textContent / escaped templates. */
export function buildTemplate(): string {
  const legend = SHORTCUTS.map(([k, d]) => `<span><kbd>${k}</kbd> ${d}</span>`).join('');
  return `
<div class="ui-main">
  <header class="topbar glass">
    <div class="brand">
      <span class="beat-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      <span class="logo">RESONANCE</span>
    </div>
    <div class="pill" id="status" data-state="idle" role="status"><span class="dot"></span><span id="status-text">Idle</span></div>
    <div class="spacer"></div>
    <button class="btn ghost" id="hide-ui" data-act="hide">${ICONS.eye}<span>Hide UI (H)</span></button>
    <span class="tip" id="vr-tip"><button class="btn primary big" id="enter-vr" data-act="vr">${ICONS.vr}<span id="enter-vr-label">Enter VR</span></button></span>
  </header>

  <div class="columns">
    <div class="col col-left">
      <section class="card" id="sources" aria-label="Sources">
        <h2>Sources</h2>
        <div class="dropzone" id="dropzone">
          ${ICONS.upload}
          <span>Drop audio files anywhere</span>
          <button class="btn" id="choose-files" data-act="pick">Choose audio files</button>
          <input type="file" id="file-input" accept="audio/*" multiple hidden />
        </div>
        <form class="url-form" id="url-form" autocomplete="off">
          <input class="field" id="url-input" type="text" inputmode="url" spellcheck="false" autocapitalize="off"
            placeholder="YouTube link, playlist, or direct audio URL" aria-label="YouTube link, playlist, or direct audio URL" />
          <button class="btn primary" id="url-add" type="submit">Add</button>
        </form>
        <div class="btn-row">
          <button class="btn" id="mic-toggle" data-act="mic" aria-pressed="false">${ICONS.mic}<span>Microphone</span><b class="state" id="mic-state">Off</b></button>
          <button class="btn" id="demo-btn" data-act="demo">${ICONS.play}<span>Play demo track</span></button>
        </div>
        <p class="hint">Use this to visualize YouTube or anything else playing on the headset</p>
        <details class="advanced" id="advanced">
          <summary>Advanced: YouTube audio proxy<span class="badge" id="proxy-badge">Off</span></summary>
          <div class="adv-body">
            <input class="field" id="proxy-input" type="text" inputmode="url" spellcheck="false" autocapitalize="off"
              placeholder="http://192.168.1.10:8787" aria-label="YouTube audio proxy base URL" />
            <p class="hint">A self-hosted server streams YouTube audio with CORS headers for exact analysis instead of microphone loop-back.
              <a href="${SERVER_README_URL}" target="_blank" rel="noopener">server/README.md</a></p>
          </div>
        </details>
      </section>
      <div class="yt-wrap" id="youtube-wrap">
        <div class="yt-inner">
          <div class="yt-host" id="youtube-host"></div>
          <p class="hint yt-caption" id="yt-caption" hidden>Audio from YouTube is analysed through the microphone (loop-back). Keep the headset volume up.</p>
        </div>
      </div>
    </div>

    <div class="col col-mid" aria-hidden="true"></div>

    <div class="col col-right">
      <section class="card" id="scenes" aria-label="Scenes">
        <h2>Scenes</h2>
        <ul class="preset-list" id="preset-list"></ul>
        <h3>Palette</h3>
        <div class="palette-list" id="palette-list"></div>
        <div class="sliders">${SLIDERS.map(slider).join('')}</div>
        <div class="switches">${sw('autocycle', 'Auto-cycle', 'note')}${sw('background', 'Background')}</div>
      </section>
    </div>
  </div>

  <footer class="player glass" id="player">
    <div class="np">
      <div class="thumb" id="np-thumb"></div>
      <div class="meta"><div class="title" id="np-title"></div><div class="sub" id="np-sub"></div></div>
    </div>
    <div class="center">
      <div class="transport">
        ${iconBtn('shuffle', 'shuffle-btn', 'Shuffle', ICONS.shuffle, 'aria-pressed="false"')}
        ${iconBtn('prev', 'prev-btn', 'Previous track', ICONS.prev, 'data-needs="queue"')}
        ${iconBtn('back', 'back-btn', 'Back 10 seconds', ICONS.back10, 'data-needs="seek"')}
        ${iconBtn('toggle', 'play-btn', 'Play', ICONS.play, '', 'play')}
        ${iconBtn('fwd', 'fwd-btn', 'Forward 10 seconds', ICONS.fwd10, 'data-needs="seek"')}
        ${iconBtn('next', 'next-btn', 'Next track', ICONS.next, 'data-needs="queue"')}
        ${iconBtn('repeat', 'repeat-btn', 'Repeat: off', ICONS.repeat)}
      </div>
      <div class="seek">
        <span id="t-cur">0:00</span>
        <input type="range" id="seek" min="0" max="1000" step="1" value="0" aria-label="Seek" />
        <span id="t-dur">0:00</span>
      </div>
    </div>
    <div class="right">
      <div class="vol">${ICONS.volume}<input type="range" id="volume" min="0" max="1" step="0.01" aria-label="Volume" /></div>
      <button class="btn" id="queue-btn" data-act="queue" aria-expanded="false" aria-controls="queue-panel">${ICONS.queue}<span>Queue</span><b class="count" id="queue-count"></b></button>
    </div>
    <div class="queue" id="queue-panel" role="dialog" aria-label="Queue">
      <div class="q-head"><b>Queue</b><span class="spacer"></span><button class="btn small" id="queue-clear" data-act="clear">Clear</button></div>
      <ul class="q-list" id="queue-list"></ul>
    </div>
  </footer>

  <div class="legend">${legend}</div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
</div>

<div class="welcome" id="welcome" role="note">
  <span class="beat-bars big" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
  <p>Drop music, paste a YouTube link, or turn on the microphone — then put on your headset and press <b>Enter VR</b></p>
</div>
<button class="btn show-ui" id="show-ui" data-act="show">${ICONS.eye}<span>Show UI (H)</span></button>
<div class="drop-veil" aria-hidden="true"><div>${ICONS.upload}<span>Drop audio files to add them to the queue</span></div></div>`;
}
