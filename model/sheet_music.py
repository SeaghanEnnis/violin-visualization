"""
Sheet Music  Model

Hierarchy:
    SheetMusic
    └── Track (one per instrument/voice)
        └── Measure (one per bar) #TODO review if this makes sens
            └── Beat (subdivisions within a measure)
                └── NoteEvent (a note or rest at a point in time)
"""

from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from fractions import Fraction
from typing import Optional
from model.note import Note


#Enums - TODO 
class Dynamic(Enum):
    #Dynamics
    PPP  = "ppp"   #pianississimo
    PP   = "pp"    #pianissimo
    P    = "p"     #piano
    MP   = "mp"    #mezzo-piano
    MF   = "mf"    #mezzo-forte
    F    = "f"     #forte
    FF   = "ff"    #fortissimo
    FFF  = "fff"   #fortississimo


class Accidental(Enum):
    #sharps flats etc
    NONE        = "none"
    SHARP       = "#"
    FLAT        = "b"
    NATURAL     = "♮"
    #Techinically these exist
    DOUBLE_SHARP = "##"
    DOUBLE_FLAT  = "bb"

class Clef(Enum):
    #hint - treble
    TREBLE  = "treble"
    BASS    = "bass"
    ALTO    = "alto"
    TENOR   = "tenor"
    PERCUSSION = "percussion"


class KeySignature(Enum):
    #Key signatures
    # This does not make a lot of sense
    C_MAJOR   = 0
    G_MAJOR   = 1
    D_MAJOR   = 2
    A_MAJOR   = 3
    E_MAJOR   = 4
    B_MAJOR   = 5
    F_SHARP_MAJOR = 6
    F_MAJOR   = -1
    B_FLAT_MAJOR  = -2
    E_FLAT_MAJOR  = -3
    A_FLAT_MAJOR  = -4
    D_FLAT_MAJOR  = -5
    G_FLAT_MAJOR  = -6


class ArticulationMark(Enum):
    """Note articulation markings."""
    NONE        = "none"
    STACCATO    = "staccato"
    TENUTO      = "tenuto"
    ACCENT      = "accent"
    MARCATO     = "marcato"
    FERMATA     = "fermata"
    TRILL       = "trill"


# ---------------------------------------------------------------------------
# Duration
# ---------------------------------------------------------------------------

@dataclass
class Duration:
    """
    Represents a rhythmic duration as a fraction of a whole note.

    Examples:
        whole note        → Duration(1, 1)  → value = 1
        half note         → Duration(1, 2)  → value = 0.5
        quarter note      → Duration(1, 4)  → value = 0.25
        dotted quarter    → Duration(1, 4, dots=1) → value = 0.375
        triplet quarter   → Duration(1, 4, tuplet=(3, 2)) → value ≈ 0.1667
    """
    numerator:   int = 1
    denominator: int = 4         # quarter note by default
    dots:        int = 0         # augmentation dots
    tuplet:      Optional[tuple[int, int]] = None  # (actual, normal) e.g. (3, 2) for triplet

    @property
    def value(self) -> float:
        """Duration as a fraction of a whole note."""
        base = Fraction(self.numerator, self.denominator)

        # Each dot adds half of the previous value
        dot_value = base
        for _ in range(self.dots):
            dot_value /= 2
            base += dot_value

        # Apply tuplet ratio: triplet (3,2) means 3 notes fit in space of 2
        if self.tuplet:
            actual, normal = self.tuplet
            base = base * Fraction(normal, actual)

        return float(base)

    def __repr__(self) -> str:
        dots_str = "." * self.dots
        tuplet_str = f" [{self.tuplet[0]}:{self.tuplet[1]}]" if self.tuplet else ""
        return f"Duration({self.numerator}/{self.denominator}{dots_str}{tuplet_str})"

    # Convenient class-level factories
    WHOLE     = None   # set after class definition
    HALF      = None
    QUARTER   = None
    EIGHTH    = None
    SIXTEENTH = None


Duration.WHOLE     = Duration(1, 1)
Duration.HALF      = Duration(1, 2)
Duration.QUARTER   = Duration(1, 4)
Duration.EIGHTH    = Duration(1, 8)
Duration.SIXTEENTH = Duration(1, 16)


# ---------------------------------------------------------------------------
# TimeSignature
# ---------------------------------------------------------------------------

@dataclass
class TimeSignature:
    """
    Describes how beats are grouped within a measure.

    Attributes:
        beats_per_measure: Number of beats (top number, e.g. 4 in 4/4).
        beat_unit:         Note value of one beat (bottom number, e.g. 4 for quarter).
    """
    beats_per_measure: int = 4
    beat_unit:         int = 4   # 4 = quarter note, 8 = eighth note, etc.

    @property
    def measure_duration(self) -> float:
        """Total duration of a measure as fraction of a whole note."""
        return self.beats_per_measure / self.beat_unit

    def __str__(self) -> str:
        return f"{self.beats_per_measure}/{self.beat_unit}"


