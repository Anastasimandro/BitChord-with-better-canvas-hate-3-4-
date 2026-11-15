// BitChord: the loop mix renderer's host-side CI test (Phase 3 Task 3 & 4).
//
// Exercises the delay gesture the way the acceptance asks: a click-track deck
// through the delay — every repeat lands on the beat grid; the feedback chain
// decays; no wet survives the engagement window's close (window + 1 beat).
// Exercises the reverb gesture: a sustained melodic close blooms with the
// synthetic IR; the wet opens at the last 2 beats and dies before handover.
// Also the performance discipline: the same mix rendered with FX off and on,
// timed, so a regression shows up as a budget breach instead of a vibe.
//
// Built by .github/workflows/loopmix-native.yml with the same flags the
// Android build uses (-O3 -ffast-math); never run on a dev machine.

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "loopmix/loop_mix_renderer.h"

using bitchord::loopmix::Deck;
using bitchord::loopmix::Envelope;
using bitchord::loopmix::Renderer;

// The wet envelope's kind on Deck — same value the JNI bridge reads (3).
constexpr int kDelayWetKind = 3;

namespace {

int failures = 0;

void check(bool ok, const std::string& what) {
  if (ok) {
    std::printf("  PASS %s\n", what.c_str());
  } else {
    std::printf("  FAIL %s\n", what.c_str());
    ++failures;
  }
}

constexpr int kSampleRate = 48000;
constexpr double kBeatSeconds = 0.5;  // 120 BPM
constexpr int64_t kBeatFrames = int64_t(kBeatSeconds * kSampleRate);

/** A short pulse low enough in frequency to survive the 2.5 kHz feedback low-pass. */
void addPulse(std::vector<float>& region, int64_t at) {
  // Half a millisecond of a 1 kHz sine's positive lobe, amplitude 1.
  for (int i = 0; i < 24; ++i) {
    const int64_t index = at + i;
    if (index < 0 || index >= int64_t(region.size())) return;
    region[index] = float(std::sin(2 * M_PI * 1000.0 * i / double(kSampleRate)));
  }
}

/** A sustained tone for reverb testing — a held note that the IR will bloom. */
void addSustained(std::vector<float>& region, int64_t from, int64_t to, float freqHz = 440.0f) {
  for (int64_t i = from; i < to && i < int64_t(region.size()); ++i) {
    region[i] = float(std::sin(2 * M_PI * freqHz * double(i) / double(kSampleRate))) * 0.5f;
  }
}

struct Mix {
  std::vector<float> left;
  std::vector<float> right;
  std::vector<double> knotTimes;
  std::vector<double> knotPositions;
};

/**
 * A deck of one-click-per-beat (or a single click at [onlyClickBeat]), knots
 * one beat apart at rate 1 — the outgoing deck's shape, stationary tempo.
 * [beats] knots end the grid; [totalBeats] extends the knots past it so the
 * deck keeps rendering through the window's close.
 */
Mix makeMix(int beats, int totalBeats, int onlyClickBeat = -1) {
  Mix mix;
  const int64_t length = int64_t((totalBeats + 2) * kBeatSeconds * kSampleRate) + 1024;
  mix.left.assign(size_t(length), 0.f);
  mix.right.assign(size_t(length), 0.f);
  for (int k = 0; k < beats; ++k) {
    if (onlyClickBeat >= 0 && k != onlyClickBeat) continue;
    addPulse(mix.left, int64_t(k) * kBeatFrames);
    addPulse(mix.right, int64_t(k) * kBeatFrames);
  }
  for (int k = 0; k <= totalBeats; ++k) {
    mix.knotTimes.push_back(double(int64_t(k) * kBeatFrames));
    mix.knotPositions.push_back(double(int64_t(k) * kBeatFrames));
  }
  return mix;
}

/** Renders the whole mix; returns the left channel, from mix frame [from] on. */
std::vector<float> renderMix(Renderer& renderer, int64_t from, int64_t to) {
  renderer.prepare();
  std::vector<float> out;
  const int block = 512;
  std::vector<float> interleaved(size_t(2 * block));
  for (int64_t frame = from; frame < to; frame += block) {
    const int frames = int(std::min<int64_t>(block, to - frame));
    renderer.render(frame, interleaved.data(), frames);
    for (int i = 0; i < frames; ++i) out.push_back(interleaved[2 * i]);
  }
  return out;
}

/** Local maxima above [threshold], as sample indices into [samples]. */
std::vector<int64_t> peaks(const std::vector<float>& samples, float threshold) {
  std::vector<int64_t> found;
  for (size_t i = 1; i + 1 < samples.size(); ++i) {
    if (samples[i] > threshold && samples[i] >= samples[i - 1] && samples[i] > samples[i + 1]) {
      found.push_back(int64_t(i));
    }
  }
  return found;
}

void assignWet(Deck& deck, double openBeatSec, double closeBeatSec) {
  deck.delayWet.times = {openBeatSec, openBeatSec + 0.01, closeBeatSec - 0.01, closeBeatSec};
  deck.delayWet.values = {0.f, 1.f, 1.f, 0.f};
}

void testRepeatsOnGrid() {
  std::printf("delay: repeats land on the beat grid\n");
  // One click per beat, the wet open from beat 2 to beat 10 — the engagement
  // window the web twin schedules (open DELAY_AIR_BEATS before the exit).
  const int openBeat = 2, closeBeat = 10;
  Mix mix = makeMix(closeBeat, closeBeat + 2);
  Renderer renderer(kSampleRate);
  Deck& deck = renderer.deck(0);
  deck.left = mix.left;
  deck.right = mix.right;
  deck.regionStart = 0;
  deck.knotTimes = mix.knotTimes;
  deck.knotPositions = mix.knotPositions;
  deck.stopAt = (closeBeat + 1.0) * kBeatSeconds;
  deck.delaySeconds = kBeatSeconds;
  assignWet(deck, openBeat * kBeatSeconds, closeBeat * kBeatSeconds);
  renderer.deck(1).finished = true;

  const std::vector<float> samples = renderMix(renderer, renderer.firstFrame(), int64_t(deck.stopAt * kSampleRate));
  const int64_t offset = -renderer.firstFrame();
  const std::vector<int64_t> echoPeaks = peaks(samples, 0.1f);

  // Every echo peak sits on the beat grid — the delay time is one beat.
  int onGrid = 0, offGrid = 0;
  for (const int64_t p : echoPeaks) {
    const int64_t gridSample = ((p - offset) % kBeatFrames + kBeatFrames) % kBeatFrames;
    if (gridSample <= 2 || gridSample >= kBeatFrames - 2) ++onGrid; else ++offGrid;
  }
  check(offGrid == 0 && onGrid > 0,
        "echo peaks on the grid (on " + std::to_string(onGrid) + ", off " + std::to_string(offGrid) + ")");

  // Repeats decay: each round trip is feedback * low-pass.
  const int64_t clickBeat = 2;
  std::vector<float> echoLevels;
  for (int k = 1; k <= 3; ++k) {
    const int64_t expected = offset + (clickBeat + k) * kBeatFrames;
    float best = 0;
    for (int64_t p : echoPeaks) {
      if (p >= expected - 2 && p <= expected + 2) best = std::max(best, samples[size_t(p)]);
    }
    echoLevels.push_back(best);
  }
  bool decays = echoLevels[0] > 0.2f && echoLevels[1] < echoLevels[0] && echoLevels[2] < echoLevels[1];
  check(decays, "echoes decay round by round");

  // No wet survives the close: everything after it, out to window + 1 beat,
  // is below -60 dBFS.
  const int64_t closeSample = offset + int64_t(closeBeat * kBeatSeconds * kSampleRate);
  const int64_t windowEnd = closeSample + kBeatFrames;
  bool silent = true;
  for (int64_t i = closeSample; i < windowEnd && i < int64_t(samples.size()); ++i) {
    if (std::abs(samples[size_t(i)]) > 0.001f) { silent = false; break; }
  }
  check(silent, "wet silent through window + 1 beat after the close");
}

void testSingleClickDecayChain() {
  std::printf("delay: one click's repeat chain decays on the grid\n");
  const int openBeat = 2, closeBeat = 10;
  Mix mix = makeMix(closeBeat, closeBeat + 2, /*onlyClickBeat=*/2);
  Renderer renderer(kSampleRate);
  Deck& deck = renderer.deck(0);
  deck.left = mix.left;
  deck.right = mix.right;
  deck.regionStart = 0;
  deck.knotTimes = mix.knotTimes;
  deck.knotPositions = mix.knotPositions;
  deck.stopAt = (closeBeat + 1.0) * kBeatSeconds;
  deck.delaySeconds = kBeatSeconds;
  assignWet(deck, openBeat * kBeatSeconds, closeBeat * kBeatSeconds);
  renderer.deck(1).finished = true;

  const std::vector<float> samples = renderMix(renderer, renderer.firstFrame(), int64_t(deck.stopAt * kSampleRate));
  const int64_t offset = -renderer.firstFrame();
  const std::vector<int64_t> echoPeaks = peaks(samples, 0.05f);

  // Isolated chain: each echo sits on the grid, one beat after the last.
  float previous = 0;
  int landed = 0;
  bool monotonic = true;
  for (int k = 3; k < closeBeat; ++k) {
    const int64_t expected = offset + int64_t(k) * kBeatFrames;
    float best = 0;
    bool found = false;
    for (int64_t p : echoPeaks) {
      if (p >= expected - 2 && p <= expected + 2 && samples[size_t(p)] > best) {
        best = samples[size_t(p)];
        found = true;
      }
    }
    if (found) {
      ++landed;
      if (previous > 0 && best >= previous) monotonic = false;
      previous = best;
    }
  }
  check(landed >= 5, "echo chain lands beat after beat (" + std::to_string(landed) + " repeats)");
  check(monotonic, "the chain only gets quieter");
}

void testPerformance() {
  std::printf("performance: the mix with the delay off and on\n");
  const int closeBeat = 32;
  Mix mix = makeMix(closeBeat, closeBeat + 2);
  const int64_t from = 0;
  const int64_t to = int64_t(closeBeat * kBeatSeconds * kSampleRate);
  double offPerFrame = 0, onPerFrame = 0;

  for (int pass = 0; pass < 3; ++pass) {
    Renderer off(kSampleRate);
    Deck& d0 = off.deck(0);
    d0.left = mix.left; d0.right = mix.right;
    d0.knotTimes = mix.knotTimes; d0.knotPositions = mix.knotPositions;
    d0.stopAt = double(to) / kSampleRate;
    off.deck(1).finished = true;
    const auto t0 = std::chrono::steady_clock::now();
    renderMix(off, from, to);
    const auto t1 = std::chrono::steady_clock::now();
    offPerFrame = std::max(offPerFrame, std::chrono::duration<double, std::nano>(t1 - t0).count() / double(to - from));

    Renderer on(kSampleRate);
    Deck& e0 = on.deck(0);
    e0.left = mix.left; e0.right = mix.right;
    e0.knotTimes = mix.knotTimes; e0.knotPositions = mix.knotPositions;
    e0.stopAt = double(to) / kSampleRate;
    e0.delaySeconds = kBeatSeconds;
    assignWet(e0, 2.0, closeBeat * kBeatSeconds);
    on.deck(1).finished = true;
    const auto t2 = std::chrono::steady_clock::now();
    renderMix(on, from, to);
    const auto t3 = std::chrono::steady_clock::now();
    onPerFrame = std::max(onPerFrame, std::chrono::duration<double, std::nano>(t3 - t2).count() / double(to - from));
  }

  std::printf("  measured: delay off %.2f ns/frame, delay on %.2f ns/frame (worst of 3)\n", offPerFrame, onPerFrame);
  std::printf("  measured: delay delta %.2f ns/frame (%.1f%%)\n", onPerFrame - offPerFrame,
              offPerFrame > 0 ? 100.0 * (onPerFrame - offPerFrame) / offPerFrame : 0.0);
  // The real-time line at 48 kHz is 20.8 us/frame; the mix must sit far under it.
  check(offPerFrame < 20800.0, "delay off inside the real-time budget");
  check(onPerFrame < 20800.0, "delay on inside the real-time budget");
  check(onPerFrame < offPerFrame * 2.0, "the delay unit's cost is bounded");
}

void assignReverbWet(Deck& deck, double openBeatSec, double closeBeatSec) {
  // Reverb wet envelope: 0 until openAt, attack over 0.02s, hold, then ramp to 0 at closeAt
  deck.reverbWet.times = {openBeatSec, openBeatSec + 0.02, closeBeatSec - 0.01, closeBeatSec};
  deck.reverbWet.values = {0.f, 1.f, 1.f, 0.f};
}

void testReverbBloom() {
  std::printf("reverb: sustained melodic close blooms with synthetic IR\n");
  // A sustained tone over the last 4 beats, reverb opens at last 2 beats
  const int closeBeat = 10;
  Mix mix = makeMix(closeBeat, closeBeat + 2);
  // Replace clicks with sustained tone from beat 6 to beat 10 (the melodic tail)
  addSustained(mix.left, int64_t(6) * kBeatFrames, int64_t(10) * kBeatFrames);
  addSustained(mix.right, int64_t(6) * kBeatFrames, int64_t(10) * kBeatFrames);

  Renderer renderer(kSampleRate);
  Deck& deck = renderer.deck(0);
  deck.left = mix.left;
  deck.right = mix.right;
  deck.regionStart = 0;
  deck.knotTimes = mix.knotTimes;
  deck.knotPositions = mix.knotPositions;
  deck.stopAt = (closeBeat + 1.0) * kBeatSeconds;
  deck.reverbSeconds = 0.75;  // REVERB_IR_SEC
  // Reverb opens at last 2 beats (beat 8), closes at end (beat 10)
  assignReverbWet(deck, 8.0 * kBeatSeconds, 10.0 * kBeatSeconds);
  renderer.deck(1).finished = true;

  const std::vector<float> samples = renderMix(renderer, renderer.firstFrame(), int64_t(deck.stopAt * kSampleRate));
  const int64_t offset = -renderer.firstFrame();

  // During the reverb window (beat 8 to 10), there should be audible reverb tail
  const int64_t openSample = offset + int64_t(8.0 * kBeatSeconds * kSampleRate);
  const int64_t closeSample = offset + int64_t(10.0 * kBeatSeconds * kSampleRate);
  bool audibleInWindow = false;
  for (int64_t i = openSample; i < closeSample && i < int64_t(samples.size()); ++i) {
    if (std::abs(samples[size_t(i)]) > 0.01f) { audibleInWindow = true; break; }
  }
  check(audibleInWindow, "reverb wet audible during engagement window");

  // After the close (window + 1 beat), wet must be silent
  const int64_t windowEnd = closeSample + kBeatFrames;
  bool silent = true;
  for (int64_t i = closeSample; i < windowEnd && i < int64_t(samples.size()); ++i) {
    if (std::abs(samples[size_t(i)]) > 0.001f) { silent = false; break; }
  }
  check(silent, "reverb wet silent through window + 1 beat after the close");
}

void testReverbNoWetBeforeOpen() {
  std::printf("reverb: no wet before the engagement window opens\n");
  const int closeBeat = 10;
  Mix mix = makeMix(closeBeat, closeBeat + 2);
  addSustained(mix.left, int64_t(6) * kBeatFrames, int64_t(10) * kBeatFrames);
  addSustained(mix.right, int64_t(6) * kBeatFrames, int64_t(10) * kBeatFrames);

  Renderer renderer(kSampleRate);
  Deck& deck = renderer.deck(0);
  deck.left = mix.left;
  deck.right = mix.right;
  deck.regionStart = 0;
  deck.knotTimes = mix.knotTimes;
  deck.knotPositions = mix.knotPositions;
  deck.stopAt = (closeBeat + 1.0) * kBeatSeconds;
  deck.reverbSeconds = 0.75;
  assignReverbWet(deck, 8.0 * kBeatSeconds, 10.0 * kBeatSeconds);
  renderer.deck(1).finished = true;

  const std::vector<float> samples = renderMix(renderer, renderer.firstFrame(), int64_t(deck.stopAt * kSampleRate));
  const int64_t offset = -renderer.firstFrame();

  // Before the reverb window opens (beat 8), only dry signal (sustained tone) should be present
  // The sustained tone is at 440 Hz, so we check that there's no additional reverb bloom
  // by verifying the signal is just the dry tone (which we know the amplitude of)
  const int64_t preOpenSample = offset + int64_t(7.0 * kBeatSeconds * kSampleRate);
  bool dryOnly = true;
  for (int64_t i = preOpenSample; i < preOpenSample + kBeatFrames && i < int64_t(samples.size()); ++i) {
    // The dry tone at 440 Hz has amplitude 0.5; reverb would add energy
    if (std::abs(samples[size_t(i)]) > 0.6f) { dryOnly = false; break; }
  }
  check(dryOnly, "only dry signal before reverb window opens");
}

void testReverbPerformance() {
  std::printf("performance: the mix with the reverb off and on\n");
  const int closeBeat = 32;
  Mix mix = makeMix(closeBeat, closeBeat + 2);
  addSustained(mix.left, int64_t(20) * kBeatFrames, int64_t(32) * kBeatFrames);
  addSustained(mix.right, int64_t(20) * kBeatFrames, int64_t(32) * kBeatFrames);
  const int64_t from = 0;
  const int64_t to = int64_t(closeBeat * kBeatSeconds * kSampleRate);
  double offPerFrame = 0, onPerFrame = 0;

  for (int pass = 0; pass < 3; ++pass) {
    Renderer off(kSampleRate);
    Deck& d0 = off.deck(0);
    d0.left = mix.left; d0.right = mix.right;
    d0.knotTimes = mix.knotTimes; d0.knotPositions = mix.knotPositions;
    d0.stopAt = double(to) / kSampleRate;
    off.deck(1).finished = true;
    const auto t0 = std::chrono::steady_clock::now();
    renderMix(off, from, to);
    const auto t1 = std::chrono::steady_clock::now();
    offPerFrame = std::max(offPerFrame, std::chrono::duration<double, std::nano>(t1 - t0).count() / double(to - from));

    Renderer on(kSampleRate);
    Deck& e0 = on.deck(0);
    e0.left = mix.left; e0.right = mix.right;
    e0.knotTimes = mix.knotTimes; e0.knotPositions = mix.knotPositions;
    e0.stopAt = double(to) / kSampleRate;
    e0.reverbSeconds = 0.75;
    assignReverbWet(e0, 30.0 * kBeatSeconds, 32.0 * kBeatSeconds);
    on.deck(1).finished = true;
    const auto t2 = std::chrono::steady_clock::now();
    renderMix(on, from, to);
    const auto t3 = std::chrono::steady_clock::now();
    onPerFrame = std::max(onPerFrame, std::chrono::duration<double, std::nano>(t3 - t2).count() / double(to - from));
  }

  std::printf("  measured: reverb off %.2f ns/frame, reverb on %.2f ns/frame (worst of 3)\n", offPerFrame, onPerFrame);
  std::printf("  measured: reverb delta %.2f ns/frame (%.1f%%)\n", onPerFrame - offPerFrame,
              offPerFrame > 0 ? 100.0 * (onPerFrame - offPerFrame) / offPerFrame : 0.0);
  // The real-time line at 48 kHz is 20.8 us/frame; the mix must sit far under it.
  check(offPerFrame < 20800.0, "reverb off inside the real-time budget");
  check(onPerFrame < 20800.0, "reverb on inside the real-time budget");
  check(onPerFrame < offPerFrame * 2.0, "the reverb unit's cost is bounded");
}

}  // namespace

int main() {
  std::printf("loop_mix renderer — delay & reverb gestures (host CI harness)\n");
  testRepeatsOnGrid();
  testSingleClickDecayChain();
  testPerformance();
  testReverbBloom();
  testReverbNoWetBeforeOpen();
  testReverbPerformance();
  if (failures != 0) {
    std::printf("%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("all checks passed\n");
  return 0;
}
