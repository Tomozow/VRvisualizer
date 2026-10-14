import type { Preset } from '@/viz/types';
import { SpectrumCathedral } from './SpectrumCathedral';
import { NebulaParticles } from './NebulaParticles';
import { WaveTunnel } from './WaveTunnel';
import { SpectralTerrain } from './SpectralTerrain';
import { PulseCore } from './PulseCore';
import { LiquidOrbit } from './LiquidOrbit';

export interface PresetFactory {
  id: string;
  name: string;
  description: string;
  create(): Preset;
}

/** Order here is the order shown in the UI and used by next/prev. */
export const PRESET_FACTORIES: PresetFactory[] = [
  { id: 'spectrum', name: 'Spectrum Cathedral', description: 'Rings of spectrum pillars rising around you', create: () => new SpectrumCathedral() },
  { id: 'nebula', name: 'Nebula', description: 'Hundreds of thousands of particles breathing with the bass', create: () => new NebulaParticles() },
  { id: 'tunnel', name: 'Wave Tunnel', description: 'Fly through the waveform itself', create: () => new WaveTunnel() },
  { id: 'terrain', name: 'Spectral Terrain', description: 'A landscape sculpted by the spectrogram', create: () => new SpectralTerrain() },
  { id: 'pulse', name: 'Pulse Core', description: 'A living core that shatters on every beat', create: () => new PulseCore() },
  { id: 'orbit', name: 'Liquid Orbit', description: 'Ribbons of light orbiting in liquid motion', create: () => new LiquidOrbit() },
];
