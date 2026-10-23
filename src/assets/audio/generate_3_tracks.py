#!/usr/bin/env python3
"""
Generate the 3 Ghibli/Hisaishi grand orchestral climax tracks for Wind Glider:
1. bgm-azure-climax (《晴空碧海之翼 · 决战狂潮》)
2. bgm-laputa-climax (《天空之城 · 狂风龙卷之跃》)
3. bgm-porco-climax (《红猪 · 亚得里亚海狂想曲》)

High-fidelity 48kHz stereo with vectorized DSP physical synthesis, acoustic convolution reverb,
and master peak limiting.
"""

import math
import os
import struct
import subprocess
import numpy as np
from scipy import signal

SAMPLE_RATE = 48000
NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

def midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))

def note(name: str, octave: int) -> float:
    idx = NOTE_NAMES.index(name.upper())
    midi = (octave + 1) * 12 + idx
    return midi_to_hz(midi)

class Reverb:
    """High-fidelity stereo acoustic space convolution reverberator."""
    def __init__(self, sr=SAMPLE_RATE):
        self.sr = sr
        
    def process(self, stereo_audio: np.ndarray, wet=0.24, decay_sec=2.2, seed=42) -> np.ndarray:
        impulse_len = int(decay_sec * self.sr)
        t_ir = np.linspace(0, decay_sec, impulse_len, endpoint=False)
        decay_curve = np.exp(-t_ir * (3.2 / decay_sec))
        
        np.random.seed(seed)
        ir_left = np.random.normal(0, 1.0, impulse_len) * decay_curve
        ir_right = np.random.normal(0, 1.0, impulse_len) * decay_curve
        
        nyq = self.sr / 2.0
        b_ir, a_ir = signal.butter(2, 4800.0 / nyq, btype='low')
        ir_left = signal.lfilter(b_ir, a_ir, ir_left)
        ir_right = signal.lfilter(b_ir, a_ir, ir_right)
        
        ir_left /= np.sqrt(np.sum(ir_left ** 2) + 1e-8)
        ir_right /= np.sqrt(np.sum(ir_right ** 2) + 1e-8)
        
        rev_left = signal.fftconvolve(stereo_audio[0], ir_left, mode='full')[:stereo_audio.shape[1]]
        rev_right = signal.fftconvolve(stereo_audio[1], ir_right, mode='full')[:stereo_audio.shape[1]]
        
        out = np.zeros_like(stereo_audio)
        out[0] = (1.0 - wet) * stereo_audio[0] + wet * rev_left
        out[1] = (1.0 - wet) * stereo_audio[1] + wet * rev_right
        return out


# ===================== INSTRUMENT SYNTHESIS ENGINES =====================

def synth_acoustic_guitar_pluck(freq: float, duration: float, velocity=0.8, pan=0.0) -> np.ndarray:
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    harmonics = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    weights = [1.0, 0.65, 0.38, 0.22, 0.12, 0.06]
    decay_rates = [2.2, 3.4, 4.8, 6.5, 8.5, 11.0]
    
    tone = np.zeros(num_samples, dtype=np.float32)
    for h, w, d in zip(harmonics, weights, decay_rates):
        h_freq = freq * h
        if h_freq < (SAMPLE_RATE / 2.0) - 200.0:
            env = np.exp(-t * (d + freq * 0.0035))
            tone += np.sin(2.0 * np.pi * h_freq * t) * w * env
            
    noise_att = np.random.normal(0, 0.25, num_samples) * np.exp(-t / 0.015)
    nyq = SAMPLE_RATE / 2.0
    b_thump, a_thump = signal.butter(2, [80.0 / nyq, 2400.0 / nyq], btype='band')
    pluck_thump = signal.lfilter(b_thump, a_thump, noise_att)
    
    out = (tone * 0.85 + pluck_thump * 0.35) * velocity * 0.55
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([out * left_gain, out * right_gain])


