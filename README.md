# Quantum Reel

One photo in, one click, and out comes a vertical TikTok/Reels-style transition video: the photo
escalates through a series of Moth quantum edits, with cuts locked to the beat of a built-in
soundtrack, flashes, zoom punches, chromatic-aberration bursts and glitch tears.

Built for Moth_Hack challenges **06 Daisy Chain** and **08 Make a web app**. See `SPEC.md` for the brief.

## Run

```
pip install -r requirements.txt
python server.py          # then open http://localhost:8000
```

`MOTH_API_KEY` is read from `.env`. The key stays in `server.py` and never reaches the browser.

## How it works

1. **Upload & frame.** Drop a photo. It's fitted to **9:16** or **1:1**, either cropped to fill or
   letterboxed over a blurred copy of itself, at Moth's 1024 px limit.
2. **Style & engine.** Pick an engine (Quantum Blur, Quantum Deep Fryer, Quantum Teleblur), a
   transition preset and a soundtrack:

   | Preset | Steps | Pacing |
   |---|---|---|
   | The Cyber Glitch | 8 | Cuts on eighths, glitch stutters, strobe, ends by rewinding the chain |
   | Decoherence Bloom | 6 | Crossfades with chromatic pulses on every beat and a slow push-in |
   | The Beat Drop | 8 | Four subtle steps with a riser zoom, then rapid-fire cuts into the drop |

   Teleblur morphs the photo toward a target: a neon interference pattern made from the photo,
   or an image you drop in.
3. **Generate.** All steps are dispatched to Moth at once, each running the engine on the photo
   at a higher strength (the last step is the climax). The reel starts playing immediately with
   classical canvas stand-ins, labelled "Classical preview", and each quantum frame swaps in as
   it lands. **Download** records one loop of the canvas and the music into a single MP4 (WebM
   in browsers that can't record MP4). **Save Final Frame** saves the climax frame as a PNG.

### Beat sync

The three soundtracks are synthesized in the browser with Web Audio, so they're royalty-free by
construction: Cyberpunk Bass (120 BPM, 12 s), Hard Phonk (140 BPM, 13.7 s), Lo-Fi Chill
(90 BPM, 10.7 s). Every cut, strobe and pulse sits on the quarter, eighth or sixteenth-note grid
of the selected track. Playback is clocked by the audio itself, so the visuals can't drift off the
beat. Changing the soundtrack re-times the reel live without re-running anything on Moth.

### Why the steps run in parallel

Moth's queue time ranges from seconds to many hours. A daisy chain (step N edits step N-1's
output) waits in that queue once per step; escalating the strength from the original photo
waits once in total.

### Caching

The server remembers uploads by content hash, runs by engine + params + inputs, and finished jobs.
Pressing Generate again with the same photo and settings, even after a reload or a server restart,
reuses the jobs already submitted. Finished frames come back instantly and queued ones keep
waiting where they were. The photo and settings are restored from the browser on reload.

## Notes

- Export records in real time (about the length of one loop), and the tab must stay visible
  while it records. Hiding it cancels the export instead of saving frozen frames.
- `tessa-image-v1` is left out because every job sent to it has failed.

## Files

- `server.py`: stdlib HTTP server that proxies `/api/upload`, `/api/run`, `/api/job/<id>` and
  `/api/asset/<id>` to Atlas, with the cache index in `.cache/index.json` and images in `.cache/`.
- `atlas.py`: minimal Atlas client (upload, submit, poll, download).
- `static/`: the app (`index.html`, `app.js`, `style.css`). Plain JS, no build step.
