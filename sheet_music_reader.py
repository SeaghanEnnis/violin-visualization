"""
See https://abcnotation.com/

ABC reference
─────────────────────
Header fields (one per line, before the first K: field):
  X:1          reference number
  T:Title      title
  C:Composer   composer
  M:4/4        meter 
  L:1/8        default note length
  Q:120        tempo
  K:Dmaj       key signature  (Maj/min)

Note body:
  Uppercase A–G     base octave = 4 (C = C4, middle C)
  Lowercase a–g     one octave above uppercase
  ,  after letter   lower one octave (each comma = -1 octave)
  '  after letter   raise one octave (each apostrophe = +1 octave)
  ^  prefix         sharp   ^^  double-sharp
  _  prefix         flat    __  double-flat
  =  prefix         natural
  z                 rest
  |                 barline (opens a new measure)
  ||  |]            section/final barline (also opens new measure)
  |:                repeat-start barline
  :|                repeat-end barline
  [notes]           chord  (e.g. [CEG]2) TODO - not tested
  -                 tie (TODO maybe does not work correctly)
  (  )              slur
  (3  (2  etc.      tuplet  ((3abc = triplet of a, b, c)
  %                 comment to end of line
  \\                line continuation (TODO, does not work)
"""

from __future__ import annotations
import re
import sys
from fractions import Fraction
from pathlib import Path
from typing import Optional

from model.sheet_music import (
    SheetMusic, Track, Measure, NoteEvent, Chord, Duration,
    TimeSignature, KeySignature, Clef,
)
from model.note import Note


# https://en.wikipedia.org/wiki/Key_signature
_KEY_TABLE: dict[str, KeySignature] = {
    "c": KeySignature.C_MAJOR,    "cmaj": KeySignature.C_MAJOR,
    "g": KeySignature.G_MAJOR,    "gmaj": KeySignature.G_MAJOR,
    "d": KeySignature.D_MAJOR,    "dmaj": KeySignature.D_MAJOR,
    "a": KeySignature.A_MAJOR,    "amaj": KeySignature.A_MAJOR,
    "e": KeySignature.E_MAJOR,    "emaj": KeySignature.E_MAJOR,
    "b": KeySignature.B_MAJOR,    "bmaj": KeySignature.B_MAJOR,
    "f#": KeySignature.F_SHARP_MAJOR,  "f#maj": KeySignature.F_SHARP_MAJOR,
    "f":  KeySignature.F_MAJOR,   "fmaj":  KeySignature.F_MAJOR,
    "bb": KeySignature.B_FLAT_MAJOR,   "bbmaj": KeySignature.B_FLAT_MAJOR,
    "eb": KeySignature.E_FLAT_MAJOR,   "ebmaj": KeySignature.E_FLAT_MAJOR,
    "ab": KeySignature.A_FLAT_MAJOR,   "abmaj": KeySignature.A_FLAT_MAJOR,
    "db": KeySignature.D_FLAT_MAJOR,   "dbmaj": KeySignature.D_FLAT_MAJOR,
    "gb": KeySignature.G_FLAT_MAJOR,   "gbmaj": KeySignature.G_FLAT_MAJOR,
    "am": KeySignature.C_MAJOR,    "amin": KeySignature.C_MAJOR,
    "em": KeySignature.G_MAJOR,    "emin": KeySignature.G_MAJOR,
    "bm": KeySignature.D_MAJOR,    "bmin": KeySignature.D_MAJOR,
    "f#m": KeySignature.A_MAJOR,   "f#min": KeySignature.A_MAJOR,
    "c#m": KeySignature.E_MAJOR,   "c#min": KeySignature.E_MAJOR,
    "g#m": KeySignature.B_MAJOR,   "g#min": KeySignature.B_MAJOR,
    "d#m": KeySignature.F_SHARP_MAJOR, "d#min": KeySignature.F_SHARP_MAJOR,
    "dm": KeySignature.F_MAJOR,    "dmin": KeySignature.F_MAJOR,
    "gm": KeySignature.B_FLAT_MAJOR,   "gmin": KeySignature.B_FLAT_MAJOR,
    "cm": KeySignature.E_FLAT_MAJOR,   "cmin": KeySignature.E_FLAT_MAJOR,
    "fm": KeySignature.A_FLAT_MAJOR,   "fmin": KeySignature.A_FLAT_MAJOR,
    "bbm": KeySignature.D_FLAT_MAJOR,  "bbmin": KeySignature.D_FLAT_MAJOR,
    "ebm": KeySignature.G_FLAT_MAJOR,  "ebmin": KeySignature.G_FLAT_MAJOR,
}

