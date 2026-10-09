"""
Violin Music Visualizer — Flask backend
Run: python app.py
Then open http://localhost:5000
"""

import os
import sys
import logging
import atexit
import platform
import threading
import time
from collections import deque
from pathlib import Path
import numpy as np
import sounddevice as sd
import librosa
import re
from flask import Flask, render_template, jsonify, request, send_from_directory

#Reduce logs
logging.getLogger("werkzeug").addFilter(
    type("_", (logging.Filter,), {
        "filter": lambda _, r: "/api/live-note" not in r.getMessage()
    })()
)

#Allow imports from the project root (sheet_music_reader, model.*)
#TODO - remove
sys.path.insert(0, str(Path(__file__).parent.parent))

ABC_DIR    = Path(__file__).parent.parent / "abc"
SHEETS_DIR = Path(__file__).parent.parent / "sheets"
ACCOMP_DIR = Path(__file__).parent.parent / "accompaniment"

app = Flask(__name__)

#Live audio detection
#2048 @ 44.1kHz ≈ 46ms/block t.
_WINDOW_SIZE   = 2048
_THRESHOLD     = 0.01
#seq counts audio blocks and stamp is when the latest one arrived (perf_counter
#clock), so Points mode can tell fresh readings from repeats of the same
#block and work out when each one was actually played.
_live_note     = {"note": None, "freq": 0.0, "seq": 0, "stamp": 0.0}
_note_lock     = threading.Lock()
_target_sr     = 44100
_stream        = None
_note_history  = deque(maxlen=3)          # temporal smoothing: vote over last 3 frames
#Which device is live right now, and whether that was auto-picked or asked for
#via /api/audio-devices — read by the frontend's input-device dropdown.
_active_device = {"index": None, "name": None, "hostapi": None, "auto": True}

#Max/min for yin read
_FMIN = librosa.note_to_hz("G3")
_FMAX = librosa.note_to_hz("C8")

#PortAudio host APIs to try before any other, per OS — WASAPI is Windows-only,
#so picking it unconditionally (as this used to) left every other platform,
#Mac included, with no working input at all. Devices outside this list are
#still tried, just after these, so an unusual setup still has a fallback.
_HOST_API_PRIORITY = {
    "Windows": ("WASAPI", "DIRECTSOUND", "MME", "WDM-KS"),
    "Darwin":  ("CORE AUDIO",),
    "Linux":   ("ALSA", "PULSE", "JACK", "OSS"),
}

def _input_devices():
    """Every input-capable device, each with its host API name."""
    hostapis = sd.query_hostapis()
    return [
        {
            "index":      i,
            "name":       dev["name"],
            "hostapi":    hostapis[dev["hostapi"]]["name"],
            "channels":   dev["max_input_channels"],
            "samplerate": int(dev["default_samplerate"]),
        }
        for i, dev in enumerate(sd.query_devices())
        if dev["max_input_channels"] > 0
    ]

def _ranked_input_devices():
    """Input devices, this platform's preferred host API(s) first."""
    preferred = _HOST_API_PRIORITY.get(platform.system(), ())
    def rank(dev):
        name = dev["hostapi"].upper()
        for i, want in enumerate(preferred):
            if want in name:
                return i
        return len(preferred)   # not a preferred API — still a candidate, just last
    return sorted(_input_devices(), key=rank)

def _probe_device(dev):
    """Does this device actually open? Try mono first, then its full channel count."""
    for chans in ([1] if dev["channels"] == 1 else [1, dev["channels"]]):
        try:
            with sd.InputStream(device=dev["index"], channels=chans,
                                samplerate=dev["samplerate"], blocksize=_WINDOW_SIZE):
                pass
            return chans
        except Exception:
            continue
    return None

