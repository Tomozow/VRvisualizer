import type { SourceKind } from '@/audio/types';

/** Single source of truth for user-facing vocabulary shared by the 2D overlay and the VR panel. */
export const KIND_LABEL: Record<SourceKind, string> = {
  file: 'Local file',
  url: 'Stream',
  youtube: 'YouTube',
  mic: 'Microphone',
  demo: 'Demo track',
};

export const BRAND = 'RESONANCE';

/** Transport button order used by both UIs: shuffle · −10 s · prev · play · next · +10 s · repeat */
export const TRANSPORT_ORDER = ['shuffle', 'back10', 'prev', 'play', 'next', 'fwd10', 'repeat'] as const;

export const LABELS = {
  background: 'Aurora sky',
  autoCycle: 'Auto-cycle',
  intensity: 'Intensity',
  speed: 'Speed',
  glow: 'Glow',
  demoButton: 'Play demo track',
  micOn: 'Microphone on',
  micOff: 'Microphone off',
  unknownDuration: '–:––',
  live: 'LIVE',
  emptyQueue: 'Nothing playing',
  noSound: 'No sound heard — raise the headset volume',
  menuHiddenHint: 'Menu hidden. Press B / Y or pull a trigger to bring it back',
  micBlockedShort: 'Microphone blocked',
  micBlockedDetail: 'Visuals can\'t follow YouTube. Allow the microphone in the browser\'s site settings, then reload.',
  micPrompt: 'Allow the microphone so the visuals can hear this video. It listens to your headset speakers; nothing is recorded or played back.',
} as const;

/** Short duration formatting shared by both UIs. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return LABELS.unknownDuration;
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = h ? String(m % 60).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}
