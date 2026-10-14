# Resonance VR – YouTube audio proxy (optional)

A tiny self-hosted helper for **personal use**. Without it the app plays YouTube through the official IFrame player and
analyses the sound with the microphone (the headset hears itself). With it, the audio is streamed through the browser's
normal `<audio>` element, so the visualizer analyses the exact signal: no microphone, no room noise, volume independent.

* You run it, on your own machine, for your own use. Do not expose it to the internet or offer it to others.
* It shells out to [yt-dlp](https://github.com/yt-dlp/yt-dlp) (required) and, if present, `ffmpeg` (recommended).
  Respect YouTube's terms of service and copyright law where you live; you are responsible for how you use it.

## Requirements

* Node.js 20 or newer (no npm dependencies)
* `yt-dlp` on your `PATH` (keep it updated: `yt-dlp -U`)
* optional: `ffmpeg` on your `PATH`. With it the stream is transcoded to 192 kbit/s MP3 and **seeking works**
  (the app restarts the stream at the requested position). Without it the raw WebM/Opus stream is passed through and
  seeking is disabled.

## Run it on a LAN host

```sh
cd server
node proxy.mjs            # listens on 0.0.0.0:8787
PORT=9000 HOST=127.0.0.1 node proxy.mjs   # other port / local only
```

Check it from the headset's network: `http://<host-ip>:8787/info?v=dQw4w9WgXcQ` should return JSON.

| Endpoint | Result |
| --- | --- |
| `GET /stream?v=<id>[&t=<seconds>]` | audio stream (`audio/mpeg` with ffmpeg, else `audio/webm`), `Accept-Ranges: none`, CORS open |
| `GET /info?v=<id>` | `{ title, duration, uploader, thumbnail, seekable }` (cached for 10 minutes) |

## Use it in the app

Open the app's settings (the *YouTube proxy URL* field in the Sources / Settings panel), enter the address, e.g.
`http://192.168.1.10:8787`, and play a YouTube link as usual. It is stored in the browser; clear the field to go back to
the microphone method. When a proxy is configured, YouTube tracks play through the proxy; playlists still use the
IFrame API only to list their videos.

### HTTPS pages and plain `http://` proxies

Browsers refuse to load `http://` audio from an `https://` page (mixed content), and a LAN address is not treated as
secure. Pick one:

* Serve the app over plain `http://` on your LAN too (`npm run dev` prints a `http://<ip>:5173` address), or
* On a Quest connected with `adb`: `adb reverse tcp:8787 tcp:8787`, then use `http://localhost:8787` in the app
  (localhost counts as secure), or
* Put the proxy behind HTTPS (for example a reverse proxy such as Caddy, or `tailscale serve`) and use the `https://` URL.

## Troubleshooting

* **"yt-dlp not found"** – install it and restart the proxy; check with `yt-dlp --version`.
* **HTTP 502 with a yt-dlp message** – the video is private, age-restricted or region-locked, or yt-dlp is outdated.
* **No seeking** – start the proxy on a machine that has `ffmpeg` (`/info` reports `"seekable": true`).
* **Stops after a few minutes** – a flaky Wi-Fi link; the proxy kills its children as soon as the client disconnects.
