/* Sequence Reality — record the world, crop it, sequence it. */
'use strict';

(() => {
    if (!window.Tone) {
        document.body.innerHTML = '<p style="padding:24px;color:#fff;font-family:sans-serif">The audio engine (Tone.js) could not be loaded. Check your connection and reload.</p>';
        return;
    }

    // =====================================================================
    // Constants
    // =====================================================================
    const STEPS = 16;
    const MAX_TRACKS = 8;
    const MAX_SAMPLES = 24;
    const MAX_REC_SECONDS = 10;
    const MIN_SEL = 0.02;
    const LAST_PROJECT_KEY = 'sr.lastProject';
    const VIEW_KEY = 'sr.view';
    const MIC_KEY = 'sr.mic';

    const ROLES = ['kick', 'snare', 'hat', 'perc'];
    const ROLE_LABEL = { kick: 'KICK', snare: 'SNARE', hat: 'HAT', perc: 'PERC' };
    // Where each role sits on the dark → bright scale (used to rank samples)
    const ROLE_RANK = { kick: 0, perc: 0.4, snare: 0.65, hat: 1 };
    // Typical brightness range of each role. Samples outside it get their playback speed nudged.
    const ROLE_RANGE_HZ = { kick: [30, 250], snare: [1200, 12000], hat: [5000, 20000], perc: [300, 5000] };
    // When one sample has to cover several roles, spread the copies apart.
    const ROLE_REUSE_ST = { kick: -5, snare: 0, hat: 5, perc: 3 };
    const TRACK_COLORS = ['#00ffcc', '#40c4ff', '#ff4fd8', '#ffd23f', '#7cff6b', '#ff8a4c', '#a78bfa', '#ff5e7a'];

    const T = (role, pattern, volume = 0) => ({ role, pattern, volume });
    const PRESETS = [
        {
            id: 'init', name: 'INIT', bpm: 120, swing: 0, desc: 'Empty grid — build your own',
            tracks: [T('kick', '................'), T('snare', '................'), T('hat', '................'), T('perc', '................')]
        },
        {
            id: 'house', name: 'HOUSE', bpm: 124, swing: 0.1, desc: 'Four-on-the-floor, offbeat hats',
            tracks: [T('kick', 'x...x...x...x...'), T('snare', '....x.......x...', -2), T('hat', '..x...x...x...x.', -4), T('perc', '...x..x....x.x..', -6)]
        },
        {
            id: 'techno', name: 'TECHNO', bpm: 132, swing: 0, desc: 'Driving kick, rolling 16th hats',
            tracks: [T('kick', 'x...x...x...x...'), T('snare', '....x.......x...', -4), T('hat', 'xxxxxxxxxxxxxxxx', -8), T('perc', '..x...x...x..xx.', -5)]
        },
        {
            id: 'hiphop', name: 'HIP HOP', bpm: 90, swing: 0.3, desc: 'Boom-bap with lazy swing',
            tracks: [T('kick', 'x......x..x.....'), T('snare', '....x.......x...'), T('hat', 'x.x.x.x.x.x.x.x.', -6), T('perc', '..............x.', -6)]
        },
        {
            id: 'trap', name: 'TRAP', bpm: 140, swing: 0, desc: 'Half-time snare, busy hats',
            tracks: [T('kick', 'x......x...x....'), T('snare', '........x.......'), T('hat', 'x.x.x.x.x.xxx.xx', -7), T('perc', '...x.......x..x.', -6)]
        },
        {
            id: 'dnb', name: 'D&B', bpm: 174, swing: 0, desc: 'Two-step break at 174',
            tracks: [T('kick', 'x.........x.....'), T('snare', '....x.......x...'), T('hat', 'x.x.x.x.x.x.x.x.', -7), T('perc', '.......x.x....x.', -6)]
        },
        {
            id: 'reggaeton', name: 'REGGAETON', bpm: 95, swing: 0, desc: 'Dembow groove',
            tracks: [T('kick', 'x...x...x...x...'), T('snare', '...x..x....x..x.', -2), T('hat', 'x.x.x.x.x.x.x.x.', -8), T('perc', '..x.......x.....', -6)]
        },
        {
            id: 'garage', name: 'UK GARAGE', bpm: 132, swing: 0.4, desc: 'Shuffled 2-step',
            tracks: [T('kick', 'x.........x..x..'), T('snare', '....x.......x...'), T('hat', '..x...x...x...x.', -5), T('perc', '.x.x.x.x.x.x.x.x', -9)]
        }
    ];

    // =====================================================================
    // Small helpers
    // =====================================================================
    const $ = (id) => document.getElementById(id);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const uid = () => (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const rawCtx = () => Tone.getContext().rawContext;
    const pitchRate = (st) => Math.pow(2, st / 12);
    const dbToGain = (db) => (db <= -40 ? 0 : Math.pow(10, db / 20));
    const fmtDb = (v) => (v <= -40 ? '−∞' : `${v > 0 ? '+' : ''}${v} dB`);
    const fmtPan = (v) => (Math.abs(v) < 0.025 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`);
    const fmtPct = (v) => `${Math.round(v * 100)}%`;
    const fmtSt = (v) => `${v > 0 ? '+' : ''}${v} st`;
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } };
    const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const trackColor = (i) => TRACK_COLORS[i % TRACK_COLORS.length];

    function h(tag, attrs = {}, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k === 'style') el.style.cssText = v;
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) if (c != null && c !== false) el.append(c);
        return el;
    }

    const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.5-7.2a.8.8 0 0 0 0-1.4L8.2 4.1a.8.8 0 0 0-1.2.7z" fill="currentColor"/></svg>';
    const svg = (markup) => { const t = document.createElement('template'); t.innerHTML = markup; return t.content.firstChild; };

    // =====================================================================
    // DOM refs
    // =====================================================================
    const dom = {
        projectBtn: $('projectBtn'), projectName: $('projectName'), saveDot: $('saveDot'),
        bpmInput: $('bpmInput'), bpmDown: $('bpmDown'), bpmUp: $('bpmUp'), playBtn: $('playBtn'),
        recBtn: $('recBtn'), recTime: $('recTime'), recMeter: $('recMeter'), recHint: $('recHint'), micSelect: $('micSelect'),
        sampleList: $('sampleList'), sampleCount: $('sampleCount'), demoKitBtn: $('demoKitBtn'), importAudioInput: $('importAudioInput'),
        presetBar: $('presetBar'), presetInfo: $('presetInfo'), pageSwitch: $('pageSwitch'),
        swingInput: $('swingInput'), swingValue: $('swingValue'), seqGrid: $('seqGrid'),
        addTrackBtn: $('addTrackBtn'), autoAssignBtn: $('autoAssignBtn'), clearBtn: $('clearBtn'),
        masterVol: $('masterVol'), masterVolValue: $('masterVolValue'), mixList: $('mixList'),
        projectNameInput: $('projectNameInput'), newProjectBtn: $('newProjectBtn'), exportBtn: $('exportBtn'),
        importInput: $('importInput'), projectList: $('projectList'), storageNote: $('storageNote'), storageUsage: $('storageUsage'),
        editor: $('editor'), edTitle: $('edTitle'), edName: $('edName'), waveWrap: $('waveWrap'), edCanvas: $('edCanvas'),
        shadeL: $('shadeL'), shadeR: $('shadeR'), hStart: $('hStart'), hEnd: $('hEnd'), playhead: $('playhead'),
        selInfo: $('selInfo'), edPlay: $('edPlay'), edAuto: $('edAuto'), edAll: $('edAll'),
        edReverse: $('edReverse'), edNormalize: $('edNormalize'), edPitchDown: $('edPitchDown'), edPitchUp: $('edPitchUp'),
        edPitch: $('edPitch'), edRole: $('edRole'), edDelete: $('edDelete'), edCancel: $('edCancel'), edSave: $('edSave'),
        picker: $('picker'), pickerTitle: $('pickerTitle'), pickerList: $('pickerList'), pickerClose: $('pickerClose'),
        toast: $('toast'),
        tabs: document.querySelectorAll('.tabbar [data-view]'),
        views: document.querySelectorAll('.view'),
    };
    const pageBtns = dom.pageSwitch.querySelectorAll('button');

    // =====================================================================
    // Project model
    // =====================================================================
    let project = null;
    let seqPage = 0;

    const parsePattern = (str) => Array.from({ length: STEPS }, (_, i) => str[i] === 'x');

    function makeTrack(role = 'perc', steps = null) {
        return {
            id: uid(), role, sampleId: null,
            steps: steps || Array(STEPS).fill(false),
            volume: 0, pan: 0, pitch: 0, reverb: 0, delay: 0, mute: false, solo: false
        };
    }

    function defaultProjectName() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `Session ${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function newProject() {
        const now = Date.now();
        return {
            id: uid(), name: defaultProjectName(), createdAt: now, updatedAt: now,
            bpm: 120, swing: 0, presetId: 'init', masterVolume: 0,
            samples: [], tracks: ROLES.map((r) => makeTrack(r))
        };
    }

    const num = (v, fallback) => (Number.isFinite(+v) ? +v : fallback);

    // Validates anything loaded from storage or an imported file.
    function sanitizeProject(p) {
        const base = newProject();
        const samples = (Array.isArray(p.samples) ? p.samples : []).map((s) => {
            let data = s.data;
            if (data instanceof ArrayBuffer) data = new Float32Array(data);
            if (!(data instanceof Float32Array) || data.length < 16) return null;
            const sampleRate = clamp(num(s.sampleRate, 44100), 8000, 192000);
            const dur = data.length / sampleRate;
            const e = s.edit || {};
            let start = clamp(num(e.start, 0), 0, dur);
            let end = clamp(num(e.end, dur), 0, dur);
            if (end - start < MIN_SEL) { start = 0; end = dur; }
            return {
                id: String(s.id || uid()),
                name: String(s.name || 'SAMPLE').slice(0, 24),
                sampleRate, data,
                edit: { start, end, reverse: !!e.reverse, normalize: e.normalize !== false, pitch: clamp(Math.round(num(e.pitch, 0)), -12, 12) },
                roleOverride: ROLES.includes(s.roleOverride) ? s.roleOverride : null
            };
        }).filter(Boolean).slice(0, MAX_SAMPLES);
        const ids = new Set(samples.map((s) => s.id));
        const tracks = (Array.isArray(p.tracks) ? p.tracks : []).slice(0, MAX_TRACKS).map((t) => {
            const nt = makeTrack(ROLES.includes(t.role) ? t.role : 'perc');
            if (t.id) nt.id = String(t.id);
            nt.sampleId = ids.has(t.sampleId) ? t.sampleId : null;
            nt.steps = Array.from({ length: STEPS }, (_, i) => !!(t.steps && t.steps[i]));
            nt.volume = clamp(num(t.volume, 0), -40, 6);
            nt.pan = clamp(num(t.pan, 0), -1, 1);
            nt.pitch = clamp(Math.round(num(t.pitch, 0)), -12, 12);
            nt.reverb = clamp(num(t.reverb, 0), 0, 1);
            nt.delay = clamp(num(t.delay, 0), 0, 1);
            nt.mute = !!t.mute;
            nt.solo = !!t.solo;
            return nt;
        });
        return {
            id: String(p.id || base.id),
            name: String(p.name || base.name).slice(0, 40),
            createdAt: num(p.createdAt, base.createdAt),
            updatedAt: num(p.updatedAt, base.updatedAt),
            bpm: clamp(Math.round(num(p.bpm, 120)), 40, 240),
            swing: clamp(num(p.swing, 0), 0, 0.6),
            presetId: PRESETS.some((x) => x.id === p.presetId) ? p.presetId : 'init',
            masterVolume: clamp(num(p.masterVolume, 0), -40, 6),
            samples,
            tracks: tracks.length ? tracks : base.tracks
        };
    }

    const sampleById = (id) => (id && project.samples.find((s) => s.id === id)) || null;

    // =====================================================================
    // Sample rendering (non-destructive: raw recording + edit settings)
    // =====================================================================
    const renderCache = new Map();

    function renderEdit(sample, edit) {
        const sr = sample.sampleRate;
        const len = sample.data.length;
        let a = clamp(Math.floor(edit.start * sr), 0, len - 1);
        let b = clamp(Math.ceil(edit.end * sr), a + 1, len);
        if (b - a < 32) b = Math.min(len, a + 32);
        const out = new Float32Array(b - a);
        out.set(sample.data.subarray(a, b));
        if (edit.reverse) out.reverse();
        if (edit.normalize) {
            let peak = 0;
            for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > peak) peak = v; }
            if (peak > 1e-4) {
                const g = Math.min(0.95 / peak, 30);
                for (let i = 0; i < out.length; i++) out[i] *= g;
            }
        }
        // Tiny fades so cuts never click
        const fadeIn = Math.min(Math.floor(sr * 0.002), out.length >> 2);
        const fadeOut = Math.min(Math.floor(sr * 0.012), out.length >> 2);
        for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
        for (let i = 0; i < fadeOut; i++) out[out.length - 1 - i] *= i / fadeOut;

        const buffer = rawCtx().createBuffer(1, out.length, sr);
        buffer.getChannelData(0).set(out);
        return { buffer, data: out, features: analyze(out, sr) };
    }

    function getRendered(sample) {
        const e = sample.edit;
        const key = `${e.start}|${e.end}|${e.reverse}|${e.normalize}|${sample.data.length}`;
        const hit = renderCache.get(sample.id);
        if (hit && hit.key === key) return hit;
        const r = renderEdit(sample, e);
        r.key = key;
        renderCache.set(sample.id, r);
        return r;
    }

    function envelope(data, win) {
        const m = Math.ceil(data.length / win);
        const env = new Float32Array(m);
        for (let i = 0; i < m; i++) {
            const s = i * win, e = Math.min(data.length, s + win);
            let sum = 0;
            for (let j = s; j < e; j++) sum += data[j] * data[j];
            env[i] = Math.sqrt(sum / Math.max(1, e - s));
        }
        return env;
    }

    // Cheap sound descriptors: brightness (≈ dominant frequency), low-end share, decay time.
    function analyze(data, sr) {
        const n = data.length;
        const none = { brightness: 0, low: 0, decay: 0, duration: n / sr };
        if (n < 16) return none;
        const win = Math.max(1, Math.round(sr * 0.005));
        const env = envelope(data, win);
        let peak = 0, peakIdx = 0;
        for (let i = 0; i < env.length; i++) if (env[i] > peak) { peak = env[i]; peakIdx = i; }
        if (peak < 1e-5) return none;

        let first = 0, last = env.length - 1;
        while (first < env.length && env[first] < peak * 0.1) first++;
        while (last > first && env[last] < peak * 0.1) last--;
        const s0 = first * win, s1 = Math.min(n, (last + 1) * win);

        let amp = 0;
        for (let i = s0; i < s1; i++) { const v = Math.abs(data[i]); if (v > amp) amp = v; }
        const hyst = amp * 0.02;
        let crossings = 0, sign = 0;
        const k = Math.exp(-2 * Math.PI * 200 / sr);
        let y = 0, eLow = 0, eAll = 0;
        for (let i = s0; i < s1; i++) {
            const x = data[i];
            if (x > hyst) { if (sign < 0) crossings++; sign = 1; }
            else if (x < -hyst) { if (sign > 0) crossings++; sign = -1; }
            y = (1 - k) * x + k * y;
            eLow += y * y;
            eAll += x * x;
        }
        const secs = Math.max(1e-3, (s1 - s0) / sr);
        let d = peakIdx;
        while (d < env.length && env[d] > peak * 0.1) d++;
        return {
            brightness: crossings / 2 / secs,
            low: eAll > 0 ? eLow / eAll : 0,
            decay: (d - peakIdx) * win / sr,
            duration: n / sr
        };
    }

    function guessRole(f) {
        if (f.low > 0.35 && f.brightness < 500) return 'kick';
        if (f.brightness > 3000) return f.decay < 0.09 ? 'hat' : 'snare';
        if (f.brightness > 1200) return 'snare';
        return 'perc';
    }

    const effectiveRole = (s) => s.roleOverride || guessRole(getRendered(s).features);

    // Finds the loudest event in a recording and crops tightly around it.
    function autoCrop(data, sr) {
        const dur = data.length / sr;
        const win = Math.max(1, Math.round(sr * 0.005));
        const env = envelope(data, win);
        // Skip the first 60 ms when looking for the peak: that is usually the screen tap.
        const skip = env.length > 40 ? Math.round(0.06 * sr / win) : 0;
        let peak = 0, pi = skip;
        for (let i = skip; i < env.length; i++) if (env[i] > peak) { peak = env[i]; pi = i; }
        if (peak < 1e-4) return { start: 0, end: dur };

        const sorted = Array.from(env).sort((a, b) => a - b);
        const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;

        const onThr = Math.max(peak * 0.08, floor * 2);
        let s = pi;
        while (s > skip && env[s - 1] > onThr) s--;
        s = Math.max(0, s - 2);

        const offThr = Math.max(peak * 0.03, floor * 1.8);
        const hold = Math.max(1, Math.round(0.06 * sr / win));
        let e = env.length, quiet = 0;
        for (let i = pi; i < env.length; i++) {
            if (env[i] < offThr) {
                if (++quiet >= hold) { e = i - hold + 1; break; }
            } else quiet = 0;
        }
        e = Math.min(env.length, e + 4);

        const start = clamp(s * win / sr, 0, dur);
        let end = clamp(e * win / sr, 0, dur);
        if (end - start < MIN_SEL) end = Math.min(dur, start + Math.max(MIN_SEL, 0.15));
        return { start, end };
    }

    // =====================================================================
    // Audio engine
    // =====================================================================
    const Engine = {
        ready: false,
        nodes: new Map(),

        init() {
            if (this.ready || !project) return;
            this.limiter = new Tone.Limiter(-1).toDestination();
            this.master = new Tone.Gain(dbToGain(project.masterVolume)).connect(this.limiter);
            this.reverb = new Tone.Reverb({ decay: 2.4, preDelay: 0.01, wet: 1 }).connect(this.master);
            this.delay = new Tone.FeedbackDelay({ delayTime: 0.375, feedback: 0.38, wet: 1 }).connect(this.master);
            this.previewBus = new Tone.Gain(1).connect(this.master);
            Tone.Transport.swingSubdivision = '16n';
            Tone.Transport.scheduleRepeat(onStep, '16n', 0);
            this.ready = true;
            this.syncAll();
        },

        syncGlobals() {
            if (!this.ready) return;
            Tone.Transport.bpm.value = project.bpm;
            Tone.Transport.swing = project.swing;
            this.delay.delayTime.rampTo((60 / project.bpm) * 0.75, 0.05); // dotted 8th
            this.master.gain.rampTo(dbToGain(project.masterVolume), 0.05);
        },

        syncAll() {
            if (!this.ready) return;
            this.syncGlobals();
            const ids = new Set(project.tracks.map((t) => t.id));
            for (const [id, n] of this.nodes) {
                if (!ids.has(id)) { this.disposeNode(n); this.nodes.delete(id); }
            }
            for (const t of project.tracks) this.syncTrack(t);
        },

        syncTrack(t) {
            if (!this.ready) return;
            let n = this.nodes.get(t.id);
            if (!n) {
                n = {
                    input: new Tone.Gain(1), panner: new Tone.Panner(0), out: new Tone.Gain(1),
                    rev: new Tone.Gain(0), del: new Tone.Gain(0), voice: null
                };
                n.input.chain(n.panner, n.out, this.master);
                n.out.connect(n.rev);
                n.out.connect(n.del);
                n.rev.connect(this.reverb);
                n.del.connect(this.delay);
                this.nodes.set(t.id, n);
            }
            const anySolo = project.tracks.some((x) => x.solo);
            const muted = t.mute || (anySolo && !t.solo);
            n.panner.pan.rampTo(t.pan, 0.03);
            n.out.gain.rampTo(muted ? 0 : dbToGain(t.volume), 0.03);
            n.rev.gain.rampTo(t.reverb, 0.03);
            n.del.gain.rampTo(t.delay * 0.8, 0.03);
        },

        disposeNode(n) {
            stopVoice(n.voice, rawCtx().currentTime);
            for (const x of [n.input, n.panner, n.out, n.rev, n.del]) { try { x.dispose(); } catch (_) { /* already gone */ } }
        },

        silence() {
            const now = rawCtx().currentTime;
            for (const n of this.nodes.values()) { stopVoice(n.voice, now); n.voice = null; }
            stopPreview();
        }
    };

    function connectToTone(nativeNode, toneNode) {
        if (typeof Tone.connect === 'function') Tone.connect(nativeNode, toneNode);
        else nativeNode.connect(toneNode.input);
    }

    function stopVoice(v, time) {
        if (!v) return;
        try {
            v.gain.gain.cancelScheduledValues(time);
            v.gain.gain.setValueAtTime(v.gain.gain.value, time);
            v.gain.gain.linearRampToValueAtTime(0, time + 0.012);
            v.src.stop(time + 0.02);
        } catch (_) { /* voice already ended */ }
    }

    // Each track is monophonic: a new hit fades out the previous one (like a drum machine).
    function playVoice(track, sample, time) {
        const n = Engine.nodes.get(track.id);
        if (!n) return;
        const r = getRendered(sample);
        const ctx = rawCtx();
        const src = ctx.createBufferSource();
        src.buffer = r.buffer;
        src.playbackRate.value = pitchRate(clamp(sample.edit.pitch + track.pitch, -24, 24));
        const gain = ctx.createGain();
        src.connect(gain);
        connectToTone(gain, n.input);
        if (n.voice) stopVoice(n.voice, time);
        const voice = { src, gain };
        n.voice = voice;
        src.onended = () => {
            try { gain.disconnect(); } catch (_) { /* ignore */ }
            if (n.voice === voice) n.voice = null;
        };
        src.start(time);
    }

    let previewVoice = null;
    function playPreview(buffer, pitchSt, onEnded) {
        stopPreview();
        if (!Engine.ready) return null;
        const ctx = rawCtx();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const rate = pitchRate(pitchSt);
        src.playbackRate.value = rate;
        connectToTone(src, Engine.previewBus);
        const t0 = ctx.currentTime + 0.01;
        const v = { src, t0, rate };
        previewVoice = v;
        src.onended = () => {
            try { src.disconnect(); } catch (_) { /* ignore */ }
            if (previewVoice === v) previewVoice = null;
            if (onEnded) onEnded();
        };
        src.start(t0);
        return v;
    }

    function stopPreview() {
        if (!previewVoice) return;
        const v = previewVoice;
        previewVoice = null;
        try { v.src.stop(); } catch (_) { /* already stopped */ }
    }

    async function previewSample(sample) {
        if (!(await unlockAudio())) return;
        playPreview(getRendered(sample).buffer, sample.edit.pitch);
    }

    function auditionTrack(track) {
        const s = sampleById(track.sampleId);
        if (!s || !Engine.ready || Tone.context.state !== 'running') return;
        playVoice(track, s, rawCtx().currentTime + 0.005);
    }

    // --- Unlocking audio (must happen inside a user gesture, esp. on iOS) ---
    function setAudioSession(type) {
        try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (_) { /* unsupported */ }
    }

    async function unlockAudio() {
        if (!project) return false;
        if (Rec.state === 'idle') setAudioSession('playback'); // iOS: play even with the silent switch on
        if (Tone.context.state !== 'running') {
            try { await Tone.start(); } catch (_) { /* retried on next gesture */ }
        }
        Engine.init();
        return Tone.context.state === 'running';
    }

    // =====================================================================
    // Transport
    // =====================================================================
    let stepCounter = 0;

    function onStep(time) {
        try {
            const step = stepCounter % STEPS;
            stepCounter++;
            const anySolo = project.tracks.some((t) => t.solo);
            for (const t of project.tracks) {
                if (!t.steps[step] || !t.sampleId || t.mute || (anySolo && !t.solo)) continue;
                const s = sampleById(t.sampleId);
                if (s) playVoice(t, s, time);
            }
            Tone.Draw.schedule(() => highlightStep(step), time);
        } catch (err) {
            console.error('Step error', err);
        }
    }

    // Own flag: Tone reports "started" only once the scheduled start time has arrived.
    let playing = false;
    const isPlaying = () => playing;

    async function startTransport() {
        if (!(await unlockAudio())) {
            toast('Audio is blocked — tap Play again.', { type: 'error' });
            return;
        }
        if (isPlaying()) return;
        for (const t of project.tracks) { const s = sampleById(t.sampleId); if (s) getRendered(s); } // pre-render
        if (!project.tracks.some((t) => t.sampleId && t.steps.some(Boolean))) {
            toast(project.samples.length ? 'No steps with samples yet — tap some steps.' : 'Nothing to hear yet — record a few sounds first.');
        }
        Engine.syncAll();
        stepCounter = 0;
        Tone.Transport.position = 0;
        Tone.Transport.start('+0.06');
        playing = true;
        updatePlayUI();
        keepAwake(true);
    }

    function stopTransport() {
        if (!Engine.ready) return;
        playing = false;
        Tone.Transport.stop();
        Tone.Draw.cancel(0);
        Engine.silence();
        highlightStep(-1);
        updatePlayUI();
        keepAwake(false);
    }

    function togglePlay() {
        if (isPlaying()) stopTransport();
        else startTransport();
    }

    function updatePlayUI() {
        const on = isPlaying();
        dom.playBtn.classList.toggle('playing', on);
        dom.playBtn.setAttribute('aria-label', on ? 'Stop' : 'Play');
    }

    let wakeLock = null;
    async function keepAwake(on) {
        try {
            if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => { wakeLock = null; });
            } else if (!on && wakeLock) {
                const w = wakeLock;
                wakeLock = null;
                await w.release();
            }
        } catch (_) { /* not supported or denied */ }
    }

    function commitBpm(v) {
        const bpm = clamp(Math.round(num(v, project.bpm)), 40, 240);
        project.bpm = bpm;
        dom.bpmInput.value = bpm;
        Engine.syncGlobals();
        renderPresetInfo();
        scheduleSave();
    }

    // =====================================================================
    // Recording
    // =====================================================================
    const Rec = { state: 'idle', stream: null, mr: null, chunks: [], t0: 0, raf: 0, source: null, analyser: null, levels: [], buf: null };
    let micDeviceId = lsGet(MIC_KEY) || '';

    function pickMime() {
        if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
        return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/aac']
            .find((t) => MediaRecorder.isTypeSupported(t)) || '';
    }

    function micErrorMessage(e) {
        const name = e && e.name;
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Microphone access was denied. Allow it in your browser’s site settings and try again.';
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone found.';
        if (name === 'NotReadableError') return 'The microphone is busy (another app may be using it).';
        if (name === 'SecurityError') return 'Recording needs a secure page (https://).';
        return `Could not start recording${e && e.message ? `: ${e.message}` : '.'}`;
    }

    async function toggleRecording() {
        if (Rec.state === 'recording') return stopRecording();
        if (Rec.state !== 'idle') return;
        if (project.samples.length >= MAX_SAMPLES) {
            toast(`Sample bay is full (${MAX_SAMPLES}). Delete one first.`, { type: 'error' });
            return;
        }
        if (!window.isSecureContext) {
            toast('Recording needs a secure page — open the app via https:// (or localhost).', { type: 'error', duration: 6000 });
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
            toast('This browser cannot record audio. Try a current Chrome, Safari or Firefox.', { type: 'error' });
            return;
        }
        unlockAudio(); // inside the gesture, before any await
        Rec.state = 'starting';
        renderRecUI();
        try {
            setAudioSession('play-and-record');
            const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
            if (micDeviceId) audio.deviceId = { exact: micDeviceId };
            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio });
            } catch (e) {
                if (micDeviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
                    micDeviceId = '';
                    lsSet(MIC_KEY, '');
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                } else throw e;
            }
            Rec.stream = stream;
            const mime = pickMime();
            Rec.mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
            Rec.chunks = [];
            Rec.mr.ondataavailable = (e) => { if (e.data && e.data.size) Rec.chunks.push(e.data); };
            Rec.mr.start();
            setupMeter(stream);
            Rec.state = 'recording';
            Rec.t0 = performance.now();
            Rec.levels = [];
            renderRecUI();
            recLoop();
            listMics();
        } catch (e) {
            console.error(e);
            cleanupRecording();
            Rec.state = 'idle';
            renderRecUI();
            toast(micErrorMessage(e), { type: 'error', duration: 6000 });
        }
    }

    function setupMeter(stream) {
        try {
            const ctx = rawCtx();
            Rec.source = ctx.createMediaStreamSource(stream);
            Rec.analyser = ctx.createAnalyser();
            Rec.analyser.fftSize = 1024;
            Rec.buf = new Float32Array(Rec.analyser.fftSize);
            Rec.source.connect(Rec.analyser);
        } catch (e) {
            // Metering is optional (e.g. Firefox with mismatched sample rates)
            Rec.source = Rec.analyser = null;
        }
    }

    function recLoop() {
        if (Rec.state !== 'recording') return;
        const secs = (performance.now() - Rec.t0) / 1000;
        dom.recTime.textContent = `${secs.toFixed(1)} s / ${MAX_REC_SECONDS} s`;
        let level = 0;
        if (Rec.analyser) {
            Rec.analyser.getFloatTimeDomainData(Rec.buf);
            for (let i = 0; i < Rec.buf.length; i++) { const v = Math.abs(Rec.buf[i]); if (v > level) level = v; }
        }
        Rec.levels.push(level);
        drawMeter();
        if (secs >= MAX_REC_SECONDS) { stopRecording(); return; }
        Rec.raf = requestAnimationFrame(recLoop);
    }

    function drawMeter() {
        const c = dom.recMeter, g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        const bars = 64, bw = c.width / bars;
        const levels = Rec.levels.slice(-bars);
        levels.forEach((l, i) => {
            const v = Math.min(1, Math.sqrt(l));
            const hgt = Math.max(2, v * c.height);
            g.fillStyle = l > 0.95 ? '#ff3b5c' : '#00ffcc';
            g.fillRect(i * bw + 1, (c.height - hgt) / 2, bw - 2, hgt);
        });
    }

    function cleanupRecording() {
        cancelAnimationFrame(Rec.raf);
        try { Rec.source && Rec.source.disconnect(); } catch (_) { /* ignore */ }
        if (Rec.stream) Rec.stream.getTracks().forEach((t) => t.stop()); // releases the mic (and the iOS recording indicator)
        Rec.stream = Rec.mr = Rec.source = Rec.analyser = null;
        setAudioSession('playback');
    }

    async function stopRecording() {
        if (Rec.state !== 'recording') return;
        Rec.state = 'processing';
        renderRecUI();
        const mr = Rec.mr;
        const blob = await new Promise((resolve) => {
            const finish = () => resolve(new Blob(Rec.chunks, { type: mr.mimeType || (Rec.chunks[0] && Rec.chunks[0].type) || 'audio/webm' }));
            mr.onstop = finish;
            try { mr.stop(); } catch (_) { finish(); }
        });
        cleanupRecording();
        try {
            if (!blob.size) throw new Error('nothing was captured');
            const { data, sampleRate } = await decodeAudioFile(await blob.arrayBuffer());
            if (data.length < sampleRate * 0.05) throw new Error('recording too short');
            const sample = addSample(data, sampleRate);
            openEditor(sample.id, true);
        } catch (e) {
            console.error(e);
            toast(`Could not use that recording (${e.message}).`, { type: 'error' });
        } finally {
            Rec.state = 'idle';
            renderRecUI();
        }
    }

    async function listMics() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        try {
            const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
            dom.micSelect.textContent = '';
            dom.micSelect.append(h('option', { value: '' }, 'Default microphone'));
            devices.forEach((d, i) => dom.micSelect.append(h('option', { value: d.deviceId }, d.label || `Microphone ${i + 1}`)));
            dom.micSelect.value = devices.some((d) => d.deviceId === micDeviceId) ? micDeviceId : '';
        } catch (_) { /* permission not yet granted */ }
    }

    function renderRecUI() {
        const st = Rec.state;
        dom.recBtn.classList.toggle('recording', st === 'recording');
        dom.recBtn.classList.toggle('busy', st === 'starting' || st === 'processing');
        dom.recBtn.setAttribute('aria-label', st === 'recording' ? 'Stop recording' : 'Record');
        if (st === 'idle') {
            dom.recTime.textContent = 'READY';
            const g = dom.recMeter.getContext('2d');
            g.clearRect(0, 0, dom.recMeter.width, dom.recMeter.height);
        } else if (st === 'starting') dom.recTime.textContent = 'OPENING MIC…';
        else if (st === 'processing') dom.recTime.textContent = 'PROCESSING…';
    }

    // =====================================================================
    // Audio file helpers
    // =====================================================================
    function toMono(audioBuffer) {
        const n = audioBuffer.numberOfChannels, len = audioBuffer.length;
        const out = new Float32Array(len);
        for (let c = 0; c < n; c++) {
            const d = audioBuffer.getChannelData(c);
            for (let i = 0; i < len; i++) out[i] += d[i] / n;
        }
        return out;
    }

    function decodeWithContext(ab) {
        const ctx = rawCtx();
        return new Promise((resolve, reject) => {
            try {
                const ret = ctx.decodeAudioData(ab, resolve, reject);
                if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
            } catch (e) { reject(e); }
        });
    }

    async function decodeAudioFile(ab) {
        const wav = decodeWav(ab);
        if (wav) return wav;
        const audio = await decodeWithContext(ab.slice(0));
        return { data: toMono(audio), sampleRate: audio.sampleRate };
    }

    function encodeWav(data, sr) {
        const len = data.length;
        const buf = new ArrayBuffer(44 + len * 2);
        const v = new DataView(buf);
        const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        str(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); str(8, 'WAVE');
        str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        str(36, 'data'); v.setUint32(40, len * 2, true);
        for (let i = 0; i < len; i++) {
            const s = clamp(data[i], -1, 1);
            v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        return buf;
    }

    // Fast path for plain PCM/float WAV; anything else goes through decodeAudioData.
    function decodeWav(ab) {
        try {
            const v = new DataView(ab);
            const str = (o, n) => String.fromCharCode(...new Uint8Array(ab, o, n));
            if (v.byteLength < 44 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null;
            let p = 12, fmt = null;
            while (p + 8 <= v.byteLength) {
                const id = str(p, 4), size = v.getUint32(p + 4, true), body = p + 8;
                if (id === 'fmt ') {
                    fmt = { format: v.getUint16(body, true), ch: v.getUint16(body + 2, true), sr: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
                } else if (id === 'data' && fmt) {
                    const pcm16 = fmt.format === 1 && fmt.bits === 16;
                    const f32 = fmt.format === 3 && fmt.bits === 32;
                    if (!pcm16 && !f32) return null;
                    const bytes = fmt.bits / 8, ch = fmt.ch;
                    const frames = Math.floor(Math.min(size, v.byteLength - body) / (bytes * ch));
                    const out = new Float32Array(frames);
                    for (let f = 0; f < frames; f++) {
                        let sum = 0;
                        for (let c = 0; c < ch; c++) {
                            const off = body + (f * ch + c) * bytes;
                            sum += pcm16 ? v.getInt16(off, true) / 32768 : v.getFloat32(off, true);
                        }
                        out[f] = sum / ch;
                    }
                    return { data: out, sampleRate: fmt.sr };
                }
                p = body + size + (size & 1);
            }
        } catch (_) { /* fall through */ }
        return null;
    }

    function download(blob, filename) {
        const a = h('a', { href: URL.createObjectURL(blob), download: filename });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    // =====================================================================
    // Samples
    // =====================================================================
    function nextSampleName(prefix = 'SAMPLE') {
        const names = new Set(project.samples.map((s) => s.name));
        let i = project.samples.length + 1;
        while (names.has(`${prefix} ${i}`)) i++;
        return `${prefix} ${i}`;
    }

    function addSample(data, sampleRate, name, { crop = true, roleOverride = null } = {}) {
        const dur = data.length / sampleRate;
        const sample = {
            id: uid(),
            name: name || nextSampleName(),
            sampleRate, data,
            edit: { ...(crop ? autoCrop(data, sampleRate) : { start: 0, end: dur }), reverse: false, normalize: true, pitch: 0 },
            roleOverride
        };
        project.samples.push(sample);
        renderSamples();
        scheduleSave();
        return sample;
    }

    function deleteSample(id) {
        const s = sampleById(id);
        if (!s) return;
        project.samples = project.samples.filter((x) => x.id !== id);
        project.tracks.forEach((t) => { if (t.sampleId === id) t.sampleId = null; });
        renderCache.delete(id);
        renderSamples();
        renderSeq();
        renderMix();
        scheduleSave();
    }

    function drawMini(canvas, data) {
        const g = canvas.getContext('2d');
        const w = canvas.width, hh = canvas.height, mid = hh / 2;
        g.clearRect(0, 0, w, hh);
        g.fillStyle = 'rgba(0,255,204,0.75)';
        const per = data.length / w;
        for (let x = 0; x < w; x++) {
            const a = Math.floor(x * per), b = Math.max(a + 1, Math.floor((x + 1) * per));
            let peak = 0;
            for (let i = a; i < b && i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
            const y = Math.max(1, peak * mid * 0.95);
            g.fillRect(x, mid - y, 1, y * 2);
        }
    }

    function synthDemoKit(sr = 44100) {
        const make = (secs, fn) => { const d = new Float32Array(Math.floor(secs * sr)); fn(d); return d; };
        const kick = make(0.5, (d) => {
            let ph = 0;
            for (let i = 0; i < d.length; i++) {
                const t = i / sr;
                ph += 2 * Math.PI * (45 + 110 * Math.exp(-t * 25)) / sr;
                d[i] = Math.sin(ph) * Math.exp(-t * 7) * 0.95;
            }
        });
        const snare = make(0.3, (d) => {
            let ph = 0;
            for (let i = 0; i < d.length; i++) {
                const t = i / sr;
                ph += 2 * Math.PI * 190 / sr;
                d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 18) * 0.6 + Math.sin(ph) * Math.exp(-t * 30) * 0.5;
            }
        });
        const hat = make(0.12, (d) => {
            let prev = 0;
            for (let i = 0; i < d.length; i++) {
                const x = Math.random() * 2 - 1;
                d[i] = (x - prev) * 0.5 * Math.exp(-(i / sr) * 45);
                prev = x;
            }
        });
        const block = make(0.25, (d) => {
            for (let i = 0; i < d.length; i++) {
                const t = i / sr;
                d[i] = (Math.sin(2 * Math.PI * 820 * t) * 0.6 + Math.sin(2 * Math.PI * 1230 * t) * 0.3) * Math.exp(-t * 28);
            }
        });
        return [['DEMO KICK', kick], ['DEMO SNARE', snare], ['DEMO HAT', hat], ['DEMO BLOCK', block]];
    }

    function loadDemoKit() {
        const kit = synthDemoKit();
        const room = MAX_SAMPLES - project.samples.length;
        if (room <= 0) { toast('Sample bay is full.', { type: 'error' }); return; }
        kit.slice(0, room).forEach(([name, data]) => addSample(data, 44100, name, { crop: false }));
        const placed = autoAssign(true);
        Engine.syncAll();
        renderSeq();
        renderMix();
        toast(placed ? `Demo kit loaded · placed on ${placed} empty track${placed > 1 ? 's' : ''}` : 'Demo kit loaded', { type: 'success' });
    }

    async function importAudio(file) {
        if (!file) return;
        if (project.samples.length >= MAX_SAMPLES) { toast('Sample bay is full.', { type: 'error' }); return; }
        if (file.size > 30 * 1024 * 1024) { toast('That file is too large (max 30 MB).', { type: 'error' }); return; }
        try {
            const { data, sampleRate } = await decodeAudioFile(await file.arrayBuffer());
            const maxLen = Math.floor(sampleRate * 20);
            const clipped = data.length > maxLen ? data.slice(0, maxLen) : data;
            const base = file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 24) || null;
            const sample = addSample(clipped, sampleRate, base);
            if (data.length > maxLen) toast('Long file — only the first 20 seconds were imported.');
            openEditor(sample.id, true);
        } catch (e) {
            console.error(e);
            toast('Could not read that audio file.', { type: 'error' });
        }
    }

    // =====================================================================
    // Presets & automatic sample placement
    // =====================================================================
    function suggestPitch(role, f, reused) {
        const [lo, hi] = ROLE_RANGE_HZ[role];
        const b = Math.max(20, f.brightness);
        let st = 0;
        if (f.brightness && b < lo) st = 12 * Math.log2(lo / b) * 0.5;
        else if (f.brightness && b > hi) st = 12 * Math.log2(hi / b) * 0.5;
        if (reused && Math.abs(st) < 1) st = ROLE_REUSE_ST[role];
        return clamp(Math.round(st), -7, 7);
    }

    // Places samples on tracks by matching each track's role (kick/snare/hat/perc)
    // to the sound character of the recordings. Returns how many tracks were filled.
    function autoAssign(onlyEmpty) {
        if (!project.samples.length) return 0;
        const feats = project.samples.map((s) => ({ s, f: getRendered(s).features }));
        const byBright = [...feats].sort((a, b) => a.f.brightness - b.f.brightness);
        byBright.forEach((x, i) => { x.rank = byBright.length > 1 ? i / (byBright.length - 1) : 0.5; });

        const used = new Map();
        if (onlyEmpty) project.tracks.forEach((t) => { if (t.sampleId) used.set(t.sampleId, (used.get(t.sampleId) || 0) + 1); });

        const order = ['kick', 'snare', 'hat', 'perc'];
        const targets = project.tracks
            .filter((t) => !onlyEmpty || !t.sampleId)
            .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));

        for (const t of targets) {
            let best = null, bestScore = -Infinity;
            for (const x of feats) {
                let score = -Math.abs(x.rank - ROLE_RANK[t.role]) * 2;
                if (x.s.roleOverride) score += x.s.roleOverride === t.role ? 5 : -1;
                else if (guessRole(x.f) === t.role) score += 1;
                if (t.role === 'kick') score += x.f.low;
                if (t.role === 'hat') score -= Math.min(x.f.decay, 1) * 0.5;
                score -= (used.get(x.s.id) || 0) * 3;
                if (score > bestScore) { bestScore = score; best = x; }
            }
            const count = (used.get(best.s.id) || 0) + 1;
            used.set(best.s.id, count);
            t.sampleId = best.s.id;
            // "Playback speed" adjustment: nudge the sample towards its role
            t.pitch = best.s.roleOverride === t.role ? 0 : suggestPitch(t.role, best.f, count > 1);
        }
        return targets.length;
    }

    function snapshot() {
        return JSON.stringify({ tracks: project.tracks, bpm: project.bpm, swing: project.swing, presetId: project.presetId });
    }

    function restore(snap) {
        const s = JSON.parse(snap);
        const ids = new Set(project.samples.map((x) => x.id));
        s.tracks.forEach((t) => { if (!ids.has(t.sampleId)) t.sampleId = null; });
        Object.assign(project, s);
        Engine.syncAll();
        renderAll();
        scheduleSave();
    }

    function applyPreset(id) {
        const pr = PRESETS.find((p) => p.id === id);
        if (!pr) return;
        const before = snapshot();
        project.tracks = pr.tracks.map((pt, i) => {
            const t = makeTrack(pt.role, parsePattern(pt.pattern));
            if (project.tracks[i]) t.id = project.tracks[i].id; // reuse the audio channel
            t.volume = pt.volume;
            return t;
        });
        project.bpm = pr.bpm;
        project.swing = pr.swing;
        project.presetId = pr.id;
        const placed = autoAssign(false);
        Engine.syncAll();
        renderAll();
        scheduleSave();
        let msg = `${pr.name} · ${pr.bpm} BPM`;
        if (pr.id !== 'init') msg += placed ? ' · samples placed' : ' · record sounds to fill it';
        toast(msg, { action: { label: 'Undo', fn: () => restore(before) } });
    }

    // =====================================================================
    // Rendering
    // =====================================================================
    function renderAll() {
        renderHeader();
        renderSamples();
        renderPresets();
        renderSeq();
        renderMix();
        dom.projectNameInput.value = project.name;
        if (currentView === 'projects') renderProjects();
    }

    function renderHeader() {
        dom.projectName.textContent = project.name;
        dom.bpmInput.value = project.bpm;
        updatePlayUI();
    }

    function renderSamples() {
        const list = dom.sampleList;
        list.textContent = '';
        dom.sampleCount.textContent = `${project.samples.length} / ${MAX_SAMPLES}`;
        if (!project.samples.length) {
            list.append(h('p', { class: 'empty' }, 'No samples yet. Record something — a door knock, a mug, your keys, a bottle cap.'));
            return;
        }
        for (const s of project.samples) {
            const r = getRendered(s);
            const canvas = h('canvas', { class: 'mini-wave', width: 240, height: 48 });
            drawMini(canvas, r.data);
            list.append(h('div', { class: 'sample-card', 'data-id': s.id },
                h('button', { class: 'sample-main', 'data-action': 'edit', title: 'Edit / crop' },
                    canvas,
                    h('span', { class: 'sample-name', text: s.name }),
                    h('span', { class: 'sample-meta' },
                        h('span', { class: `badge${s.roleOverride ? '' : ' auto'}`, title: s.roleOverride ? 'Sound type (set by you)' : 'Sound type (auto-detected)' }, ROLE_LABEL[effectiveRole(s)]),
                        h('span', { class: 'sample-len' }, `${r.buffer.duration.toFixed(2)} s`))
                ),
                h('button', { class: 'sample-play', 'data-action': 'preview', 'aria-label': `Play ${s.name}` }, svg(PLAY_SVG))
            ));
        }
    }

    function renderPresets() {
        dom.presetBar.textContent = '';
        for (const p of PRESETS) {
            dom.presetBar.append(h('button', {
                class: `preset-chip${p.id === project.presetId ? ' active' : ''}`,
                'data-preset': p.id,
                'aria-pressed': String(p.id === project.presetId)
            }, p.name));
        }
        renderPresetInfo();
    }

    function renderPresetInfo() {
        const p = PRESETS.find((x) => x.id === project.presetId) || PRESETS[0];
        dom.presetInfo.textContent = `${p.name} — ${p.desc}. Tap a style: steps, tempo and samples are set automatically.`;
        dom.swingInput.value = project.swing;
        dom.swingValue.textContent = fmtPct(project.swing);
    }

    let stepCols = [];
    let lastStep = -1;

    function renderSeq() {
        const grid = dom.seqGrid;
        grid.textContent = '';
        grid.className = `seq-grid page-${seqPage}`;
        pageBtns.forEach((b, i) => b.classList.toggle('active', i === seqPage));
        const anySolo = project.tracks.some((t) => t.solo);

        project.tracks.forEach((t, ti) => {
            const s = sampleById(t.sampleId);
            const muted = t.mute || (anySolo && !t.solo);
            const steps = h('div', { class: 'steps' });
            for (let si = 0; si < STEPS; si++) {
                steps.append(h('button', {
                    class: `step${si % 4 === 0 ? ' beat' : ''}${t.steps[si] ? ' on' : ''}`,
                    'data-track': ti, 'data-step': si,
                    'aria-pressed': String(t.steps[si]),
                    'aria-label': `Track ${ti + 1} step ${si + 1}`
                }));
            }
            grid.append(h('div', { class: `track${muted ? ' muted' : ''}`, style: `--c:${trackColor(ti)}` },
                h('div', { class: 'track-head' },
                    h('button', { class: `sample-btn${s ? '' : ' empty-track'}`, 'data-action': 'pick', 'data-track': ti, title: 'Choose sample' },
                        h('span', { class: 'label' }, s ? s.name : 'Empty — tap to choose')),
                    h('span', { class: 'role-chip' }, ROLE_LABEL[t.role]),
                    h('button', { class: `ms-btn mute${t.mute ? ' on' : ''}`, 'data-action': 'mute', 'data-track': ti, 'aria-pressed': String(t.mute), title: 'Mute' }, 'M'),
                    h('button', { class: `ms-btn solo${t.solo ? ' on' : ''}`, 'data-action': 'solo', 'data-track': ti, 'aria-pressed': String(t.solo), title: 'Solo' }, 'S')
                ),
                steps
            ));
        });

        stepCols = Array.from({ length: STEPS }, (_, i) => Array.from(grid.querySelectorAll(`.step[data-step="${i}"]`)));
        lastStep = -1;
        dom.addTrackBtn.disabled = project.tracks.length >= MAX_TRACKS;
    }

    function highlightStep(step) {
        if (lastStep >= 0 && stepCols[lastStep]) stepCols[lastStep].forEach((c) => c.classList.remove('now'));
        lastStep = step;
        if (step >= 0 && stepCols[step]) stepCols[step].forEach((c) => c.classList.add('now'));
        const page = step < 0 ? -1 : Math.floor(step / 8);
        pageBtns.forEach((b, i) => b.classList.toggle('playing', i === page && i !== seqPage));
    }

    function setStep(ti, si, value, audition) {
        const t = project.tracks[ti];
        if (!t || t.steps[si] === value) return;
        t.steps[si] = value;
        const cell = stepCols[si] && stepCols[si][ti];
        if (cell) {
            cell.classList.toggle('on', value);
            cell.setAttribute('aria-pressed', String(value));
        }
        if (value && audition && !isPlaying()) auditionTrack(t);
        scheduleSave();
    }

    function renderMix() {
        dom.masterVol.value = project.masterVolume;
        dom.masterVolValue.textContent = fmtDb(project.masterVolume);
        const list = dom.mixList;
        list.textContent = '';
        const slider = (ti, param, label, min, max, step, value, fmt) => h('label', { class: 'slider-row' },
            h('span', {}, label),
            h('input', { type: 'range', min, max, step, value, 'data-track': ti, 'data-param': param, 'aria-label': `${label}, track ${ti + 1}` }),
            h('output', {}, fmt(value)));
        project.tracks.forEach((t, ti) => {
            const s = sampleById(t.sampleId);
            list.append(h('div', { class: 'mix-card', style: `--c:${trackColor(ti)}` },
                h('div', { class: 'mix-head' },
                    h('strong', {}, `${ti + 1} · ${s ? s.name : 'Empty'}`),
                    h('span', { class: 'role-chip' }, ROLE_LABEL[t.role]),
                    h('button', { class: 'icon-btn', 'data-action': 'remove', 'data-track': ti, 'aria-label': `Remove track ${ti + 1}`, title: 'Remove track', disabled: project.tracks.length <= 1 }, '✕')
                ),
                slider(ti, 'volume', 'Volume', -40, 6, 1, t.volume, fmtDb),
                slider(ti, 'pan', 'Pan', -1, 1, 0.05, t.pan, fmtPan),
                slider(ti, 'pitch', 'Pitch', -12, 12, 1, t.pitch, fmtSt),
                slider(ti, 'reverb', 'Reverb', 0, 1, 0.01, t.reverb, fmtPct),
                slider(ti, 'delay', 'Delay', 0, 1, 0.01, t.delay, fmtPct)
            ));
        });
    }

    const MIX_FORMAT = { volume: fmtDb, pan: fmtPan, pitch: fmtSt, reverb: fmtPct, delay: fmtPct };

    async function renderProjects() {
        const list = dom.projectList;
        if (!DB.ok) {
            list.textContent = '';
            list.append(h('p', { class: 'empty' }, 'Saving is not available in this browser mode.'));
            return;
        }
        let metas = [];
        try { metas = await DB.listMeta(); } catch (e) { console.error(e); }
        metas.sort((a, b) => b.updatedAt - a.updatedAt);
        list.textContent = '';
        if (!metas.length) list.append(h('p', { class: 'empty' }, 'No saved projects yet.'));
        for (const m of metas) {
            const current = m.id === project.id;
            const date = new Date(m.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
            list.append(h('div', { class: `project-item${current ? ' current' : ''}`, 'data-id': m.id },
                h('div', { class: 'info' },
                    h('div', { class: 'title' }, m.name + (current ? ' (open)' : '')),
                    h('div', { class: 'meta' }, `${m.sampleCount} samples · ${m.bpm} BPM · ${date}`)),
                current ? null : h('button', { 'data-action': 'open' }, 'Open'),
                h('button', { class: 'danger', 'data-action': 'delete', 'aria-label': `Delete ${m.name}` }, 'Delete')
            ));
        }
        if (navigator.storage && navigator.storage.estimate) {
            try {
                const est = await navigator.storage.estimate();
                dom.storageUsage.textContent = `${(est.usage / 1048576).toFixed(1)} MB used`;
            } catch (_) { /* ignore */ }
        }
    }

    // =====================================================================
    // Editor (crop window)
    // =====================================================================
    const Ed = { open: false, id: null, isNew: false, edit: null, roleOverride: null, dur: 0, drag: null, previewing: false, raf: 0 };

    function openEditor(id, isNew = false) {
        const s = sampleById(id);
        if (!s) return;
        stopPreview();
        closePicker();
        Object.assign(Ed, {
            open: true, id, isNew, edit: { ...s.edit }, roleOverride: s.roleOverride,
            dur: s.data.length / s.sampleRate, drag: null, previewing: false
        });
        dom.edTitle.textContent = isNew ? 'New sample — crop it' : 'Edit sample';
        dom.edName.value = s.name;
        dom.edRole.value = s.roleOverride || 'auto';
        dom.edDelete.textContent = isNew ? 'Discard' : 'Delete';
        dom.edCancel.hidden = isNew;
        dom.editor.hidden = false;
        document.body.classList.add('modal-open');
        requestAnimationFrame(() => {
            drawEditorWave();
            updateEditorUI();
            refreshEditorRole();
        });
    }

    function closeEditor() {
        if (!Ed.open) return;
        stopEditorPreview();
        Ed.open = false;
        Ed.drag = null;
        dom.editor.hidden = true;
        document.body.classList.remove('modal-open');
    }

    function drawEditorWave() {
        const s = sampleById(Ed.id);
        if (!s) return;
        const c = dom.edCanvas;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        c.width = Math.max(1, Math.round(c.clientWidth * dpr));
        c.height = Math.max(1, Math.round(c.clientHeight * dpr));
        const g = c.getContext('2d');
        const w = c.width, hh = c.height, mid = hh / 2;
        g.clearRect(0, 0, w, hh);
        g.fillStyle = 'rgba(64,196,255,0.15)';
        g.fillRect(0, mid, w, 1);
        g.fillStyle = '#00ffcc';
        const data = s.data, per = data.length / w;
        let peak = 0;
        for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
        const scale = peak > 1e-4 ? (mid * 0.92) / peak : mid;
        for (let x = 0; x < w; x++) {
            const a = Math.floor(x * per), b = Math.max(a + 1, Math.floor((x + 1) * per));
            let mn = 0, mx = 0;
            for (let i = a; i < b && i < data.length; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
            const y1 = mid - mx * scale, y2 = mid - mn * scale;
            g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
        }
    }

    function updateEditorUI() {
        const { start, end, pitch, reverse, normalize } = Ed.edit;
        const a = (start / Ed.dur) * 100, b = (end / Ed.dur) * 100;
        dom.hStart.style.left = `${a}%`;
        dom.hEnd.style.left = `${b}%`;
        dom.shadeL.style.width = `${a}%`;
        dom.shadeR.style.width = `${100 - b}%`;
        dom.selInfo.textContent = `${(end - start).toFixed(2)} s of ${Ed.dur.toFixed(2)} s`;
        dom.edPitch.textContent = fmtSt(pitch);
        dom.edReverse.setAttribute('aria-pressed', String(reverse));
        dom.edNormalize.setAttribute('aria-pressed', String(normalize));
    }

    function refreshEditorRole() {
        const s = sampleById(Ed.id);
        if (!s) return;
        const f = renderEdit(s, Ed.edit).features;
        dom.edRole.options[0].textContent = `Auto (sounds like ${ROLE_LABEL[guessRole(f)]})`;
    }

    function editorTimeAt(clientX) {
        const r = dom.waveWrap.getBoundingClientRect();
        return clamp((clientX - r.left) / r.width, 0, 1) * Ed.dur;
    }

    function moveHandle(which, t) {
        if (which === 'start') Ed.edit.start = clamp(t, 0, Ed.edit.end - MIN_SEL);
        else Ed.edit.end = clamp(t, Ed.edit.start + MIN_SEL, Ed.dur);
        updateEditorUI();
    }

    function stopEditorPreview() {
        cancelAnimationFrame(Ed.raf);
        Ed.previewing = false;
        stopPreview();
        dom.playhead.style.display = 'none';
        dom.edPlay.textContent = '▶ Play';
    }

    async function toggleEditorPreview() {
        if (Ed.previewing) { stopEditorPreview(); return; }
        if (!(await unlockAudio())) return;
        const s = sampleById(Ed.id);
        if (!s || !Ed.open) return;
        const edit = { ...Ed.edit };
        const r = renderEdit(s, edit);
        const v = playPreview(r.buffer, edit.pitch, () => { if (Ed.previewing && !previewVoice) stopEditorPreview(); });
        if (!v) return;
        Ed.previewing = true;
        dom.edPlay.textContent = '■ Stop';
        const len = edit.end - edit.start;
        const tick = () => {
            if (!Ed.previewing || previewVoice !== v) return;
            const frac = clamp(((rawCtx().currentTime - v.t0) * v.rate) / len, 0, 1);
            const pos = edit.reverse ? edit.end - frac * len : edit.start + frac * len;
            dom.playhead.style.left = `${(pos / Ed.dur) * 100}%`;
            dom.playhead.style.display = 'block';
            Ed.raf = requestAnimationFrame(tick);
        };
        tick();
    }

    function saveEditor() {
        const s = sampleById(Ed.id);
        if (!s) { closeEditor(); return; }
        s.name = (dom.edName.value.trim() || s.name).slice(0, 24);
        s.edit = { ...Ed.edit };
        s.roleOverride = Ed.roleOverride;
        const wasNew = Ed.isNew;
        closeEditor();
        let msg = 'Sample saved';
        if (wasNew) {
            const placed = autoAssign(true);
            if (placed) {
                Engine.syncAll();
                msg = `Saved · placed on ${placed} empty track${placed > 1 ? 's' : ''}`;
            }
        }
        renderSamples();
        renderSeq();
        renderMix();
        scheduleSave();
        toast(msg, { type: 'success' });
    }

    function deleteFromEditor() {
        const s = sampleById(Ed.id);
        if (!s) { closeEditor(); return; }
        const ok = Ed.isNew
            ? confirm('Discard this recording?')
            : confirm(`Delete "${s.name}"? It will be removed from all tracks.`);
        if (!ok) return;
        closeEditor();
        deleteSample(s.id);
    }

    // =====================================================================
    // Sample picker
    // =====================================================================
    let pickerTrack = -1;

    function openPicker(ti) {
        pickerTrack = ti;
        const t = project.tracks[ti];
        dom.pickerTitle.textContent = `Track ${ti + 1} · ${ROLE_LABEL[t.role]}`;
        const list = dom.pickerList;
        list.textContent = '';
        if (!project.samples.length) {
            list.append(h('p', { class: 'empty' }, 'No samples yet — go to Record first.'));
        }
        for (const s of project.samples) {
            list.append(h('div', { class: 'picker-item' },
                h('button', { class: 'sample-play', style: 'position:static', 'data-preview': s.id, 'aria-label': `Play ${s.name}` }, svg(PLAY_SVG)),
                h('button', { class: `choose${t.sampleId === s.id ? ' current' : ''}`, 'data-choose': s.id },
                    h('span', { class: 'label' }, s.name),
                    h('span', { class: `badge${s.roleOverride ? '' : ' auto'}` }, ROLE_LABEL[effectiveRole(s)]))
            ));
        }
        if (t.sampleId) list.append(h('button', { class: 'ghost', 'data-choose': '' }, 'Remove sample from this track'));
        dom.picker.hidden = false;
        document.body.classList.add('modal-open');
    }

    function closePicker() {
        if (dom.picker.hidden) return;
        dom.picker.hidden = true;
        pickerTrack = -1;
        stopPreview();
        if (!Ed.open) document.body.classList.remove('modal-open');
    }

    // =====================================================================
    // Persistence (IndexedDB) — swap this object for a cloud backend later
    // =====================================================================
    const DB = {
        db: null, ok: false,
        async open() {
            if (!window.indexedDB) return false;
            try {
                this.db = await new Promise((resolve, reject) => {
                    const r = indexedDB.open('sequence-reality', 1);
                    r.onupgradeneeded = () => {
                        const db = r.result;
                        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
                        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
                    };
                    r.onsuccess = () => resolve(r.result);
                    r.onerror = () => reject(r.error);
                    r.onblocked = () => reject(new Error('database blocked'));
                });
                this.ok = true;
            } catch (e) {
                console.warn('IndexedDB unavailable', e);
                this.ok = false;
            }
            return this.ok;
        },
        run(stores, mode, fn) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(stores, mode);
                const req = fn(tx);
                tx.oncomplete = () => resolve(req ? req.result : undefined);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
            });
        },
        put(p) {
            const meta = { id: p.id, name: p.name, updatedAt: p.updatedAt, createdAt: p.createdAt, bpm: p.bpm, presetId: p.presetId, sampleCount: p.samples.length };
            return this.run(['projects', 'meta'], 'readwrite', (tx) => {
                tx.objectStore('projects').put(p);
                tx.objectStore('meta').put(meta);
            });
        },
        get(id) { return this.run('projects', 'readonly', (tx) => tx.objectStore('projects').get(id)); },
        listMeta() { return this.run('meta', 'readonly', (tx) => tx.objectStore('meta').getAll()); },
        remove(id) {
            return this.run(['projects', 'meta'], 'readwrite', (tx) => {
                tx.objectStore('projects').delete(id);
                tx.objectStore('meta').delete(id);
            });
        }
    };

    let saveTimer = 0, saving = false, saveAgain = false, version = 0, savedVersion = 0;

    function setSaveState(state) {
        dom.saveDot.className = `save-dot ${state}`;
        dom.saveDot.title = { saved: 'All changes saved', dirty: 'Unsaved changes', saving: 'Saving…', error: 'Save failed', off: 'Not saved (storage unavailable)' }[state] || '';
    }

    function scheduleSave() {
        if (!project) return;
        version++;
        if (!DB.ok) return;
        setSaveState('dirty');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveNow, 700);
    }

    async function saveNow() {
        clearTimeout(saveTimer);
        if (!DB.ok || !project) return;
        if (saving) { saveAgain = true; return; }
        saving = true;
        const v = version;
        setSaveState('saving');
        try {
            project.updatedAt = Date.now();
            await DB.put(project);
            lsSet(LAST_PROJECT_KEY, project.id);
            savedVersion = Math.max(savedVersion, v);
            setSaveState(version > savedVersion ? 'dirty' : 'saved');
        } catch (e) {
            console.error('Save failed', e);
            setSaveState('error');
            toast(e && e.name === 'QuotaExceededError'
                ? 'Storage is full — export and delete old projects.'
                : 'Could not save the project.', { type: 'error' });
        } finally {
            saving = false;
            if (saveAgain) { saveAgain = false; saveNow(); }
        }
    }

    async function switchProject(next) {
        stopTransport();
        closeEditor();
        closePicker();
        await saveNow();
        renderCache.clear();
        project = sanitizeProject(next);
        version++;
        Engine.syncAll();
        renderAll();
        await saveNow();
    }

    async function openProject(id) {
        try {
            const p = await DB.get(id);
            if (!p) throw new Error('not found');
            await switchProject(p);
            toast(`Opened "${project.name}"`);
        } catch (e) {
            console.error(e);
            toast('Could not open that project.', { type: 'error' });
        }
    }

    async function deleteProject(id) {
        let name = 'this project';
        try { const metas = await DB.listMeta(); name = `"${(metas.find((m) => m.id === id) || {}).name || 'project'}"`; } catch (_) { /* ignore */ }
        if (!confirm(`Delete ${name} permanently? This cannot be undone.`)) return;
        try {
            await DB.remove(id);
            if (id === project.id) {
                const metas = (await DB.listMeta()).sort((a, b) => b.updatedAt - a.updatedAt);
                const next = metas[0] ? await DB.get(metas[0].id) : null;
                // Avoid re-saving the deleted project while switching
                project = null;
                project = sanitizeProject(next || newProject());
                renderCache.clear();
                Engine.syncAll();
                renderAll();
                await saveNow();
            }
            renderProjects();
            toast('Project deleted');
        } catch (e) {
            console.error(e);
            toast('Could not delete the project.', { type: 'error' });
        }
    }

    async function exportProject() {
        if (!window.JSZip) { toast('Export is unavailable (JSZip failed to load).', { type: 'error' }); return; }
        try {
            const zip = new JSZip();
            const used = new Set();
            const samples = project.samples.map((s) => {
                const base = slug(s.name) || 'sample';
                let f = base, k = 2;
                while (used.has(f)) f = `${base}-${k++}`;
                used.add(f);
                const file = `samples/${f}.wav`;
                zip.file(file, encodeWav(s.data, s.sampleRate));
                return { id: s.id, name: s.name, sampleRate: s.sampleRate, edit: s.edit, roleOverride: s.roleOverride, file };
            });
            const meta = {
                format: 'sequence-reality', version: 1,
                name: project.name, bpm: project.bpm, swing: project.swing, presetId: project.presetId,
                masterVolume: project.masterVolume, tracks: project.tracks, samples
            };
            zip.file('project.json', JSON.stringify(meta, null, 2));
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            download(blob, `${slug(project.name) || 'project'}.zip`);
        } catch (e) {
            console.error(e);
            toast('Export failed.', { type: 'error' });
        }
    }

    async function importProject(file) {
        if (!file) return;
        if (!window.JSZip) { toast('Import is unavailable (JSZip failed to load).', { type: 'error' }); return; }
        try {
            const zip = await JSZip.loadAsync(file);
            const pj = zip.file('project.json');
            if (!pj) throw new Error('no project.json inside');
            const meta = JSON.parse(await pj.async('string'));
            const samples = [];
            for (const s of meta.samples || []) {
                const f = s.file && zip.file(s.file);
                if (!f) continue;
                const dec = await decodeAudioFile(await f.async('arraybuffer'));
                samples.push({ ...s, data: dec.data, sampleRate: dec.sampleRate });
            }
            const now = Date.now();
            let name = String(meta.name || 'Imported project').slice(0, 28);
            const taken = new Set((await DB.listMeta().catch(() => [])).map((m) => m.name));
            if (taken.has(name)) name = `${name} (imported)`;
            await switchProject({ ...meta, name, id: uid(), createdAt: now, updatedAt: now, samples });
            toast(`Imported "${project.name}"`, { type: 'success' });
        } catch (e) {
            console.error(e);
            toast(`Import failed (${e.message}).`, { type: 'error' });
        }
    }

    // =====================================================================
    // Toast
    // =====================================================================
    let toastTimer = 0;
    function toast(msg, { type = 'info', duration, action } = {}) {
        clearTimeout(toastTimer);
        const el = dom.toast;
        el.textContent = '';
        el.className = `toast ${type}`;
        el.append(h('span', {}, msg));
        if (action) {
            const b = h('button', {}, action.label);
            b.addEventListener('click', () => { hideToast(); action.fn(); });
            el.append(b);
        }
        void el.offsetWidth;
        el.classList.add('show');
        toastTimer = setTimeout(hideToast, duration || (action ? 6000 : type === 'error' ? 5000 : 2600));
    }
    function hideToast() { dom.toast.classList.remove('show'); }

    // =====================================================================
    // Views
    // =====================================================================
    let currentView = 'rec';
    function setView(v) {
        if (!['rec', 'seq', 'mix', 'projects'].includes(v)) v = 'rec';
        currentView = v;
        dom.views.forEach((el) => el.classList.toggle('active', el.id === `view-${v}`));
        dom.tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
        lsSet(VIEW_KEY, v);
        if (v === 'projects') renderProjects();
        window.scrollTo(0, 0);
    }

    // =====================================================================
    // Events
    // =====================================================================
    function bindEvents() {
        // Any gesture may (re)start audio — covers iOS "interrupted" contexts too.
        const kick = () => { if (Tone.context.state !== 'running') unlockAudio(); };
        document.addEventListener('pointerdown', kick, { capture: true, passive: true });
        document.addEventListener('keydown', kick, { capture: true });

        dom.tabs.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
        dom.projectBtn.addEventListener('click', () => setView('projects'));

        // Transport
        dom.playBtn.addEventListener('click', togglePlay);
        dom.bpmDown.addEventListener('click', () => commitBpm(project.bpm - 1));
        dom.bpmUp.addEventListener('click', () => commitBpm(project.bpm + 1));
        dom.bpmInput.addEventListener('change', () => commitBpm(dom.bpmInput.value));
        dom.bpmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.bpmInput.blur(); });

        // Record
        dom.recBtn.addEventListener('click', toggleRecording);
        dom.micSelect.addEventListener('focus', listMics);
        dom.micSelect.addEventListener('change', () => { micDeviceId = dom.micSelect.value; lsSet(MIC_KEY, micDeviceId); });
        dom.demoKitBtn.addEventListener('click', loadDemoKit);
        dom.importAudioInput.addEventListener('change', () => {
            const f = dom.importAudioInput.files[0];
            dom.importAudioInput.value = '';
            importAudio(f);
        });
        dom.sampleList.addEventListener('click', (e) => {
            const b = e.target.closest('[data-action]');
            const card = e.target.closest('.sample-card');
            if (!b || !card) return;
            const s = sampleById(card.dataset.id);
            if (!s) return;
            if (b.dataset.action === 'preview') previewSample(s);
            else openEditor(s.id);
        });

        // Sequencer
        dom.presetBar.addEventListener('click', (e) => {
            const b = e.target.closest('[data-preset]');
            if (b) applyPreset(b.dataset.preset);
        });
        dom.swingInput.addEventListener('input', () => {
            project.swing = clamp(+dom.swingInput.value, 0, 0.6);
            dom.swingValue.textContent = fmtPct(project.swing);
            Engine.syncGlobals();
            scheduleSave();
        });
        pageBtns.forEach((b) => b.addEventListener('click', () => {
            seqPage = +b.dataset.page;
            dom.seqGrid.className = `seq-grid page-${seqPage}`;
            pageBtns.forEach((x, i) => x.classList.toggle('active', i === seqPage));
            highlightStep(lastStep);
        }));

        let paint = null, suppressClick = false;
        dom.seqGrid.addEventListener('pointerdown', (e) => {
            if (e.pointerType !== 'mouse' || e.button !== 0) return;
            const st = e.target.closest('.step');
            if (!st) return;
            const ti = +st.dataset.track, si = +st.dataset.step;
            paint = { ti, value: !project.tracks[ti].steps[si] };
            setStep(ti, si, paint.value, true);
            suppressClick = true;
        });
        window.addEventListener('pointermove', (e) => {
            if (!paint) return;
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const st = el && el.closest && el.closest('.step');
            if (st && +st.dataset.track === paint.ti) setStep(paint.ti, +st.dataset.step, paint.value, false);
        });
        const endPaint = () => { if (paint) { paint = null; setTimeout(() => { suppressClick = false; }, 0); } };
        window.addEventListener('pointerup', endPaint);
        window.addEventListener('pointercancel', endPaint);

        dom.seqGrid.addEventListener('click', (e) => {
            const st = e.target.closest('.step');
            if (st) {
                if (suppressClick) { suppressClick = false; return; }
                const ti = +st.dataset.track, si = +st.dataset.step;
                setStep(ti, si, !project.tracks[ti].steps[si], true);
                return;
            }
            const b = e.target.closest('[data-action]');
            if (!b) return;
            const ti = +b.dataset.track;
            const t = project.tracks[ti];
            if (!t) return;
            if (b.dataset.action === 'pick') openPicker(ti);
            else if (b.dataset.action === 'mute' || b.dataset.action === 'solo') {
                t[b.dataset.action] = !t[b.dataset.action];
                Engine.syncAll();
                renderSeq();
                highlightStep(lastStep);
                scheduleSave();
            }
        });

        dom.addTrackBtn.addEventListener('click', () => {
            if (project.tracks.length >= MAX_TRACKS) return;
            project.tracks.push(makeTrack('perc'));
            Engine.syncAll();
            renderSeq();
            renderMix();
            scheduleSave();
            openPicker(project.tracks.length - 1);
        });
        dom.autoAssignBtn.addEventListener('click', () => {
            if (!project.samples.length) { toast('Record some samples first.'); return; }
            const before = snapshot();
            autoAssign(false);
            Engine.syncAll();
            renderSeq();
            renderMix();
            scheduleSave();
            toast('Samples placed by sound type', { action: { label: 'Undo', fn: () => restore(before) } });
        });
        dom.clearBtn.addEventListener('click', () => {
            if (!project.tracks.some((t) => t.steps.some(Boolean))) return;
            const before = snapshot();
            project.tracks.forEach((t) => t.steps.fill(false));
            renderSeq();
            scheduleSave();
            toast('Steps cleared', { action: { label: 'Undo', fn: () => restore(before) } });
        });

        // Picker
        dom.pickerClose.addEventListener('click', closePicker);
        dom.picker.addEventListener('click', (e) => {
            if (e.target === dom.picker) { closePicker(); return; }
            const pv = e.target.closest('[data-preview]');
            if (pv) { const s = sampleById(pv.dataset.preview); if (s) previewSample(s); return; }
            const ch = e.target.closest('[data-choose]');
            if (!ch) return;
            const t = project.tracks[pickerTrack];
            if (t) {
                t.sampleId = ch.dataset.choose || null;
                t.pitch = 0;
                Engine.syncTrack(t);
                renderSeq();
                renderMix();
                scheduleSave();
                if (t.sampleId) auditionTrack(t);
            }
            closePicker();
        });

        // Mix
        dom.masterVol.addEventListener('input', () => {
            project.masterVolume = +dom.masterVol.value;
            dom.masterVolValue.textContent = fmtDb(project.masterVolume);
            Engine.syncGlobals();
            scheduleSave();
        });
        dom.mixList.addEventListener('input', (e) => {
            const inp = e.target;
            const t = project.tracks[+inp.dataset.track];
            const param = inp.dataset.param;
            if (!t || !param) return;
            t[param] = +inp.value;
            if (inp.nextElementSibling) inp.nextElementSibling.textContent = MIX_FORMAT[param](t[param]);
            Engine.syncTrack(t);
            scheduleSave();
        });
        dom.mixList.addEventListener('click', (e) => {
            const b = e.target.closest('[data-action="remove"]');
            if (!b || project.tracks.length <= 1) return;
            const before = snapshot();
            project.tracks.splice(+b.dataset.track, 1);
            Engine.syncAll();
            renderSeq();
            renderMix();
            scheduleSave();
            toast('Track removed', { action: { label: 'Undo', fn: () => restore(before) } });
        });

        // Projects
        dom.projectNameInput.addEventListener('input', () => {
            project.name = dom.projectNameInput.value.slice(0, 40) || defaultProjectName();
            dom.projectName.textContent = project.name;
            scheduleSave();
        });
        dom.projectNameInput.addEventListener('blur', () => {
            dom.projectNameInput.value = project.name;
            renderProjects();
        });
        dom.newProjectBtn.addEventListener('click', async () => {
            await switchProject(newProject());
            setView('rec');
            toast('New project started');
        });
        dom.exportBtn.addEventListener('click', exportProject);
        dom.importInput.addEventListener('change', () => {
            const f = dom.importInput.files[0];
            dom.importInput.value = '';
            importProject(f);
        });
        dom.projectList.addEventListener('click', (e) => {
            const b = e.target.closest('[data-action]');
            const item = e.target.closest('.project-item');
            if (!b || !item) return;
            if (b.dataset.action === 'open') openProject(item.dataset.id);
            else if (b.dataset.action === 'delete') deleteProject(item.dataset.id);
        });

        // Editor
        dom.waveWrap.addEventListener('pointerdown', (e) => {
            if (!Ed.open || (e.pointerType === 'mouse' && e.button !== 0)) return;
            e.preventDefault();
            if (Ed.previewing) stopEditorPreview();
            const t = editorTimeAt(e.clientX);
            const ds = Math.abs(t - Ed.edit.start), de = Math.abs(t - Ed.edit.end);
            const which = ds < de ? 'start' : de < ds ? 'end' : (t <= Ed.edit.start ? 'start' : 'end');
            Ed.drag = { which, id: e.pointerId };
            try { dom.waveWrap.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            moveHandle(which, t);
        });
        dom.waveWrap.addEventListener('pointermove', (e) => {
            if (Ed.drag && e.pointerId === Ed.drag.id) moveHandle(Ed.drag.which, editorTimeAt(e.clientX));
        });
        const endDrag = (e) => {
            if (!Ed.drag || e.pointerId !== Ed.drag.id) return;
            Ed.drag = null;
            refreshEditorRole();
        };
        dom.waveWrap.addEventListener('pointerup', endDrag);
        dom.waveWrap.addEventListener('pointercancel', endDrag);

        dom.edPlay.addEventListener('click', toggleEditorPreview);
        dom.edAuto.addEventListener('click', () => {
            const s = sampleById(Ed.id);
            if (!s) return;
            stopEditorPreview();
            Object.assign(Ed.edit, autoCrop(s.data, s.sampleRate));
            updateEditorUI();
            refreshEditorRole();
        });
        dom.edAll.addEventListener('click', () => {
            stopEditorPreview();
            Ed.edit.start = 0;
            Ed.edit.end = Ed.dur;
            updateEditorUI();
            refreshEditorRole();
        });
        dom.edReverse.addEventListener('click', () => { stopEditorPreview(); Ed.edit.reverse = !Ed.edit.reverse; updateEditorUI(); });
        dom.edNormalize.addEventListener('click', () => { stopEditorPreview(); Ed.edit.normalize = !Ed.edit.normalize; updateEditorUI(); });
        dom.edPitchDown.addEventListener('click', () => { Ed.edit.pitch = clamp(Ed.edit.pitch - 1, -12, 12); updateEditorUI(); });
        dom.edPitchUp.addEventListener('click', () => { Ed.edit.pitch = clamp(Ed.edit.pitch + 1, -12, 12); updateEditorUI(); });
        dom.edRole.addEventListener('change', () => { Ed.roleOverride = ROLES.includes(dom.edRole.value) ? dom.edRole.value : null; });
        dom.edSave.addEventListener('click', saveEditor);
        dom.edCancel.addEventListener('click', closeEditor);
        dom.edDelete.addEventListener('click', deleteFromEditor);
        dom.edName.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.edName.blur(); });

        // Keyboard
        document.addEventListener('keydown', (e) => {
            const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range';
            if (e.key === 'Escape') {
                if (!dom.picker.hidden) closePicker();
                else if (Ed.open) { if (Ed.isNew) saveEditor(); else closeEditor(); }
                return;
            }
            if (e.code === 'Space' && !typing && !Ed.open && e.target.tagName !== 'BUTTON') {
                e.preventDefault();
                togglePlay();
            }
        });

        window.addEventListener('resize', () => { if (Ed.open) drawEditorWave(); });

        // Lifecycle: save when backgrounded, recover audio when back
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                saveNow();
                if (Rec.state === 'recording') stopRecording();
            } else {
                if (Engine.ready && Tone.context.state !== 'running') Tone.context.resume().catch(() => { /* needs a tap */ });
                if (isPlaying()) keepAwake(true);
            }
        });
        window.addEventListener('pagehide', () => { saveNow(); });
    }

    // =====================================================================
    // Boot
    // =====================================================================
    async function boot() {
        await DB.open();
        let stored = null;
        if (DB.ok) {
            try {
                const last = lsGet(LAST_PROJECT_KEY);
                if (last) stored = await DB.get(last);
                if (!stored) {
                    const metas = (await DB.listMeta()).sort((a, b) => b.updatedAt - a.updatedAt);
                    if (metas[0]) stored = await DB.get(metas[0].id);
                }
            } catch (e) {
                console.error('Could not load last project', e);
            }
        }
        project = stored ? sanitizeProject(stored) : newProject();

        bindEvents();
        renderAll();
        renderRecUI();
        setView(lsGet(VIEW_KEY) || 'rec');

        if (DB.ok) {
            setSaveState('saved');
            if (!stored) saveNow();
            if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { /* best effort */ });
        } else {
            setSaveState('off');
            dom.storageNote.textContent = 'This browser is blocking storage (private mode?). Your work will not be kept — use Export .zip to keep it.';
        }
    }

    // Exposed for debugging in the console only
    window.SequenceReality = {
        get project() { return project; },
        Engine, autoAssign, autoCrop, analyze, guessRole, applyPreset, loadDemoKit
    };

    boot();
})();