def synth_irish_flute_note(freq: float, duration: float, velocity=0.8, pan=0.0, vibrato_delay=0.14) -> np.ndarray:
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    
    vibrato_env = np.clip((t - vibrato_delay) / 0.22, 0.0, 1.0)
    vibrato = np.sin(2.0 * np.pi * 5.6 * t) * (freq * 0.014) * vibrato_env
    instant_freq = freq + vibrato
    phase = 2.0 * np.pi * np.cumsum(instant_freq) / SAMPLE_RATE
    
    h1 = np.sin(phase) * 1.0
    h2 = np.sin(phase * 2.0 + 0.3) * 0.45
    h3 = np.sin(phase * 3.0 + 0.7) * 0.24
    h4 = np.sin(phase * 4.0 + 1.1) * 0.09
    tone = h1 + h2 + h3 + h4
    
    raw_noise = np.random.normal(0, 0.12, num_samples)
    nyq = SAMPLE_RATE / 2.0
    low_cut = max(100.0, freq * 0.8) / nyq
    high_cut = min(nyq - 100.0, freq * 2.5) / nyq
    b_breath, a_breath = signal.butter(2, [low_cut, high_cut], btype='band')
    breath_noise = signal.lfilter(b_breath, a_breath, raw_noise) * 0.16
    
    attack_chuff = np.exp(-t / 0.02) * np.random.normal(0, 0.25, num_samples)
    combined = tone * 0.85 + breath_noise + attack_chuff
    
    attack_time = 0.04
    release_time = min(0.12, duration * 0.3)
    env = np.ones(num_samples)
    att_samples = int(attack_time * SAMPLE_RATE)
    if att_samples > 0:
        env[:att_samples] = np.sin(np.linspace(0, np.pi / 2, att_samples))
    rel_samples = int(release_time * SAMPLE_RATE)
    if rel_samples > 0:
        env[-rel_samples:] = np.cos(np.linspace(0, np.pi / 2, rel_samples))
        
    out = combined * env * velocity * 0.62
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([out * left_gain, out * right_gain])


def synth_warm_string_pad(freqs: list, duration: float, velocity=0.7, pan=0.0) -> np.ndarray:
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    out_mono = np.zeros(num_samples, dtype=np.float32)
    
    for f in freqs:
        detunes = [-0.0035, 0.0, 0.0038]
        phases = [0.0, 1.4, 2.8]
        note_sig = np.zeros(num_samples, dtype=np.float32)
        
        for det, ph in zip(detunes, phases):
            f_det = f * (1.0 + det)
            vib = np.sin(2 * np.pi * 5.1 * t + ph) * (f_det * 0.006)
            p = 2.0 * np.pi * np.cumsum(f_det + vib) / SAMPLE_RATE + ph
            saw = (2.0 * (p / (2 * np.pi) % 1.0) - 1.0)
            tri = 2.0 * np.abs(saw) - 1.0
            voice = saw * 0.5 + tri * 0.5
            note_sig += voice
            
        out_mono += note_sig * (1.0 / len(freqs))
        
    nyq = SAMPLE_RATE / 2.0
    b_lp, a_lp = signal.butter(3, min(nyq - 200, 3400) / nyq, btype='low')
    out_mono = signal.lfilter(b_lp, a_lp, out_mono)
    
    att_time = min(0.35, duration * 0.3)
    rel_time = min(0.45, duration * 0.35)
    att_samp = int(att_time * SAMPLE_RATE)
    rel_samp = int(rel_time * SAMPLE_RATE)
    env = np.ones(num_samples)
    if att_samp > 0:
        env[:att_samp] = (1.0 - np.cos(np.linspace(0, np.pi, att_samp))) * 0.5
    if rel_samp > 0:
        env[-rel_samp:] = (1.0 + np.cos(np.linspace(0, np.pi, rel_samp))) * 0.5
        
    out_mono = out_mono * env * velocity * 0.44
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([out_mono * left_gain, out_mono * right_gain])


def synth_string_staccato(freq: float, duration: float, velocity=0.8, pan=0.0) -> np.ndarray:
    """Crisp, driving orchestral staccato / spiccato string strike."""
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    
    detunes = [-0.003, 0.0, 0.003]
    note_sig = np.zeros(num_samples, dtype=np.float32)
    for d in detunes:
        f_d = freq * (1.0 + d)
        phase = 2 * np.pi * f_d * t
        saw = 2.0 * (phase / (2 * np.pi) % 1.0) - 1.0
        note_sig += saw
    note_sig /= 3.0
    
    nyq = SAMPLE_RATE / 2.0
    b_lp, a_lp = signal.butter(2, min(nyq - 200, max(800, freq * 3.5)) / nyq, btype='low')
    note_sig = signal.lfilter(b_lp, a_lp, note_sig)
    
    # Fast crisp bow bite envelope
    env = np.exp(-t * 9.5) * np.clip(t / 0.015, 0.0, 1.0)
    out = note_sig * env * velocity * 0.7
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([out * left_gain, out * right_gain])


