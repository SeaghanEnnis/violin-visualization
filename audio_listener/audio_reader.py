import numpy as np
import sounddevice as sd
import librosa

#Partial duplication in the mian app.py
def get_first_working_wasapi_input():
    devices = sd.query_devices()
    
    print("Scanning system for a functional WASAPI microphone")
    for index, dev in enumerate(devices):
        api_name = sd.query_hostapis(dev['hostapi'])['name']
        
        if "WASAPI" in api_name.upper() and dev['max_input_channels'] > 0:
            name = dev['name']
            rate = int(dev['default_samplerate'])
            max_chans = dev['max_input_channels']
            
            print(f"WASAPI Device [{index}]: {name}")
            print(f"Device Freq Rate: {rate}Hz | Max Input Channels: {max_chans}")
            
            channels_to_test = [1] if max_chans == 1 else [1, max_chans]
            
            for chans in channels_to_test:
                try:
                    with sd.InputStream(device=index, channels=chans, samplerate=rate, blocksize=1024):
                        pass
                    print(f"Stream verified on Device #{index} with {chans} channel(s).")
                    return index, rate, name, chans
                except Exception as e:
                    print(f"Attempt with {chans} channel(s) failed: {e}")
                    continue
                
    return None, None, None, None

#Get input sound device
TARGET_DEVICE, SAMPLE_RATE, DEVICE_NAME, CHANNELS = get_first_working_wasapi_input()

if TARGET_DEVICE is None:
    print("Fatal Error: No functional WASAPI audio input device could be initialized.")
    exit()


WINDOW_SIZE = 4096   
THRESHOLD = 0.01     

print(f"Active WASAPI Hardware: {DEVICE_NAME}")
print(f"Sampling Rate: {SAMPLE_RATE} Hz | Channels: {CHANNELS}")
print(F"Starting live note detection... Press Ctrl+C to stop.\n")

def frequency_to_note(frequency):
    if frequency <= 0:
        return "None"
    midi_note = librosa.hz_to_midi(frequency)
    return librosa.midi_to_note(int(round(midi_note)))

def audio_callback(indata, frames, time, status):
    if status:
        print(status)
        
    #grab the first available input channel
    audio_buffer = indata[:, 0]
    volume = np.sqrt(np.mean(audio_buffer**2))

    #skip low sounds
    if volume < THRESHOLD:
        return

    #stolen from https://stackoverflow.com/questions/29380678/spectrum-analyzer-of-wave-files-with-numpy-rfft
    fft_data = np.abs(np.fft.rfft(audio_buffer))
    frequencies = np.fft.rfftfreq(WINDOW_SIZE, d=1.0/SAMPLE_RATE)
    
    peak_index = np.argmax(fft_data)
    dominant_frequency = frequencies[peak_index]
    
    if 50 < dominant_frequency < 2000:
        note = frequency_to_note(dominant_frequency)
        print(f"Freq:{dominant_frequency:7.2f} Hz | Note: {note}")

try:
    #https://python-sounddevice.readthedocs.io/en/0.5.3/usage.html
    with sd.InputStream(
        device=TARGET_DEVICE,
        channels=CHANNELS, 
        samplerate=SAMPLE_RATE, 
        blocksize=WINDOW_SIZE, 
        callback=audio_callback
    ):
        while True:
            sd.sleep(10)
except KeyboardInterrupt as e:
    print("Stream stopped by user.")
    print(e)
except Exception as e:
    print(f"Unexpected runtime error: {e}")
    print(e)
