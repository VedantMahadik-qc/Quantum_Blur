# SPEC: Quantum Reel — Automated Quantum Transition Video Generator

## 1. Executive Summary & Core Pivot
Transform the existing "Quantum Layers" codebase away from a manual desktop photo editor into **Quantum Reel**: an automated, one-click generator that takes a single user photo, processes it through sequential quantum transformations via Moth Atlas engines, and renders a trendy, high-energy, vertical (9:16) TikTok/Reels-style transition edit complete with beat-synced cuts, glitch flashes, and background music.

---

## 2. What to Remove vs. What to Keep

### ❌ REMOVE / STRIP OUT:
* **Manual layer editing:** Remove manual masking brush, per-step opacity sliders, custom blend-mode pickers, and timeline dragging.
* **3-Panel Desktop DAW Layout:** Kill the complex left/middle/right desktop layout.
* **Slow frame-fader playback:** Replace the linear crossfade slider with a snappy, rhythmic video generation engine.

###  KEEP & REPURPOSE:
* `server.py` & `atlas.py`: Keep the Moth API proxy and caching layer.
* The sequential chaining pipeline (running step $N$ on the output of step $N-1$ or scaling parameters from step $1 \dots N$).
* Moth engine integrations: Quantum Blur, Deep Fryer, Quantum Teleblur.

---

## 3. The User Journey (3 Simple Steps)

1. **Upload & Frame:**
   * User drops in 1 image.
   * Auto-crops or letterboxes to **9:16 Vertical (Story/Reel)** or **1:1 Square**.
2. **Select Style & Engine:**
   * **Engine:** Dropdown (Quantum Blur, Quantum Deep Fryer, Quantum Teleblur).
   * **Transition Preset (The Pacing Vibe):**
     * *The Cyber Glitch (Fast cuts, strobe flashes, heavy glitch).*
     * *Decoherence Bloom (Smooth quantum blur transition with chromatic pulses).*
     * *The Beat Drop (Slow build-up through 4 subtle steps, then rapid-fire cuts into the final modded visual).*
   * **Soundtrack:** Toggle built-in royalty-free beats / cyber bass loops (e.g., Cyberpunk Bass, Lo-Fi Chill, Hard Phonk).
3. **Generate & Export:**
   * User clicks **"⚡ Generate Quantum Reel"**.
   * App runs progressive transformations, compiles the video with audio in the browser via Canvas + Web Audio / WebCodecs / MediaRecorder, and provides:
     * Live looping video preview in a vertical smartphone frame.
     * **[ Download MP4 / WebM ]** button.
     * **[ Save Final Frame ]** button.

---

## 4. Quantum Processing Pipeline

### Chained State Progression
* Instead of running disconnected jobs, the app creates a sequence of **6 to 10 progressive steps**:
  * **Step 0:** Original photo (clean, baseline state).
  * **Steps 1 to $N-1$:** Progressive quantum parameter escalation (e.g., increasing unitary rotation angle, quantum blur radius, or entanglement noise).
  * **Step $N$:** The climax — full quantum transformation / deep-fried interference pattern.
* **Background Queue:** Show a sleek progress bar ("Dispatching Quantum Circuit...", "Sampling Wavepacket 3/8...", "Applying Transition Shaders...").

---

## 5. Transition & Video Rendering Engine

The video should not be a sluggish slideshow. It must look like a modern social media edit:

### Visual FX Applied on Cuts
* **Rhythmic Flash:** White/cyan flash overlay (1–2 frames) on every transition step.
* **Zoom Pulse:** Subtle scale bounce ($1.0 \rightarrow 1.08 \rightarrow 1.0$) on each cut.
* **Chromatic Aberration / Glitch Displacement:** A 0.15s chromatic aberration burst when transitioning between quantum states.
* **Progressive Chain Overlay:** At the climax, rapidly strobe through all previous layers in quick succession before slamming onto the final image.

### Audio Integration
* Provide 3 built-in royalty-free audio tracks (10–15 seconds loops with distinct BPMs: 120 BPM, 140 BPM, 90 BPM).
* The video cuts **must align mathematically with the beat markers** of the selected audio track:
  * E.g., at 120 BPM (0.5s per beat), cuts snap directly to the quarter-note or eighth-note grid.
* The exported video file must bundle both the canvas video stream and audio stream into a single playable file.

---

## 6. UI/UX Design Specifications

* **Theme:** Sleek, modern dark-mode (`#0a0a0f` background, neon cyan/violet accents, glassmorphic cards).
* **Focal Point:** A central vertical smartphone mockup (`9:16` aspect ratio preview) showing the real-time render.
* **Control Dock:** A clean, minimal control bar beneath or beside the phone:
  * Image Upload dropzone.
  * Engine selector dropdown.
  * Audio track selector dropdown.
  * One prominent glowing action button: **`[ ⚡ Generate Quantum Reel ]`**.
* **Zero clutter:** All complex API configurations (polling intervals, caching, canvas export bitrate) stay under the hood.

---

## 7. Deliverables & Technical Stack

* **Backend (`server.py`, `atlas.py`):**
  * FastAPI or lightweight Python HTTP server acting as API proxy to `https://api.mothquantum.com`.
  * Multi-step dispatch with server-side caching so rerunning identical parameters is instant.
* **Frontend (`static/index.html`, `static/app.js`, `static/style.css`):**
  * Modern Vanilla JS or lightweight reactive UI.
  * Canvas-based video compositor utilizing `CanvasRenderingContext2D` + `Web Audio API` + `MediaRecorder` (mimeType `video/webm` or `video/mp4`).
* **Clean Build:** Must run locally via `python server.py` and open cleanly on `http://localhost:8000`.