# Sequence Reality

Your world is an instrument. Walk around with your phone, record sounds, crop them, and drop them into a step sequencer. Pick a style — House, Techno, Hip Hop, Trap, D&B, Reggaeton, UK Garage — and the app lays out the pattern, sets the tempo and places your samples by sound type (kick, snare, hi-hat, percussion).

## Features

- Record from the microphone; a crop window opens right after recording, with the hit already selected
- Style presets that place samples automatically and adjust tempo and playback speed
- 16-step sequencer with up to 8 tracks, mute/solo and swing
- Mixer with volume, pan, pitch, reverb and delay per track
- Projects save automatically in the browser; export/import as `.zip`

## Running it

It's a static site with no build step:

```bash
python -m http.server 5173
```

Then open http://localhost:5173. Phones only allow microphone access over **https**, so to use it on a phone, host it on an https site such as GitHub Pages.

Built with [Tone.js](https://tonejs.github.io/) and [JSZip](https://stuk.github.io/jszip/).
