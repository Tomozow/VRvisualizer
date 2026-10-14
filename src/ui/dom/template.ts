import { BRAND, LABELS, TRANSPORT_ORDER } from '@/ui/labels';
import { ICONS } from './icons';

export const SERVER_README_URL = 'https://github.com/Tomozow/VRvisualizer/blob/main/server/README.md';

/** Scene sliders: [param key, label, max]. Shared by the template and the Overlay logic. */
export const SLIDERS = [
  ['intensity', LABELS.intensity, 2],
  ['speed', LABELS.speed, 2],
  ['glow', LABELS.glow, 1],
] as const;

export const QUALITIES = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
] as const;

/** Shown in the "?" dialog. Keys are rendered as <kbd>, separated by " / " when more than one alternative. */
const SHORTCUTS: ReadonlyArray<readonly [readonly string[], string]> = [
  [['Space'], 'Play / pause'],
  [['←', '→'], 'Seek 10 s back / forward'],
  [['Shift + ←', '→'], 'Previous / next track'],
  [['↑', '↓'], 'Volume up / down'],
  [['N', 'P'], 'Next / previous scene'],
  [['1–9'], 'Jump to a scene'],
  [['C'], 'Next palette'],
  [['A'], 'Auto-cycle scenes on / off'],
  [['M'], 'Show / hide the VR menu panel'],
  [['H'], 'Hide / show this interface'],
  [['Drag'], 'Look around (mouse or touch)'],
  [['?'], 'Open this help'],
];

const iconBtn = (act: string, id: string, label: string, icon: string, extra = '', cls = ''): string =>
  `<button class="icon-btn ${cls}" id="${id}" data-act="${act}" aria-label="${label}" title="${label}" ${extra}>${icon}</button>`;

const slider = ([key, label, max]: (typeof SLIDERS)[number]): string =>
  `<div class="slider"><label for="param-${key}">${label}</label><output id="out-${key}"></output>` +
  `<input type="range" id="param-${key}" data-param="${key}" min="0" max="${max}" step="0.01" /></div>`;

const sw = (id: string, label: string, note = ''): string =>
  `<button class="switch" id="${id}" data-act="${id}" role="switch" aria-checked="false"><span class="sw"></span>` +
  `<span class="lbl">${label}${note ? `<small id="${id}-note"></small>` : ''}</span></button>`;

const TRANSPORT: Record<(typeof TRANSPORT_ORDER)[number], string> = {
  shuffle: iconBtn('shuffle', 'shuffle-btn', 'Shuffle', ICONS.shuffle, 'aria-pressed="false"'),
  back10: iconBtn('back', 'back-btn', 'Back 10 seconds', ICONS.back10, 'data-needs="seek"'),
  prev: iconBtn('prev', 'prev-btn', 'Previous track', ICONS.prev, 'data-needs="queue"'),
  play: iconBtn('toggle', 'play-btn', 'Play', ICONS.play, '', 'play'),
  next: iconBtn('next', 'next-btn', 'Next track', ICONS.next, 'data-needs="queue"'),
  fwd10: iconBtn('fwd', 'fwd-btn', 'Forward 10 seconds', ICONS.fwd10, 'data-needs="seek"'),
  repeat: iconBtn('repeat', 'repeat-btn', 'Repeat: off', ICONS.repeat),
};

/**
 * Static markup only: all dynamic text is written later through textContent / escaped templates.
 * @param quest true on a Meta Quest browser: no keyboard, so shortcut hints and the help dialog are left out.
 */
