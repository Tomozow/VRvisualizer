/** Helpers that derive display metadata (title / artist) from file names, URLs and ID3 tags. */

export interface TrackMeta { title: string; artist?: string }

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|ogg|oga|opus|flac|weba|webm|mp4|m4v|mka|aif|aiff|caf)$/i;

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || file.type === 'video/mp4' || file.type === 'video/webm' || AUDIO_EXT.test(file.name);
}

/** "01 - Artist - Title.mp3" → { artist, title } */
export function parseFileName(name: string): TrackMeta {
  let s = name.replace(AUDIO_EXT, '').trim();
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  if (!s.includes(' ')) s = s.replace(/_+/g, ' ');
  s = s.replace(/^\s*\d{1,3}\s*[-._)]\s*(?=\S)/, '').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(s);
  if (m && m[1].trim() && m[2].trim()) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: s || name };
}

/** Title from the last path segment of a direct audio URL (falls back to the host name) */
export function metaFromUrl(url: URL): TrackMeta {
  const seg = url.pathname.split('/').filter(Boolean).pop();
  return seg ? parseFileName(seg) : { title: url.hostname };
}

const DECODERS: Record<number, string> = { 0: 'windows-1252', 1: 'utf-16', 2: 'utf-16be', 3: 'utf-8' };

function decodeText(bytes: Uint8Array): string {
  if (bytes.length < 2) return '';
  const enc = bytes[0];
  let body = bytes.subarray(1);
  let label = DECODERS[enc] ?? 'utf-8';
  if (enc === 1 && body.length >= 2) {
    if (body[0] === 0xff && body[1] === 0xfe) { label = 'utf-16le'; body = body.subarray(2); }
    else if (body[0] === 0xfe && body[1] === 0xff) { label = 'utf-16be'; body = body.subarray(2); }
    else label = 'utf-16le';
  }
  // eslint-disable-next-line no-control-regex
  return new TextDecoder(label).decode(body).replace(/\u0000+$/g, '').trim();
}

/** Minimal ID3v2 (2.2 / 2.3 / 2.4) reader for title + artist; resolves to {} for anything else. */
export async function readId3(file: File): Promise<Partial<TrackMeta>> {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
    const ver = head[3];
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    const buf = new Uint8Array(await file.slice(10, 10 + Math.min(size, 1 << 20)).arrayBuffer());
    const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
    const out: Partial<TrackMeta> = {};
    for (let p = 0; p + hdr <= buf.length;) {
      const id = String.fromCharCode(...buf.subarray(p, p + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break;
      let len: number;
      if (ver === 2) len = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
      else if (ver === 4) len = ((buf[p + 4] & 0x7f) << 21) | ((buf[p + 5] & 0x7f) << 14) | ((buf[p + 6] & 0x7f) << 7) | (buf[p + 7] & 0x7f);
      else len = ((buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7]) >>> 0;
      if (len <= 0 || p + hdr + len > buf.length) break;
      const frame = buf.subarray(p + hdr, p + hdr + len);
      if (id === 'TIT2' || id === 'TT2') out.title = decodeText(frame) || undefined;
      else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(frame) || undefined;
      if (out.title && out.artist) break;
      p += hdr + len;
    }
    return out;
  } catch {
    return {};
  }
}
