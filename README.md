# Violin Music Guide

## Run
pip install -r requirements.txt
python app.py
open http://localhost:5000

## Microphone input
"Wait for Me" and "Points" modes listen to a microphone to follow along. The
input device is picked automatically — WASAPI on Windows, Core Audio on Mac,
ALSA/PulseAudio on Linux — with a specific device pickable instead from the
"Input" dropdown in the controls bar, or rescanned there if you plug something
in after starting the app.

**On Mac**, the first time it opens a microphone, macOS will prompt for
permission. If that prompt is dismissed or missed, grant it manually under
System Settings → Privacy & Security → Microphone (enable it for Terminal, or
whichever app you launched `python app.py` from) and restart the app — until
then every device will appear in the list but stay silent.

If no device works, the app still runs; the score plays and displays, live
pitch/timing feedback just won't be available.
