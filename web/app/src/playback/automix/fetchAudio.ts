import { botguard } from '@/playback/youtube/botguard';
import { ytAuthSnapshot } from '@/extension/useYtAuth';
import { getInnertube, getSignedInnertube } from '@/playback/youtube/innertube';
import { resolvePlayer, UnplayableError, usesWebPo } from '@/playback/youtube/resolver';

/**
 * A picture wider than this is a music video; a square one is YouTube's art
 * track for a song (the player's own rule, YouTubeEngine.MIN_VIDEO_ASPECT).
 */
const MIN_VIDEO_ASPECT = 1.2;

/** The track's audio, and whether YouTube serves it as a music video rather than a song. */
export interface TrackAudio {
  bytes: ArrayBuffer;
  musicVideo: boolean;
}

/** googlevideo serves a direct URL in ranges; Android (vivi/InnerTubeX) asks for 512 KiB–1 MiB at a time. */
const CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES = 40 * 1024 * 1024;

/**
 * The whole audio file of [videoId], for analysis: the same direct URL Shaka
 * plays (VISIONOS), fetched in ranges. Opus in WebM when there is one (every
 * browser that runs the app decodes it in decodeAudioData), else AAC.
 * Throws when the track only streams over SABR, which has no file to fetch.
 */
export async function fetchTrackAudio(videoId: string, signal?: AbortSignal): Promise<TrackAudio> {
  const source = await resolveAudioUrl(videoId);
  const bytes = await fetchRange(videoId, source, 0, source.total, signal);
  return { bytes, musicVideo: source.musicVideo };
}

/**
 * BitChord, Automix 2.0 Phase 1: one EDGE of the track's audio, for the
 * just-in-time ladder — the first [seconds] of it or the last. The ranges
 * are edge-anchored, which is what makes them exact without a container
 * index: a head range starts at byte 0 (the decoded buffer is the track's
 * opening), a tail range ends at the last byte (the decoded buffer is the
 * track's ending, however many seconds its decoder finds). A tail range has
 * no container header of its own, so the first INIT_BYTES come along as
 * well; a decoder that still refuses the concatenation gets the caller's
 * full-fetch fallback.
 *
 * [durationSec] is the track's length (the player response carries it); the
 * byte estimate is its bitrate. Without it the edge can't be aimed, and the
 * whole file is fetched — the ladder degrades, it never guesses.
 */
export interface TrackAudioEdge extends TrackAudio {
  /** The track's length in seconds, per the player response (0 when unknown). */
  durationSec: number;
  /** True when the edge couldn't be aimed and the whole file came back instead. */
  fellBackToFull: boolean;
}

/** Over [margin], a bitrate estimate from content-length is still an estimate: clusters, art, metadata. */
const EDGE_MARGIN = 1.35;
/** Minimum aimed edge: the container header alone can be a tenth of a small request. */
const MIN_EDGE_BYTES = 256 * 1024;
/** Maximum aimed edge: no edge window in the ladder is worth more than this. */
const MAX_EDGE_BYTES = 12 * 1024 * 1024;
/** The container header fetched alongside a tail range, for the decoder. */
const INIT_BYTES = 64 * 1024;

export async function fetchTrackAudioEdge(
  videoId: string,
  edge: 'head' | 'tail',
  seconds: number,
  signal?: AbortSignal,
): Promise<TrackAudioEdge> {
  const source = await resolveAudioUrl(videoId);
  const durationSec = source.durationSec;
  const total = source.total;
  if (!(durationSec > 0) || !(total > 0)) {
    const bytes = await fetchRange(videoId, source, 0, source.total, signal);
    return { bytes, musicVideo: source.musicVideo, durationSec, fellBackToFull: true };
  }
  const bytesPerSec = total / durationSec;
  const span = Math.min(
    MAX_EDGE_BYTES,
    Math.max(MIN_EDGE_BYTES, Math.round(seconds * bytesPerSec * EDGE_MARGIN)),
  );

  if (edge === 'head') {
    const bytes = await fetchRange(videoId, source, 0, Math.min(total, span), signal);
    return { bytes, musicVideo: source.musicVideo, durationSec, fellBackToFull: false };
  }

  // The tail: the container's opening (header, tracks, and for WebM the
  // SeekHead that points at the Cues), then the last [span] bytes.
  const init = await fetchRange(videoId, source, 0, Math.min(total, INIT_BYTES), signal);
  const from = Math.max(0, total - span);
  const tail = await fetchRange(videoId, source, from, total, signal);
  const out = new Uint8Array(init.byteLength + tail.byteLength);
  out.set(new Uint8Array(init), 0);
  out.set(new Uint8Array(tail), init.byteLength);
  return { bytes: out.buffer, musicVideo: source.musicVideo, durationSec, fellBackToFull: false };
}