# ---------------------------------------------------------------------------
# NoteEvent  (note or rest within the score)
# ---------------------------------------------------------------------------

@dataclass
class NoteEvent:
    """
    A single note or rest placed at a rhythmic position within a measure.

    Attributes:
        note:         The pitch (None indicates a rest).
        duration:     Rhythmic duration of the event.
        dynamic:      Volume/dynamic marking for this note.
        articulation: Articulation marking.
        tied:         True if this note is tied to the next NoteEvent of the same pitch.
        slur_start:   True if this note begins a slur.
        slur_end:     True if this note ends a slur.
        fingering:    Optional fingering number (1–5).
        velocity:     MIDI velocity override (0–127). Derived from dynamic if None.
    """
    note:         Optional[Note] = None   # None = rest
    duration:     Duration        = field(default_factory=lambda: Duration.QUARTER)
    dynamic:      Optional[Dynamic]         = None
    articulation: ArticulationMark          = ArticulationMark.NONE
    tied:         bool                      = False
    slur_start:   bool                      = False
    slur_end:     bool                      = False
    fingering:    Optional[int]             = None
    velocity:     Optional[int]             = None   # 0–127

    @property
    def is_rest(self) -> bool:
        return self.note is None

    @property
    def effective_velocity(self) -> int:
        """MIDI velocity: explicit override, or derived from dynamic marking."""
        if self.velocity is not None:
            return max(0, min(127, self.velocity))
        dynamic_map = {
            Dynamic.PPP: 16,  Dynamic.PP: 33,  Dynamic.P:  49,
            Dynamic.MP:  64,  Dynamic.MF: 80,  Dynamic.F:  96,
            Dynamic.FF: 112,  Dynamic.FFF: 127,
        }
        return dynamic_map.get(self.dynamic, 64)

    def __str__(self) -> str:
        if self.is_rest:
            return f"Rest({self.duration})"
        return f"{self.note}({self.duration})"


# ---------------------------------------------------------------------------
# Chord  (multiple notes sounding simultaneously)
# ---------------------------------------------------------------------------

@dataclass
class Chord:
    """
    A group of NoteEvents that share the same duration and start time,
    representing notes played simultaneously.
    """
    notes:        list[Note]                = field(default_factory=list)
    duration:     Duration                  = field(default_factory=lambda: Duration.QUARTER)
    dynamic:      Optional[Dynamic]         = None
    articulation: ArticulationMark          = ArticulationMark.NONE

    def add_note(self, note: Note) -> Chord:
        self.notes.append(note)
        return self

    def __str__(self) -> str:
        pitches = "+".join(str(n) for n in self.notes)
        return f"Chord([{pitches}], {self.duration})"


# ---------------------------------------------------------------------------
# Beat  (a single rhythmic slot within a measure)
# ---------------------------------------------------------------------------

@dataclass
class Beat:
    """
    Represents one rhythmic slot within a measure.

    A beat can hold either a single NoteEvent or a Chord. For polyphonic
    music, a measure may hold multiple voices represented as separate lists
    of Beat objects.
    """
    position:  float                        = 0.0   # offset from measure start (in whole-note fractions)
    event:     Optional[NoteEvent | Chord]  = None

    @property
    def duration(self) -> float:
        return self.event.duration.value if self.event else 0.0

    def __str__(self) -> str:
        return f"Beat@{self.position:.3f}: {self.event}"


# ---------------------------------------------------------------------------
# Measure
# ---------------------------------------------------------------------------

@dataclass
class Measure:
    """
    One bar of music.

    Attributes:
        number:        Bar number (1-indexed).
        time_signature: May differ from the track default (e.g., meter change).
        key_signature:  May differ from the track default (e.g., modulation).
        clef:          Clef in effect for this measure (if changed mid-piece).
        beats:         Ordered rhythmic events in this measure (voice 1).
        voices:        Dict of additional voices keyed by voice number (2, 3, …).
        repeat_start:  Repeat barline at the start of this measure.
        repeat_end:    Repeat barline at the end of this measure.
        tempo:         BPM override for this measure (None = inherit from score).
        rehearsal_mark: Optional rehearsal letter/number (e.g., "A", "1").
    """
    number:         int                          = 1
    time_signature: Optional[TimeSignature]      = None
    key_signature:  Optional[KeySignature]       = None
    clef:           Optional[Clef]               = None
    beats:          list[Beat]                   = field(default_factory=list)
    voices:         dict[int, list[Beat]]        = field(default_factory=dict)
    repeat_start:   bool                         = False
    repeat_end:     bool                         = False
    tempo:          Optional[float]              = None
    rehearsal_mark: Optional[str]                = None

    def add_event(self, event: NoteEvent | Chord, voice: int = 1) -> Measure:
        """Appends a NoteEvent or Chord to the specified voice, auto-computing position."""
        if voice == 1:
            position = sum(b.duration for b in self.beats)
            self.beats.append(Beat(position=position, event=event))
        else:
            if voice not in self.voices:
                self.voices[voice] = []
            position = sum(b.duration for b in self.voices[voice])
            self.voices[voice].append(Beat(position=position, event=event))
        return self

    @property
    def total_duration(self) -> float:
        """Sum of all event durations in voice 1."""
        return sum(b.duration for b in self.beats)

    def __repr__(self) -> str:
        return f"Measure(number={self.number}, events={len(self.beats)})"


