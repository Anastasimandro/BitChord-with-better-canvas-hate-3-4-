// Adapted from AutoMix's src/lib/analysis/analyzer.ts (https://github.com/heydavidf/automix),
// Copyright (C) 2026 David Finnegan. AGPL-3.0-only: see ../LICENSE and ../NOTICE.md.
// BitChord: the audio comes from YouTube (fetchTrackAudio) instead of a local
// file, the queue is keyed by video id, and results are kept in memory as
// well as IndexedDB so the mix loop can read them synchronously.
//
// Automix 2.0 Phase 1: the monolithic pass is a LADDER. Each rung is a
// request carrying exactly the audio that rung needs, and the record grows
// rung by rung:
//
// - L0 (critical path, when the track joins the coming pair): ONE edge —
//   Beat This! over it, the edge's LUFS, its coarse energy span, and from
//   the tail span the silence trim and the false-ending rule. L0 alone
//   plans a valid blend/filter/fade/gap.
// - L1 (>90 s of the outgoing track left): the edge spans re-windowed at
//   the phrase resolution the grids produced — the rung that makes the
//   intro/outro numbers phrase-true instead of half-second-true.
// - L2 (when a loop mix is about to be planned, or a blend would move up a
//   grade): the cheap vocal detector over the overlap windows.
// - L3 (idle, cancellable): the whole track — key, whole-curve energy,
//   whole-track LUFS, open-unmix — into the cache for later sessions.
//
// Nothing invalidates wholesale: each component carries its version
// (components.ts) and a cached record is adopted component by component.
import { trackLog } from '@/playback/trackLog';
import { getAnalysis, putAnalysis } from '../db';
import { fetchTrackAudio, fetchTrackAudioEdge, type TrackAudio } from '../fetchAudio';
import type { AnalyzeRequest, AnalyzeResponse } from './analysis.worker';
import { BEAT_SR, VOCAL_WINDOW_SEC } from './models';
import { GRID_VERSION, VOCAL_VERSION, adoptCached, needsLevel3 } from './components';
import type { TrackAnalysis, TrackTags, VocalWindow } from './types';
import { ANALYSIS_VERSION } from './types';

export type AnalysisStatus = 'pending' | 'analyzing' | 'done' | 'error';
/** The ladder's rungs. L0/L1/L2 are edge-scoped; L3 is the whole track. */
export type AnalysisLevel = 0 | 1 | 2 | 3;

/** A failed analysis is asked for again after this long. */
const RETRY_FAILED_MS = 60_000;
const ANALYSIS_SR = 44100; // RhythmExtractor2013 assumes 44.1 kHz
/** BitChord: Beat This! is run over this much of the opening and of the end: two model chunks. */
const BEAT_WINDOW_SEC = 59;
/** How much edge audio a ranged fetch aims at: the window plus cluster slop. */
const EDGE_SEC = 65;
/** The phone's models (analysis/models.ts). Beat This! is the critical path; open-unmix waits for L3. */
const USE_VOCAL_MODEL = true;
/**
 * Compressed audio kept for the loop mix's FULL-decode fallback: current,
 * next, one behind. Ranged copies (analysis/edges) are ~1.5 MB each and fit
 * six tracks in the budget the full copies had.
 */
const KEEP_BYTES_FOR = 2;
/** Ranged edge copies kept per side, so a level re-run doesn't refetch. */
const KEEP_EDGES_FOR = 6;

/**
 * The just-in-time analysis queue: fetch the rung's audio (a ranged edge for
 * L0-L2), decode, transfer to the worker, merge the answer into the record
 * and persist. One request at a time keeps peak memory at one decode, and
 * the priority order (level, then urgency, then age) keeps the rung the
 * coming transition needs ahead of everything idle.
 */