/** The bytes of [source] from [from] to [to] (exclusive end; 0 or past the end means "to the last byte"). */
async function fetchRange(videoId: string, source: Awaited<ReturnType<typeof resolveAudioUrl>>, from: number, to: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  let at = from;
  let refusals = 0;
  const endByte = to > 0 ? Math.min(to, from + MAX_BYTES) : 0;
  for (;;) {
    const { url, total } = source;
    const rangeEnd = endByte ? Math.min(endByte, at + CHUNK_BYTES) - 1 : at + CHUNK_BYTES - 1;
    url.searchParams.set('range', `${at}-${rangeEnd}`);
    const response = await fetch(url, { signal, credentials: 'omit' });
    if (response.status === 403 && refusals < MAX_REFUSALS) {
      // googlevideo sometimes refuses a URL part-way through; a fresh one
      // (another player response) carries on from the same byte.
      refusals++;
      source = await resolveAudioUrl(videoId, source.itag);
      continue;
    }
    if (!response.ok) throw new Error(`audio fetch HTTP ${response.status} at byte ${at}`);
    const part = new Uint8Array(await response.arrayBuffer());
    parts.push(part);
    at += part.byteLength;
    const atEnd = endByte ? at >= endByte : part.byteLength < CHUNK_BYTES;
    if (part.byteLength === 0 || atEnd || at - from > MAX_BYTES || (total ? at >= total : false)) break;
  }

  const out = new Uint8Array(at - from);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out.buffer;
}

const MAX_REFUSALS = 2;

/** A deciphered direct URL for the track's best audio (or the same itag, when resuming). */
async function resolveAudioUrl(
  videoId: string,
  itag?: number,
): Promise<{ url: URL; total: number; itag: number; musicVideo: boolean; durationSec: number }> {
  const { info, client, yt } = await resolveAsPlayerWould(videoId);
  const audio = (info.streaming_data?.adaptive_formats ?? []).filter(
    (f) => f.has_audio && !f.has_video && (f.url || f.signature_cipher || f.cipher) && !f.is_drc,
  );
  const pick = (mime: string) =>
    audio.filter((f) => f.mime_type.startsWith(mime)).sort((a, b) => b.bitrate - a.bitrate)[0];
  const format = (itag !== undefined ? audio.find((f) => f.itag === itag) : undefined) ?? pick('audio/webm') ?? pick('audio/mp4');
  if (!format) throw new Error('no direct audio URL (SABR only)');
  if (itag !== undefined && format.itag !== itag) throw new Error('the format changed between requests');

  const url = new URL(await format.decipher(yt.session.player));
  if (usesWebPo(client)) {
    const pot = await botguard.mint(videoId);
    if (pot) url.searchParams.set('pot', pot);
  }
  const pictures = (info.streaming_data?.adaptive_formats ?? []).filter((f) => f.has_video && f.width && f.height);
  const widest = pictures.sort((a, b) => b.width! * b.height! - a.width! * a.height!)[0];
  const musicVideo = !!widest && widest.width! / widest.height! >= MIN_VIDEO_ASPECT;
  // The player response's own duration: what the edge estimator aims its byte
  // ranges with. A missing one (0) is the full-fetch fallback's cue.
  const reported = (info as { video_details?: { duration?: number } }).video_details?.duration;
  const durationSec = typeof reported === 'number' && reported > 0 ? reported : 0;
  return { url, total: format.content_length ?? 0, itag: format.itag, musicVideo, durationSec };
}

/**
 * The player's own walk (YouTubeEngine.load): anonymously first, and when
 * YouTube calls that an age gate (which is also how its "sign in to confirm
 * you're not a bot" reads), again as the signed-in user. Without the second
 * step a song that plays fine could never be analysed.
 */
async function resolveAsPlayerWould(videoId: string) {
  try {
    return await resolvePlayer(await getInnertube(), videoId);
  } catch (error) {
    if (!(error instanceof UnplayableError && error.ageGated) || !ytAuthSnapshot().signedIn) throw error;
    return resolvePlayer(await getSignedInnertube(), videoId, new Set(), true);
  }
}