def synth_french_horn_note(freq: float, duration: float, velocity=0.85, pan=0.0) -> np.ndarray:
    """Warm majestic orchestral French Horn / Brass voice."""
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    
    vib = np.sin(2 * np.pi * 4.8 * t) * (freq * 0.008) * np.clip(t / 0.25, 0.0, 1.0)
    phase = 2 * np.pi * np.cumsum(freq + vib) / SAMPLE_RATE
    
    # Horn harmonic profile: rich warm low harmonics
    h1 = np.sin(phase) * 1.0
    h2 = np.sin(phase * 2.0) * 0.75
    h3 = np.sin(phase * 3.0) * 0.45
    h4 = np.sin(phase * 4.0) * 0.25
    h5 = np.sin(phase * 5.0) * 0.12
    tone = h1 + h2 + h3 + h4 + h5
    
    nyq = SAMPLE_RATE / 2.0
    b, a = signal.butter(3, min(nyq - 200, 2600.0) / nyq, btype='low')
    filtered = signal.lfilter(b, a, tone)
    
    # Brass swell envelope
    att_time = min(0.08, duration * 0.25)
    rel_time = min(0.18, duration * 0.3)
    att_samp = int(att_time * SAMPLE_RATE)
    rel_samp = int(rel_time * SAMPLE_RATE)
    env = np.ones(num_samples)
    if att_samp > 0:
        env[:att_samp] = np.linspace(0, 1, att_samp)
    if rel_samp > 0:
        env[-rel_samp:] = np.linspace(1, 0, rel_samp)
        
    out = filtered * env * velocity * 0.55
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([out * left_gain, out * right_gain])


def synth_accordion_chord(freqs: list, duration: float, velocity=0.7, pan=0.0) -> np.ndarray:
    """Warm Mediterranean reed accordion / musette sound for Porco Rosso."""
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    out_mono = np.zeros(num_samples, dtype=np.float32)
    
    for f in freqs:
        # Musette wet detuning (+-8 cents)
        for det in [-0.005, 0.005]:
            p = 2 * np.pi * f * (1.0 + det) * t
            pulse = signal.square(p, duty=0.35)
            out_mono += pulse
    out_mono /= (len(freqs) * 2.0)
    
    nyq = SAMPLE_RATE / 2.0
    b, a = signal.butter(2, min(nyq - 200, 3200) / nyq, btype='low')
    out_mono = signal.lfilter(b, a, out_mono)
    
    att_samp = int(min(0.05, duration * 0.2) * SAMPLE_RATE)
    rel_samp = int(min(0.1, duration * 0.25) * SAMPLE_RATE)
    env = np.ones(num_samples)
    if att_samp > 0:
        env[:att_samp] = np.linspace(0, 1, att_samp)
    if rel_samp > 0:
        env[-rel_samp:] = np.linspace(1, 0, rel_samp)
        
    out_mono = out_mono * env * velocity * 0.45
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([out_mono * left_gain, out_mono * right_gain])


def synth_celesta_bell(freq: float, duration: float, velocity=0.6, pan=0.0) -> np.ndarray:
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    m1 = np.sin(2 * np.pi * freq * t) * np.exp(-t / 1.1)
    m2 = np.sin(2 * np.pi * freq * 2.756 * t) * np.exp(-t / 0.45) * 0.4
    m3 = np.sin(2 * np.pi * freq * 5.404 * t) * np.exp(-t / 0.22) * 0.18
    m4 = np.sin(2 * np.pi * freq * 8.933 * t) * np.exp(-t / 0.11) * 0.06
    bell = (m1 + m2 + m3 + m4) * velocity * 0.35
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([bell * left_gain, bell * right_gain])