_STEP_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_ACC_DELTA      = {"^^": 2, "^": 1, "__": -2, "_": -1, "=": 0, "": 0}

# Normal counts for tuplets: n notes in the space of _TUPLET_NORMAL[n]
_TUPLET_NORMAL  = {2: 3, 3: 2, 4: 3, 5: 4, 6: 4, 7: 4}

# Accidentals implied by each key signature — applied to unmodified notes
# sharps: F C G D A E B  
# flats: B E A D G C F
_KEY_ACCIDENTALS: dict[KeySignature, dict[str, int]] = {
    KeySignature.C_MAJOR:       {},
    KeySignature.G_MAJOR:       {"F": 1},
    KeySignature.D_MAJOR:       {"F": 1, "C": 1},
    KeySignature.A_MAJOR:       {"F": 1, "C": 1, "G": 1},
    KeySignature.E_MAJOR:       {"F": 1, "C": 1, "G": 1, "D": 1},
    KeySignature.B_MAJOR:       {"F": 1, "C": 1, "G": 1, "D": 1, "A": 1},
    KeySignature.F_SHARP_MAJOR: {"F": 1, "C": 1, "G": 1, "D": 1, "A": 1, "E": 1},
    KeySignature.F_MAJOR:       {"B": -1},
    KeySignature.B_FLAT_MAJOR:  {"B": -1, "E": -1},
    KeySignature.E_FLAT_MAJOR:  {"B": -1, "E": -1, "A": -1},
    KeySignature.A_FLAT_MAJOR:  {"B": -1, "E": -1, "A": -1, "D": -1},
    KeySignature.D_FLAT_MAJOR:  {"B": -1, "E": -1, "A": -1, "D": -1, "G": -1},
    KeySignature.G_FLAT_MAJOR:  {"B": -1, "E": -1, "A": -1, "D": -1, "G": -1, "C": -1},
}


# ---------------------------------------------------------------------------
# Header field parsers
# ---------------------------------------------------------------------------

def _parse_key(s: str) -> KeySignature:
    key = _KEY_TABLE.get(s.strip().lower().replace(" ", ""))
    if key is None:
        raise ValueError(f"Unrecognised ABC key '{s}'")
    return key


def _parse_meter(s: str) -> TimeSignature:
    s = s.strip()
    if s.upper() in ("C",):
        return TimeSignature(4, 4)
    if s.upper() in ("C|",):
        return TimeSignature(2, 2)
    top, bot = s.split("/")
    return TimeSignature(int(top.strip()), int(bot.strip()))


def _parse_default_length(s: str) -> Fraction:
    num, den = s.strip().split("/")
    return Fraction(int(num), int(den))


def _parse_tempo(s: str, default_len: Fraction) -> float:
    """Return BPM normalised to a quarter-note beat."""
    s = re.sub(r'"[^"]*"', "", s).strip()
    if "=" in s:
        unit_str, bpm_str = s.split("=", 1)
        bpm = float(bpm_str.strip())
        unit_str = unit_str.strip()
        if "/" in unit_str:
            un, ud = unit_str.split("/")
            unit = Fraction(int(un), int(ud))
        else:
            unit = default_len
        return float(bpm * unit / Fraction(1, 4))
    return float(s.strip() or "120")


def _parse_header(lines: list[str]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("%"):
            continue
        if re.match(r"^[A-Za-z]:", line):
            fields[line[0].upper()] = line[2:].strip()
    return fields


# ---------------------------------------------------------------------------
# Note body tokenizer
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"""
    (?P<annotation>  "[^"]*" )                   |   # "Tutti", "Solo", chord symbols — skip
    (?P<tuplet>      \( (?P<tnum>[2-9]) )       |
    (?P<chord_start> \[  )                       |
    # chord_end captures an optional trailing duration
    (?P<chord_end>   \]
        (?P<cnum> \d+)?
        (?P<cslash> /*)
        (?P<cden> \d+)?
    )                                            |
    # Barlines — longer alternatives first
    (?P<barline>  :\|\| | :\| | \|\| | \|\: | \|\] | \| )  |
    (?P<slur_end>    \)  )                       |
    (?P<slur_start>  \(  )                       |
    (?P<tie>         -   )                       |
    (?P<note>
        (?P<acc>   \^{1,2} | _{1,2} | = )?
        (?P<step>  [A-Ga-gz] )
        (?P<oct>   [,']* )
        (?P<num>   \d+ )?
        (?P<slash> /* )
        (?P<den>   \d+ )?
    )                                            |
    (?P<space>   \s+ )
""", re.VERBOSE)


