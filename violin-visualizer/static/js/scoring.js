/**
 * Points-mode scoring — pure logic, no DOM, so it can be exercised on its own.
 *
 * Each note that has a pitch is worth up to 100 points:
 *   40  tempo       — when the note started vs. when it was due
 *   30  note        — how much of what was played was the right note
 *   30  intonation  — how close to dead-centre on that note it was, in cents
 *
 * Input is a stream of samples, one per mic block, already placed on the
 * song clock: {p, midiF} where p is the song position (in beats) the block
 * was captured at and midiF is the detected pitch as a fractional MIDI number
 * (null for silence). The song clock and the mic clock are different things —
 * mapping one onto the other is the caller's job, see visualizer.js.
 *
 * Everything tunable is in the constants below. The thresholds are starting
 * points to be tuned by playing, not measured values.
 */

//Points available per note
export const WEIGHTS = { tempo: 40, note: 30, intonation: 30 };

//Pitch
const IN_TUNE_CENTS     = 15;   // this close to the target = full intonation credit
const OTHER_NOTE_CENTS  = 50;   // further than this from the target and it's a different note

//Timing. Full credit within TIMING_FULL_BEATS of the due time, none past
//TIMING_ZERO_BEATS — but never tighter than the mic can resolve (a block is
//tens to over a hundred ms long), hence the floors.
const TIMING_FULL_BEATS  = 0.15;
const TIMING_ZERO_BEATS  = 0.5;
const TIMING_FLOOR_S     = 0.06;   // added to 0.6 of a block: the tightest "full credit" window
const TIMING_MIN_FALLOFF = 0.25;   // seconds between full credit and none, at least

//Onset search: look this far before a note's due time for an early entry
//(capped at half the previous note's length), and don't accept a first
//sounding of the right pitch later than this fraction of the note.
const EARLY_LOOKBACK_S  = 0.6;
const LATEST_ONSET_FRAC = 0.75;

//A note is judged once the song clock is this far past its end, so the
//mic readings for it (which arrive late) have all had time to land.
const FINALIZE_DELAY_S  = 0.5;

//A note this good or better counts toward a streak
const STREAK_MIN_POINTS = 50;

//Losing at least this many points in one category earns that category's
//tag (Late, Sharp...) instead of "Perfect"
const NOTABLE_LOSS = 8;

const clamp01 = v => Math.max(0, Math.min(1, v));

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

//Signed cents from the nearest of `targets` (positive = sharp)
export function centsFromNearest(midiF, targets) {
  let best = Infinity;
  for (const t of targets) {
    const c = (midiF - t) * 100;
    if (Math.abs(c) < Math.abs(best)) best = c;
  }
  return best;
}

//1 within IN_TUNE_CENTS of the note, falling to 0 at OTHER_NOTE_CENTS
export function intonationQuality(absCents) {
  return clamp01(1 - (absCents - IN_TUNE_CENTS) / (OTHER_NOTE_CENTS - IN_TUNE_CENTS));
}

//1 when the onset is within the "on time" window, falling to 0 past the
//"clearly wrong" one. `rate` is song beats per second; `blockSec` is the
//mic's block length, which limits how finely a start can be timed.
export function timingQuality(absErrS, rate, blockSec) {
  const beatS = 1 / rate;
  const full  = Math.max(TIMING_FULL_BEATS * beatS, TIMING_FLOOR_S + 0.6 * blockSec);
  const zero  = Math.max(TIMING_ZERO_BEATS * beatS, full + TIMING_MIN_FALLOFF);
  return clamp01(1 - (absErrS - full) / (zero - full));
}

const NO_POINTS = () => ({ tempo: 0, note: 0, intonation: 0, total: 0 });

export function gradeFor(pct) {
  if (pct === null) return "No notes scored";
  if (pct >= 0.9)  return "Excellent";
  if (pct >= 0.75) return "Great";
  if (pct >= 0.6)  return "Good";
  if (pct >= 0.4)  return "Getting there";
  return "Keep practising";
}