def synth_bodhran_drum(duration: float, velocity=0.8, pan=0.0) -> np.ndarray:
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    freq_drop = 48.0 + 42.0 * np.exp(-t / 0.06)
    phase = 2.0 * np.pi * np.cumsum(freq_drop) / SAMPLE_RATE
    body = np.sin(phase) * np.exp(-t / 0.18)
    noise = np.random.normal(0, 0.3, num_samples) * np.exp(-t / 0.02)
    nyq = SAMPLE_RATE / 2.0
    b, a = signal.butter(2, [180.0 / nyq, 1600.0 / nyq], btype='band')
    slap = signal.lfilter(b, a, noise)
    drum = (body * 0.85 + slap * 0.3) * velocity * 0.75
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([drum * left_gain, drum * right_gain])


def synth_timpani_hit(freq: float, duration: float, velocity=0.85, pan=0.0) -> np.ndarray:
    """Orchestral timpani strike with pitch pitch-bend and resonant cavity."""
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    freq_drop = freq + (freq * 0.4) * np.exp(-t / 0.04)
    phase = 2.0 * np.pi * np.cumsum(freq_drop) / SAMPLE_RATE
    tone = np.sin(phase) * np.exp(-t / 0.45)
    harm = np.sin(phase * 1.5) * np.exp(-t / 0.3) * 0.35
    thump = np.random.normal(0, 0.3, num_samples) * np.exp(-t / 0.015)
    timp = (tone + harm + thump * 0.25) * velocity * 0.85
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([timp * left_gain, timp * right_gain])


def synth_cymbal_crash(duration: float, velocity=0.6, pan=0.0) -> np.ndarray:
    """Shimmering orchestral cymbal crash / swell."""
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    noise = np.random.uniform(-1, 1, num_samples)
    nyq = SAMPLE_RATE / 2.0
    b, a = signal.butter(3, 4000.0 / nyq, btype='high')
    crash = signal.lfilter(b, a, noise)
    env = np.exp(-t / 0.65) * np.clip(t / 0.01, 0.0, 1.0)
    out = crash * env * velocity * 0.35
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([out * left_gain, out * right_gain])


def synth_breeze_shaker(duration: float, velocity=0.5, pan=0.0) -> np.ndarray:
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    noise = np.random.uniform(-1, 1, num_samples)
    nyq = SAMPLE_RATE / 2.0
    b, a = signal.butter(2, 4500.0 / nyq, btype='high')
    rustle = signal.lfilter(b, a, noise)
    env = np.sin(np.pi * (t / duration)) ** 1.8
    shaker = rustle * env * velocity * 0.35
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([shaker * left_gain, shaker * right_gain])


# ===================== MASTERING & EXPORT UTILS =====================