def _find_working_input(preferred_index=None):
    """A device that actually opens: `preferred_index` first if given (an
    explicit choice from the dropdown), then every other input device,
    platform-preferred host APIs first. Returns a device dict (plus its
    working channel count) or None if nothing on the machine will open."""
    candidates = _ranked_input_devices()
    if preferred_index is not None:
        chosen = next((d for d in candidates if d["index"] == preferred_index), None)
        if chosen is None:
            try:
                raw = sd.query_devices(preferred_index)
                if raw["max_input_channels"] > 0:
                    chosen = {
                        "index": preferred_index, "name": raw["name"],
                        "hostapi": sd.query_hostapis(raw["hostapi"])["name"],
                        "channels": raw["max_input_channels"],
                        "samplerate": int(raw["default_samplerate"]),
                    }
            except Exception:
                chosen = None
        if chosen is not None:
            candidates = [chosen] + [d for d in candidates if d["index"] != preferred_index]

    for dev in candidates:
        chans = _probe_device(dev)
        if chans is not None:
            return {**dev, "channels": chans}
    return None

def _freq_to_note(freq):
    if freq <= 0:
        return None
    return librosa.midi_to_note(int(round(librosa.hz_to_midi(freq))), unicode=False)

def _publish_block(note, freq, stamp):
    """Record the latest block's reading. Called with the lock NOT held."""
    with _note_lock:
        _live_note["note"]  = note
        _live_note["freq"]  = freq
        _live_note["seq"]  += 1
        _live_note["stamp"] = stamp

def _audio_callback(indata, _frames, _time, _status):
    arrived = time.perf_counter()   # taken first: yin below takes a few ms
    audio  = indata[:, 0].astype(np.float64)
    volume = np.sqrt(np.mean(audio ** 2))
    if volume < _THRESHOLD:
        _note_history.clear()
        _publish_block(None, 0.0, arrived)
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
    _publish_block(smoothed, freq, arrived)

#Closing a stream doesn't always release the device instantly at the OS level
#— Bluetooth input in particular can take a beat to renegotiate — so the very
#next attempt to open it can fail even though the device is perfectly fine a
#moment later. Retried with backoff rather than surfaced as a hard failure.
_START_RETRY_DELAYS_S = (0, 0.2, 0.5)

def _open_and_start(dev):
    """Construct and start a stream on `dev`, retrying briefly. Returns
    (stream, None) or (None, last_exception)."""
    last_exc = None
    for delay in _START_RETRY_DELAYS_S:
        if delay:
            time.sleep(delay)
        stream = sd.InputStream(device=dev["index"], channels=dev["channels"], samplerate=dev["samplerate"],
                                blocksize=_WINDOW_SIZE, callback=_audio_callback)
        try:
            stream.start()
            return stream, None
        except Exception as exc:
            stream.close()
            last_exc = exc
    return None, last_exc

def _start_audio(device_index=None):
    """Open the InputStream in the main thread (same as audio_listener/audio_reader.py).
    PortAudio drives the callback on its own internal audio thread; no Python
    background thread is needed and no WASAPI/COM issues arise.

    `device_index` pins a specific device (from the input-device dropdown);
    left as None, the best-guess device for this OS is used instead. Returns
    (ok, error_message).
    """
    global _target_sr, _stream, _active_device
    dev = _find_working_input(device_index)
    if dev is None:
        _active_device = {"index": None, "name": None, "hostapi": None, "auto": device_index is None}
        msg = "no working input device found" if device_index is None else "that device couldn't be opened"
        print(f"Live audio: {msg} — /api/live-note will return null")
        return False, msg

    stream, exc = _open_and_start(dev)
    if stream is None:
        #Passing the quick open/close probe doesn't guarantee a real start
        #(some virtual/exclusive-mode devices only fail here) — reported back
        #rather than left to crash the request or, at startup, the app itself.
        _active_device = {"index": None, "name": None, "hostapi": None, "auto": device_index is None}
        msg = f"{dev['name']} opened but failed to start ({exc})"
        print(f"Live audio: {msg}")
        return False, msg

    _target_sr = dev["samplerate"]
    _stream = stream
    _active_device = {"index": dev["index"], "name": dev["name"], "hostapi": dev["hostapi"], "auto": device_index is None}
    print(f"Live audio detection started (device {dev['index']} '{dev['name']}' via {dev['hostapi']}, "
          f"{dev['samplerate']} Hz, {dev['channels']} ch)")
    return True, None

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


