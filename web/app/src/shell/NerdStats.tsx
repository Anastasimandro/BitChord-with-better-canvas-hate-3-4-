import { useEffect, useReducer, useState } from 'react';
import { useParty } from '@/party/listenTogether';
import type { AutoDJSnapshot } from '@/playback/automix';
import type { analyzer as Analyzer } from '@/playback/automix/analysis/analyzer';
import { mixReport, type ReportStats, type MixGesture, loadEvents, type TransitionEvent } from '@/playback/automix/telemetry';
import { AutomixEditor } from '@/playback/automix/engine/AutomixEditor';
import type { NowPlaying } from '@/state/player';
import { usePlayer } from '@/state/player';

/**
 * Stats for nerds, under the artist in the full-screen player (the phone's
 * SleeveNerdStats): the stream as it plays, and under it, dimmer, what
 * Automix is doing. Nothing at all while the setting is off.
 */
export function NerdStats() {
  const show = usePlayer((s) => s.showNerdStats);
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const automix = usePlayer((s) => s.automix);
  if (!show || !nowPlaying) return null;
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-px type-[500_11px/14px] tabular-nums [text-shadow:0_1px_4px_rgb(0_0_0/0.55)]">
      <span className="truncate text-secondary">{describeStream(nowPlaying) ?? 'Measuring the stream…'}</span>
      {automix && <AutomixLine videoId={nowPlaying.videoId} />}
      {automix && <MixReport />}
    </div>
  );
}

/**
 * The mix report (Automix 2.0 Phase 0): what the mix loop chose and why,
 * this session and across the local ring of ~500 events. Text and a table,
 * no charts; one tap to open once stats for nerds are on.
 */
function MixReport() {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<{ session: ReportStats; aggregate: ReportStats } | null>(null);
  const [pairDetail, setPairDetail] = useState<TransitionEvent | null>(null);
  useEffect(() => {
    if (open) setReport(mixReport());
  }, [open]);
  if (!open) {
    return (
      <button type="button" className="self-start truncate text-tertiary underline decoration-dotted" onClick={() => setOpen(true)}>
        mix report
      </button>
    );
  }
  if (pairDetail) {
    const [outId, inId] = pairDetail.pair.split('>');
    return (
      <div className="flex flex-col gap-px text-tertiary">
        <button type="button" className="self-start underline decoration-dotted" onClick={() => setPairDetail(null)}>
          ← back to mix report
        </button>
        <AutomixEditor
          outgoingVideoId={outId ?? ''}
          incomingVideoId={inId ?? ''}
          onClose={() => setPairDetail(null)}
          onSave={() => { /* overrides saved via editor's internal logic */ }}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-px text-tertiary">
      <button type="button" className="self-start underline decoration-dotted" onClick={() => setOpen(false)}>
        mix report
      </button>
      {report && <MixReportBody report={report} onPairClick={setPairDetail} />}
    </div>
  );
}

/** "loop 3 · filter 2 · crossfade 1 · skip 12% · both grids 80%", sessions and all time. */
function MixReportBody({ report, onPairClick }: { report: { session: ReportStats; aggregate: ReportStats }; onPairClick: (e: TransitionEvent) => void }) {
  const [events, setEvents] = useState<TransitionEvent[]>([]);
  useEffect(() => {
    setEvents(loadEvents().slice(-20).reverse());
  }, []);

  const line = (s: ReportStats) => {
    if (!s.total) return 'no transitions recorded yet';
    const styles = s.styles.length ? s.styles.map((st) => `${st.style} ${st.count}`).join(' · ') : 'none';
    const skip = s.styles.some((st) => st.skipRate !== null)
      ? ` · skipped ${Math.round(100 * (s.styles.reduce((a, st) => a + (st.skipRate ?? 0) * st.count, 0) / Math.max(1, s.completed)))}%`
      : '';
    const reasons = s.topReasons.length ? ` · ${s.topReasons.map((r) => `${r.reason} ×${r.count}`).join(' · ')}` : '';
    return `${styles}${skip} · both grids ${Math.round(100 * s.hitRate)}%${reasons}`;
  };
  const gestureLine = (s: ReportStats) => {
    if (!s.total) return 'no gestures recorded yet';
    const gestures = s.gestures.length ? s.gestures.map((g) => `${g.gesture} ${g.count}`).join(' · ') : 'none';
    const skip = s.gestures.some((g) => g.skipRate !== null)
      ? ` · skipped ${Math.round(100 * (s.gestures.reduce((a, g) => a + (g.skipRate ?? 0) * g.count, 0) / Math.max(1, s.completed)))}%`
      : '';
    return `${gestures}${skip}`;
  };

  const formatPair = (pair: string) => {
    const parts = pair.split('>');
    const out = parts[0] ?? '';
    const inn = parts[1] ?? '';
    return `${out.slice(0, 8)}… → ${inn.slice(0, 8)}…`;
  };

  const formatTime = (ms: number) => {
    const date = new Date(ms);
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
  };

  return (
    <>
      <span className="truncate">
        session ({report.session.total}): {line(report.session)}
      </span>
      <span className="truncate">
        all time ({report.aggregate.total}): {line(report.aggregate)}
      </span>
      <span className="truncate">
        gestures (session): {gestureLine(report.session)}
      </span>
      <span className="truncate">
        gestures (all time): {gestureLine(report.aggregate)}
      </span>
      <div className="mt-2 flex flex-col gap-1 border-t border-divider pt-2">
        <span className="type-caption-2 text-secondary uppercase tracking-wide">recent pairs (tap to edit)</span>
        {events.length === 0 ? (
          <span className="type-caption-2 text-tertiary">no transitions recorded yet</span>
        ) : (
          events.map((e, i) => (
            <button
              key={`${e.pair}-${e.at}`}
              onClick={() => onPairClick(e)}
              className="text-left truncate type-caption-2 text-tertiary hover:text-primary py-1 px-2 rounded-row hover:bg-quinary transition-colors"
              style={{ borderLeft: '3px solid', borderLeftColor: styleColor(e.styleChosen) }}
            >
              <span className="font-mono text-[10px] mr-2">{formatTime(e.at)}</span>
              <span className="font-mono text-[10px] mr-2">{formatPair(e.pair)}</span>
              <span className="px-1.5 py-0.5 rounded-[3px] bg-quaternary text-[9px]">{e.styleChosen}</span>
              {e.overridesApplied && e.overridesApplied.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-[3px] bg-key/20 text-key text-[9px]">manual</span>
              )}
              {e.gesture !== 'none' && (
                <span className="ml-1 px-1.5 py-0.5 rounded-[3px] bg-amber/20 text-amber text-[9px]">{e.gesture}</span>
              )}
              {e.stemUsed && (
                <span className="ml-1 px-1.5 py-0.5 rounded-[3px] bg-green/20 text-green text-[9px]">stems</span>
              )}
            </button>
          ))
        )}
      </div>
    </>
  );
}