export function buildTemplate(quest = false): string {
  const keys = SHORTCUTS.map(
    ([ks, d]) => `<div class="key-row"><span class="key-caps">${ks.map((k) => `<kbd>${k}</kbd>`).join('<i>/</i>')}</span><span>${d}</span></div>`,
  ).join('');
  const hk = quest ? '' : ' (H)';
  const welcomeCopy = quest
    ? 'Drop in a song, paste a YouTube link, or press ▶ for the demo. Then press <b>Enter VR</b>.'
    : 'Drop in a song, paste a YouTube link, or press ▶ for the demo — then open this page on your Quest and press <b>Enter VR</b>.';
  return `
<div class="ui-main">
  <div class="top-stack">
    <header class="topbar glass">
      <div class="brand">
        <span class="beat-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="logo">${BRAND}</span>
      </div>
      <div class="pill" id="status" data-state="idle" role="status"><span class="dot"></span><span id="status-text">Idle</span></div>
      <span class="chip ok" id="chip-listening" hidden>Listening</span>
      <div class="spacer"></div>
      <button class="icon-btn ringed" id="help-btn" data-act="help" aria-label="Help and shortcuts" title="Help and shortcuts (?)" aria-haspopup="dialog"${quest ? ' hidden' : ''}><span aria-hidden="true">?</span></button>
      <button class="btn ghost" id="hide-ui" data-act="hide" aria-label="Hide UI" title="Hide UI${hk}">${ICONS.eye}<span>Hide UI${hk}</span></button>
      <div class="vr-block">
        <span class="vr-reason" id="vr-reason" role="status" hidden></span>
        <button class="btn small" id="vr-copy" data-act="copylink" hidden>Copy link</button>
        <span class="tip" id="vr-tip"><button class="btn primary big" id="enter-vr" data-act="vr">${ICONS.vr}<span id="enter-vr-label">Enter VR</span></button></span>
      </div>
    </header>
    <div class="banner" id="banner" hidden>
      <span class="banner-text" id="banner-text"></span>
      <button class="icon-btn" data-act="banner-close" aria-label="Dismiss message" title="Dismiss">${ICONS.close}</button>
    </div>
    <div class="banner warn" id="mic-banner" role="alert" hidden>
      <div class="banner-body"><b>${LABELS.micBlockedShort}</b><span>${LABELS.micBlockedDetail}</span></div>
      <div class="banner-actions">
        <button class="btn small" id="mic-retry" data-act="mic-retry">Try again</button>
        <button class="btn small" id="mic-demo" data-act="demo">Use demo track</button>
      </div>
    </div>
  </div>

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
            placeholder="YouTube or audio link" aria-label="YouTube link, playlist, or direct audio URL" />
          <button class="btn" id="paste-btn" type="button" data-act="paste" aria-label="Paste from clipboard">${ICONS.clipboard}<span>Paste</span></button>
          <button class="btn primary" id="url-add" type="submit">Add</button>
        </form>
        <p class="hint">On Quest: open YouTube in another tab → Share → Copy link, then Paste.</p>
        <div class="btn-col">
          <button class="btn" id="demo-btn" data-act="demo">${ICONS.play}<span>${LABELS.demoButton}</span></button>
          <button class="btn" id="mic-toggle" data-act="mic" aria-pressed="false">${ICONS.mic}<span>Microphone</span>
            <span class="meter" id="mic-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            <b class="state" id="mic-state">Off</b></button>
        </div>
        <p class="hint">Use the microphone to visualize YouTube or anything else playing on the headset.</p>
        <details class="advanced" id="advanced">
          <summary>Advanced: YouTube audio proxy<span class="badge" id="proxy-badge">Off</span></summary>
          <div class="adv-body">
            <p class="hint">A small server you run yourself (Node + yt-dlp) lets the app read YouTube audio directly, so no microphone is needed.</p>
            <div class="proxy-row">
              <input class="field" id="proxy-input" type="text" inputmode="url" spellcheck="false" autocapitalize="off"
                placeholder="http://192.168.1.10:8787" aria-label="YouTube audio proxy base URL" />
              <button class="btn" id="proxy-test" data-act="proxy-test">Test</button>
            </div>
            <p class="proxy-status" id="proxy-status" role="status" hidden></p>
            <p class="hint warn-text" id="proxy-warn" hidden>Browsers block http:// proxies on https:// pages. Use https:// or adb reverse + http://localhost:8787.</p>
            <a class="btn" id="proxy-guide" href="${SERVER_README_URL}" target="_blank" rel="noopener">Setup guide</a>
          </div>
        </details>
      </section>
      <div class="yt-wrap" id="youtube-wrap">
        <div class="yt-inner">
          <div class="note" id="mic-prompt" role="status" hidden>${ICONS.mic}<p>${LABELS.micPrompt}</p></div>
          <div class="yt-host" id="youtube-host"></div>
          <p class="hint yt-caption" id="yt-caption" hidden>Visuals listen through the headset microphone. Keep the volume up.</p>
        </div>
      </div>
    </div>

    <div class="col col-mid" aria-hidden="true"></div>

    <div class="col col-right">
      <section class="card" id="scenes" aria-label="Scenes">
        <h2>Scenes</h2>
        <ul class="scene-grid" id="preset-list"></ul>
        <div class="block">
          <h3>Palette</h3>
          <div class="swatches" id="palette-list" role="group" aria-label="Palette"></div>
          <p class="palette-name" id="palette-name"></p>
        </div>
        <div class="sliders">${SLIDERS.map(slider).join('')}</div>
        <div class="switches">${sw('autocycle', LABELS.autoCycle, 'note')}${sw('background', LABELS.background)}</div>
        <div class="row-control">
          <span class="rc-label" id="quality-label">Quality</span>
          <div class="seg" id="quality" role="radiogroup" aria-labelledby="quality-label">
            ${QUALITIES.map(([id, label]) => `<button class="seg-btn" data-act="quality" data-id="${id}" role="radio" aria-checked="false">${label}</button>`).join('')}
          </div>
        </div>
      </section>
    </div>
  </div>

  <footer class="player glass" id="player">
    <div class="np">
      <div class="thumb" id="np-thumb"></div>
      <div class="meta">
        <div class="title" id="np-title"></div>
        <div class="sub" id="np-sub"></div>
        <span class="chip warn" id="chip-nosound" role="status" title="${LABELS.noSound}" hidden>${LABELS.noSound}</span>
      </div>
    </div>
    <div class="center">
      <div class="transport">${TRANSPORT_ORDER.map((k) => TRANSPORT[k]).join('')}</div>
      <div class="seek">
        <span id="t-cur">0:00</span>
        <input type="range" id="seek" min="0" max="1000" step="1" value="0" aria-label="Seek" />
        <span id="t-dur">${LABELS.unknownDuration}</span>
      </div>
    </div>
    <div class="right">
      <div class="vol">
        ${iconBtn('mute', 'mute-btn', 'Mute', ICONS.volume)}
        <input type="range" id="volume" min="0" max="1" step="0.01" aria-label="Volume" />
        <output id="vol-out" for="volume">0%</output>
      </div>
      <button class="btn" id="queue-btn" data-act="queue" aria-expanded="false" aria-controls="queue-panel">${ICONS.queue}<span>Queue</span><b class="count" id="queue-count"></b></button>
    </div>
    <div class="queue" id="queue-panel" role="dialog" aria-label="Queue">
      <div class="q-head"><b>Queue</b><span class="spacer"></span><button class="btn small" id="queue-clear" data-act="clear">Clear</button></div>
      <ul class="q-list" id="queue-list"></ul>
    </div>
  </footer>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
</div>

<div class="welcome" id="welcome" role="region" aria-label="Welcome">
  <button class="icon-btn welcome-x" id="welcome-x" data-act="welcome-close" aria-label="Dismiss welcome" title="Dismiss">${ICONS.close}</button>
  <span class="beat-bars big" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
  <p class="welcome-text">${welcomeCopy}</p>
  <button class="btn primary big" id="welcome-demo" data-act="welcome-demo">${ICONS.play}<span>Play demo</span></button>
  ${quest ? '' : '<p class="hint welcome-look">Drag to look around</p>'}
</div>

<div class="modal" id="help" hidden>
  <div class="modal-backdrop" data-act="help-close"></div>
  <div class="modal-card glass" role="dialog" aria-modal="true" aria-labelledby="help-title">
    <div class="modal-head">
      <h2 id="help-title">Shortcuts</h2>
      <button class="icon-btn" id="help-close" data-act="help-close" aria-label="Close help" title="Close">${ICONS.close}</button>
    </div>
    <div class="key-list">${keys}</div>
  </div>
</div>

<button class="btn show-ui" id="show-ui" data-act="show">${ICONS.eye}<span>Show UI${hk}</span></button>
<div class="drop-veil" aria-hidden="true"><div>${ICONS.upload}<span>Drop audio files to add them to the queue</span></div></div>`;
}
