"""
Violin Music Visualizer — Flask backend
Run: python app.py
Then open http://localhost:5000
"""

import os
import sys
import logging
import atexit
import threading
from collections import deque
from pathlib import Path
import numpy as np
import sounddevice as sd
import librosa
import re
from flask import Flask, render_template, jsonify, request

#Reduce logs
logging.getLogger("werkzeug").addFilter(
    type("_", (logging.Filter,), {
        "filter": lambda _, r: "/api/live-note" not in r.getMessage()
    })()
)

#Allow imports from the project root (sheet_music_reader, model.*)
#TODO - remove
sys.path.insert(0, str(Path(__file__).parent.parent))

ABC_DIR = Path(__file__).parent.parent / "abc"

app = Flask(__name__)

#Live audio detection
#2048 @ 44.1kHz ≈ 46ms/block t.
_WINDOW_SIZE   = 2048
_THRESHOLD     = 0.01
_live_note     = {"note": None, "freq": 0.0}
_note_lock     = threading.Lock()
_target_sr     = 44100
_stream        = None
_note_history  = deque(maxlen=3)          # temporal smoothing: vote over last 3 frames

#Max/min for yin read
_FMIN = librosa.note_to_hz("G3")
_FMAX = librosa.note_to_hz("C8")

def _get_first_wasapi_input():
    devices = sd.query_devices()
    for index, dev in enumerate(devices):
        if "WASAPI" not in sd.query_hostapis(dev["hostapi"])["name"].upper():
            continue
        if dev["max_input_channels"] <= 0:
            continue
        rate  = int(dev["default_samplerate"])
        chans = dev["max_input_channels"]
        for c in ([1] if chans == 1 else [1, chans]):
            try:
                with sd.InputStream(device=index, channels=c, samplerate=rate,
                                    blocksize=_WINDOW_SIZE):
                    pass
                return index, rate, c
            except Exception:
                continue
    return None, None, None

def _freq_to_note(freq):
    if freq <= 0:
        return None
    return librosa.midi_to_note(int(round(librosa.hz_to_midi(freq))), unicode=False)

def _audio_callback(indata, _frames, _time, _status):
    audio  = indata[:, 0].astype(np.float64)
    volume = np.sqrt(np.mean(audio ** 2))
    if volume < _THRESHOLD:
        _note_history.clear()
        with _note_lock:
            _live_note["note"] = None
            _live_note["freq"] = 0.0
        return

    #YIN (autocorrelation-based, deterministic): constrained to the violin's
    #fmin/fmax range so it doesn't latch onto a harmonic partial and report a
    #note an octave away from what was actually played
    f0 = librosa.yin(
        audio, fmin=_FMIN, fmax=_FMAX, sr=_target_sr,
        frame_length=1024, hop_length=128,
    )

    #Median across the frames in this block, to single-frame outliers
    freq = float(np.median(f0))
    note = _freq_to_note(freq)

    #smoothing
    _note_history.append(note)
    smoothed = max(set(_note_history), key=list(_note_history).count)
    with _note_lock:
        _live_note["note"] = smoothed
        _live_note["freq"] = freq

def _start_audio():
    """Open the InputStream in the main thread (same as audio_listener/audio_reader.py).
    PortAudio drives the callback on its own internal audio thread; no Python
    background thread is needed and no WASAPI/COM issues arise."""
    global _target_sr, _stream
    dev, rate, chans = _get_first_wasapi_input()
    if dev is None:
        print("Live audio: no WASAPI input found — /api/live-note will return null")
        return
    _target_sr = rate
    _stream = sd.InputStream(device=dev, channels=chans, samplerate=rate,
                             blocksize=_WINDOW_SIZE, callback=_audio_callback)
    _stream.start()
    print(f"Live audio detection started (device {dev}, {rate} Hz, {chans} ch)")

def _stop_audio():
    global _stream
    if _stream is not None:
        _stream.stop()
        _stream.close()
        _stream = None

atexit.register(_stop_audio)

#For some reason this is required to prevent multiple subprocesses from damaging the audio input
if not app.debug or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
    _start_audio()

# ── Shared string definitions ───────────────────────────────────────────────
STRINGS = [
    {"name": "E", "freq": 2.4,  "color": "#f0e6d0", "phase": 1.8},
    {"name": "A", "freq": 1.7,  "color": "#d4b896", "phase": 1.1},
    {"name": "D", "freq": 1.2,  "color": "#c4a96b", "phase": 0.5},
    {"name": "G", "freq": 0.8,  "color": "#8b4513", "phase": 0.0},
]

DEFAULT_PIECE = None   # all pieces loaded from abc/ folder


