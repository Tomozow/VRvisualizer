#!/usr/bin/env node
// Resonance VR: optional self-hosted YouTube audio proxy, for personal use only (see README.md).
//   GET /stream?v=<id>[&t=<seconds>]  audio stream with CORS headers (yt-dlp -> ffmpeg mp3, or raw webm without ffmpeg)
//   GET /info?v=<id>                  { title, duration, uploader, thumbnail, seekable }
// Needs Node 20+ and yt-dlp on PATH. Environment: PORT (8787), HOST (0.0.0.0), YTDLP, FFMPEG.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const YTDLP = process.env.YTDLP || 'yt-dlp';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
const ID = /^[\w-]{11}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true', // browsers ask before an https page may reach a LAN address
};
const infoCache = new Map();

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const lastLine = (s, fallback) => s.trim().split('\n').pop() || fallback;
const missing = (e) => (e.code === 'ENOENT' ? `${e.path} not found: install it and make sure it is on PATH` : e.message);
const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

function stream(res, id, t) {
  const yt = spawn(YTDLP, ['-f', 'bestaudio[ext=webm]/bestaudio', '--no-playlist', '-q', '--no-warnings', '-o', '-', watchUrl(id)]);
  const procs = [yt];
  let out = yt.stdout, err = '', started = false;
  yt.stderr.on('data', (d) => (err += d));
  if (hasFfmpeg) {
    const args = ['-v', 'error', ...(t > 0 ? ['-ss', String(t)] : []), '-i', 'pipe:0', '-vn', '-f', 'mp3', '-b:a', '192k', 'pipe:1'];
    const ff = spawn(FFMPEG, args);
    ff.stdin.on('error', () => {});
    ff.stderr.on('data', (d) => (err += d));
    yt.stdout.pipe(ff.stdin);
    procs.push(ff);
    out = ff.stdout;
  }
  const kill = () => procs.forEach((p) => p.kill());
  const fail = (msg) => {
    if (!started && !res.headersSent) send(res, 502, { error: msg });
    else res.end();
    kill();
  };
  res.on('close', kill);
  yt.on('error', (e) => fail(missing(e)));
  for (const p of procs) p.on('close', (code) => { if (code && !started) fail(lastLine(err, `exit code ${code}`)); });
  // wait for the first audio bytes so failures can still be reported as HTTP errors
  out.once('data', (chunk) => {
    started = true;
    res.writeHead(200, { ...CORS, 'Content-Type': hasFfmpeg ? 'audio/mpeg' : 'audio/webm', 'Accept-Ranges': 'none', 'Cache-Control': 'no-store' });
    res.write(chunk);
    out.pipe(res);
  });
}

function info(res, id) {
  const hit = infoCache.get(id);
  if (hit && Date.now() - hit.at < 600_000) return send(res, 200, hit.data);
  const p = spawn(YTDLP, ['-J', '--no-playlist', '--no-warnings', watchUrl(id)]);
  let out = '', err = '';
  const timer = setTimeout(() => p.kill(), 30_000);
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('error', (e) => send(res, 502, { error: missing(e) }));
  p.on('close', (code) => {
    clearTimeout(timer);
    if (res.headersSent) return;
    try {
      const j = JSON.parse(out);
      const data = { title: j.title, duration: j.duration, uploader: j.uploader ?? j.channel, thumbnail: j.thumbnail, seekable: hasFfmpeg };
      infoCache.set(id, { at: Date.now(), data });
      send(res, 200, data);
    } catch {
      send(res, 502, { error: lastLine(err, `yt-dlp exited with code ${code}`) });
    }
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  const id = url.searchParams.get('v') ?? '';
  if (url.pathname === '/stream' || url.pathname === '/info') {
    if (!ID.test(id)) return send(res, 400, { error: 'missing or invalid ?v=<11 character video id>' });
    return url.pathname === '/info' ? info(res, id) : stream(res, id, Math.max(0, Number(url.searchParams.get('t')) || 0));
  }
  send(res, 200, 'Resonance VR YouTube proxy: GET /stream?v=<id> or /info?v=<id>\n', 'text/plain');
}).listen(PORT, HOST, () => {
  console.log(`Resonance VR proxy on http://${HOST}:${PORT}  (${hasFfmpeg ? 'ffmpeg found: mp3 + seeking' : 'no ffmpeg: raw webm, no seeking'})`);
});