def _abc_pitch(step: str, acc: str, oct_shifts: str, base_octave: int,
               key_accs: dict[str, int] | None = None,
               bar_accs: dict[str, int] | None = None) -> Optional[Note]:
    """Convert ABC pitch components to a Note, or None for rests (z).

    Accidental priority (standard ABC rules):
      1. Explicit accidental on this note  →  use it, carry forward in the bar
      2. Carry-forward from earlier in the bar  →  use it
      3. Key signature default  →  use it
    """
    if step.lower() == "z":
        return None
    octave  = base_octave + (1 if step.islower() else 0)
    step_up = step.upper()
    for ch in oct_shifts:
        if ch == ",":  octave -= 1
        elif ch == "'": octave += 1
    if acc:
        delta = _ACC_DELTA.get(acc, 0)
        if bar_accs is not None:
            bar_accs[step_up] = delta   # persist for rest of bar (= → 0 = natural)
    elif bar_accs is not None and step_up in bar_accs:
        delta = bar_accs[step_up]
    else:
        delta = (key_accs or {}).get(step_up, 0)
    semitone  = _STEP_SEMITONES[step_up] + delta
    octave   += semitone // 12          # handle wrap-around (e.g. B# → next C)
    semitone  = semitone % 12
    midi      = (octave + 1) * 12 + semitone
    return Note.from_midi(midi)


def _abc_duration(num_str: str, slash_str: str, den_str: str,
                  default_len: Fraction) -> Duration:

    #Resolve ABC duration modifier against L: default length.
    #A → 1
    #A2 → 2 
    #A3/2 → 3/2 (dotted)
    #A/2 → 1/2

    if not num_str and not slash_str:
        frac = Fraction(1)
    elif slash_str and not num_str and not den_str:
        frac = Fraction(1, 2 ** len(slash_str))
    else:
        num = int(num_str) if num_str else 1
        den = int(den_str) if den_str else (2 ** len(slash_str) if slash_str else 1)
        frac = Fraction(num, den)
    total = default_len * frac
    return Duration(total.numerator, total.denominator)