#abc file support
#match the note to the string
def _string_for_midi(midi: int) -> str:
    # MIDI to String
    if midi < 62:   return "G"   # G3 – C#4
    if midi < 69:   return "D"   # D4 – G#4
    if midi < 76:   return "A"   # A4 – D#5
    return "E"                    # E5 and above


def _abc_to_score_json(sheet) -> list[dict]:
    """Convert a SheetMusic object (from parse_abc) to the frontend score format."""
    from model.sheet_music import NoteEvent, Chord

    BEATS_PER_WHOLE = 4   # 1 whole note = 4 quarter-note beats
    events: list[dict] = []
    t = 0.0

    for track in sheet.tracks:
        for measure in track.measures:
            for beat in measure.beats:
                ev  = beat.event
                dur = ev.duration.value * BEATS_PER_WHOLE

                if isinstance(ev, NoteEvent):
                    if ev.is_rest or ev.note is None:
                        events.append({
                            "t":       round(t, 4),
                            "dur":     round(dur, 4),
                            "notes":   [],
                            "pitches": {},
                            "dynamic": 0.0,
                            "bow":     "down",
                            "name":    getattr(ev, "_section", ""),
                            "slur":    None,
                            "rest":    True,
                        })
                        t += dur
                        continue
                    sname = _string_for_midi(ev.note.midi_number)
                    events.append({
                        "t":       round(t, 4),
                        "dur":     round(dur, 4),
                        "notes":   [sname],
                        "pitches": {sname: str(ev.note)},
                        "dynamic": 0.7,
                        "bow":     "down",
                        "name":    getattr(ev, "_section", ""),
                        "slur":    getattr(ev, "_slur_id", None),
                    })

                elif isinstance(ev, Chord):
                    notes_list, pitches = [], {}
                    for note in ev.notes:
                        sname = _string_for_midi(note.midi_number)
                        if sname not in pitches:
                            notes_list.append(sname)
                            pitches[sname] = str(note)
                    if notes_list:
                        events.append({
                            "t":       round(t, 4),
                            "dur":     round(dur, 4),
                            "notes":   notes_list,
                            "pitches": pitches,
                            "dynamic": 0.7,
                            "bow":     "down",
                            "name":    getattr(ev, "_section", ""),
                            "slur":    False,
                        })

                t += dur

    return events


def _read_abc_meta(path: Path) -> tuple[str, str, float]:
    #Return (title, composer, tempo_bpm) from an ABC file header
    title, composer, tempo = path.stem, "Unknown", 120.0
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("T:"):
                title    = line[2:].strip()
            elif line.startswith("C:"):
                composer = line[2:].strip()
            elif line.startswith("Q:"):
                #Tempo
                m = re.search(r"(\d+)\s*$", line[2:].strip())
                if m:
                    tempo = float(m.group(1))
            elif line.startswith("K:"):
                break
    return title, composer, tempo


@app.route("/api/live-note")
def live_note():
    with _note_lock:
        return jsonify({"note": _live_note["note"], "freq": round(_live_note["freq"], 2)})


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/pieces")
def get_pieces():
    """List all ABC pieces from the abc/ folder."""
    result = []
    if ABC_DIR.exists():
        for abc_file in sorted(ABC_DIR.glob("*.abc")):
            title, composer, _ = _read_abc_meta(abc_file)
            result.append({
                "id":       f"abc:{abc_file.stem}",
                "title":    title,
                "composer": composer,
            })
    return jsonify(result)


@app.route("/api/score")
def get_score():
    #Return score and metadata for an ABC piece. ?piece=abc:<stem>
    #TODO - add a midi reader?
    piece_id = request.args.get("piece") or DEFAULT_PIECE
    if not piece_id:
        return jsonify({"error": "No piece specified and no default available"}), 400

    if not piece_id.startswith("abc:"):
        return jsonify({"error": f"Unknown piece '{piece_id}'"}), 404

    filename = piece_id[4:] + ".abc"
    abc_path = ABC_DIR / filename
    if not abc_path.exists():
        return jsonify({"error": f"ABC file '{filename}' not found"}), 404
    try:
        from sheet_music_reader.sheet_music_reader import parse_abc
        sheet    = parse_abc(abc_path.read_text(encoding="utf-8"))
        events   = _abc_to_score_json(sheet)
        duration = max((e["t"] + e["dur"] for e in events), default=0)
        return jsonify({
            "piece": {
                "title":      sheet.title,
                "composer":   sheet.composer,
                "instrument": "Violin",
                "duration":   round(duration, 2),
                "tempo":      sheet.tempo,
            },
            "strings": STRINGS,
            "score":   events,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    print("running at http://localhost:5000")
    app.run(debug=True, port=5000)