function styleColor(style: string): string {
  switch (style) {
    case 'loop': return '#8b5cf6';
    case 'blend': return '#22d3ee';
    case 'filter': return '#ec4899';
    case 'fade': return '#f59e0b';
    case 'gap': return '#22c55e';
    case 'crossfade': return '#6b7280';
    default: return '#6b7280';
  }
}

/** "Opus · 48 kHz · 141 kbps · Stereo · itag 251 · VISIONOS direct", as much as is known. */
function describeStream(np: NowPlaying): string | null {
  const s = np.stream;
  if (!s) return null;
  const parts = [
    s.codec,
    s.sampleRateHz ? `${+(s.sampleRateHz / 1000).toFixed(1)} kHz` : null,
    s.bitrateKbps ? `${s.bitrateKbps} kbps` : null,
    s.channels ? ({ 1: 'Mono', 2: 'Stereo' } as Record<number, string>)[s.channels] ?? `${s.channels} channels` : null,
    s.itag ? `itag ${s.itag}` : null,
    `${s.client} ${s.mode}`,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Automix's line: both songs' analysis while it waits, the blend once one is planned. Both sides always named. */
function AutomixLine({ videoId }: { videoId: string }) {
  const state = usePlayer((s) => s.automixState);
  const nextInQueue = usePlayer((s) => s.queue[s.index + 1]?.track.videoId ?? null);
  const inParty = useParty((s) => !!s.code);
  const analyzer = useAnalyzer();

  let text: string;
  if (inParty) text = 'Automix: stopped in Listen Together';
  else if (state?.state === 'scheduled' && state.plan) text = describeBlend(state);
  else if (state?.loop) text = `Automix · loop mix ready · ${describeLoop(state)}`;
  else {
    const label = (id: string | null, outgoing: boolean) => {
      if (!id || !analyzer) return 'waiting';
      const a = analyzer.get(id);
      if (a) {
        const g = outgoing && a.tailGrid !== undefined ? a.tailGrid : a.bpm ? { bpm: a.bpm, gridConfidence: a.gridConfidence } : null;
        const key = a.camelot ? ` ${a.camelot.num}${a.camelot.letter}` : '';
        const video = a.musicVideo ? ', music video: no loop' : '';
        if (!g) return `analysed (no beat${key}${video})`;
        const grid = g.gridConfidence >= 0.2 ? `grid ${g.gridConfidence.toFixed(2)}` : `weak grid ${g.gridConfidence.toFixed(2)}`;
        return `analysed (${Math.round(g.bpm)} BPM${key}, ${grid}${video})`;
      }
      const status = analyzer.statusOf(id);
      return status === 'analyzing' ? 'analysing…' : status === 'error' ? 'failed' : 'waiting';
    };
    const next = state?.nextKey ?? nextInQueue;
    text = `Automix · this song: ${label(videoId, true)} · next: ${next ? label(next, false) : 'none'}`;
  }
  return <span className="truncate text-tertiary">{text}</span>;
}

/** "out 4-bar loop, clear by lyrics · in 2-bar, clear by mask · 111 → 85 BPM over 11 bars". */
function describeLoop(state: AutoDJSnapshot): string {
  const l = state.loop!;
  const from = Math.round(l.out.bpm);
  const to = Math.round(l.in.bpm / l.fold);
  const tempo = from === to ? `${from} BPM` : `${from} → ${to} BPM over ${l.rampBars} bars`;
  const fold = l.fold === 1 ? '' : l.fold > 1 ? ' (next in double time)' : ' (next in half time)';
  const side = (p: typeof l.out) => `${p.bars}-bar, clear by ${p.checkedBy}`;
  return `out ${side(l.out)} · in ${side(l.in)} · ${tempo}${fold}`;
}

function describeBlend(state: AutoDJSnapshot): string {
  const plan = state.plan!;
  const when =
    state.startsInSec !== null && state.startsInSec > 0 ? `in ${Math.ceil(state.startsInSec)} s` : 'now';
  if (plan.style === 'loop' && state.loop) {
    return `Automix · ${state.startsInSec !== null && state.startsInSec > 0 ? `loop mix ${when}` : 'looping'} · ${describeLoop(state)}`;
  }
  if (plan.style === 'crossfade') return `Automix · crossfading ${when} · ${Math.round(plan.durationSec)} s · ${plan.reason ?? 'no beat match'}`;
  const bars = state.beatSec ? Math.round(plan.durationSec / (4 * state.beatSec)) : null;
  if (plan.style === 'filter') return `Automix · filter mix ${when} · ${bars ? `${bars} bars` : `${plan.durationSec.toFixed(1)} s`} · ${plan.reason}`;
  const stretch = Math.abs(plan.rate - 1) < 0.0005 ? 'same tempo' : `next at ${plan.rate.toFixed(3)}×`;
  return `Automix · mixing ${when} · ${bars ? `${bars} bars` : `${plan.durationSec.toFixed(1)} s`} · ${stretch}`;
}

/** The analysis queue, once the Automix code is loaded; re-renders as its statuses change. */
function useAnalyzer(): typeof Analyzer | null {
  const [instance, setInstance] = useState<typeof Analyzer | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let live = true;
    void import('@/playback/automix/analysis/analyzer').then(({ analyzer }) => {
      if (!live) return;
      setInstance(analyzer);
      unsubscribe = analyzer.subscribe(bump);
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);
  return instance;
}

/**
 * The stretch of the seek bar the next Automix blend covers (the phone's
 * transitionWindow): brighter than the unplayed track, under the played
 * fill, feathered at both ends because a blend has no hard edge in time.
 * Once the blend runs it steps aside for the fill's own beat pulse
 * (useScrubber). Place it inside the bar's track, before the fill.
 */
export function MixWindowHighlight() {
  const mix = usePlayer((s) => s.automixState?.window ?? null);
  const startsIn = usePlayer((s) => s.automixState?.startsInSec ?? null);
  const videoId = usePlayer((s) => s.nowPlaying?.videoId);
  const duration = usePlayer((s) => s.nowPlaying?.durationSec ?? 0);
  const automix = usePlayer((s) => s.automix);
  const [shown, setShown] = useState(mix);
  useEffect(() => {
    if (mix) setShown(mix);
  }, [mix]);
  const visible = automix && !!mix && mix.videoId === videoId && duration > 0;
  const w = shown;
  if (!w || duration <= 0) return null;
  const left = Math.max(0, Math.min(1, w.startSec / duration));
  const right = Math.max(left, Math.min(1, w.endSec / duration));
  const blending = startsIn !== null && startsIn <= 0;
  return (
    <div
      className="pointer-events-none absolute inset-y-0 transition-opacity duration-500"
      style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%`, opacity: visible && !blending ? 1 : 0 }}
      aria-hidden="true"
    >
      <div
        className="size-full bg-tertiary"
        style={{
          maskImage: 'linear-gradient(to right, transparent, #000 30%, #000 70%, transparent)',
        }}
      />
    </div>
  );
}