def _abc_to_score_json(sheet) -> tuple[list[dict], list[dict]]:
    """Convert a SheetMusic object (from parse_abc) to the frontend score format.

    Returns (events, sync_anchors) — sync_anchors are {t, page, row} points
    lifted from any `%%sync page=N row=M` directives in the source ABC, used
    to scroll a companion PDF (sheets/<tune>.pdf) in step with playback.
    """
    from model.sheet_music import NoteEvent, Chord

    BEATS_PER_WHOLE = 4   # 1 whole note = 4 quarter-note beats
    events: list[dict] = []
    sync_anchors: list[dict] = []
    t = 0.0

    for track in sheet.tracks:
        for measure in track.measures:
            for beat in measure.beats:
                ev  = beat.event
                dur = ev.duration.value * BEATS_PER_WHOLE

                sync = getattr(ev, "_sync", None)
                if sync:
                    sync_anchors.append({"t": round(t, 4), "page": sync[0], "row": sync[1]})

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
                            "line":    getattr(ev, "_line", 0),
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
                        "line":    getattr(ev, "_line", 0),
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
                            "line":    getattr(ev, "_line", 0),
                        })

                t += dur

    return events, sync_anchors


def _score_lines(events: list[dict]) -> list[dict]:
    """Group events by the ABC source line they came from, for Line by Line
    practice. Returns [{start, end}] in beats, in playing order."""
    lines: list[dict] = []
    for ev in events:
        end = round(ev["t"] + ev["dur"], 4)
        if lines and lines[-1]["src"] == ev["line"]:
            lines[-1]["end"] = end
        else:
            lines.append({"src": ev["line"], "start": ev["t"], "end": end})
    return [{"start": l["start"], "end": l["end"]} for l in lines]


#%%accompaniment file=<name>.mp3 bpm=100 offset=0.92 — a backing track in
#accompaniment/ to play alongside the score. `bpm` is the tempo it was
#recorded at; `offset` is where score beat 0 falls in the audio, in seconds.
#Without the directive, accompaniment/<stem>-<N>bpm.(mp3|ogg|wav|m4a) is
#picked up with offset 0.
_ACCOMP_RE      = re.compile(r"^%%accompaniment\s+(.*)$", re.IGNORECASE | re.MULTILINE)
_ACCOMP_EXTS    = (".mp3", ".ogg", ".wav", ".m4a")

def _find_accompaniment(abc_text: str, stem: str, score_tempo: float) -> dict | None:
    m = _ACCOMP_RE.search(abc_text)
    if m:
        opts = dict(re.findall(r"(\w+)=(\S+)", m.group(1)))
        path = ACCOMP_DIR / opts.get("file", "")
        if not opts.get("file") or not path.is_file():
            print(f"%%accompaniment in {stem}.abc: file '{opts.get('file')}' not found in {ACCOMP_DIR}")
            return None
        bpm_m = re.search(r"-(\d+)bpm", path.stem)
        return {
            "url":    f"/accompaniment/{path.name}",
            "bpm":    float(opts.get("bpm") or (bpm_m.group(1) if bpm_m else score_tempo)),
            "offset": float(opts.get("offset", 0)),
        }

    if ACCOMP_DIR.exists():
        for path in sorted(ACCOMP_DIR.glob(f"{stem}*")):
            if path.suffix.lower() not in _ACCOMP_EXTS:
                continue
            bpm_m = re.fullmatch(re.escape(stem) + r"(?:-(\d+)bpm)?", path.stem)
            if bpm_m:
                return {
                    "url":    f"/accompaniment/{path.name}",
                    "bpm":    float(bpm_m.group(1) or score_tempo),
                    "offset": 0.0,
                }
    return None


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