class Analyzer {
  private worker: Worker | null = null;
  private queue: QueueEntry[] = [];
  private seq = 0;
  private running = false;
  private pendingResolve: ((r: AnalyzeResponse) => void) | null = null;
  private readonly results = new Map<string, TrackAnalysis>();
  private readonly status = new Map<string, AnalysisStatus>();
  private readonly listeners = new Set<() => void>();
  private readonly failedAt = new Map<string, number>();
  /** Rungs already landed (or finally failed), per track: "0:head", "1:tail", "2", "3". */
  private readonly done = new Map<string, Set<string>>();
  /** Which tracks the mix loop still cares about; anything else is dropped from the queue. */
  private activeKeys = new Set<string>();
  /** BitChord: each recent track's compressed audio, so a mix can decode the bars it loops (fallback path). */
  private readonly bytes = new Map<string, Promise<TrackAudio>>();
  /** Ranged edge copies, per side, while a track is near the mix. */
  private readonly edges = new Map<string, { head?: EdgeState; tail?: EdgeState }>();
  /** The cheap detector's sustained-doubt flag per track, for the open-unmix escalation. */
  private readonly vocalUncertain = new Map<string, boolean>();
  /** Waiters for "rung X of track Y landed". */
  private readonly waiters = new Map<string, Set<() => void>>();

  /** The track's compressed audio: fetched once, kept for the last few tracks. */
  audioBytes(videoId: string): Promise<ArrayBuffer> {
    return this.trackAudio(videoId).then((a) => a.bytes);
  }

  private trackAudio(videoId: string): Promise<TrackAudio> {
    let held = this.bytes.get(videoId);
    if (held) {
      this.bytes.delete(videoId);
      this.bytes.set(videoId, held);
      return held;
    }
    held = fetchTrackAudio(videoId);
    held.catch(() => this.bytes.delete(videoId));
    this.bytes.set(videoId, held);
    while (this.bytes.size > KEEP_BYTES_FOR) this.bytes.delete(this.bytes.keys().next().value!);
    return held;
  }

  /**
   * One edge's ranged copy, for the loop mix's ranged decode: the bytes and
   * the numbers the caller needs to place the decoded buffer on the track's
   * own timeline.
   */
  async edgeRegion(videoId: string, edge: 'head' | 'tail'): Promise<{ bytes: ArrayBuffer; trackDurationSec: number; fellBackToFull: boolean }> {
    const state = await this.edgeState(videoId, edge);
    return { bytes: state.bytes, trackDurationSec: state.trackDurationSec, fellBackToFull: state.fellBackToFull };
  }

  private async edgeState(videoId: string, edge: 'head' | 'tail'): Promise<EdgeState> {
    let perTrack = this.edges.get(videoId);
    if (!perTrack) {
      perTrack = {};
      this.edges.set(videoId, perTrack);
      while (this.edges.size > KEEP_EDGES_FOR) this.edges.delete(this.edges.keys().next().value!);
    }
    const held = perTrack[edge];
    if (held) return held;
    const made = await fetchTrackAudioEdge(videoId, edge, EDGE_SEC);
    const state: EdgeState = {
      bytes: made.bytes,
      trackDurationSec: made.durationSec,
      musicVideo: made.musicVideo,
      fellBackToFull: made.fellBackToFull,
    };
    perTrack[edge] = state;
    return state;
  }

  /** The analysis of [videoId], if any rung of it has landed. */
  get(videoId: string): TrackAnalysis | null {
    return this.results.get(videoId) ?? null;
  }

  statusOf(videoId: string): AnalysisStatus | null {
    return this.status.get(videoId) ?? null;
  }