export class Scorer {
  /**
   * @param events every event in the piece, in time order:
   *               [{t, dur, midis: [...]}] — rests have midis = []
   */
  constructor(events) {
    this.notes = [];
    events.forEach((ev, i) => {
      if (!ev.midis.length) return;
      const prev = events[i - 1];
      const next = events[i + 1];
      this.notes.push({
        t: ev.t, dur: ev.dur, midis: ev.midis,
        prevMidis: prev ? prev.midis : [],
        prevDur:   prev ? prev.dur   : 0,
        nextMidis: next ? next.midis : [],
      });
    });
    this.reset();
  }

  reset() {
    this.samples  = [];
    this.results  = [];   // one per judged note, in order
    this.next     = 0;    // index into this.notes of the next note to judge
    this.blockSec = 0.05;
  }

  get done() { return this.next >= this.notes.length; }

  addSample(sample) {
    this.samples.push(sample);
  }

  /**
   * Judge every note whose window has fully passed. Returns the newly
   * judged results (empty most frames).
   */
  update(songPos, rate, blockSec) {
    if (blockSec) this.blockSec = blockSec;
    const finished = [];
    while (this.next < this.notes.length) {
      const n = this.notes[this.next];
      if (songPos < n.t + n.dur + FINALIZE_DELAY_S * rate) break;
      const r = this._judge(n, this.next, rate);
      this.results.push(r);
      finished.push(r);
      this.next++;
    }
    return finished;
  }

  _judge(n, index, rate) {
    const blockSec = this.blockSec;
    const blockU   = blockSec * rate;                 // a block, in beats
    const gapU     = blockU * 2.5;                    // a hole this big means readings were lost
    //(No previous event at all — the very first note — means only the count-in
    //came before, so the full lookback applies.)
    const prevS    = n.prevDur ? n.prevDur / rate : Infinity;
    const lookback = Math.min(EARLY_LOOKBACK_S, 0.5 * prevS) * rate;
    const lo = n.t - lookback, hi = n.t + n.dur;

    //The onset search reads a little past the note's end: a note that starts
    //late is still sounding then, and on a short note (a quarter at speed is
    //only a few mic blocks long) the readings inside the window alone may be
    //too few to recognise it. Pitch itself is still judged inside the window.
    const win = this.samples.filter(s => s.p >= lo && s.p < hi + 0.5 * n.dur);
    if (!win.some(s => s.p >= n.t && s.p < hi)) {
      //No readings at all for this note (throttled tab, dropped polls): not the
      //player's doing, so it's left out rather than scored as a miss.
      return { index, t: n.t, unscored: true, missed: false, points: NO_POINTS(), label: "—" };
    }

    const isCorrect = s => s.midiF != null &&
      Math.abs(centsFromNearest(s.midiF, n.midis)) <= OTHER_NOTE_CENTS;

    //When did the stretch of right-pitch readings starting at win[k] begin?
    //Halfway between the last reading that wasn't it and the first that was
    //(a block that straddles the change reads either way) — NOT the first
    //reading's own time, which readings tens of ms apart can put well after
    //the real start.
    const onsetOf = k => {
      const first = win[k], before = k > 0 ? win[k - 1] : null;
      const o = before && first.p - before.p <= gapU ? (before.p + first.p) / 2 : first.p - blockU / 2;
      return Math.max(o, lo);
    };

    //First sustained stretch of the right pitch that reaches the note's window
    const minRun = win.length >= 4 ? 2 : 1;
    let run = null;
    for (let k = 0; k < win.length; ) {
      if (!isCorrect(win[k])) { k++; continue; }
      let e = k;
      while (e + 1 < win.length && isCorrect(win[e + 1]) && win[e + 1].p - win[e].p <= gapU) e++;
      if (e - k + 1 >= minRun && win[e].p >= n.t && onsetOf(k) <= n.t + LATEST_ONSET_FRAC * n.dur) {
        run = { k, e };
        break;
      }
      k = e + 1;
    }

    if (!run) {
      const wrong = win.some(s => s.p >= n.t && s.midiF != null);
      return {
        index, t: n.t, unscored: false, missed: true, points: NO_POINTS(),
        label: wrong ? "Wrong note" : "Missed", detail: wrong ? "wrong" : "silent",
      };
    }

    let onset = onsetOf(run.k);

    //Same pitch as the note before: a held or re-bowed note gives no pitch
    //change to time a start from, so an "early" reading there proves nothing.
    const repeat = n.prevMidis.some(m => n.midis.includes(m));
    if (repeat && onset < n.t) onset = n.t;

    const errS   = (onset - n.t) / rate;               // + late, − early
    const timing = timingQuality(Math.abs(errS), rate, blockSec);

    //Pitch is judged from the start onward, so a late entry costs tempo
    //points but isn't also counted as wrong notes — and likewise, readings
    //that are the NEXT note arriving early are that note's tempo problem,
    //not this note being wrong.
    const from   = Math.max(n.t, onset);
    const isNext = s => n.nextMidis.length > 0 &&
      Math.abs(centsFromNearest(s.midiF, n.nextMidis)) <= OTHER_NOTE_CENTS;
    let played = win.filter(s => s.p >= from && s.p < hi && s.midiF != null && !(isNext(s) && !isCorrect(s)));
    //A start so late that its readings all fall just past the window: judge those
    if (!played.length) played = win.slice(run.k, run.e + 1).filter(s => s.midiF != null);
    const right  = played.filter(isCorrect);
    const noteAcc = played.length ? right.length / played.length : 0;
    const cents  = median(right.map(s => centsFromNearest(s.midiF, n.midis)));
    const intoQ  = intonationQuality(Math.abs(cents));

    const points = {
      tempo:      WEIGHTS.tempo * timing,
      note:       WEIGHTS.note * noteAcc,
      intonation: WEIGHTS.intonation * noteAcc * intoQ,
    };
    points.total = points.tempo + points.note + points.intonation;

    //The on-screen tag: what cost the most, unless nothing cost much
    const lost = {
      tempo: WEIGHTS.tempo - points.tempo,
      note:  WEIGHTS.note - points.note,
      tune:  WEIGHTS.intonation - points.intonation,
    };
    const worst = Object.keys(lost).reduce((a, b) => lost[a] >= lost[b] ? a : b);
    let label, detail;
    if (lost[worst] < NOTABLE_LOSS)   { label = "Perfect";                      detail = "perfect"; }
    else if (worst === "tempo")       { label = errS > 0 ? "Late" : "Early";    detail = "tempo"; }
    else if (worst === "note")        { label = "Wrong note";                   detail = "wrong"; }
    else                              { label = cents > 0 ? "Sharp" : "Flat";   detail = cents > 0 ? "sharp" : "flat"; }

    return { index, t: n.t, unscored: false, missed: false, errS, timing, noteAcc, cents, intoQ, points, label, detail };
  }

