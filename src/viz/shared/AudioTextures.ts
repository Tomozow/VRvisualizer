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
  const freqData = freqHistory.image.data as Uint8Array;
  const waveData = waveHistory.image.data as Uint8Array;
  let head = HISTORY_ROWS - 1;

  const textures: AudioTextures = {
    freqHistory,
    waveHistory,
    head,
    uniforms: {
      uFreqHistory: { value: freqHistory },
      uWaveHistory: { value: waveHistory },
      uHistoryHead: { value: head },
      uHistoryRows: { value: HISTORY_ROWS },
    },
    update(f: AudioFeatures) {
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
      freqHistory.needsUpdate = true;
      waveHistory.needsUpdate = true;
      textures.head = head;
      textures.uniforms.uHistoryHead.value = head;
    },
    dispose() {
      freqHistory.dispose();
      waveHistory.dispose();
    },
  };
  return textures;
}

/** GLSL snippet with helpers to sample the history textures. Prepend to shaders that use them. */
export const HISTORY_GLSL = /* glsl */ `
uniform sampler2D uFreqHistory;
uniform sampler2D uWaveHistory;
uniform float uHistoryHead;
uniform float uHistoryRows;
// v coordinate of the row that is `age` frames old (0 = newest)
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
`;