  /** Whether the cheap detector reported sustained vocal doubt for [videoId]. */
  isVocalUncertain(videoId: string): boolean {
    return this.vocalUncertain.get(videoId) ?? false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The mix loop's current interest: the playing track, the next one, and
   * whatever prefetches behind them. Anything in the queue whose track left
   * this set is dropped when dequeued — the cancellable part of prefetch.
   */
  setActive(keys: string[]): void {
    this.activeKeys = new Set(keys);
  }

  /**
   * Asks for [videoId] to be analyzed to [level] (edge-scoped for 0-2).
   * A cached record resolves at once for the rungs it already holds;
   * `urgent` puts the rung ahead of its level's queue (the playing and
   * next tracks outrank prefetch).
   */
  request(
    videoId: string,
    tags: TrackTags,
    level: AnalysisLevel,
    opts: { urgent?: boolean; edge?: 'head' | 'tail' } = {},
  ): void {
    const known = this.status.get(videoId);
    if (known === 'analyzing') return;
    // a failure (a refused download, a network blip) is tried again after a while, not given up on
    if (known === 'error' && Date.now() - (this.failedAt.get(videoId) ?? 0) < RETRY_FAILED_MS) return;

    const record = this.results.get(videoId);
    if (record && this.rungDone(videoId, level, opts.edge)) return;

    // The cached record is looked up once; until it lands, the record here
    // is whatever earlier rungs merged this session.
    if (!record && known !== 'error') {
      this.setStatus(videoId, known ?? 'pending');
      void getAnalysis(videoId).then((cached) => {
        if (cached && !this.results.has(videoId)) {
          this.merge(videoId, adoptCached(cached), { persisted: true });
        }
        this.drainSatisfied(videoId, level, opts.edge);
      });
    }

    const at = this.queue.findIndex((q) => q.videoId === videoId && q.level === level && q.edge === opts.edge);
    if (at >= 0) {
      if (opts.urgent) {
        const [entry] = this.queue.splice(at, 1);
        this.queue.unshift(entry!);
      }
      return;
    }
    this.queue.push({ videoId, tags, level, edge: opts.edge, urgent: opts.urgent ?? false, seq: this.seq++ });
    void this.run();
  }

  /**
   * Idle work: L3 for the tracks the mix loop cares about, and nothing for
   * the rest. Called every tick; deduped by the rung set, cancelled by
   * [setActive] when the queue moves.
   */
  requestIdle(tracks: { videoId: string; tags: TrackTags }[]): void {
    for (const t of tracks) {
      const record = this.results.get(t.videoId);
      if (record && !needsLevel3(record)) continue;
      this.request(t.videoId, t.tags, 3);
    }
  }

  /**
   * Resolves when [level] (edge-scoped for 0-2) of [videoId] has landed, or
   * after [timeoutMs] — the loop mix's bounded wait for vocal evidence.
   */
  whenLevel(videoId: string, level: AnalysisLevel, edge: 'head' | 'tail' | undefined, timeoutMs: number): Promise<void> {
    if (this.rungDone(videoId, level, edge)) return Promise.resolve();
    return new Promise((resolve) => {
      const key = rungKey(videoId, level, edge);
      const set = this.waiters.get(key) ?? new Set();
      set.add(resolve);
      this.waiters.set(key, set);
      setTimeout(() => {
        this.waiters.get(key)?.delete(resolve);
        resolve();
      }, timeoutMs);
    });
  }

  private rungDone(videoId: string, level: AnalysisLevel, edge?: 'head' | 'tail'): boolean {
    return this.done.get(videoId)?.has(rungKey(videoId, level, edge)) ?? false;
  }

  private drainSatisfied(videoId: string, level: AnalysisLevel, edge?: 'head' | 'tail'): void {
    if (!this.rungDone(videoId, level, edge)) return;
    this.queue = this.queue.filter((q) => !(q.videoId === videoId && q.level === level && q.edge === edge));
    this.resolveWaiters(videoId, level, edge);
  }

  private resolveWaiters(videoId: string, level: AnalysisLevel, edge?: 'head' | 'tail'): void {
    const key = rungKey(videoId, level, edge);
    const waiting = this.waiters.get(key);
    if (!waiting) return;
    this.waiters.delete(key);
    for (const w of waiting) w();
  }

  private setStatus(videoId: string, status: AnalysisStatus) {
    this.status.set(videoId, status);
    for (const l of this.listeners) l();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<AnalyzeResponse>) => {
      this.pendingResolve?.(ev.data);
      this.pendingResolve = null;
    };
    worker.onerror = (ev) => {
      this.pendingResolve?.({ type: 'error', fileKey: '', message: ev.message ?? 'worker error' });
      this.pendingResolve = null;
    };
    this.worker = worker;
    return worker;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Let the cache lookups above answer before downloading anything.
    await new Promise((r) => setTimeout(r, 50));
    while (this.queue.length > 0) {
      const at = this.bestEntry();
      if (at < 0) {
        this.queue.length = 0;
        break;
      }
      const entry = this.queue.splice(at, 1)[0]!;
      if (!this.wanted(entry)) continue;
      if (this.rungDone(entry.videoId, entry.level, entry.edge)) continue;
      this.setStatus(entry.videoId, 'analyzing');
      const started = performance.now();
      try {
        const fields = await this.analyzeEntry(entry);
        this.merge(entry.videoId, fields, { persisted: true, tags: entry.tags });
        this.markDone(entry);
        trackLog.i(
          `automix L${entry.level}${entry.edge ? `:${entry.edge}` : ''} of ${entry.videoId} in ${Math.round(performance.now() - started)}ms`,
          entry.videoId,
        );
        this.setStatus(entry.videoId, this.rungDone(entry.videoId, 3) ? 'done' : 'pending');
      } catch (e) {
        trackLog.w(`automix L${entry.level} analysis failed: ${String(e)}`, entry.videoId);
        this.failedAt.set(entry.videoId, Date.now());
        this.bytes.delete(entry.videoId);
        this.setStatus(entry.videoId, 'error');
      }
    }
    this.running = false;
  }