def render_and_export(master_stereo: np.ndarray, total_samples: int, base_name: str, title: str):
    out_dir = "/var/www/wind-glider/src/assets/audio"
    os.makedirs(out_dir, exist_ok=True)
    
    rev = Reverb()
    print(f"Applying acoustic space convolution reverb for '{base_name}'...")
    master_wet = rev.process(master_stereo, wet=0.22, decay_sec=2.2)
    
    # 35Hz subsonic safety highpass
    nyq = SAMPLE_RATE / 2.0
    b_hp, a_hp = signal.butter(2, 35.0 / nyq, btype='high')
    master_wet[0] = signal.lfilter(b_hp, a_hp, master_wet[0])
    master_wet[1] = signal.lfilter(b_hp, a_hp, master_wet[1])
    
    # Air brilliance sheen
    b_hs, a_hs = signal.butter(1, 11000.0 / nyq, btype='low')
    air = master_wet - signal.lfilter(b_hs, a_hs, master_wet)
    master_wet += air * 0.15
    
    # Master peak normalization to -0.6 dBTP (0.83)
    peak_val = np.max(np.abs(master_wet))
    print(f"Pre-master peak for '{base_name}': {peak_val:.4f}")
    target_peak = 0.83
    if peak_val > 0:
        master_wet = (master_wet / peak_val) * target_peak
    master_wet = np.tanh(master_wet * 1.05) / np.tanh(1.05)
    
    wav_path = os.path.join(out_dir, f"{base_name}.wav")
    int16_stereo = np.clip(master_wet * 32767.0, -32768, 32767).astype(np.int16)
    interleaved = np.empty((total_samples * 2,), dtype=np.int16)
    interleaved[0::2] = int16_stereo[0]
    interleaved[1::2] = int16_stereo[1]
    
    with open(wav_path, 'wb') as f:
        f.write(b'RIFF')
        data_size = total_samples * 4
        f.write(struct.pack('<I', 36 + data_size))
        f.write(b'WAVEfmt ')
        f.write(struct.pack('<IHHIIHH', 16, 1, 2, SAMPLE_RATE, SAMPLE_RATE * 4, 4, 16))
        f.write(b'data')
        f.write(struct.pack('<I', data_size))
        f.write(interleaved.tobytes())
        
    ogg_path = os.path.join(out_dir, f"{base_name}.ogg")
    mp3_path = os.path.join(out_dir, f"{base_name}.mp3")
    
    print(f"Encoding OGG Vorbis (Quality 6, 48kHz) -> {ogg_path}")
    subprocess.run([
        'ffmpeg', '-y', '-i', wav_path,
        '-c:a', 'libvorbis', '-qscale:a', '6',
        '-metadata', f'title={title}',
        '-metadata', 'artist=Joe Hisaishi / Wind Glider Philharmonic',
        '-metadata', 'album=Wind Glider: Master Climax OST',
        ogg_path
    ], check=True)
    
    print(f"Encoding MP3 (VBR V0, 48kHz) -> {mp3_path}")
    subprocess.run([
        'ffmpeg', '-y', '-i', wav_path,
        '-c:a', 'libmp3lame', '-qscale:a', '0',
        '-metadata', f'title={title}',
        '-metadata', 'artist=Joe Hisaishi / Wind Glider Philharmonic',
        '-metadata', 'album=Wind Glider: Master Climax OST',
        mp3_path
    ], check=True)
    
    if os.path.exists(wav_path):
        os.remove(wav_path)
        
    print(f"Done '{base_name}': OGG={os.path.getsize(ogg_path)} bytes, MP3={os.path.getsize(mp3_path)} bytes\n")


