import * as THREE from 'three';
import { BAND_COUNT, WAVE_COUNT, type AudioFeatures } from '@/audio/types';
import { HISTORY_ROWS, type AudioTextures } from '@/viz/types';

function makeTexture(width: number): THREE.DataTexture {
  const data = new Uint8Array(width * HISTORY_ROWS);
  const tex = new THREE.DataTexture(data, width, HISTORY_ROWS, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping; // lets shaders wrap the ring buffer with fract()
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** GPU ring buffer of recent spectrum / waveform frames shared by all presets. */
export function createAudioTextures(): AudioTextures {
  const freqHistory = makeTexture(BAND_COUNT);
  const waveHistory = makeTexture(WAVE_COUNT);
  // Pre-blurred copies (5-band / 12-sample box blur + short temporal average) so vertex shaders that want a
  // smooth profile (terrain, tunnel) need one fetch instead of 15–49.
  const freqSmooth = makeTexture(BAND_COUNT);
  const waveSmooth = makeTexture(WAVE_COUNT);
  const freqData = freqHistory.image.data as Uint8Array;
  const waveData = waveHistory.image.data as Uint8Array;
  const freqSData = freqSmooth.image.data as Uint8Array;
  const waveSData = waveSmooth.image.data as Uint8Array;
  const freqEma = new Float32Array(BAND_COUNT);
  const waveEma = new Float32Array(WAVE_COUNT);
  const tmpF = new Float32Array(BAND_COUNT);
  const tmpW = new Float32Array(WAVE_COUNT);
  const markRow = (tex: THREE.DataTexture, width: number, row: number) => {
    // three assumes 4 components per pixel for update ranges; scale offsets accordingly (R8 data, unpackAlignment 1)
    tex.addUpdateRange(row * width * 4, width * 4);
    tex.needsUpdate = true;
  };
  let head = HISTORY_ROWS - 1;
  const ROW_HZ = 72; // one history row per 1/72 s regardless of the display refresh rate
  let acc = 0;

  const textures: AudioTextures = {
    freqHistory,
    waveHistory,
    head,
    freqSmooth,
    waveSmooth,
    uniforms: {
      uFreqHistory: { value: freqHistory },
      uWaveHistory: { value: waveHistory },
      uFreqSmooth: { value: freqSmooth },
      uWaveSmooth: { value: waveSmooth },
      uHistoryHead: { value: head },
      uHistoryRows: { value: HISTORY_ROWS },
    },
    update(f: AudioFeatures, dt = 1 / ROW_HZ) {
      acc += dt;
      let rows = Math.floor(acc * ROW_HZ);
      if (rows <= 0) return;
      if (rows > 4) rows = 4; // after a stall, do not flood the buffer with duplicates
      acc -= rows / ROW_HZ;
      for (let n = 0; n < rows; n++) {
        head = (head + 1) % HISTORY_ROWS;
        const fo = head * BAND_COUNT;
        for (let i = 0; i < BAND_COUNT; i++) {
          const v = f.bands[i];
          freqData[fo + i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
        }
        const wo = head * WAVE_COUNT;
        for (let i = 0; i < WAVE_COUNT; i++) {
          const v = f.waveform[i] * 0.5 + 0.5;
          waveData[wo + i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
        }
        // smooth copies: 5-tap box over bands, 12-tap box over the waveform, then a temporal EMA (≈3 rows)
        for (let i = 0; i < BAND_COUNT; i++) {
          let acc2 = 0;
          for (let k = -2; k <= 2; k++) {
            const j = i + k;
            acc2 += f.bands[j < 0 ? 0 : j >= BAND_COUNT ? BAND_COUNT - 1 : j];
          }
          tmpF[i] = acc2 * 0.2;
        }
        for (let i = 0; i < WAVE_COUNT; i++) {
          let acc2 = 0;
          for (let k = -6; k <= 5; k++) {
            const j = (i + k + WAVE_COUNT) % WAVE_COUNT;
            acc2 += f.waveform[j];
          }
          tmpW[i] = acc2 / 12;
        }
        for (let i = 0; i < BAND_COUNT; i++) {
          freqEma[i] += (tmpF[i] - freqEma[i]) * 0.35;
          const v = freqEma[i];
          freqSData[fo + i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
        }
        for (let i = 0; i < WAVE_COUNT; i++) {
          waveEma[i] += (tmpW[i] - waveEma[i]) * 0.5;
          const v = waveEma[i] * 0.5 + 0.5;
          waveSData[wo + i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
        }
        markRow(freqHistory, BAND_COUNT, head);
        markRow(waveHistory, WAVE_COUNT, head);
        markRow(freqSmooth, BAND_COUNT, head);
        markRow(waveSmooth, WAVE_COUNT, head);
      }
      textures.head = head;
      textures.uniforms.uHistoryHead.value = head;
    },
    dispose() {
      freqHistory.dispose();
      waveHistory.dispose();
      freqSmooth.dispose();
      waveSmooth.dispose();
    },
  };
  return textures;
}

/** GLSL snippet with helpers to sample the history textures. Prepend to shaders that use them. */
export const HISTORY_GLSL = /* glsl */ `
uniform sampler2D uFreqHistory;
uniform sampler2D uWaveHistory;
uniform sampler2D uFreqSmooth;
uniform sampler2D uWaveSmooth;
uniform float uHistoryHead;
uniform float uHistoryRows;
// v coordinate of the row that is "age" frames old (0 = newest)
float histV(float age) {
  return (uHistoryHead - age + 0.5) / uHistoryRows;
}
// band energy 0..1 for band u (0..1) at age (frames)
float histFreq(float u, float age) {
  return texture2D(uFreqHistory, vec2(u, histV(age))).r;
}
// waveform sample -1..1 for position u (0..1) at age (frames)
float histWave(float u, float age) {
  return texture2D(uWaveHistory, vec2(u, histV(age))).r * 2.0 - 1.0;
}
// pre-blurred variants (5 bands / 12 samples + ~3 rows): one fetch instead of a multi-tap blur
float histFreqSmooth(float u, float age) {
  return texture2D(uFreqSmooth, vec2(u, histV(age))).r;
}
float histWaveSmooth(float u, float age) {
  return texture2D(uWaveSmooth, vec2(u, histV(age))).r * 2.0 - 1.0;
}
`;