  /** The most wanted entry: lowest level first, then urgent, then oldest. */
  private bestEntry(): number {
    let best = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i]!;
      if (best < 0) {
        best = i;
        continue;
      }
      const b = this.queue[best]!;
      if (q.level !== b.level) {
        if (q.level < b.level) best = i;
      } else if (q.urgent !== b.urgent) {
        if (q.urgent) best = i;
      } else if (q.seq < b.seq) best = i;
    }
    return best;
  }

  /** True while [entry]'s track is still in the mix loop's interest. */
  private wanted(entry: QueueEntry): boolean {
    return this.activeKeys.has(entry.videoId);
  }

  private markDone(entry: QueueEntry): void {
    const set = this.done.get(entry.videoId) ?? new Set();
    set.add(rungKey(entry.videoId, entry.level, entry.edge));
    this.done.set(entry.videoId, set);
    this.resolveWaiters(entry.videoId, entry.level, entry.edge);
  }

  private async analyzeEntry(entry: QueueEntry): Promise<Partial<TrackAnalysis>> {
    if (entry.level === 0 || entry.level === 1 || entry.level === 2) {
      if (entry.edge === undefined) throw new Error(`L${entry.level} needs an edge`);
      if (entry.level === 0) return this.analyzeEdgeL0(entry.videoId, entry.edge);
      if (entry.level === 1) return this.analyzeEdgeL1(entry.videoId, entry.edge);
      return this.analyzeEdgeL2(entry.videoId, entry.edge);
    }
    return this.analyzeWholeL3(entry.videoId);
  }

  /** Decodes the edge's bytes once per sample rate and holds them. */
  private async decodedEdge(edge: EdgeState, sampleRate: number): Promise<Float32Array> {
    const held = sampleRate === 44100 ? edge.mono44 : edge.mono22;
    if (held) return held;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate });
    const decoded = downmixToMono(await ctx.decodeAudioData(edge.bytes.slice(0)));
    if (sampleRate === 44100) edge.mono44 = decoded;
    else edge.mono22 = decoded;
    return decoded;
  }

  /**
   * L0: Beat This! over one edge, the edge's loudness, its coarse energy
   * span, and the tail's silence trim. The edge audio is capped at
   * [EDGE_SEC + slop] around the anchored side: a head range is trimmed from
   * its far end, a tail range from its near end, so the anchored side stays
   * exact. The transferred windows are COPIES — the cached decodes stay
   * intact for L1/L2 (a transferred subarray would detach the whole buffer).
   */
  private async analyzeEdgeL0(videoId: string, edge: 'head' | 'tail'): Promise<Partial<TrackAnalysis>> {
    const state = await this.edgeState(videoId, edge);
    const mono44full = await this.decodedEdge(state, ANALYSIS_SR);
    const mono22full = await this.decodedEdge(state, BEAT_SR);
    const durationSec =
      state.trackDurationSec > 0 ? state.trackDurationSec : mono44full.length / ANALYSIS_SR;
    const cap44 = Math.round((EDGE_SEC + 2) * ANALYSIS_SR);
    const cap22 = Math.round((EDGE_SEC + 2) * BEAT_SR);

    let mono44: Float32Array;
    let mono22: Float32Array;
    let offsetSec: number;
    if (edge === 'head') {
      mono44 = mono44full.subarray(0, Math.min(mono44full.length, cap44));
      mono22 = mono22full.subarray(0, Math.min(mono22full.length, cap22));
      offsetSec = 0;
    } else if (state.fellBackToFull) {
      // the whole file came back: the edge is its last EDGE_SEC seconds
      offsetSec = Math.max(0, durationSec - EDGE_SEC);
      mono44 = mono44full.subarray(Math.round(offsetSec * ANALYSIS_SR));
      mono22 = mono22full.subarray(Math.round(offsetSec * BEAT_SR));
    } else {
      // the range is end-anchored: the decoded buffer's END is the track's end
      const decodedSec = mono44full.length / ANALYSIS_SR;
      offsetSec = Math.max(0, durationSec - decodedSec);
      const from = Math.max(0, mono44full.length - cap44);
      mono44 = mono44full.subarray(from);
      mono22 = mono22full.subarray(Math.max(0, mono22full.length - cap22));
      if (from > 0) offsetSec += from / ANALYSIS_SR;
    }

    return this.ask(videoId, {
      type: 'analyze',
      fileKey: videoId,
      durationSec,
      edge: {
        edge,
        mono22: copyForTransfer(mono22),
        mono44: copyForTransfer(mono44),
        offsetSec,
        endSec: Math.min(durationSec, offsetSec + mono44.length / ANALYSIS_SR),
      },
    }).then((fields) => ({ ...fields, musicVideo: state.musicVideo }));
  }

  /** L1: the edge's span re-windowed at the phrase resolution, from the decode L0 already paid for. */
  private async analyzeEdgeL1(videoId: string, edge: 'head' | 'tail'): Promise<Partial<TrackAnalysis>> {
    const record = this.results.get(videoId);
    const phraseWindow = phraseWindowSec(record?.beatIntervalSec ?? null);
    const state = await this.edgeState(videoId, edge);
    const mono44 = await this.decodedEdge(state, ANALYSIS_SR);
    const durationSec = state.trackDurationSec > 0 ? state.trackDurationSec : mono44.length / ANALYSIS_SR;
    const cap = Math.round((EDGE_SEC + 2) * ANALYSIS_SR);
    let offsetSec: number;
    let span: Float32Array;
    if (edge === 'head') {
      offsetSec = 0;
      span = mono44.subarray(0, Math.min(mono44.length, cap));
    } else if (state.fellBackToFull) {
      offsetSec = Math.max(0, durationSec - EDGE_SEC);
      span = mono44.subarray(Math.round(offsetSec * ANALYSIS_SR));
    } else {
      const decodedSec = mono44.length / ANALYSIS_SR;
      offsetSec = Math.max(0, durationSec - decodedSec);
      const from = Math.max(0, mono44.length - cap);
      span = mono44.subarray(from);
      if (from > 0) offsetSec += from / ANALYSIS_SR;
    }
    return this.ask(videoId, {
      type: 'analyze',
      fileKey: videoId,
      durationSec,
      spanOnly: true,
      energyWindowSec: phraseWindow,
      edge: {
        edge,
        mono22: new Float32Array(0),
        mono44: copyForTransfer(span),
        offsetSec,
        endSec: Math.min(durationSec, offsetSec + span.length / ANALYSIS_SR),
      },
    });
  }

  /**
   * L2: the cheap vocal detector over the edge's overlap window (stereo —
   * the detector reads the mid channel). The window is the loop mix's search
   * span: the last ~60 s of the outgoing edge, the first ~45 s of the
   * incoming one.
   */
  private async analyzeEdgeL2(videoId: string, edge: 'head' | 'tail'): Promise<Partial<TrackAnalysis>> {
    const state = await this.edgeState(videoId, edge);
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: ANALYSIS_SR });
    const buffer = await ctx.decodeAudioData(state.bytes.slice(0));
    const durationSec = state.trackDurationSec > 0 ? state.trackDurationSec : buffer.duration;
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    let offsetSec: number;
    let from: number;
    if (edge === 'head') {
      offsetSec = 0;
      from = 0;
    } else if (state.fellBackToFull) {
      offsetSec = Math.max(0, durationSec - EDGE_SEC);
      from = Math.round(offsetSec * buffer.sampleRate);
    } else {
      const decodedSec = buffer.duration;
      offsetSec = Math.max(0, durationSec - decodedSec);
      from = 0;
    }
    const to = Math.min(left.length, from + Math.round(EDGE_SEC * buffer.sampleRate));
    return this.ask(videoId, {
      type: 'analyze',
      fileKey: videoId,
      durationSec,
      cheapVocalWindows: [{ offsetSec, left: copyForTransfer(left.slice(from, to)), right: copyForTransfer(right.slice(from, to)) }],
    }).then((fields) => ({ ...fields, musicVideo: state.musicVideo }));
  }

  /** L3: the whole track — key, whole-curve energy, whole-track loudness, open-unmix — into the cache. */
  private async analyzeWholeL3(videoId: string): Promise<Partial<TrackAnalysis>> {
    const { bytes, musicVideo } = await this.trackAudio(videoId);
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: ANALYSIS_SR });
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    const mono = downmixToMono(buffer);
    const durationSec = buffer.duration;

    const record = this.results.get(videoId);
    const phraseWindow = phraseWindowSec(record?.beatIntervalSec ?? null);
    const needKey = record?.camelot == null;
    const vocalModelWindows: { offsetSec: number; left: Float32Array; right: Float32Array }[] = [];
    if (USE_VOCAL_MODEL && (record?.vocalVersion ?? 0) < VOCAL_VERSION) {
      const left = buffer.getChannelData(0);
      const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
      // the opening the incoming loop is looked for in (45 s) and the end the
      // outgoing one is (60 s): two windows and three, where the song is long enough
      const vocalStarts = [0, VOCAL_WINDOW_SEC].filter((s) => s + VOCAL_WINDOW_SEC <= durationSec);
      for (let k = 1; k <= 3; k++) {
        const start = durationSec - k * VOCAL_WINDOW_SEC;
        if (start >= 2 * VOCAL_WINDOW_SEC) vocalStarts.push(start);
      }
      for (const start of vocalStarts) {
        const a = Math.round(start * ANALYSIS_SR);
        const b = Math.min(left.length, a + Math.floor(VOCAL_WINDOW_SEC * ANALYSIS_SR));
        vocalModelWindows.push({ offsetSec: start, left: copyForTransfer(left.slice(a, b)), right: copyForTransfer(right.slice(a, b)) });
      }
    }

    const fields = await this.ask(videoId, {
      type: 'analyze',
      fileKey: videoId,
      durationSec,
      samples: mono,
      energyWindowSec: phraseWindow,
      needKey,
      vocalModelWindows,
    });
    // musicVideo comes from the fetch, not the DSP.
    return { ...fields, musicVideo };
  }

  /** One round trip to the worker, transferring the buffers. */
  private ask(videoId: string, request: AnalyzeRequest): Promise<Partial<TrackAnalysis>> {
    const worker = this.ensureWorker();
    return new Promise<AnalyzeResponse>((resolve, reject) => {
      this.pendingResolve = resolve;
      try {
        worker.postMessage(request, transferablesOf(request));
      } catch (e) {
        this.pendingResolve = null;
        reject(e);
      }
    }).then((response) => {
      if (response.type === 'error' || !response.result) throw new Error(response.message ?? 'analysis failed');
      return response.result;
    });
  }

  /**
   * Merges one rung's fields into the record and persists it. The merges
   * that need thought:
   * - energySpans: a new span replaces the one at its edge, never piles on.
   * - vocals: an open-unmix window replaces the cheap windows it covers.
   * - the grid version stamps only when BOTH mixable edges have landed.
   */
  private merge(
    videoId: string,
    fields: Partial<TrackAnalysis> & { vocalUncertain?: boolean },
    opts: { persisted?: boolean; tags?: TrackTags } = {},
  ): void {
    if (fields.vocalUncertain !== undefined) this.vocalUncertain.set(videoId, fields.vocalUncertain);
    const current = this.results.get(videoId);
    let next: TrackAnalysis;
    if (!current) {
      next = {
        fileKey: videoId,
        path: `youtube:${videoId}`,
        tags: opts.tags ?? fields.tags ?? { title: '', artist: '' },
        durationSec: fields.durationSec ?? 0,
        bpm: null,
        beatIntervalSec: null,
        firstDownbeatSec: null,
        gridConfidence: 0,
        camelot: null,
        keyName: null,
        keyConfidence: 0,
        energy: 0.5,
        energyCurve: [],
        introEndSec: null,
        outroStartSec: null,
        analysisVersion: ANALYSIS_VERSION,
      };
    } else {
      next = { ...current };
      if (fields.durationSec && fields.durationSec > 0) next.durationSec = fields.durationSec;
      if (fields.tags) next.tags = fields.tags;
      if (fields.musicVideo !== undefined) next.musicVideo = fields.musicVideo;
    }

    // grids
    if (fields.bpm != null) { next.bpm = fields.bpm; next.beatIntervalSec = fields.beatIntervalSec ?? next.beatIntervalSec; next.firstDownbeatSec = fields.firstDownbeatSec ?? next.firstDownbeatSec; next.gridConfidence = fields.gridConfidence ?? next.gridConfidence; }
    if (fields.headBeats !== undefined) next.headBeats = fields.headBeats;
    if (fields.tailBeats !== undefined) next.tailBeats = fields.tailBeats;
    if (fields.tailGrid !== undefined) next.tailGrid = fields.tailGrid;

    // energy: an incoming span replaces whatever sat at the same edge — L1's
    // phrase-windowed span supersedes L0's coarse one, never piles onto it
    if (fields.energySpans?.length) {
      const incoming = fields.energySpans;
      const kept = (next.energySpans ?? []).filter((s) => !incoming.some((n) => Math.abs(n.startSec - s.startSec) < 2));
      next.energySpans = [...kept, ...incoming];
    }
    if (fields.energyCurve?.length) next.energyCurve = fields.energyCurve;
    if (fields.energy != null) next.energy = fields.energy;
    if (fields.introEndSec !== undefined) next.introEndSec = fields.introEndSec;
    if (fields.outroStartSec !== undefined) next.outroStartSec = fields.outroStartSec;
    if (fields.contentEndSec !== undefined) next.contentEndSec = fields.contentEndSec;

    // loudness
    if (fields.lufs !== undefined && fields.lufs !== null) next.lufs = fields.lufs;
    if (fields.lufsHead !== undefined && fields.lufsHead !== null) next.lufsHead = fields.lufsHead;
    if (fields.lufsTail !== undefined && fields.lufsTail !== null) next.lufsTail = fields.lufsTail;

    // vocals: an open-unmix window replaces the cheap windows it covers
    if (fields.vocals?.length) {
      const model = fields.vocals.filter((w) => w.source === 'model');
      let kept = next.vocals ?? [];
      if (model.length) kept = kept.filter((w) => !model.some((m) => rangesOverlap(w, m)));
      next.vocals = [...kept, ...fields.vocals];
    }

    // key
    if (fields.camelot !== undefined) next.camelot = fields.camelot;
    if (fields.keyName !== undefined) next.keyName = fields.keyName;
    if (fields.keyConfidence !== undefined) next.keyConfidence = fields.keyConfidence;

    // component stamps: the grid only when both mixable edges have landed
    if (fields.gridVersion !== undefined) next.gridVersion = fields.gridVersion;
    else if ((next.headBeats != null || (next.bpm != null && next.gridConfidence > 0)) && (next.tailBeats != null || next.tailGrid != null)) {
      next.gridVersion = GRID_VERSION;
    }
    if (fields.vocalVersion !== undefined) next.vocalVersion = fields.vocalVersion;
    if (fields.miscVersion !== undefined) next.miscVersion = fields.miscVersion;

    this.results.set(videoId, next);
    if (opts.persisted && this.status.get(videoId) !== 'error') void putAnalysis(next);
  }
}