# ===================== TRACK 1: AZURE CLIMAX =====================
def generate_azure_climax():
    bpm = 124.0
    beat_dur = 60.0 / bpm
    meas_dur = beat_dur * 4.0
    total_meas = 48
    total_sec = total_meas * meas_dur  # ~92.9s
    total_samp = int(total_sec * SAMPLE_RATE)
    
    print(f"Generating Track 1: Azure Climax ({total_sec:.2f}s, {bpm} BPM)...")
    buf = np.zeros((2, total_samp), dtype=np.float32)
    
    def add(clip, sec):
        s = int(sec * SAMPLE_RATE)
        if s >= total_samp: return
        e = min(total_samp, s + clip.shape[1])
        buf[:, s:e] += clip[:, :e - s]

    # Chord progressions in G Maj / E Min / C Maj / D Lydian
    chords = [
        [note('G', 3), note('B', 3), note('D', 4), note('G', 4)],
        [note('D', 3), note('F#', 3), note('A', 3), note('D', 4)],
        [note('E', 3), note('G', 3), note('B', 3), note('E', 4)],
        [note('C', 3), note('E', 3), note('G', 3), note('C', 4)],
    ]
    
    # 1. Acoustic guitar / Celtic harp ostinato
    for m in range(total_meas):
        ch = chords[m % 4]
        m_start = m * meas_dur
        for step in range(8):
            t = m_start + step * (beat_dur / 2.0)
            p = ch[step % 4]
            add(synth_acoustic_guitar_pluck(p, 0.45, 0.72, pan=-0.35), t)
            if step % 2 == 0:
                add(synth_celesta_bell(p * 2, 0.35, 0.45, pan=0.4), t)

    # 2. Lush String Pads
    for m in range(total_meas):
        ch = chords[m % 4]
        m_start = m * meas_dur
        pad_notes = [ch[0] * 0.5, ch[1], ch[2], ch[3]]
        add(synth_warm_string_pad(pad_notes, meas_dur + 0.3, velocity=0.68, pan=0.1), m_start)

    # 3. Flute Main Soaring Melodies
    melody_a = [
        ('D', 5, 1.0), ('G', 5, 1.5), ('A', 5, 0.5), ('B', 5, 1.0),
        ('A', 5, 1.0), ('G', 5, 1.0), ('E', 5, 1.5), ('D', 5, 0.5),
        ('E', 5, 1.0), ('G', 5, 1.0), ('A', 5, 2.0),
        ('B', 5, 1.5), ('C', 6, 0.5), ('B', 5, 1.0), ('A', 5, 1.0),
    ]
    melody_b = [
        ('B', 5, 1.0), ('D', 6, 1.5), ('C', 6, 0.5), ('B', 5, 1.0),
        ('A', 5, 1.0), ('B', 5, 1.0), ('G', 5, 2.0),
        ('E', 5, 1.0), ('G', 5, 1.0), ('A', 5, 1.0), ('B', 5, 1.0),
        ('D', 6, 2.0), ('G', 5, 2.0),
    ]
    
    for section, start_m in [(melody_a, 4), (melody_b, 12), (melody_a, 20), (melody_b, 28), (melody_a, 36)]:
        t = start_m * meas_dur
        for name, octv, dur_beats in section:
            dur_sec = dur_beats * beat_dur
            f = note(name, octv)
            add(synth_irish_flute_note(f, dur_sec + 0.08, velocity=0.88, pan=0.0), t)
            add(synth_french_horn_note(f * 0.5, dur_sec + 0.1, velocity=0.55, pan=-0.25), t)
            t += dur_sec

    # 4. Bodhran / Percussion Rhythm
    for m in range(total_meas):
        m_start = m * meas_dur
        add(synth_bodhran_drum(0.4, velocity=0.88, pan=0.0), m_start)
        add(synth_bodhran_drum(0.35, velocity=0.72, pan=0.0), m_start + 2.0 * beat_dur)
        for b in range(4):
            add(synth_breeze_shaker(0.18, velocity=0.45, pan=0.3), m_start + b * beat_dur + beat_dur * 0.5)
        if m % 4 == 3:
            add(synth_timpani_hit(note('G', 2), 0.8, velocity=0.9, pan=-0.1), m_start + 3.0 * beat_dur)
            add(synth_cymbal_crash(1.2, velocity=0.6, pan=0.2), m_start + 3.0 * beat_dur)

    render_and_export(buf, total_samp, "bgm-azure-climax", "Flight Over Azure Waters · Climax (晴空碧海之翼 · 决战狂潮)")
    
    # Also save as wind-glider-theme for backwards compatibility
    render_and_export(buf, total_samp, "wind-glider-theme", "Flight Over Azure Waters (晴空碧海之翼)")


