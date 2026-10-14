import type { PlaybackState, Track } from '../types';

/** Decides which queue entry follows the current one: sequential, or shuffle without repeats; keeps a history for "previous". */
export class PlayOrder {
  private readonly history: string[] = [];
  private readonly played = new Set<string>();

  /** Forget everything (queue cleared) */
  clear(): void {
    this.history.length = 0;
    this.played.clear();
  }

  /** Start a new shuffle cycle in which only `currentId` counts as played */
  restartCycle(currentId?: string): void {
    this.played.clear();
    if (currentId) this.played.add(currentId);
  }

  markPlayed(id: string): void { this.played.add(id); }

  /** Remember the track we are leaving so "previous" can return to it (shuffle) */
  remember(id: string | undefined): void {
    if (!id) return;
    this.history.push(id);
    if (this.history.length > 200) this.history.shift();
  }

  back(): string | undefined { return this.history.pop(); }

  /**
   * Index of the entry that follows `index`, or -1. `auto` = the track ended by itself (respects repeat off / one);
   * a manual skip always wraps around.
   */
  next(queue: Track[], index: number, repeat: PlaybackState['repeat'], shuffle: boolean, auto: boolean): number {
    const n = queue.length;
    if (!n) return -1;
    if (auto && repeat === 'one' && index >= 0) return index;
    if (!shuffle) {
      if (index + 1 < n) return index + 1;
      return auto && repeat !== 'all' ? -1 : 0;
    }
    let pool: number[] = [];
    for (let i = 0; i < n; i++) if (i !== index && !this.played.has(queue[i].id)) pool.push(i);
    if (!pool.length) {
      if (auto && repeat !== 'all') return -1;
      this.restartCycle(queue[index]?.id);
      pool = [];
      for (let i = 0; i < n; i++) if (n === 1 || i !== index) pool.push(i);
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }
}