#Parse ABC into Sheet Music Object
def parse_abc(abc_text: str) -> SheetMusic:
    #Parsing Notation

    cleaned: list[str] = []
    for line in abc_text.splitlines():
        pos = line.find("%") # Strip comments
        if pos >= 0:
            line = line[:pos]
        line = line.rstrip()
        if line.endswith("\\"): #handle line continuations (trailing backslash) - TODO check
            cleaned.append(line[:-1] + " ")
        else:
            cleaned.append(line)

    # Split into header (before and including K:) and body
    header_lines: list[str] = []
    body_lines:   list[str] = []
    in_body = False
    for line in cleaned:
        if in_body:
            body_lines.append(line)
        else:
            header_lines.append(line)
            if re.match(r"^[Kk]:", line.strip()):
                in_body = True

    fields      = _parse_header(header_lines)
    default_len = _parse_default_length(fields.get("L", "1/8"))
    meter       = _parse_meter(fields.get("M", "4/4"))
    tempo       = _parse_tempo(fields.get("Q", "120"), default_len)
    key         = _parse_key(fields.get("K", "C"))
    key_accs    = _KEY_ACCIDENTALS.get(key, {})

    score = SheetMusic(
        title          = fields.get("T", "Untitled"),
        composer       = fields.get("C", "Unknown"),
        time_signature = meter,
        key_signature  = key,
        tempo          = tempo,
    )

    #Violin only ??
    track = score.add_track(
        name       = fields.get("P", "Violin"),
        instrument = "Violin",
        clef       = Clef.TREBLE,
    )

    # ABC convention: uppercase C = C4 (middle C)
    BASE_OCTAVE     = 4
    body_text       = " ".join(body_lines)
    current_measure = track.add_measure()

    in_chord            = False
    chord_notes: list[Optional[Note]] = []
    chord_dur: Optional[Duration]     = None
    slur_open           = False
    slur_count          = 0       # increments each time a new ( is opened
    current_slur_id: Optional[int] = None
    pending_tie         = False
    pending_annotation  = ""          # last "text" annotation seen, applied to next event
    tuplet_rem          = 0
    tuplet_ratio: Optional[tuple[int, int]] = None
    bar_accs: dict[str, int]          = {}  # explicit accidentals in current bar

    for m in _TOKEN_RE.finditer(body_text):
        kind = m.lastgroup

        if kind == "space":
            continue

        #Inline annotations ("Tutti", "Solo", chord symbols)
        if kind == "annotation":
            pending_annotation = m.group("annotation").strip('"')
            continue

        #Barlines
        if kind == "barline":
            bar = m.group("barline")
            if bar in (":|", ":||"):
                current_measure.repeat_end = True
            current_measure = track.add_measure()
            if bar == "|:":
                current_measure.repeat_start = True
            bar_accs = {}   # explicit accidentals reset at each barline
            continue

        #Chords
        if kind == "chord_start":
            in_chord    = True
            chord_notes = []
            chord_dur   = None
            continue

        if kind == "chord_end":
            in_chord  = False
            chord_dur = _abc_duration(
                m.group("cnum")   or "",
                m.group("cslash") or "",
                m.group("cden")   or "",
                default_len,
            )
            valid_notes = [n for n in chord_notes if n is not None]
            if valid_notes and chord_dur is not None:
                #All chord notes are simultaneous — use a single Chord object
                chord_obj = Chord(notes=valid_notes, duration=chord_dur)
                chord_obj._section = pending_annotation  # type: ignore[attr-defined]
                pending_annotation = ""
                current_measure.add_event(chord_obj)
                pending_tie = False
            continue

        #Tuplets
        if kind == "tuplet":
            n            = int(m.group("tnum"))
            tuplet_rem   = n
            tuplet_ratio = (n, _TUPLET_NORMAL.get(n, n - 1))
            continue

        #Slurs
        if kind == "slur_start":
            slur_open = True
            slur_count += 1
            current_slur_id = slur_count
            continue

        if kind == "slur_end":
            slur_open = False
            current_slur_id = None
            continue

        #Ties
        if kind == "tie":
            pending_tie = True
            continue

        #Notes/rests
        if kind == "note":
            step      = m.group("step")
            acc       = m.group("acc")   or ""
            oct_str   = m.group("oct")   or ""
            num_str   = m.group("num")   or ""
            slash_str = m.group("slash") or ""
            den_str   = m.group("den")   or ""

            pitch = _abc_pitch(step, acc, oct_str, BASE_OCTAVE, key_accs, bar_accs)
            dur   = _abc_duration(num_str, slash_str, den_str, default_len)

            #Tuplet time-scaling - currently not used
            if tuplet_rem > 0 and tuplet_ratio is not None:
                actual, normal = tuplet_ratio
                scaled = Fraction(dur.numerator, dur.denominator) * Fraction(normal, actual)
                dur = Duration(scaled.numerator, scaled.denominator)
                tuplet_rem -= 1
                if tuplet_rem == 0:
                    tuplet_ratio = None

            if in_chord:
                chord_notes.append(pitch)
                continue   #duration comes from the ] token

            event = NoteEvent(
                note       = pitch,
                duration   = dur,
                slur_start = slur_open,
                tied       = pending_tie,
            )
            event._section  = pending_annotation
            event._slur_id  = current_slur_id      
            pending_annotation = ""
            current_measure.add_event(event)
            pending_tie = False

    return score


# formatted printer
# TODO use a real logger/formatter
def print_score(score: SheetMusic) -> None:
    print(f"{score.title}")
    print(f"Composer : {score.composer}")
    print(f"Tempo    : {score.tempo} BPM")
    print(f"Time Sig : {score.time_signature}")
    print(f"Key Sig  : {score.key_signature.name}")
    print("-" * 60)
    for track in score.tracks:
        print(f"\nTrack: {track.name}  [{track.instrument}]")
        for measure in track.measures:
            beats_desc = "  ".join(str(b.event) for b in measure.beats)
            print(f"Bar {measure.number:>2}: {beats_desc}")



# Read a file into sheet music object
def load_from_file(path: str | Path) -> SheetMusic:
    return parse_abc(Path(path).read_text(encoding="utf-8"))

# Testable
if __name__ == "__main__":
    abc_path = sys.argv[1] if len(sys.argv) > 1 else "sample.abc"
    print(f"\nReading ABC notation from: {abc_path}\n")
    score = load_from_file(abc_path)
    print_score(score)

    for track in score.tracks:
        for measure in track.measures:
            for beat in measure.beats:
                if not beat.event.is_rest and beat.event.note:
                    n = beat.event.note
                    print(f"{n}  freq={n.frequency} Hz  MIDI={n.midi_number}"
                          f"dur={beat.event.duration}")
