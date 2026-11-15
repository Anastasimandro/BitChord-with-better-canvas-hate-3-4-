// BitChord: the Automix loop mix's renderer. Two decks, each a decoded region
// of one song played through Signalsmith Stretch, looped on whole bars and
// following a tempo ramp beat by beat, mixed into one stereo stream.
//
// Everything is on one clock: mix frame 0 is the moment the outgoing song's
// loop starts (t0). Each deck follows "knots" -- (time since t0, track
// position) for every beat of the mix -- so its tempo changes on the beat and
// its loop seams land on the exact sample. The renderer runs inside the
// outgoing player's audio sink, so the start of the mix is sample-exact
// against the song it takes over from, and the two decks can't drift apart.
//
// Copyright (C) 2026 Kushagra Singh. GPL-3.0-or-later, with the rest of BitChord.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

#include "signalsmith-stretch/signalsmith-stretch.h"

namespace bitchord::loopmix {

/** A piecewise-linear automation curve over mix time (seconds since t0). */
struct Envelope {
  std::vector<double> times;
  std::vector<float> values;
  /** Interpolate in the log domain (a frequency sweep). */
  bool exponential = false;

  bool empty() const { return times.empty(); }
  float at(double time) const;
};

/** RBJ biquad, transposed direct form II, two channels. */
struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  float z1[2] = {0, 0};
  float z2[2] = {0, 0};

  void lowShelf(double sampleRate, double frequency, double gainDb);
  void highPass(double sampleRate, double frequency, double q);
  void lowPass(double sampleRate, double frequency, double q);
  void bypass() { b0 = 1; b1 = b2 = a1 = a2 = 0; }
  inline float tick(int channel, float x) {
    const float y = b0 * x + z1[channel];
    z1[channel] = b1 * x - a1 * y + z2[channel];
    z2[channel] = b2 * x - a2 * y;
    return y;
  }
};

struct Deck {
  // The decoded region, planar, at the renderer's rate.
  std::vector<float> left;
  std::vector<float> right;
  /** Track seconds of region sample 0. */
  double regionStart = 0;

  /** Loop bounds in region samples, and where the loop lets go (unwrapped samples; huge = never). */
  int64_t loopStart = 0;
  int64_t loopEnd = 0;
  double releaseAt = 1e18;

  /** Beat knots: mix frames, and the unwrapped position heard then (in region samples). */
  std::vector<double> knotTimes;
  std::vector<double> knotPositions;
  /** After the last knot: carry on at rate 1 (the incoming song), or stop (the outgoing one). */
  bool runOn = false;
  /** Mix seconds after which the deck renders nothing at all. */
  double stopAt = 1e18;
  /** Seconds of pre-roll before its first knot, so its first audible sample is already settled. */
  double preroll = 0.4;
  /** A plain gain on the deck (loudness matching between the two songs). */
  float level = 1;

  Envelope gain;
  Envelope lowDb;
  Envelope highPassHz;

  /** Unwrapped region-sample position at which the deck fades out over [fadeSamples]; negative = never. */
  std::atomic<double> fadeOutAt{-1.0};
  /** Track seconds heard at the end of the last rendered block. */
  std::atomic<double> heard{0.0};

  // Live state, render thread only.
  signalsmith::stretch::SignalsmithStretch<float> stretch;
  bool started = false;
  bool finished = false;
  double readPos = 0;      // unwrapped region samples, the next input sample to feed
  double heardPos = 0;     // unwrapped region samples heard at the end of the last block
  double lastKnotHeard = 0;
  Biquad shelf;
  Biquad highPass;
  float shelfDb = 0;
  float highPassFreq = 0;

  // Phase 3 Task 3: the delay gesture's render unit, one per deck. The dry
  // path never passes through it: the deck's post-filter signal is tapped
  // into a circular buffer whose feedback loop runs through a low-pass, and
  // the delayed output is added with its own wet envelope. Same graph as the
  // web twin's DeckDelay (loopDeck.ts). [delaySeconds] is one beat of the
  // outgoing grid at the deck's effective rate, passed in per plan; 0 means
  // the unit is absent and costs nothing (no buffer, no branches on the
  // render path that matter). The buffer is allocated in [Renderer::prepare],
  // never in render.
  double delaySeconds = 0;
  Biquad delayLowPass;
  Envelope delayWet;
  std::vector<float> delayLeft;
  std::vector<float> delayRight;
  int delaySize = 0;   // frames in the circular buffer; 0 = the unit is off
  int delayPos = 0;    // next write position (== oldest sample)

  // Phase 3 Task 4: the reverb gesture's render unit, one per deck. A
  // ConvolverNode with a synthetic IR on the web; here a per-block
  // convolution with the same IR (exponentially decaying noise, stereo,
  // REVERB_IR_SEC). The dry path never passes through it. The wet gain has
  // its own envelope; 0 reverbSeconds means the unit is absent and costs
  // nothing. The IR is generated once at process init and shared.
  double reverbSeconds = 0;
  Envelope reverbWet;
  std::vector<float> reverbIRLeft;
  std::vector<float> reverbIRRight;
  int reverbIRSize = 0;
  // Convolution state: circular buffer for the input history needed for the IR
  std::vector<float> reverbHistLeft;
  std::vector<float> reverbHistRight;
  int reverbHistPos = 0;

  /** Track seconds an unwrapped position plays (continuous; the loop and its release applied). */
  double trackSecondsAt(double unwrapped, double sampleRate) const;
  /** The unwrapped position, after the release, that plays track second [seconds]. */
  double releasedPositionOf(double seconds, double sampleRate) const;
  /** The region sample an unwrapped position reads, or -1 outside the region. */
  int64_t sampleAt(int64_t unwrapped) const;
  /** Heard position (unwrapped samples) at mix frame [t], before the run-on. */
  double knotHeard(double t) const;
  /** Input samples per output sample around mix frame [t]. */
  double knotRate(double t) const;
};

class Renderer {
 public:
  Renderer(int sampleRate);

  Deck& deck(int index) { return decks_[index]; }
  int sampleRate() const { return sampleRate_; }

  /** Call once both decks are filled in, before the first [render]. */
  void prepare();

  /** The earliest mix frame anything renders at (negative: before t0). */
  int64_t firstFrame() const;

  /**
   * Renders [frames] stereo frames starting at mix frame [frame] into
   * [interleaved] (overwritten). Frames must be asked for in order.
   */
  void render(int64_t frame, float* interleaved, int frames);

 private:
  void renderDeck(Deck& deck, int64_t frame, int frames);

  int sampleRate_;
  Deck decks_[2];
  std::vector<float> inLeft_, inRight_, outLeft_, outRight_;
  std::vector<float> mixLeft_, mixRight_;
};

}  // namespace bitchord::loopmix
