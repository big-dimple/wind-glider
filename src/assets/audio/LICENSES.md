# Audio Assets

## Wind Glider Original Soundtrack: "Flight Over Azure Waters" (晴空碧海之翼)

- **Aesthetic**: Ghibli / Celtic Solarpunk acoustic orchestral theme composed of acoustic guitar / Celtic harp fingerpicking, soaring Irish tin whistle / wooden flute solo, warm string quartet (violins, viola, cello), crystal wind chimes / celesta, and soft Bodhran / breeze shaker rhythm.
- **Key & Tempo**: G Major / E minor / D Lydian, 124 BPM, 48 measures (92.9 seconds) seamless loop.
- **Composition & Synthesis**: Deterministic physical modeling & vectorized DSP synthesis via `src/assets/audio/generate_theme.py`.
- **Mastering & Headroom**: 48kHz 24-bit PCM master, stereo acoustic convolution reverb, 32Hz subsonic cut, 11kHz airy high-shelf boost, measured `-15.8 LUFS` integrated loudness with a clean `-1.7 dBTP` true peak.
- **Delivered Formats**:
  - `wind-glider-theme.ogg`: Ogg Vorbis (Quality 6, 48kHz stereo, ~192kbps).
  - `wind-glider-theme.mp3`: MP3 (LAME VBR V0, 48kHz stereo, ~295kbps).
- **Playback Strategy**: Starts upon the first user interaction in READY scene, opens progressively through countdown, soars during flight and racing with dynamic acoustic low-pass filtering and ducking. Looping seamlessly transitions measure 48 back into measure 1 without clicks or silence.
