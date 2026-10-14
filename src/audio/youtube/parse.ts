export interface YouTubeRef {
  videoId?: string;
  listId?: string;
}

const ID = /^[\w-]{11}$/;
const LIST = /^(PL|UU|LL|FL|OL|RD)[\w-]{8,}$/;

/** Parse a YouTube watch / youtu.be / shorts / embed / playlist URL, a bare 11-char video id or a bare playlist id. */
export function parseYouTube(input: string): YouTubeRef | null {
  const s = input.trim();
  if (ID.test(s)) return { videoId: s };
  if (LIST.test(s) && s.length > 12) return { listId: s };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const isYt = host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be';
  if (!isYt) return null;

  const ref: YouTubeRef = {};
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') {
    if (parts[0] && ID.test(parts[0])) ref.videoId = parts[0];
  } else {
    const v = url.searchParams.get('v');
    if (v && ID.test(v)) ref.videoId = v;
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0]) && parts[1] && ID.test(parts[1])) ref.videoId = parts[1];
  }
  const list = url.searchParams.get('list');
  if (list && /^[\w-]{10,}$/.test(list)) ref.listId = list;
  return ref.videoId || ref.listId ? ref : null;
}

/** Auto-generated "mix" / radio playlists cannot be enumerated through the embed API */
export function isMixList(listId: string): boolean {
  return listId.startsWith('RD');
}

export function youtubeThumbnail(id: string): string {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}
