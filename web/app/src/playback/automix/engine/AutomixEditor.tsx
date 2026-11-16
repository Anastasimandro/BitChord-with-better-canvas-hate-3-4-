import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { usePlayer } from '@/state/player';
import { analyzer } from '@/playback/automix/analysis/analyzer';
import type { TrackAnalysis } from '@/playback/automix/analysis/types';
import { scoreStyles, type StyleScorerInput } from '@/playback/automix/engine/policy';
import { applyOverrides } from '@/playback/automix/engine/transition-scheduler';
import { PRESET_OVERRIDES, type PresetName, applyPreset } from '@/playback/automix/engine/presets';
import type { TransitionPlan } from '@/playback/automix/engine/transition-scheduler';
import type { MixStyle, MixGesture } from '@/playback/automix/telemetry';

interface AutomixEditorProps {
  outgoingVideoId: string;
  incomingVideoId: string;
  onClose: () => void;
  onSave: (overrides: {
    outgoing: TrackAnalysis['manualOverrides'];
    incoming: TrackAnalysis['manualOverrides'];
  }) => void;
}

export function AutomixEditor({
  outgoingVideoId,
  incomingVideoId,
  onClose,
  onSave,
}: AutomixEditorProps) {
  const [outgoing, setOutgoing] = useState<TrackAnalysis | null>(null);
  const [incoming, setIncoming] = useState<TrackAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [outgoingOverrides, setOutgoingOverrides] = useState<TrackAnalysis['manualOverrides']>({});
  const [incomingOverrides, setIncomingOverrides] = useState<TrackAnalysis['manualOverrides']>({});
  const [selectedPreset, setSelectedPreset] = useState<PresetName | 'Auto'>('Auto');
  const [entryBeat, setEntryBeat] = useState<number>(1);
  const [overlapBars, setOverlapBars] = useState<number>(16);
  const [gesture, setGesture] = useState<MixGesture>('none');
  const [gestureLengthBars, setGestureLengthBars] = useState<number>(8);
  const [gridNudgeBeats, setGridNudgeBeats] = useState<number>(0);
  const [outgoingBpm, setOutgoingBpm] = useState<number | null>(null);
  const [incomingBpm, setIncomingBpm] = useState<number | null>(null);
  const [outgoingCamelot, setOutgoingCamelot] = useState<string>('');
  const [incomingCamelot, setIncomingCamelot] = useState<string>('');

  const [previewing, setPreviewing] = useState(false);
  const [previewPlan, setPreviewPlan] = useState<TransitionPlan | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const curvesCanvasRef = useRef<HTMLCanvasElement>(null);
  const markersCanvasRef = useRef<HTMLCanvasElement>(null);

  const [dragging, setDragging] = useState<{
    type: 'entryBeat' | 'overlapStart' | 'overlapEnd' | 'gestureStart' | 'gestureEnd' | null;
    startX: number;
    startValue: number;
  } | null>(null);
  const [snapped, setSnapped] = useState(true);

  const computedPlan = useMemo(() => {
    if (!outgoing || !incoming) return null;
    return computePreviewPlan(outgoing, incoming, outgoingOverrides, incomingOverrides);
  }, [outgoing, incoming, outgoingOverrides, incomingOverrides]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        let out = analyzer.get(outgoingVideoId);
        let inn = analyzer.get(incomingVideoId);

        if (!out) {
          analyzer.request(outgoingVideoId, { title: '', artist: '' }, 0, { urgent: true, edge: 'tail' });
          await analyzer.whenLevel(outgoingVideoId, 0, 'tail', 10000);
          out = analyzer.get(outgoingVideoId);
        }
        if (!inn) {
          analyzer.request(incomingVideoId, { title: '', artist: '' }, 0, { urgent: true, edge: 'head' });
          await analyzer.whenLevel(incomingVideoId, 0, 'head', 10000);
          inn = analyzer.get(incomingVideoId);
        }

        if (out && inn) {
          setOutgoing(out);
          setIncoming(inn);
          setOutgoingOverrides(out.manualOverrides ?? {});
          setIncomingOverrides(inn.manualOverrides ?? {});
          initFromOverrides(out.manualOverrides, inn.manualOverrides);
        } else {
          setError('Analysis not available for one or both tracks');
        }
      } catch (e) {
        setError(`Failed to load analysis: ${e}`);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [outgoingVideoId, incomingVideoId]);

  const initFromOverrides = useCallback((outOverrides: TrackAnalysis['manualOverrides'] | undefined, inOverrides: TrackAnalysis['manualOverrides'] | undefined) => {
    const planOverride = inOverrides?.planOverride ?? outOverrides?.planOverride;
    if (planOverride) {
      if (planOverride.style) {
        const presetEntry = Object.entries(PRESET_OVERRIDES).find(([, v]) => v && v.style === planOverride.style);
        const preset = presetEntry?.[0] as PresetName | undefined;
        setSelectedPreset(preset ?? 'Auto');
      }
      if (planOverride.entryBeat) setEntryBeat(planOverride.entryBeat);
      if (planOverride.overlapBars) setOverlapBars(planOverride.overlapBars);
      if (planOverride.gesture) setGesture(planOverride.gesture);
    }
    if (outOverrides?.bpm !== undefined) setOutgoingBpm(outOverrides.bpm);
    if (inOverrides?.bpm !== undefined) setIncomingBpm(inOverrides.bpm);
    if (outOverrides?.camelot) setOutgoingCamelot(outOverrides.camelot);
    if (inOverrides?.camelot) setIncomingCamelot(inOverrides.camelot);
    if (inOverrides?.gridNudgeBeats !== undefined) setGridNudgeBeats(inOverrides.gridNudgeBeats);
  }, []);

  useEffect(() => {
    if (!outgoing || !incoming) return;
    drawWaveform(outgoing, incoming);
    drawGrid(outgoing, incoming);
    drawCurves(outgoing, incoming);
    drawMarkers();
  }, [outgoing, incoming, entryBeat, overlapBars, gesture, gestureLengthBars, computedPlan]);

  const drawWaveform = useCallback((out: TrackAnalysis, inn: TrackAnalysis) => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const outGrid = out.tailGrid ?? (out.bpm ? { bpm: out.bpm, beatIntervalSec: 60 / out.bpm, firstDownbeatSec: out.firstDownbeatSec ?? 0, gridConfidence: out.gridConfidence } : null);
    const inGrid = inn.headBeats ? { bpm: inn.bpm ?? 120, beatIntervalSec: 60 / (inn.bpm ?? 120), firstDownbeatSec: inn.firstDownbeatSec ?? 0, gridConfidence: inn.gridConfidence } : null;

    if (!outGrid || !inGrid) return;

    const outRate = 1;
    const inRate = outGrid.bpm / inGrid.bpm;
    const effBpm = outGrid.bpm * outRate;
    const beatSec = 60 / effBpm;
    const barSec = beatSec * 4;

    const plan = computedPlan;
    let mixOutTrackTime: number;
    let hasPlanMixOut = false;
    if (plan && plan.mixOutTrackTime !== undefined && plan.mixOutTrackTime !== null) {
      hasPlanMixOut = true;
    }
    if (hasPlanMixOut && plan) {
      mixOutTrackTime = plan.mixOutTrackTime;
    } else {
      let hasContentEnd = false;
      if (out.contentEndSec !== undefined && out.contentEndSec !== null) {
        hasContentEnd = true;
      }
      let hasOutroStart = false;
      if (out.outroStartSec !== undefined && out.outroStartSec !== null) {
        hasOutroStart = true;
      }
      if (hasContentEnd) {
        mixOutTrackTime = out.contentEndSec!;
      } else if (hasOutroStart) {
        mixOutTrackTime = out.outroStartSec!;
      } else {
        mixOutTrackTime = out.durationSec - 30;
      }
    }

    let mixInTrackTime: number;
    let hasPlanMixIn = false;
    if (plan && plan.mixInTrackTime !== undefined && plan.mixInTrackTime !== null) {
      hasPlanMixIn = true;
    }
    if (hasPlanMixIn && plan) {
      mixInTrackTime = plan.mixInTrackTime;
    } else {
      let hasFirstDownbeat = false;
      if (inn.firstDownbeatSec !== undefined && inn.firstDownbeatSec !== null) {
        hasFirstDownbeat = true;
      }
      mixInTrackTime = hasFirstDownbeat ? inn.firstDownbeatSec! : 0;
    }

    let durationSec: number;
    let hasPlanDuration = false;
    if (plan && plan.durationSec !== undefined && plan.durationSec !== null) {
      hasPlanDuration = true;
    }
    if (hasPlanDuration && plan) {
      durationSec = plan.durationSec;
    } else {
      durationSec = overlapBars * barSec;
    }

    const windowStart = mixOutTrackTime;
    const windowEnd = mixOutTrackTime + durationSec * outRate;

    drawEnergyCurve(ctx, out, 0, rect.height / 2, windowStart, windowEnd, '#8b5cf6', rect.width);
    drawEnergyCurve(ctx, inn, rect.height / 2, rect.height / 2, mixInTrackTime, mixInTrackTime + durationSec * inRate, '#22d3ee', rect.width);
  }, [outgoing, incoming, computedPlan, overlapBars]);

  const drawGrid = useCallback((out: TrackAnalysis, inn: TrackAnalysis) => {
    const canvas = gridCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const outGrid = out.tailGrid ?? (out.bpm ? { bpm: out.bpm, beatIntervalSec: 60 / out.bpm, firstDownbeatSec: out.firstDownbeatSec ?? 0, gridConfidence: out.gridConfidence } : null);
    const inGrid = inn.headBeats ? { bpm: inn.bpm ?? 120, beatIntervalSec: 60 / (inn.bpm ?? 120), firstDownbeatSec: inn.firstDownbeatSec ?? 0, gridConfidence: inn.gridConfidence } : null;

    if (!outGrid || !inGrid) return;

    const plan = computedPlan;
    let mixOutTrackTime: number;
    let hasPlanMixOut = false;
    if (plan && plan.mixOutTrackTime !== undefined && plan.mixOutTrackTime !== null) {
      hasPlanMixOut = true;
    }
    if (hasPlanMixOut && plan) {
      mixOutTrackTime = plan.mixOutTrackTime;
    } else {
      let hasContentEnd = false;
      if (out.contentEndSec !== undefined && out.contentEndSec !== null) {
        hasContentEnd = true;
      }
      let hasOutroStart = false;
      if (out.outroStartSec !== undefined && out.outroStartSec !== null) {
        hasOutroStart = true;
      }
      if (hasContentEnd) {
        mixOutTrackTime = out.contentEndSec!;
      } else if (hasOutroStart) {
        mixOutTrackTime = out.outroStartSec!;
      } else {
        mixOutTrackTime = out.durationSec - 30;
      }
    }

    let mixInTrackTime: number;
    let hasPlanMixIn = false;
    if (plan && plan.mixInTrackTime !== undefined && plan.mixInTrackTime !== null) {
      hasPlanMixIn = true;
    }
    if (hasPlanMixIn && plan) {
      mixInTrackTime = plan.mixInTrackTime;
    } else {
      let hasFirstDownbeat = false;
      if (inn.firstDownbeatSec !== undefined && inn.firstDownbeatSec !== null) {
        hasFirstDownbeat = true;
      }
      mixInTrackTime = hasFirstDownbeat ? inn.firstDownbeatSec! : 0;
    }

    let durationSec: number;
    let hasPlanDuration = false;
    if (plan && plan.durationSec !== undefined && plan.durationSec !== null) {
      hasPlanDuration = true;
    }
    if (hasPlanDuration && plan) {
      durationSec = plan.durationSec;
    } else {
      durationSec = overlapBars * 4 * (60 / (outGrid.bpm * 1));
    }

    const windowStart = mixOutTrackTime;
    const windowEnd = windowStart + durationSec;

    drawBeatGrid(ctx, outGrid, 0, rect.height / 2, windowStart, windowEnd, rect.width, '#8b5cf6');
    drawBeatGrid(ctx, inGrid, rect.height / 2, rect.height / 2, mixInTrackTime, mixInTrackTime + durationSec, rect.width, '#22d3ee');
  }, [outgoing, incoming, computedPlan, overlapBars]);

  const drawCurves = useCallback((out: TrackAnalysis, inn: TrackAnalysis) => {
    const canvas = curvesCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const plan = computedPlan;
    if (!plan) return;

    const outGrid = out.tailGrid ?? (out.bpm ? { bpm: out.bpm, beatIntervalSec: 60 / out.bpm, firstDownbeatSec: out.firstDownbeatSec ?? 0, gridConfidence: out.gridConfidence } : null);
    const inGrid = inn.headBeats ? { bpm: inn.bpm ?? 120, beatIntervalSec: 60 / (inn.bpm ?? 120), firstDownbeatSec: inn.firstDownbeatSec ?? 0, gridConfidence: inn.gridConfidence } : null;
    if (!outGrid || !inGrid) return;

    const mixOutTrackTime = plan.mixOutTrackTime;
    const mixInTrackTime = plan.mixInTrackTime;
    const durationSec = plan.durationSec;
    const windowStart = mixOutTrackTime;
    const windowEnd = windowStart + durationSec;

    const outRate = 1;
    const inRate = outGrid.bpm / inGrid.bpm;

    drawVolumeCurves(ctx, windowStart, windowEnd, durationSec, outRate, inRate, rect.width, rect.height / 2);

    if (plan.style === 'blend' || plan.style === 'filter') {
      drawEqCurves(ctx, windowStart, windowEnd, durationSec, outGrid, inGrid, outRate, inRate, plan, rect.width, rect.height / 2);
    }

    if (plan.style === 'filter') {
      drawFilterSweep(ctx, windowStart, windowEnd, rect.width, rect.height / 2);
    }

    if (plan.gesture && plan.gesture !== 'none') {
      drawGestureSpan(ctx, plan, windowStart, windowEnd, rect.width, rect.height / 2);
    }
  }, [outgoing, incoming, computedPlan]);

  const drawMarkers = useCallback(() => {
    const canvas = markersCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const plan = computedPlan;
    if (!plan || !outgoing || !incoming) return;

    const outGrid = outgoing.tailGrid ?? (outgoing.bpm ? { bpm: outgoing.bpm, beatIntervalSec: 60 / outgoing.bpm, firstDownbeatSec: outgoing.firstDownbeatSec ?? 0, gridConfidence: outgoing.gridConfidence } : null);
    const inGrid = incoming.headBeats ? { bpm: incoming.bpm ?? 120, beatIntervalSec: 60 / (incoming.bpm ?? 120), firstDownbeatSec: incoming.firstDownbeatSec ?? 0, gridConfidence: incoming.gridConfidence } : null;
    if (!outGrid || !inGrid) return;

    const mixOutTrackTime = plan.mixOutTrackTime;
    const mixInTrackTime = plan.mixInTrackTime;
    const durationSec = plan.durationSec;
    const windowStart = mixOutTrackTime;
    const windowEnd = windowStart + durationSec;

    const outRate = 1;
    const inRate = outGrid.bpm / inGrid.bpm;
    const beatSec = 60 / (outGrid.bpm * outRate);
    const barSec = beatSec * 4;

    const entryBeatSec = mixInTrackTime + (entryBeat - 1) * barSec;
    const entryX = timeToX(entryBeatSec, mixInTrackTime, mixInTrackTime + durationSec * inRate, rect.width);
    drawMarker(ctx, entryX, rect.height / 2, rect.height, 'Entry Beat', '#22d3ee', dragging?.type === 'entryBeat');

    const overlapStartX = timeToX(windowStart, windowStart, windowEnd, rect.width);
    const overlapEndX = timeToX(windowEnd, windowStart, windowEnd, rect.width);
    drawMarker(ctx, overlapStartX, 0, rect.height / 2, 'Overlap Start', '#8b5cf6', dragging?.type === 'overlapStart');
    drawMarker(ctx, overlapEndX, 0, rect.height / 2, 'Overlap End', '#8b5cf6', dragging?.type === 'overlapEnd');

    if (gesture !== 'none' && gestureLengthBars > 0) {
      const gestureStartSec = windowEnd - gestureLengthBars * barSec;
      const gestureStartX = timeToX(gestureStartSec, windowStart, windowEnd, rect.width);
      const gestureEndX = timeToX(windowEnd, windowStart, windowEnd, rect.width);
      drawMarker(ctx, gestureStartX, 0, rect.height, 'Gesture Start', '#f59e0b', dragging?.type === 'gestureStart');
      drawMarker(ctx, gestureEndX, 0, rect.height, 'Gesture End', '#f59e0b', dragging?.type === 'gestureEnd');
    }
  }, [outgoing, incoming, computedPlan, entryBeat, overlapBars, gesture, gestureLengthBars, dragging]);

  const handleMouseDown = useCallback((e: React.MouseEvent, type: 'entryBeat' | 'overlapStart' | 'overlapEnd' | 'gestureStart' | 'gestureEnd') => {
    const canvas = markersCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setDragging({ type, startX: x, startValue: getValueForType(type) });
    e.preventDefault();
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging || !outgoing || !incoming || !computedPlan) return;

    const dragType = dragging.type;
    if (!dragType) return;

    const canvas = markersCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const deltaX = x - dragging.startX;

    const plan = computedPlan;
    const outGrid = outgoing.tailGrid ?? (outgoing.bpm ? { bpm: outgoing.bpm, beatIntervalSec: 60 / outgoing.bpm, firstDownbeatSec: outgoing.firstDownbeatSec ?? 0, gridConfidence: outgoing.gridConfidence } : null);
    const inGrid = incoming.headBeats ? { bpm: incoming.bpm ?? 120, beatIntervalSec: 60 / (incoming.bpm ?? 120), firstDownbeatSec: incoming.firstDownbeatSec ?? 0, gridConfidence: incoming.gridConfidence } : null;
    if (!outGrid || !inGrid) return;

    const mixOutTrackTime = plan.mixOutTrackTime;
    const mixInTrackTime = plan.mixInTrackTime;
    const durationSec = plan.durationSec;
    const windowStart = mixOutTrackTime;
    const windowEnd = windowStart + durationSec;

    const outRate = 1;
    const inRate = outGrid.bpm / inGrid.bpm;
    const beatSec = 60 / (outGrid.bpm * outRate);
    const barSec = beatSec * 4;

    const pixelsPerSec = rect.width / (windowEnd - windowStart);
    const deltaSec = deltaX / pixelsPerSec;

    let newValue = dragging.startValue;
    let snappedTo = false;

    switch (dragType) {
      case 'entryBeat': {
        const beatDelta = deltaSec / barSec;
        newValue = Math.max(1, Math.round(dragging.startValue + beatDelta));
        snappedTo = true;
        break;
      }
      case 'overlapStart': {
        const barDelta = deltaSec / barSec;
        newValue = Math.max(1, Math.min(overlapBars, Math.round(overlapBars + barDelta)));
        snappedTo = true;
        break;
      }
      case 'overlapEnd': {
        const barDelta = deltaSec / barSec;
        newValue = Math.max(1, Math.min(overlapBars, Math.round(overlapBars + barDelta)));
        snappedTo = true;
        break;
      }
      case 'gestureStart':
      case 'gestureEnd': {
        const barDelta = deltaSec / barSec;
        newValue = Math.max(1, Math.min(gestureLengthBars, Math.round(gestureLengthBars + barDelta)));
        snappedTo = true;
        break;
      }
    }

    setSnapped(snappedTo);
    applyValueForType(dragType, newValue);
  }, [dragging, outgoing, incoming, computedPlan, overlapBars, gestureLengthBars]);

  const handleMouseUp = useCallback(() => {
    setDragging(null);
    setSnapped(true);
  }, []);

  const getValueForType = (type: string): number => {
    switch (type) {
      case 'entryBeat': return entryBeat;
      case 'overlapStart':
      case 'overlapEnd': return overlapBars;
      case 'gestureStart':
      case 'gestureEnd': return gestureLengthBars;
      default: return 0;
    }
  };

  const applyValueForType = (type: string, value: number) => {
    switch (type) {
      case 'entryBeat': setEntryBeat(value); break;
      case 'overlapStart':
      case 'overlapEnd': setOverlapBars(value); break;
      case 'gestureStart':
      case 'gestureEnd': setGestureLengthBars(value); break;
    }
  };

  const handlePreview = useCallback(() => {
    if (!outgoing || !incoming) return;
    setPreviewing(true);
    setPreviewError(null);

    try {
      const plan = computePreviewPlan(outgoing, incoming, outgoingOverrides, incomingOverrides);
      if (!plan) throw new Error('Failed to compute preview plan');

      setPreviewPlan(plan);
      setPreviewing(false);
    } catch (e) {
      setPreviewError(`Preview failed: ${e}`);
      setPreviewing(false);
    }
  }, [outgoing, incoming, outgoingOverrides, incomingOverrides]);

  const handleSave = useCallback(async () => {
    const outBpm = outgoingBpm !== null ? outgoingBpm : undefined;
    const inBpm = incomingBpm !== null ? incomingBpm : undefined;
    const outOverrides: TrackAnalysis['manualOverrides'] = {
      ...outgoingOverrides,
      bpm: outBpm,
      camelot: outgoingCamelot || undefined,
    };
    const inOverrides: TrackAnalysis['manualOverrides'] = {
      ...incomingOverrides,
      bpm: inBpm,
      camelot: incomingCamelot || undefined,
      gridNudgeBeats: gridNudgeBeats || undefined,
      planOverride: {
        style: selectedPreset !== 'Auto' ? PRESET_OVERRIDES[selectedPreset as PresetName]!.style : undefined,
        entryBeat: entryBeat > 1 ? entryBeat : undefined,
        overlapBars: overlapBars !== 16 ? overlapBars : undefined,
        gesture: gesture !== 'none' ? gesture : undefined,
      },
    };

    if (outgoing && incoming) {
      await Promise.all([
        analyzer.updateManualOverrides(outgoingVideoId, outOverrides),
        analyzer.updateManualOverrides(incomingVideoId, inOverrides),
      ]);
    }

    onSave({ outgoing: outOverrides, incoming: inOverrides });
    onClose();
  }, [
    outgoing, incoming,
    outgoingOverrides, incomingOverrides,
    outgoingBpm, incomingBpm,
    outgoingCamelot, incomingCamelot,
    gridNudgeBeats, selectedPreset,
    entryBeat, overlapBars, gesture,
    outgoingVideoId, incomingVideoId,
    onSave, onClose
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (loading) {
    return (
      <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-scrim/80">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-key border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-scrim/80">
        <div className="rounded-[10px] bg-page p-6 max-w-md mx-4">
          <h2 className="type-title-2-emphasized mb-4">Error</h2>
          <p className="type-body text-secondary mb-6">{error}</p>
          <button onClick={onClose} className="rounded-pill bg-key-bg px-6 py-2 type-title-3-emphasized text-white">
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-scrim/80 animate-fade-in">
      <div className="w-full max-w-[1200px] max-h-[90vh] m-4 rounded-[10px] bg-page overflow-hidden flex flex-col">
        <header className="flex items-center justify-between p-4 border-b border-divider">
          <h2 className="type-title-2-emphasized">
            {outgoing?.tags.title ?? 'Outgoing'} → {incoming?.tags.title ?? 'Incoming'}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePreview}
              disabled={previewing}
              className={`rounded-pill px-4 py-2 type-title-3-emphasized ${previewing ? 'bg-gray-5 text-tertiary' : 'bg-key-bg text-white'}`}
            >
              {previewing ? 'Computing…' : 'Preview Plan'}
            </button>
            <button onClick={onClose} className="rounded-pill px-4 py-2 type-title-3-emphasized text-secondary hover:text-primary">
              Close
            </button>
          </div>
        </header>

        <div className="flex-1 flex overflow-auto p-4 gap-4">
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="relative flex-1 min-h-[300px] rounded-[10px] bg-quinary overflow-hidden">
              <canvas ref={waveformCanvasRef} className="absolute inset-0" aria-hidden="true" />
              <canvas ref={gridCanvasRef} className="absolute inset-0" aria-hidden="true" />
              <canvas ref={curvesCanvasRef} className="absolute inset-0" aria-hidden="true" />
              <canvas
                ref={markersCanvasRef}
                className="absolute inset-0 cursor-crosshair"
                onMouseDown={(e) => handleMouseDown(e, 'entryBeat')}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                role="application"
                aria-label="Transition editor: drag markers to adjust entry beat, overlap, and gesture"
              />
            </div>

            <div className="flex flex-wrap gap-4 type-caption-2 text-tertiary">
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#8b5cf6]" /> Outgoing</span>
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#22d3ee]" /> Incoming</span>
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-white" /> Volume</span>
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#f59e0b]" /> Gesture</span>
              {snapped && <span className="flex items-center gap-1 text-green"><span className="w-3 h-3 rounded-full border border-green" /> Snapped</span>}
              {!snapped && <span className="flex items-center gap-1 text-amber"><span className="w-3 h-3 rounded-full border border-amber" /> Uns</span>}
            </div>
          </div>

          <div className="w-[360px] flex-shrink-0 space-y-4 overflow-auto">
            <fieldset className="rounded-[10px] bg-quinary p-4">
              <legend className="type-subhead-emphasized mb-3">Style</legend>
              <div className="grid grid-cols-2 gap-2">
                {(['Auto', 'Fade', 'Rise', 'Blend', 'Loop'] as const).map((preset) => (
                  <button
                    key={preset}
                    onClick={() => {
                      setSelectedPreset(preset as PresetName | 'Auto');
                      if (preset !== 'Auto') {
                        const presetName = preset as PresetName;
                        const applied = applyPreset(incomingOverrides, presetName, true);
                        setIncomingOverrides(applied);
                        const po = PRESET_OVERRIDES[presetName]!;
                        if (po.style) setSelectedPreset(presetName);
                        if (po.gesture) setGesture(po.gesture);
                      }
                    }}
                    className={`rounded-row px-3 py-2 type-body-emphasized transition-colors ${
                      selectedPreset === preset
                        ? 'bg-key-bg text-white'
                        : 'bg-quaternary text-secondary hover:text-primary'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="rounded-[10px] bg-quinary p-4">
              <legend className="type-subhead-emphasized mb-3">Entry Beat (1 = first downbeat)</legend>
              <input
                type="number"
                min="1"
                max="32"
                value={entryBeat as string | number}
                onChange={(e) => setEntryBeat(Math.max(1, Math.min(32, parseInt(e.target.value) || 1)))}
                className="w-full rounded-row bg-quaternary px-3 py-2 type-title-3"
              />
              <p className="mt-1 type-caption-2 text-tertiary">
                Snaps to downbeats. Max 8 bars / 25% track duration.
              </p>
            </fieldset>

            <fieldset className="rounded-[10px] bg-quinary p-4">
              <legend className="type-subhead-emphasized mb-3">Overlap Bars</legend>
              <input
                type="number"
                min="1"
                max="32"
                value={overlapBars as string | number}
                onChange={(e) => setOverlapBars(Math.max(1, Math.min(32, parseInt(e.target.value) || 1)))}
                className="w-full rounded-row bg-quaternary px-3 py-2 type-title-3"
              />
            </fieldset>

            <fieldset className="rounded-[10px] bg-quinary p-4">
              <legend className="type-subhead-emphasized mb-3">FX Gesture</legend>
              <div className="grid grid-cols-2 gap-2 mb-2">
                {(['none', 'delay', 'reverb', 'both'] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGesture(g)}
                    className={`rounded-row px-3 py-2 type-body-emphasized transition-colors ${
                      gesture === g ? 'bg-key-bg text-white' : 'bg-quaternary text-secondary hover:text-primary'
                    }`}
                  >
                    {g.charAt(0).toUpperCase() + g.slice(1)}
                  </button>
                ))}
              </div>
              {gesture !== 'none' && (
                <div>
                  <label className="type-caption-2 text-tertiary">Gesture Length (bars)</label>
                  <input
                    type="number"
                    min="1"
                    max="16"
                    value={gestureLengthBars as string | number}
                    onChange={(e) => setGestureLengthBars(Math.max(1, Math.min(16, parseInt(e.target.value) || 1)))}
                    className="w-full rounded-row bg-quaternary px-3 py-2 type-title-3 mt-1"
                  />
                </div>
              )}
            </fieldset>

            <fieldset className="rounded-[10px] bg-quinary p-4">
              <legend className="type-subhead-emphasized mb-3">BPM (overrides grid)</legend>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="type-caption-2 text-tertiary block mb-1">Outgoing</label>
                  <input
                    type="number"
                    min="40"
                    max="220"
                    step="0.01"
                    value={outgoingBpm != null ? outgoingBpm.toString() : ''}
                    onChange={(e) => { const v = e.target.value; setOutgoingBpm(v ? parseFloat(v) : null); }}
                    placeholder={outgoing?.bpm ? Math.round(outgoing.bpm).toString() : 'auto'}
                    className="w-full rounded-row bg-quaternary px-3 py-2 type-title-3"
                  />
                </div>
                <div>
                  <label className="type-caption-2 text-tertiary block mb-1">Incoming</label>
                  <input
                    type="number"
                    min="40"
                    max="220"
                    step="0.01"
                    value={incomingBpm != null ? incomingBpm.toString() : ''}
                    onChange={(e) => { const v = e.target.value; setIncomingBpm(v ? parseFloat(v) : null); }}
                    placeholder={incoming?.bpm ? Math.round(incoming.bpm).toString() : 'auto'}
                    className="w-full rounded-row bg-quaternary px-3 py-2 type-title-3"
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="rounded-[10px] bg-quinary p-4">
              <legend className="type-subhead-emphasized mb-3">Camelot Key (e.g., 8A, 12B)</legend>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="type-caption-2 text-tertiary block mb-1">Outgoing</label>
                  <input
                    type="text"
                    value={outgoingCamelot}
                    onChange={(e) => setOutgoingCamelot(e.target.value.toUpperCase())}
                    placeholder={outgoing?.camelot ? `${outgoing.camelot.num}${outgoing.camelot.letter}` : 'auto'}
                    className="w-full rounded-row bg-quaternary px-3 py-2 type-title-3"
                    maxLength={3}
                  />
                </div>
                <div>
                  <label className="type-caption-2 text-tertiary block mb-1">Incoming</label>
                  <input
                    type="text"
                    value={incomingCamelot}
                    onChange={(e) => setIncomingCamelot(e.target.value.toUpperCase())}
                    placeholder={incoming?.camelot ? `${incoming.camelot.num}${incoming.camelot.letter}` : 'auto'}
                    className="w-full rounded-row bg-quaternary px-3 py-2 type-title-3"
                    maxLength={3}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="rounded-[10px] bg-quinary p-4">
              <legend className="type-subhead-emphasized mb-3">Grid Nudge (beats)</legend>
              <input
                type="number"
                min="-16"
                max="16"
                value={gridNudgeBeats as string | number}
                onChange={(e) => setGridNudgeBeats(Math.max(-16, Math.min(16, parseInt(e.target.value) || 0)))}
                className="w-full rounded-row bg-quaternary px-3 py-2 type-title-3"
              />
              <p className="mt-1 type-caption-2 text-tertiary">
                Shifts incoming track's head-grid alignment by N beats.
              </p>
            </fieldset>

            <button
              onClick={handleSave}
              className="w-full rounded-pill bg-key-bg px-6 py-3 type-title-2-emphasized text-white hover:opacity-90"
            >
              Save Overrides
            </button>

            {previewPlan && (
              <div className="rounded-[10px] bg-green/10 border border-green/30 p-3 type-caption-2">
                <strong className="text-green">Preview Plan:</strong>{' '}
                {previewPlan.style} · {previewPlan.durationSec.toFixed(1)}s · {computeBars(previewPlan, outgoing, incoming)} bars
                {previewPlan.gesture && previewPlan.gesture !== 'none' && ` · ${previewPlan.gesture}`}
                {previewPlan.stemUsed && ' · stems'}
                {previewPlan.overridesApplied && previewPlan.overridesApplied.length > 0 && ` · ${previewPlan.overridesApplied.join(', ')}`}
              </div>
            )}
            {previewError && (
              <div className="rounded-[10px] bg-red/10 border border-red/30 p-3 type-caption-2 text-red">
                {previewError}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function drawEnergyCurve(
  ctx: CanvasRenderingContext2D,
  analysis: TrackAnalysis,
  y: number,
  height: number,
  startSec: number,
  endSec: number,
  color: string,
  width: number,
): void {
  const spans = analysis.energySpans ?? [];
  const relevantSpan = spans.find(s => {
    const spanEnd = s.startSec + s.curve.length * s.windowSec;
    return s.startSec <= endSec && spanEnd >= startSec;
  });

  let curve: number[] = [];
  let windowSec = 1;
  let curveStartSec = 0;

  if (relevantSpan) {
    curve = relevantSpan.curve;
    windowSec = relevantSpan.windowSec;
    curveStartSec = relevantSpan.startSec;
  } else if (analysis.energyCurve.length) {
    curve = analysis.energyCurve;
    windowSec = analysis.durationSec / analysis.energyCurve.length;
    curveStartSec = 0;
  } else {
    return;
  }

  const visibleStartIdx = Math.max(0, Math.floor((startSec - curveStartSec) / windowSec));
  const visibleEndIdx = Math.min(curve.length, Math.ceil((endSec - curveStartSec) / windowSec));
  const visibleCurve = curve.slice(visibleStartIdx, visibleEndIdx);

  if (!visibleCurve.length) return;

  const maxVal = Math.max(...visibleCurve, 0.01);
  const centerY = y + height / 2;
  const amplitude = height / 2 * 0.9;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  const stepX = width / visibleCurve.length;
  visibleCurve.forEach((val, i) => {
    const x = i * stepX;
    const normalized = Math.min(1, val / maxVal);
    const offset = normalized * amplitude;
    if (i === 0) {
      ctx.moveTo(x, centerY - offset);
      ctx.lineTo(x, centerY + offset);
    } else {
      ctx.lineTo(x, centerY - offset);
      ctx.moveTo(x, centerY + offset);
      ctx.lineTo(x - stepX, centerY + offset);
    }
  });
  ctx.stroke();

  ctx.fillStyle = `${color}20`;
  ctx.beginPath();
  visibleCurve.forEach((val, i) => {
    const x = i * stepX;
    const normalized = Math.min(1, val / maxVal);
    const offset = normalized * amplitude;
    if (i === 0) ctx.moveTo(x, centerY);
    ctx.lineTo(x, centerY - offset);
  });
  for (let i = visibleCurve.length - 1; i >= 0; i--) {
    const val = visibleCurve[i];
    if (val === undefined) continue;
    const x = i * stepX;
    const normalized = Math.min(1, val / maxVal);
    const offset = normalized * amplitude;
    ctx.lineTo(x, centerY + offset);
  }
  ctx.closePath();
  ctx.fill();
}

function drawBeatGrid(
  ctx: CanvasRenderingContext2D,
  grid: { bpm: number; beatIntervalSec: number; firstDownbeatSec: number; gridConfidence: number },
  y: number,
  height: number,
  startSec: number,
  endSec: number,
  width: number,
  color: string,
): void {
  const beatSec = grid.beatIntervalSec;
  const barSec = beatSec * 4;
  const firstDownbeat = grid.firstDownbeatSec;

  const firstBeatInWindow = firstDownbeat + Math.ceil((startSec - firstDownbeat) / beatSec) * beatSec;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;

  for (let t = firstBeatInWindow; t < endSec; t += beatSec) {
    const x = ((t - startSec) / (endSec - startSec)) * width;
    const isDownbeat = Math.abs((t - firstDownbeat) % barSec) < beatSec * 0.1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + (isDownbeat ? height * 0.5 : height * 0.2));
    ctx.stroke();
  }

  const firstDownbeatInWindow = firstDownbeat + Math.ceil((startSec - firstDownbeat) / barSec) * barSec;
  ctx.fillStyle = color;
  for (let t = firstDownbeatInWindow; t < endSec; t += barSec) {
    const x = ((t - startSec) / (endSec - startSec)) * width;
    ctx.beginPath();
    ctx.arc(x, y + height * 0.7, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawVolumeCurves(
  ctx: CanvasRenderingContext2D,
  startSec: number,
  endSec: number,
  durationSec: number,
  outRate: number,
  inRate: number,
  width: number,
  height: number,
): void {
  const N = 65;
  const fadeOut = new Float32Array(N);
  const fadeIn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    fadeOut[i] = Math.cos((x * Math.PI) / 2);
    fadeIn[i] = Math.sin((x * Math.PI) / 2);
  }

  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.beginPath();
  fadeOut.forEach((val, i) => {
    const x = (i / (N - 1)) * width;
    const y = height / 2 - val * height / 2 * 0.8;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.beginPath();
  fadeIn.forEach((val, i) => {
    const x = (i / (N - 1)) * width;
    const y = height - (height / 2 - val * height / 2 * 0.8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawEqCurves(
  ctx: CanvasRenderingContext2D,
  startSec: number,
  endSec: number,
  durationSec: number,
  outGrid: { bpm: number; beatIntervalSec: number },
  inGrid: { bpm: number; beatIntervalSec: number },
  outRate: number,
  inRate: number,
  plan: TransitionPlan,
  width: number,
  height: number,
): void {
  const midSec = durationSec / 2;
  const barSec = outGrid.beatIntervalSec * 4 / outRate;
  const swapStart = midSec - barSec / 2;
  const swapEnd = midSec + barSec / 2;

  const swapX1 = (swapStart / durationSec) * width;
  const swapX2 = (swapEnd / durationSec) * width;

  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);

  ctx.beginPath();
  ctx.moveTo(0, height / 4);
  ctx.lineTo(swapX1, height / 4);
  ctx.lineTo(swapX2, height / 4 * 3);
  ctx.lineTo(width, height / 4 * 3);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, height * 3 / 4);
  ctx.lineTo(swapX1, height * 3 / 4);
  ctx.lineTo(swapX2, height / 4);
  ctx.lineTo(width, height / 4);
  ctx.stroke();

  ctx.setLineDash([]);
}

function drawFilterSweep(
  ctx: CanvasRenderingContext2D,
  startSec: number,
  endSec: number,
  width: number,
  height: number,
): void {
  ctx.strokeStyle = '#ec4899';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 3]);

  ctx.beginPath();
  ctx.moveTo(0, height * 0.1);
  ctx.lineTo(width, height * 0.6);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, height * 0.9);
  ctx.lineTo(width, height * 0.4);
  ctx.stroke();

  ctx.setLineDash([]);
}

function drawGestureSpan(
  ctx: CanvasRenderingContext2D,
  plan: TransitionPlan,
  startSec: number,
  endSec: number,
  width: number,
  height: number,
): void {
  const gestureSec = plan.gestureSeconds ?? 0;
  if (gestureSec <= 0) return;

  const gestureStartSec = endSec - gestureSec;
  const x1 = ((gestureStartSec - startSec) / (endSec - startSec)) * width;
  const x2 = width;

  ctx.fillStyle = '#f59e0b40';
  ctx.fillRect(x1, 0, x2 - x1, height);

  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.strokeRect(x1, 0, x2 - x1, height);
  ctx.setLineDash([]);

  ctx.fillStyle = '#f59e0b';
  ctx.font = '11px DM Sans';
  ctx.fillText(plan.gesture ?? 'gesture', x1 + 4, 14);
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  height: number,
  label: string,
  color: string,
  active: boolean,
): void {
  ctx.strokeStyle = active ? '#fff' : color;
  ctx.lineWidth = active ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + height);
  ctx.stroke();

  ctx.fillStyle = active ? '#fff' : color;
  ctx.beginPath();
  ctx.arc(x, y + height / 2, active ? 8 : 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.font = 'bold 10px DM Sans';
  ctx.fillText(label, x + 10, y + 14);
}

function timeToX(timeSec: number, windowStart: number, windowEnd: number, width: number): number {
  return Math.max(0, Math.min(width, ((timeSec - windowStart) / (windowEnd - windowStart)) * width));
}

function computePreviewPlan(
  outgoing: TrackAnalysis,
  incoming: TrackAnalysis,
  outOverrides: TrackAnalysis['manualOverrides'],
  inOverrides: TrackAnalysis['manualOverrides'],
): TransitionPlan | null {
  try {
    const { from: overriddenOut, to: overriddenIn, overridesApplied } = applyOverrides(
      outgoing,
      incoming,
      outOverrides,
      inOverrides,
    );

    const fromGrid = overriddenOut.tailGrid ?? (overriddenOut.bpm ? { bpm: overriddenOut.bpm, beatIntervalSec: 60 / overriddenOut.bpm, firstDownbeatSec: overriddenOut.firstDownbeatSec ?? 0, gridConfidence: overriddenOut.gridConfidence } : null);
    const toGrid = overriddenIn.headBeats ? { bpm: overriddenIn.bpm ?? 120, beatIntervalSec: 60 / (overriddenIn.bpm ?? 120), firstDownbeatSec: overriddenIn.firstDownbeatSec ?? 0, gridConfidence: overriddenIn.gridConfidence } : null;

    if (!fromGrid || overriddenOut.gridConfidence < 0.2) {
      return {
        t0: 0,
        durationSec: 12,
        mixInTrackTime: 0,
        mixOutTrackTime: 0,
        rate: 1,
        fallback: true,
        style: 'crossfade',
        reason: 'this song has no beat grid at its end',
        overridesApplied,
      };
    }

    if (!toGrid || overriddenIn.gridConfidence < 0.2) {
      return {
        t0: 0,
        durationSec: 8 * (60 / fromGrid.bpm),
        mixInTrackTime: 0,
        mixOutTrackTime: 0,
        rate: 1,
        fallback: false,
        style: 'filter',
        reason: 'next song has no beat grid',
        overridesApplied,
      };
    }

    const outRate = 1;
    const rawRate = fromGrid.bpm * outRate / toGrid.bpm;
    const rate = [rawRate, rawRate / 2, rawRate * 2].reduce((best, r) =>
      Math.abs(r - 1) < Math.abs(best - 1) ? r : best,
    );

    const stretchAllowed = rate >= 1 ? rate - 1 <= 0.25 : 1 - rate <= 0.1;
    const effBars = Math.min(16, overriddenOut.gridConfidence >= 0.6 ? 16 : overriddenOut.gridConfidence >= 0.45 ? 8 : 4);
    const durationSec = effBars * 4 * (60 / (fromGrid.bpm * outRate));

    const mixOutTrackTime = overriddenOut.contentEndSec ?? overriddenOut.outroStartSec ?? overriddenOut.durationSec - 30;
    const mixInTrackTime = toGrid.firstDownbeatSec ?? 0;

    const planOverride = inOverrides?.planOverride ?? outOverrides?.planOverride;
    let finalStyle: MixStyle = 'blend';
    let finalGesture: MixGesture = 'none';
    let finalGestureSeconds = 0;

    if (planOverride) {
      if (planOverride.style) finalStyle = planOverride.style;
      if (planOverride.gesture) finalGesture = planOverride.gesture;
    }

    return {
      t0: 0,
      durationSec,
      mixInTrackTime,
      mixOutTrackTime,
      rate: stretchAllowed ? rate : 1,
      fallback: !stretchAllowed,
      style: finalStyle,
      reason: stretchAllowed ? null : 'tempos too far apart',
      gesture: finalGesture,
      gestureSeconds: finalGestureSeconds,
      overridesApplied,
    };
  } catch {
    return null;
  }
}

function computeBars(plan: TransitionPlan, out: TrackAnalysis | null, inn: TrackAnalysis | null): number {
  if (!out || !inn) return 0;
  const outGrid = out.tailGrid ?? (out.bpm ? { bpm: out.bpm, beatIntervalSec: 60 / out.bpm } : null);
  if (!outGrid) return 0;
  const beatSec = 60 / outGrid.bpm;
  const barSec = beatSec * 4;
  return Math.round(plan.durationSec / barSec);
}

export default AutomixEditor;"// CI trigger"  