@app.route("/api/audio-devices", methods=["GET"])
def list_audio_devices():
    """Every input device this machine has, plus which one is live now."""
    try:
        devices = _ranked_input_devices()
    except Exception as exc:
        return jsonify({"devices": [], "current": None, "auto": True, "active": False, "error": str(exc)}), 500
    return jsonify({
        "devices": devices,
        "current": _active_device["index"],
        "name":    _active_device["name"],
        "auto":    _active_device["auto"],
        "active":  _stream is not None,
    })


@app.route("/api/audio-devices", methods=["POST"])
def select_audio_device():
    """Switch the live input device. Body: {"device": <index>} or {"device": null} for auto-detect."""
    body = request.get_json(silent=True) or {}
    raw = body.get("device")
    try:
        device_index = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": f"Invalid device '{raw}'"}), 400

    _stop_audio()
    _note_history.clear()
    with _note_lock:
        _live_note.update(note=None, freq=0.0)
    ok, err = _start_audio(device_index)

    #200 either way: the request itself was handled correctly, whether or not
    #the device came up — "ok" in the body is what the caller should check
    #(some devices pass the earlier probe but fail here anyway, e.g.
    #exclusive-mode or Bluetooth devices that reject a rapid reopen).
    return jsonify({
        "ok":      ok,
        "error":   err,
        "current": _active_device["index"],
        "name":    _active_device["name"],
        "hostapi": _active_device["hostapi"],
        "auto":    _active_device["auto"],
    })


@app.route("/api/live-note")
def live_note():
    with _note_lock:
        stamp = _live_note["stamp"]
        return jsonify({
            "note":       _live_note["note"],
            "freq":       round(_live_note["freq"], 2),
            #For Points mode's timing: which block this is, how long ago it
            #arrived, and how long a block is. (How long the device sat on the
            #audio before handing it over isn't reliably reported — PortAudio's
            #figures for it contradicted each other on the real mic — so the
            #frontend applies an adjustable allowance instead.)
            "seq":        _live_note["seq"],
            "age_ms":     round((time.perf_counter() - stamp) * 1000, 1) if stamp else None,
            "block_ms":   round(_WINDOW_SIZE / _target_sr * 1000, 1),
            "mic":        _stream is not None,
        })


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/sheets/<path:filename>")
def sheet_pdf(filename):
    """Serve scanned sheet-music PDFs from sheets/ so pdf.js can fetch them."""
    return send_from_directory(SHEETS_DIR, filename)


@app.route("/accompaniment/<path:filename>")
def accompaniment_audio(filename):
    """Serve backing tracks from accompaniment/ (range requests, so seeking works)."""
    return send_from_directory(ACCOMP_DIR, filename)


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

    stem     = piece_id[4:]
    filename = stem + ".abc"
    abc_path = ABC_DIR / filename
    if not abc_path.exists():
        return jsonify({"error": f"ABC file '{filename}' not found"}), 404
    try:
        from sheet_music_reader.sheet_music_reader import parse_abc
        abc_text = abc_path.read_text(encoding="utf-8")
        sheet    = parse_abc(abc_text)
        events, sync_anchors = _abc_to_score_json(sheet)
        duration = max((e["t"] + e["dur"] for e in events), default=0)

        pdf_path = SHEETS_DIR / (stem + ".pdf")
        pdf_url  = f"/sheets/{stem}.pdf" if pdf_path.exists() else None

        return jsonify({
            "piece": {
                "title":      sheet.title,
                "composer":   sheet.composer,
                "instrument": "Violin",
                "duration":   round(duration, 2),
                "tempo":      sheet.tempo,
                "pdf":        pdf_url,
            },
            "accompaniment": _find_accompaniment(abc_text, stem, sheet.tempo),
            "strings":       STRINGS,
            "score":         events,
            "lines":         _score_lines(events),
            "syncAnchors":   sync_anchors,
            "syncPageRows":  sheet.sync_page_rows,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    print("running at http://localhost:5000")
    app.run(debug=True, port=5000)