# ---------------------------------------------------------------------------
# Track
# ---------------------------------------------------------------------------

@dataclass
class Track:
    """
    A single instrument/voice part within the score.

    Attributes:
        name:           Human-readable name (e.g., "Violin I", "Piano - Right Hand").
        instrument:     General MIDI instrument name or number.
        clef:           Default clef for this track.
        measures:       Ordered list of Measure objects.
        is_percussion:  True for unpitched percussion tracks (MIDI channel 10).
        midi_channel:   MIDI channel (1-indexed, 1–16; 10 reserved for percussion).
        transpose:      Semitone transposition for transposing instruments (e.g., +2 for Bb clarinet).
    """
    name:          str                   = "Track"
    instrument:    str                   = "Acoustic Grand Piano"
    clef:          Clef                  = Clef.TREBLE
    measures:      list[Measure]         = field(default_factory=list)
    is_percussion: bool                  = False
    midi_channel:  int                   = 1
    transpose:     int                   = 0   # semitones

    def add_measure(self, measure: Optional[Measure] = None) -> Measure:
        """Appends a new (or provided) measure and returns it."""
        if measure is None:
            measure = Measure(number=len(self.measures) + 1)
        else:
            measure.number = len(self.measures) + 1
        self.measures.append(measure)
        return measure

    def __repr__(self) -> str:
        return f"Track('{self.name}', measures={len(self.measures)})"


# ---------------------------------------------------------------------------
# SheetMusic  (the top-level document)
# ---------------------------------------------------------------------------

@dataclass
class SheetMusic:
    """
    The complete sheet music document.

    Attributes:
        title:          Title of the piece.
        composer:       Composer's name.
        arranger:       Arranger's name (if applicable).
        time_signature: Default time signature for the piece.
        key_signature:  Default key signature.
        tempo:          Default tempo in BPM.
        tracks:         Ordered list of Track objects (instruments/voices).
        metadata:       Arbitrary extra metadata (copyright, publisher, etc.).
    """
    title:          str                     = "Untitled"
    composer:       str                     = "Unknown"
    arranger:       Optional[str]           = None
    time_signature: TimeSignature           = field(default_factory=TimeSignature)
    key_signature:  KeySignature            = KeySignature.C_MAJOR
    tempo:          float                   = 120.0   # BPM
    tracks:         list[Track]             = field(default_factory=list)
    metadata:       dict[str, str]          = field(default_factory=dict)

    def add_track(self, track: Optional[Track] = None, **kwargs) -> Track:
        """Adds a new Track (or provided instance) and returns it."""
        if track is None:
            track = Track(**kwargs)
        self.tracks.append(track)
        return track

    @property
    def measure_count(self) -> int:
        return max((len(t.measures) for t in self.tracks), default=0)

    def __repr__(self) -> str:
        return (
            f"SheetMusic(title='{self.title}', composer='{self.composer}', "
            f"tracks={len(self.tracks)}, measures≈{self.measure_count})"
        )


#Testing file
if __name__ == "__main__":
    # --- Build a simple two-measure melody (C major scale fragment) ---
    score = SheetMusic(
        title="Simple Scale Fragment",
        composer="Demo",
        time_signature=TimeSignature(4, 4),
        key_signature=KeySignature.C_MAJOR,
        tempo=100.0,
    )

    melody = score.add_track(name="Melody", instrument="Violin")

    # Measure 1: C4 D4 E4 F4 (quarter notes)
    # Measure 2: G4 (half) + rest (quarter) + A4 (quarter)
    m1 = melody.add_measure()
    for note_name in ["C", "D", "E", "F"]:
        m1.add_event(NoteEvent(note=Note(note_name, 4), duration=Duration.QUARTER))

    m2 = melody.add_measure()
    m2.add_event(NoteEvent(note=Note("G", 4), duration=Duration.HALF))
    m2.add_event(NoteEvent(note=None,         duration=Duration.QUARTER))  # rest
    m2.add_event(NoteEvent(note=Note("A", 4), duration=Duration.QUARTER))

    #TODO test remainder of class

    print(score)
    for track in score.tracks:
        print(f"{track}")
        for measure in track.measures:
            print(f"{measure}")
            for beat in measure.beats:
                print(f"{beat}")

    #Test notes to freqs
    print()
    print("Frequencies: ")
    for note_name in ["C", "E", "G"]:
        n = Note(note_name, 4)
        print(f"{n}: {n.frequency} Hz  (MIDI {n.midi_number})")