interface QueueEntry {
  videoId: string;
  tags: TrackTags;
  level: AnalysisLevel;
  edge?: 'head' | 'tail';
  urgent: boolean;
  seq: number;
}

/** One ranged edge copy: the bytes, and what the caller needs to place a decode of them on the timeline. */
interface EdgeState {
  bytes: ArrayBuffer;
  /** The track's length per the player response; 0 when unknown (full-fetch fallback). */
  trackDurationSec: number;
  musicVideo: boolean;
  /** True when the edge couldn't be aimed and the whole file came back instead. */
  fellBackToFull: boolean;
  mono44?: Float32Array;
  mono22?: Float32Array;
}

function rungKey(videoId: string, level: AnalysisLevel, edge?: 'head' | 'tail'): string {
  return `${videoId}:${level}:${edge ?? '*'}`;
}

/** The phrase window an energy curve is read at: 16 beats, in sane bounds. */
export function phraseWindowSec(beatIntervalSec: number | null): number {
  const window = beatIntervalSec && beatIntervalSec > 0 ? beatIntervalSec * 16 : 4;
  return Math.max(2, Math.min(8, window));
}

function rangesOverlap(a: VocalWindow, b: VocalWindow): boolean {
  const aEnd = a.startSec + a.curve.length / a.fps;
  const bEnd = b.startSec + b.curve.length / b.fps;
  return a.startSec < bEnd && b.startSec < aEnd;
}

/** The buffers a request carries, for zero-copy transfer. */
function transferablesOf(request: AnalyzeRequest): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const push = (f?: Float32Array | null) => {
    if (f && f.buffer instanceof ArrayBuffer && f.buffer.byteLength > 0) out.push(f.buffer);
  };
  if (request.edge) {
    push(request.edge.mono22);
    push(request.edge.mono44);
  }
  for (const w of request.cheapVocalWindows ?? []) {
    push(w.left);
    push(w.right);
  }
  push(request.samples);
  for (const w of request.vocalModelWindows ?? []) {
    push(w.left);
    push(w.right);
  }
  return out;
}

/** A copy the worker can own: postMessage detaches the whole underlying buffer, and the edge decodes stay cached here. */
function copyForTransfer(f: Float32Array): Float32Array {
  if (f.buffer instanceof SharedArrayBuffer || !(f.buffer instanceof ArrayBuffer)) return new Float32Array(f);
  return new Float32Array(f);
}

function downmixToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i]! += data[i]! / channels;
  }
  return out;
}

export const analyzer = new Analyzer();