# ===================== TRACK 2: LAPUTA CLIMAX =====================
def generate_laputa_climax():
    bpm = 132.0
    beat_dur = 60.0 / bpm
    meas_dur = beat_dur * 4.0
    total_meas = 48
    total_sec = total_meas * meas_dur  # ~87.27s
    total_samp = int(total_sec * SAMPLE_RATE)
    
    print(f"Generating Track 2: Laputa Climax ({total_sec:.2f}s, {bpm} BPM)...")
    buf = np.zeros((2, total_samp), dtype=np.float32)
    
    def add(clip, sec):
        s = int(sec * SAMPLE_RATE)
        if s >= total_samp: return
        e = min(total_samp, s + clip.shape[1])
        buf[:, s:e] += clip[:, :e - s]

    # Minor / Epic heroic progression (A minor, F major, G major, E minor / C major, D minor)
    laputa_chords = [
        [note('A', 2), note('C', 4), note('E', 4), note('A', 4)],
        [note('F', 2), note('A', 3), note('C', 4), note('F', 4)],
        [note('G', 2), note('B', 3), note('D', 4), note('G', 4)],
        [note('E', 2), note('G', 3), note('B', 3), note('E', 4)],
        [note('D', 2), note('F', 3), note('A', 3), note('D', 4)],
        [note('E', 2), note('G#', 3), note('B', 3), note('E', 4)],
    ]
    
    # 1. Driving Staccato Strings (16th note Ostinato)
    for m in range(total_meas):
        ch = laputa_chords[m % len(laputa_chords)]
        m_start = m * meas_dur
        for step in range(8):
            t = m_start + step * (beat_dur / 2.0)
            p = ch[1 + (step % 3)]
            add(synth_string_staccato(p, 0.22, velocity=0.82, pan=-0.25), t)
            add(synth_string_staccato(ch[0], 0.25, velocity=0.75, pan=0.25), t)

    # 2. Warm String Chords
    for m in range(total_meas):
        ch = laputa_chords[m % len(laputa_chords)]
        m_start = m * meas_dur
        pad_notes = [ch[0], ch[1], ch[2], ch[3]]
        add(synth_warm_string_pad(pad_notes, meas_dur + 0.2, velocity=0.65, pan=0.0), m_start)

    # 3. Heroic Laputa Soaring Brass & Flute Melody
    laputa_melody_a = [
        ('E', 5, 1.0), ('A', 5, 1.5), ('B', 5, 0.5), ('C', 6, 1.0),
        ('B', 5, 1.0), ('A', 5, 1.0), ('G', 5, 1.0), ('E', 5, 1.0),
        ('F', 5, 1.5), ('G', 5, 0.5), ('A', 5, 1.0), ('F', 5, 1.0),
        ('E', 5, 2.0), ('E', 5, 2.0),
    ]
    laputa_melody_b = [
        ('C', 6, 1.0), ('B', 5, 0.5), ('A', 5, 0.5), ('B', 5, 1.0), ('E', 5, 1.0),
        ('A', 5, 1.5), ('B', 5, 0.5), ('C', 6, 1.0), ('D', 6, 1.0),
        ('E', 6, 1.5), ('D', 6, 0.5), ('C', 6, 1.0), ('B', 5, 1.0),
        ('A', 5, 3.0), ('A', 5, 1.0),
    ]

    for section, start_m in [(laputa_melody_a, 4), (laputa_melody_b, 12), (laputa_melody_a, 20), (laputa_melody_b, 28), (laputa_melody_b, 36)]:
        t = start_m * meas_dur
        for name, octv, dur_beats in section:
            dur_sec = dur_beats * beat_dur
            f = note(name, octv)
            add(synth_french_horn_note(f, dur_sec + 0.1, velocity=0.92, pan=-0.2), t)
            add(synth_irish_flute_note(f, dur_sec + 0.06, velocity=0.75, pan=0.2), t)
            add(synth_celesta_bell(f * 2, dur_sec * 0.5, velocity=0.5, pan=0.35), t)
            t += dur_sec

    # 4. Powerful Timpani & Driving Orchestral Percussion
    for m in range(total_meas):
        m_start = m * meas_dur
        add(synth_timpani_hit(note('A', 1), 0.6, velocity=0.95, pan=-0.15), m_start)
        add(synth_timpani_hit(note('E', 2), 0.5, velocity=0.85, pan=0.15), m_start + 2.0 * beat_dur)
        if m % 4 == 3:
            add(synth_timpani_hit(note('A', 1), 0.8, velocity=1.0, pan=0.0), m_start + 3.0 * beat_dur)
            add(synth_cymbal_crash(1.4, velocity=0.75, pan=0.2), m_start + 3.0 * beat_dur)
        for b in range(4):
            add(synth_breeze_shaker(0.15, velocity=0.5, pan=0.3), m_start + b * beat_dur)

    render_and_export(buf, total_samp, "bgm-laputa-climax", "Castle in the Sky · Storm Vault Climax (天空之城 · 狂风龙卷之跃)")