  /** Judge everything left (end of the piece). */
  finish(rate) {
    return this.update(Infinity, rate);
  }

  /**
   * Slide every reading along the song clock by `beats` and judge the whole
   * run again. This is how the mic-delay allowance can be fine-tuned after a
   * run: the readings themselves don't change, only when they're taken to
   * have happened.
   */
  shiftAndRejudge(beats, rate) {
    this.samples.forEach(s => { s.p += beats; });
    this.results = [];
    this.next    = 0;
    this.update(Infinity, rate);
  }

  /** Totals so far, as fractions of what was available for the notes judged. */
  summary() {
    const rs = this.results.filter(r => !r.unscored);
    const n  = rs.length;
    const sum = k => rs.reduce((a, r) => a + r.points[k], 0);
    const pct = (k, w) => n ? sum(k) / (w * n) : null;

    let streak = 0, bestStreak = 0;
    rs.forEach(r => {
      streak = !r.missed && r.points.total >= STREAK_MIN_POINTS ? streak + 1 : 0;
      bestStreak = Math.max(bestStreak, streak);
    });

    const timed = rs.filter(r => !r.missed);
    return {
      judged:     n,
      hit:        timed.length,
      missed:     n - timed.length,
      points:     Math.round(sum("total")),
      maxPoints:  100 * n,
      percent:    pct("total", 100),
      tempo:      pct("tempo", WEIGHTS.tempo),
      note:       pct("note", WEIGHTS.note),
      intonation: pct("intonation", WEIGHTS.intonation),
      bestStreak,
      //Average start error in seconds (+ = dragging behind, − = rushing)
      meanErrS:   timed.length ? timed.reduce((a, r) => a + r.errS, 0) / timed.length : null,
    };
  }
}
