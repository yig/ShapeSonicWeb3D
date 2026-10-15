// Web Audio sonification engine (the 2D web demo's engine, ../demo/js/audio.js,
// with separate edge and corner families as in the iOS mixer):
//
// * Left hand → left ear, right hand → right ear; left-hand sounds are lower.
//   The contact, edge and corner recordings are hard-panned L/R pairs that
//   already differ in pitch; the guidance loop is shared, so each hand gets a
//   copy panned to its ear, the left one 2 semitones lower.
// * Contact: 5 voices per hand at C D E G A (thumb … little finger).
// * Edge (pluck) and corner (bell): re-triggered every 0.45 s while a hand is
//   in range, through a gain that follows the distance.
// * All loops run from the start at gain 0; updates only move gain targets
//   (setTargetAtTime), so there are no clicks and CPU use is constant.

import { FINGERS, HANDS, type HandLevels } from './sonify';

const PENTATONIC = [0, 2, 4, 7, 9];
const LEFT_GUIDANCE_SEMITONES = -2;
// Gain smoothing time constants (s); contact is the most abrupt by design.
const TAU = { guidance: 0.008, contact: 0.003, edge: 0.006, corner: 0.006 };
// Samples at or below this at the ends of a decoded file are trimmed (MP3
// encoder padding would delay plucks and leave gaps at loop points).
const SILENCE = 1e-4;
const PLUCK_INTERVAL = 0.45;
const MIX = { guidance: 0.5, contact: 0.45, edge: 0.9, corner: 0.9 };

const FILES = {
  guidance: 'audio/guidance.mp3',
  contact: ['audio/contact-left.mp3', 'audio/contact-right.mp3'],
  edge: ['audio/edge-left.mp3', 'audio/edge-right.mp3'],
  corner: ['audio/corner-left.mp3', 'audio/corner-right.mp3'],
};

const semitones = (s: number) => 2 ** (s / 12);

function trimSilence(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const loud = (i: number) => chans.some((d) => Math.abs(d[i]) > SILENCE);
  let start = 0, end = buffer.length;
  while (start < end && !loud(start)) start++;
  while (end > start && !loud(end - 1)) end--;
  if (end - start === buffer.length || end <= start) return buffer;
  const out = ctx.createBuffer(chans.length, end - start, buffer.sampleRate);
  chans.forEach((d, c) => out.copyToChannel(d.subarray(start, end), c));
  return out;
}

interface HandNodes {
  guidance: GainNode;
  contact: GainNode[];
  edge: GainNode;
  corner: GainNode;
}

export class Sonifier {
  ctx: AudioContext | null = null;
  ready = false;
  private master: GainNode | null = null;
  private hands: HandNodes[] = [];
  private buffers: { edge: AudioBuffer[]; corner: AudioBuffer[] } | null = null;
  private lastPluck = { edge: [-Infinity, -Infinity], corner: [-Infinity, -Infinity] };
  private volume = 0.8;
  /** The last levels set, for tests and the debug readout. */
  levels: HandLevels[] = [];

  /** Must be called from a user gesture (autoplay policies). */
  async start(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    try {
      // iOS 17+: play even with the silent switch on.
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (session) session.type = 'playback';
    } catch {}
    const resumed = ctx.resume();
    const load = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load ${url}`);
      return trimSilence(ctx, await ctx.decodeAudioData(await res.arrayBuffer()));
    };
    const [guidance, contact, edge, corner] = await Promise.all([
      load(FILES.guidance),
      Promise.all(FILES.contact.map(load)),
      Promise.all(FILES.edge.map(load)),
      Promise.all(FILES.corner.map(load)),
    ]);
    this.buffers = { edge, corner };
    await resumed;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    const gain = (dest: AudioNode) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(dest);
      return g;
    };
    const loop = (buffer: AudioBuffer, rate: number, dest: AudioNode) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.playbackRate.value = rate;
      const g = gain(dest);
      src.connect(g);
      src.start(0, Math.random() * buffer.duration);
      return g;
    };
    for (let h = 0; h < HANDS; h++) {
      const pan = new StereoPannerNode(ctx, { pan: h === 0 ? -1 : 1 });
      pan.connect(this.master);
      this.hands.push({
        guidance: loop(guidance, h === 0 ? semitones(LEFT_GUIDANCE_SEMITONES) : 1, pan),
        contact: PENTATONIC.map((s) => loop(contact[h], semitones(s), this.master!)),
        edge: gain(this.master),
        corner: gain(this.master),
      });
    }
    this.ready = true;
  }

  /** Output latency in ms, where the browser reports it. */
  get latencyMs(): number | null {
    if (!this.ctx) return null;
    return ((this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0)) * 1000;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  update(levels: HandLevels[]) {
    this.levels = levels;
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (let h = 0; h < HANDS; h++) {
      const node = this.hands[h], lv = levels[h];
      node.guidance.gain.setTargetAtTime(MIX.guidance * lv.guidance, t, TAU.guidance);
      for (let f = 0; f < FINGERS; f++) node.contact[f].gain.setTargetAtTime(MIX.contact * lv.contact[f], t, TAU.contact);
      for (const family of ['edge', 'corner'] as const) {
        node[family].gain.setTargetAtTime(MIX[family] * lv[family], t, TAU[family]);
        if (lv[family] > 0) {
          if (t - this.lastPluck[family][h] >= PLUCK_INTERVAL) {
            const src = this.ctx.createBufferSource();
            src.buffer = this.buffers![family][h];
            src.connect(node[family]);
            src.start(t);
            this.lastPluck[family][h] = t;
          }
        } else {
          // Leaving the range and coming back plucks immediately.
          this.lastPluck[family][h] = -Infinity;
        }
      }
    }
  }
}