# ===================== TRACK 3: PORCO ROSSO CLIMAX =====================
def generate_porco_climax():
    bpm = 128.0
    beat_dur = 60.0 / bpm
    meas_dur = beat_dur * 4.0
    total_meas = 48
    total_sec = total_meas * meas_dur  # ~90.0s
    total_samp = int(total_sec * SAMPLE_RATE)
    
    print(f"Generating Track 3: Porco Rosso Climax ({total_sec:.2f}s, {bpm} BPM)...")
    buf = np.zeros((2, total_samp), dtype=np.float32)
    
    def add(clip, sec):
        s = int(sec * SAMPLE_RATE)
        if s >= total_samp: return
        e = min(total_samp, s + clip.shape[1])
        buf[:, s:e] += clip[:, :e - s]

    # Porco Rosso / Mediterranean Jazz-Orchestral progression (F Maj, D min, Bb Maj, C7, A min, D7, G min, C7)
    porco_chords = [
        [note('F', 3), note('A', 3), note('C', 4), note('F', 4)],
        [note('D', 3), note('F', 3), note('A', 3), note('D', 4)],
        [note('A#', 2), note('D', 3), note('F', 3), note('A#', 3)],
        [note('C', 3), note('E', 3), note('G', 3), note('A#', 3)],
        [note('A', 2), note('C', 3), note('E', 3), note('A', 3)],
        [note('D', 3), note('F#', 3), note('A', 3), note('C', 4)],
        [note('G', 2), note('A#', 2), note('D', 3), note('G', 3)],
        [note('C', 3), note('E', 3), note('G', 3), note('C', 4)],
    ]
    
    # 1. Mediterranean Accordion & Strummed Guitar Chords
    for m in range(total_meas):
        ch = porco_chords[m % len(porco_chords)]
        m_start = m * meas_dur
        add(synth_accordion_chord([ch[1], ch[2], ch[3]], meas_dur + 0.1, velocity=0.72, pan=-0.25), m_start)
        # Upbeat swing guitar strums on beats 2 and 4
        add(synth_acoustic_guitar_pluck(ch[2], 0.3, velocity=0.7, pan=0.3), m_start + beat_dur)
        add(synth_acoustic_guitar_pluck(ch[3], 0.3, velocity=0.75, pan=0.3), m_start + 3.0 * beat_dur)

    # 2. Warm String Section
    for m in range(total_meas):
        ch = porco_chords[m % len(porco_chords)]
        m_start = m * meas_dur
        add(synth_warm_string_pad([ch[0], ch[1], ch[2]], meas_dur + 0.2, velocity=0.6, pan=0.1), m_start)

    # 3. Spirited Romantic Porco Rosso Trumpet/Horn & Flute Melodies
    porco_melody_a = [
        ('C', 5, 0.5), ('D', 5, 0.5), ('F', 5, 1.5), ('G', 5, 0.5), ('A', 5, 1.0),
        ('C', 6, 1.5), ('A', 5, 0.5), ('F', 5, 1.0), ('D', 5, 1.0),
        ('G', 5, 1.5), ('F', 5, 0.5), ('D', 5, 1.0), ('C', 5, 1.0),
        ('F', 5, 2.0), ('F', 5, 2.0),
    ]
    porco_melody_b = [
        ('A', 5, 1.0), ('C', 6, 1.0), ('D', 6, 1.5), ('C', 6, 0.5),
        ('A', 5, 1.0), ('F', 5, 1.0), ('G', 5, 1.5), ('A', 5, 0.5),
        ('A#', 5, 1.0), ('A', 5, 1.0), ('G', 5, 1.0), ('E', 5, 1.0),
        ('F', 5, 3.0), ('F', 5, 1.0),
    ]

    for section, start_m in [(porco_melody_a, 4), (porco_melody_b, 12), (porco_melody_a, 20), (porco_melody_b, 28), (porco_melody_b, 36)]:
        t = start_m * meas_dur
        for name, octv, dur_beats in section:
            dur_sec = dur_beats * beat_dur
            f = note(name, octv)
            add(synth_french_horn_note(f, dur_sec + 0.08, velocity=0.9, pan=0.15), t)
            add(synth_irish_flute_note(f * 2, dur_sec + 0.05, velocity=0.7, pan=-0.2), t)
            t += dur_sec

    # 4. Upbeat Swing Bodhran / Jazz-style rhythm
    for m in range(total_meas):
        m_start = m * meas_dur
        add(synth_bodhran_drum(0.35, velocity=0.85, pan=-0.1), m_start)
        add(synth_bodhran_drum(0.3, velocity=0.8, pan=-0.1), m_start + 2.0 * beat_dur)
        for b in range(4):
            add(synth_breeze_shaker(0.16, velocity=0.45, pan=0.25), m_start + b * beat_dur + 0.25 * beat_dur)
        if m % 4 == 3:
            add(synth_cymbal_crash(1.2, velocity=0.6, pan=0.3), m_start + 3.0 * beat_dur)

    render_and_export(buf, total_samp, "bgm-porco-climax", "Porco Rosso · Adriatic Rhapsody (红猪 · 亚得里亚海狂想曲)")


if __name__ == "__main__":
    generate_azure_climax()
    generate_laputa_climax()
    generate_porco_climax()
    print("ALL 3 CLIMAX TRACKS GENERATED SUCCESSFULLY!")
