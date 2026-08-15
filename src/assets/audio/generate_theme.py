#!/usr/bin/env python3
"""
Wind Glider (风之翼：晴空滑翔竞速) - Main Theme Generator
"Flight Over Azure Waters" (晴空碧海之翼)
Acoustic Celtic/Ghibli style orchestral score composed and synthesized with high-precision vectorized DSP.
"""

import math
import os
import struct
import subprocess
import numpy as np
from scipy import signal

SAMPLE_RATE = 48000
BPM = 124.0
BEAT_DUR = 60.0 / BPM  # ~0.48387s
MEASURE_DUR = BEAT_DUR * 4.0  # ~1.93548s
TOTAL_MEASURES = 48
TOTAL_SECONDS = TOTAL_MEASURES * MEASURE_DUR  # ~92.903s
TOTAL_SAMPLES = int(TOTAL_SECONDS * SAMPLE_RATE)

print(f"Generating Wind Glider OST: {TOTAL_MEASURES} measures, {TOTAL_SECONDS:.2f}s, {SAMPLE_RATE}Hz")

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
        
    def process(self, stereo_audio: np.ndarray, wet=0.24, decay_sec=2.0) -> np.ndarray:
        impulse_len = int(decay_sec * self.sr)
        t_ir = np.linspace(0, decay_sec, impulse_len, endpoint=False)
        decay_curve = np.exp(-t_ir * (3.2 / decay_sec))
        
        # Stereo impulse response with natural early reflections & warm diffusion
        np.random.seed(42)  # Deterministic seed for reproducible builds
        ir_left = np.random.normal(0, 1.0, impulse_len) * decay_curve
        ir_right = np.random.normal(0, 1.0, impulse_len) * decay_curve
        
        # Lowpass filter on impulse response for warm natural room absorption
        nyq = self.sr / 2.0
        b_ir, a_ir = signal.butter(2, 4500.0 / nyq, btype='low')
        ir_left = signal.lfilter(b_ir, a_ir, ir_left)
        ir_right = signal.lfilter(b_ir, a_ir, ir_right)
        
        # Normalize IR energy
        ir_left /= np.sqrt(np.sum(ir_left ** 2) + 1e-8)
        ir_right /= np.sqrt(np.sum(ir_right ** 2) + 1e-8)
        
        rev_left = signal.fftconvolve(stereo_audio[0], ir_left, mode='full')[:stereo_audio.shape[1]]
        rev_right = signal.fftconvolve(stereo_audio[1], ir_right, mode='full')[:stereo_audio.shape[1]]
        
        out = np.zeros_like(stereo_audio)
        out[0] = (1.0 - wet) * stereo_audio[0] + wet * rev_left
        out[1] = (1.0 - wet) * stereo_audio[1] + wet * rev_right
        return out


def synth_acoustic_guitar_pluck(freq: float, duration: float, velocity=0.8, pan=0.0) -> np.ndarray:
    """Vectorized rich acoustic plucked string synthesis (Karplus-decay harmonics)."""
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    
    # Plucked string harmonic spectrum with frequency-dependent decay rates
    harmonics = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    weights = [1.0, 0.65, 0.38, 0.22, 0.12, 0.06]
    decay_rates = [2.2, 3.4, 4.8, 6.5, 8.5, 11.0]
    
    tone = np.zeros(num_samples, dtype=np.float32)
    for h, w, d in zip(harmonics, weights, decay_rates):
        h_freq = freq * h
        if h_freq < (SAMPLE_RATE / 2.0) - 200.0:
            env = np.exp(-t * (d + freq * 0.0035))
            tone += np.sin(2.0 * np.pi * h_freq * t) * w * env
            
    # Initial woody pluck transient
    noise_att = np.random.normal(0, 0.25, num_samples) * np.exp(-t / 0.015)
    nyq = SAMPLE_RATE / 2.0
    b_thump, a_thump = signal.butter(2, [80.0 / nyq, 2400.0 / nyq], btype='band')
    pluck_thump = signal.lfilter(b_thump, a_thump, noise_att)
    
    out = (tone * 0.85 + pluck_thump * 0.35) * velocity * 0.55
    
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([out * left_gain, out * right_gain])


def synth_irish_flute_note(freq: float, duration: float, velocity=0.8, pan=0.0, vibrato_delay=0.14) -> np.ndarray:
    """Physical/additive model of Irish Tin Whistle / Bamboo Flute."""
    num_samples = int(duration * SAMPLE_RATE)
    t = np.linspace(0, duration, num_samples, endpoint=False)
    
    # Vibrato LFO: starts after vibrato_delay, 5.6 Hz, ~1.4% pitch modulation
    vibrato_env = np.clip((t - vibrato_delay) / 0.22, 0.0, 1.0)
    vibrato = np.sin(2.0 * np.pi * 5.6 * t) * (freq * 0.014) * vibrato_env
    instant_freq = freq + vibrato
    phase = 2.0 * np.pi * np.cumsum(instant_freq) / SAMPLE_RATE
    
    # Harmonic spectrum of wooden whistle
    h1 = np.sin(phase) * 1.0
    h2 = np.sin(phase * 2.0 + 0.3) * 0.45
    h3 = np.sin(phase * 3.0 + 0.7) * 0.24
    h4 = np.sin(phase * 4.0 + 1.1) * 0.09
    tone = h1 + h2 + h3 + h4
    
    # Air breath turbulence
    raw_noise = np.random.normal(0, 0.12, num_samples)
    nyq = SAMPLE_RATE / 2.0
    low_cut = max(100.0, freq * 0.8) / nyq
    high_cut = min(nyq - 100.0, freq * 2.5) / nyq
    b_breath, a_breath = signal.butter(2, [low_cut, high_cut], btype='band')
    breath_noise = signal.lfilter(b_breath, a_breath, raw_noise) * 0.16
    
    # Attack transient
    attack_chuff = np.exp(-t / 0.02) * np.random.normal(0, 0.25, num_samples)
    
    combined = tone * 0.85 + breath_noise + attack_chuff
    
    # Expression envelope
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
    """Lush acoustic string ensemble (Violins/Viola/Cello formant modeled)."""
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
    b_lp, a_lp = signal.butter(3, min(nyq - 200, 3200) / nyq, btype='low')
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
        
    out_mono = out_mono * env * velocity * 0.42
    
    left_gain = math.cos((pan + 1) * math.pi / 4)
    right_gain = math.sin((pan + 1) * math.pi / 4)
    return np.vstack([out_mono * left_gain, out_mono * right_gain])


def synth_celesta_bell(freq: float, duration: float, velocity=0.6, pan=0.0) -> np.ndarray:
    """Sparkling crystal bell / celesta chime."""
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
    """Deep warm acoustic Irish Bodhran bass drum."""
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


def synth_breeze_shaker(duration: float, velocity=0.5, pan=0.0) -> np.ndarray:
    """Soft natural seed shaker / wind rustle rhythm."""
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


master_stereo = np.zeros((2, TOTAL_SAMPLES), dtype=np.float32)

def add_audio(clip: np.ndarray, start_sec: float):
    start_samp = int(start_sec * SAMPLE_RATE)
    if start_samp >= TOTAL_SAMPLES:
        return
    clip_len = clip.shape[1]
    end_samp = min(TOTAL_SAMPLES, start_samp + clip_len)
    actual_len = end_samp - start_samp
    master_stereo[:, start_samp:end_samp] += clip[:, :actual_len]

# Chord definitions
CHORDS = {
    'G': [note('G', 2), note('D', 3), note('G', 3), note('B', 3), note('D', 4), note('G', 4)],
    'G_high': [note('G', 3), note('B', 3), note('D', 4), note('G', 4), note('B', 4)],
    'Em': [note('E', 2), note('B', 2), note('E', 3), note('G', 3), note('B', 3), note('E', 4)],
    'Em7': [note('E', 2), note('B', 2), note('D', 3), note('G', 3), note('B', 3), note('D', 4)],
    'C': [note('C', 2), note('G', 2), note('C', 3), note('E', 3), note('G', 3), note('C', 4)],
    'Cmaj7': [note('C', 2), note('G', 2), note('E', 3), note('G', 3), note('B', 3), note('E', 4)],
    'D': [note('D', 2), note('A', 2), note('D', 3), note('F#', 3), note('A', 3), note('D', 4)],
    'Dadd9': [note('D', 2), note('A', 2), note('E', 3), note('F#', 3), note('A', 3), note('E', 4)],
    'Dsus4': [note('D', 2), note('A', 2), note('D', 3), note('G', 3), note('A', 3), note('D', 4)],
    'D/F#': [note('F#', 2), note('A', 2), note('D', 3), note('F#', 3), note('A', 3), note('D', 4)],
    'G/B': [note('B', 2), note('D', 3), note('G', 3), note('B', 3), note('D', 4), note('G', 4)],
    'Am7': [note('A', 2), note('E', 3), note('G', 3), note('C', 4), note('E', 4)],
    'Bm7': [note('B', 2), note('F#', 3), note('A', 3), note('D', 4), note('F#', 4)],
    'Esus4': [note('E', 2), note('B', 2), note('E', 3), note('A', 3), note('B', 3)],
    'E': [note('E', 2), note('B', 2), note('E', 3), note('G#', 3), note('B', 3)],
    'Fmaj7': [note('F', 2), note('C', 3), note('E', 3), note('A', 3), note('C', 4)],
    'C/E': [note('E', 2), note('G', 2), note('C', 3), note('E', 3), note('G', 3)],
}

MEASURE_CHORDS = [
    # Intro (1-8)
    'G', 'Em7', 'Cmaj7', 'Dadd9',
    'G', 'Em7', 'Am7', 'D',
    # Section A (9-24) - Soaring Sky
    'G', 'D/F#', 'Em7', 'Bm7',
    'Cmaj7', 'G/B', 'Am7', 'D',
    'G', 'D/F#', 'Em7', 'Bm7',
    'Cmaj7', 'Am7', 'Dsus4', 'D',
    # Section B (25-40) - Ocean Glider & Uplifting Winds
    'Em', 'Cmaj7', 'D', 'G',
    'Em', 'Am7', 'Bm7', 'E',
    'Cmaj7', 'D', 'Bm7', 'Em7',
    'Am7', 'Bm7', 'Cmaj7', 'Dsus4',
    # Section C / Outro Transition (41-48) - Golden Hour Horizon Loop
    'G', 'Em7', 'Cmaj7', 'Bm7',
    'Am7', 'G/B', 'Cmaj7', 'Dadd9',
]

print("Rendering Acoustic Guitar / Harp fingerpicking arpeggios...")
for m_idx, chord_name in enumerate(MEASURE_CHORDS):
    chord_notes = CHORDS[chord_name]
    m_start = m_idx * MEASURE_DUR
    pattern = [0, 1, 2, 4, 3, 2, 4, 1] if len(chord_notes) >= 5 else [0, 1, 2, 3, 2, 1, 2, 3]
    for step, p_idx in enumerate(pattern):
        note_freq = chord_notes[p_idx % len(chord_notes)]
        step_time = m_start + step * (BEAT_DUR / 2.0)
        pan = -0.35 + (step % 4) * 0.18
        vel = 0.85 if step == 0 else 0.65 if step % 2 == 0 else 0.52
        dur = BEAT_DUR * 1.8
        clip = synth_acoustic_guitar_pluck(note_freq, dur, velocity=vel, pan=pan)
        add_audio(clip, step_time)

print("Rendering Warm String Ensemble / Cellos & Violins Pad...")
for m_idx, chord_name in enumerate(MEASURE_CHORDS):
    chord_notes = CHORDS[chord_name]
    m_start = m_idx * MEASURE_DUR
    string_voices = [chord_notes[0]] + chord_notes[-3:]
    
    if m_idx < 8:
        vel = 0.45
    elif m_idx < 24:
        vel = 0.65
    elif m_idx < 40:
        vel = 0.82
    else:
        vel = 0.55
        
    dur = MEASURE_DUR * 1.05
    clip = synth_warm_string_pad(string_voices, dur, velocity=vel, pan=0.0)
    add_audio(clip, m_start)

print("Rendering Celesta & Sparkling Wind Chime accents...")
chime_events = [
    (0, 0, 'G', 5, -0.4), (0, 2, 'B', 5, 0.4), (1, 0, 'E', 5, -0.2), (2, 0, 'G', 5, 0.3),
    (4, 0, 'G', 5, -0.4), (4, 2, 'D', 6, 0.5), (6, 0, 'E', 6, -0.3), (7, 2, 'D', 6, 0.3),
    (8, 0, 'B', 5, -0.5), (10, 0, 'G', 5, 0.4), (12, 0, 'E', 5, -0.3), (14, 0, 'A', 5, 0.3),
    (16, 0, 'B', 5, -0.4), (18, 0, 'D', 6, 0.4), (20, 0, 'E', 6, -0.5), (22, 2, 'F#', 6, 0.5),
    (24, 0, 'G', 6, -0.6), (26, 0, 'F#', 6, 0.6), (28, 0, 'E', 6, -0.4), (30, 0, 'D', 6, 0.4),
    (32, 0, 'C', 6, -0.5), (34, 0, 'B', 5, 0.5), (36, 0, 'A', 5, -0.4), (38, 2, 'D', 6, 0.4),
    (40, 0, 'G', 5, -0.3), (42, 0, 'B', 5, 0.3), (44, 0, 'E', 5, -0.2), (46, 0, 'D', 6, 0.4),
    (47, 2, 'G', 5, 0.0),
]

for m, b, n_name, octv, pan in chime_events:
    freq = note(n_name, octv)
    t_start = m * MEASURE_DUR + b * BEAT_DUR
    clip = synth_celesta_bell(freq, 2.2, velocity=0.75, pan=pan)
    add_audio(clip, t_start)

print("Rendering Celtic Bodhran & Breeze Shakers rhythm...")
for m_idx in range(TOTAL_MEASURES):
    m_start = m_idx * MEASURE_DUR
    if m_idx >= 8:
        clip1 = synth_bodhran_drum(0.5, velocity=0.85 if m_idx >= 24 else 0.7)
        add_audio(clip1, m_start)
        clip3 = synth_bodhran_drum(0.5, velocity=0.75 if m_idx >= 24 else 0.6)
        add_audio(clip3, m_start + 2 * BEAT_DUR)
        if 24 <= m_idx < 40:
            clip_sync = synth_bodhran_drum(0.4, velocity=0.62)
            add_audio(clip_sync, m_start + 3.5 * BEAT_DUR)
            
    if 8 <= m_idx < 46:
        for s16 in range(16):
            shaker_time = m_start + s16 * (BEAT_DUR / 4.0)
            vel = 0.65 if s16 % 4 == 2 else 0.45 if s16 % 2 == 0 else 0.3
            pan = 0.25 if s16 % 2 == 0 else -0.25
            clip_shk = synth_breeze_shaker(0.12, velocity=vel, pan=pan)
            add_audio(clip_shk, shaker_time)

print("Rendering Lyrical Irish Tin Whistle / Bamboo Flute Solo Melody...")
MELODY_NOTES = [
    # Intro Motif
    (4, 0, 'D', 5, 1.5, 0.1), (4, 1.5, 'E', 5, 0.5, 0.1), (4, 2, 'G', 5, 2.0, 0.1),
    (5, 0, 'B', 5, 1.5, 0.15), (5, 1.5, 'A', 5, 0.5, 0.15), (5, 2, 'G', 5, 1.0, 0.15), (5, 3, 'E', 5, 1.0, 0.15),
    (6, 0, 'G', 5, 2.5, 0.1), (6, 2.5, 'A', 5, 1.5, 0.1), (7, 0, 'D', 5, 3.5, 0.1),
    # Section A
    (8, 0, 'D', 5, 1.0, 0.0), (8, 1, 'G', 5, 1.5, 0.0), (8, 2.5, 'A', 5, 0.5, 0.0), (8, 3, 'B', 5, 1.0, 0.0),
    (9, 0, 'A', 5, 2.0, 0.0), (9, 2, 'D', 5, 2.0, 0.0),
    (10, 0, 'E', 5, 1.5, 0.0), (10, 1.5, 'G', 5, 0.5, 0.0), (10, 2, 'B', 5, 1.5, 0.0), (10, 3.5, 'D', 6, 0.5, 0.0),
    (11, 0, 'A', 5, 3.5, 0.0),
    (12, 0, 'C', 6, 1.5, 0.0), (12, 1.5, 'B', 5, 0.5, 0.0), (12, 2, 'A', 5, 1.0, 0.0), (12, 3, 'G', 5, 1.0, 0.0),
    (13, 0, 'B', 5, 2.0, 0.0), (13, 2, 'D', 5, 2.0, 0.0),
    (14, 0, 'E', 5, 1.5, 0.0), (14, 1.5, 'F#', 5, 0.5, 0.0), (14, 2, 'G', 5, 1.5, 0.0), (14, 3.5, 'A', 5, 0.5, 0.0),
    (15, 0, 'A', 5, 2.0, 0.0), (15, 2, 'D', 5, 2.0, 0.0),
    (16, 0, 'D', 5, 1.0, 0.0), (16, 1, 'G', 5, 1.5, 0.0), (16, 2.5, 'A', 5, 0.5, 0.0), (16, 3, 'B', 5, 1.0, 0.0),
    (17, 0, 'D', 6, 2.0, 0.0), (17, 2, 'B', 5, 2.0, 0.0),
    (18, 0, 'E', 6, 1.5, 0.0), (18, 1.5, 'D', 6, 0.5, 0.0), (18, 2, 'B', 5, 1.5, 0.0), (18, 3.5, 'A', 5, 0.5, 0.0),
    (19, 0, 'G', 5, 3.5, 0.0),
    (20, 0, 'C', 6, 1.5, 0.0), (20, 1.5, 'D', 6, 0.5, 0.0), (20, 2, 'E', 6, 1.0, 0.0), (20, 3, 'D', 6, 1.0, 0.0),
    (21, 0, 'B', 5, 2.0, 0.0), (21, 2, 'G', 5, 2.0, 0.0),
    (22, 0, 'A', 5, 2.5, 0.0), (22, 2.5, 'B', 5, 1.5, 0.0), (23, 0, 'G', 5, 3.5, 0.0),
    # Section B
    (24, 0, 'E', 6, 2.0, 0.05), (24, 2, 'D', 6, 1.0, 0.05), (24, 3, 'B', 5, 1.0, 0.05),
    (25, 0, 'G', 5, 2.0, 0.05), (25, 2, 'A', 5, 1.0, 0.05), (25, 3, 'B', 5, 1.0, 0.05),
    (26, 0, 'D', 6, 1.5, 0.05), (26, 1.5, 'E', 6, 0.5, 0.05), (26, 2, 'F#', 6, 1.5, 0.05), (26, 3.5, 'G', 6, 0.5, 0.05),
    (27, 0, 'E', 6, 3.5, 0.05),
    (28, 0, 'G', 6, 1.5, 0.05), (28, 1.5, 'F#', 6, 0.5, 0.05), (28, 2, 'E', 6, 1.0, 0.05), (28, 3, 'D', 6, 1.0, 0.05),
    (29, 0, 'B', 5, 2.0, 0.05), (29, 2, 'G', 5, 2.0, 0.05),
    (30, 0, 'A', 5, 1.5, 0.05), (30, 1.5, 'B', 5, 0.5, 0.05), (30, 2, 'C', 6, 1.5, 0.05), (30, 3.5, 'D', 6, 0.5, 0.05),
    (31, 0, 'B', 5, 3.5, 0.05),
    (32, 0, 'C', 6, 1.5, 0.05), (32, 1.5, 'D', 6, 0.5, 0.05), (32, 2, 'E', 6, 1.0, 0.05), (32, 3, 'G', 6, 1.0, 0.05),
    (33, 0, 'F#', 6, 2.0, 0.05), (33, 2, 'D', 6, 2.0, 0.05),
    (34, 0, 'E', 6, 1.5, 0.05), (34, 1.5, 'D', 6, 0.5, 0.05), (34, 2, 'B', 5, 1.5, 0.05), (34, 3.5, 'A', 5, 0.5, 0.05),
    (35, 0, 'G', 5, 3.5, 0.05),
    (36, 0, 'A', 5, 1.5, 0.05), (36, 1.5, 'B', 5, 0.5, 0.05), (36, 2, 'C', 6, 1.0, 0.05), (36, 3, 'D', 6, 1.0, 0.05),
    (37, 0, 'B', 5, 2.0, 0.05), (37, 2, 'G', 5, 2.0, 0.05),
    (38, 0, 'A', 5, 2.5, 0.05), (38, 2.5, 'B', 5, 1.5, 0.05), (39, 0, 'A', 5, 3.5, 0.05),
    # Section C / Outro Loop
    (40, 0, 'B', 5, 2.0, 0.0), (40, 2, 'D', 6, 2.0, 0.0),
    (41, 0, 'G', 6, 2.5, 0.0), (41, 2.5, 'E', 6, 1.5, 0.0),
    (42, 0, 'D', 6, 2.0, 0.0), (42, 2, 'B', 5, 2.0, 0.0),
    (43, 0, 'A', 5, 3.5, 0.0),
    (44, 0, 'G', 5, 1.5, 0.0), (44, 1.5, 'A', 5, 0.5, 0.0), (44, 2, 'B', 5, 2.0, 0.0),
    (45, 0, 'D', 6, 2.0, 0.0), (45, 2, 'B', 5, 2.0, 0.0),
    (46, 0, 'A', 5, 2.5, 0.0), (46, 2.5, 'G', 5, 1.5, 0.0), (47, 0, 'G', 5, 3.5, 0.0),
]

for m, b, n_name, octv, dur_beats, pan in MELODY_NOTES:
    freq = note(n_name, octv)
    t_start = m * MEASURE_DUR + b * BEAT_DUR
    dur_sec = dur_beats * BEAT_DUR * 1.02
    clip = synth_irish_flute_note(freq, dur_sec, velocity=0.88, pan=pan)
    add_audio(clip, t_start)

print("Applying Master Acoustic Reverb & Spatial Diffusion...")
reverb = Reverb(sr=SAMPLE_RATE)
master_wet = reverb.process(master_stereo, wet=0.24, decay_sec=2.0)

print("Applying Master EQ, Dynamics Limiter and Headroom Normalization...")
nyq = SAMPLE_RATE / 2.0
b_hp, a_hp = signal.butter(2, 32.0 / nyq, btype='high')
master_wet[0] = signal.lfilter(b_hp, a_hp, master_wet[0])
master_wet[1] = signal.lfilter(b_hp, a_hp, master_wet[1])

b_hs, a_hs = signal.butter(1, 11000.0 / nyq, btype='low')
air = master_wet - signal.lfilter(b_hs, a_hs, master_wet)
master_wet += air * 0.15

peak_val = np.max(np.abs(master_wet))
print(f"Pre-master peak: {peak_val:.4f}")
target_peak = 0.82
if peak_val > 0:
    master_wet = (master_wet / peak_val) * target_peak

master_wet = np.tanh(master_wet * 1.05) / np.tanh(1.05)

out_dir = "/var/www/wind-glider/src/assets/audio"
os.makedirs(out_dir, exist_ok=True)
wav_path = os.path.join(out_dir, "wind-glider-theme.wav")

int16_stereo = np.clip(master_wet * 32767.0, -32768, 32767).astype(np.int16)
interleaved = np.empty((TOTAL_SAMPLES * 2,), dtype=np.int16)
interleaved[0::2] = int16_stereo[0]
interleaved[1::2] = int16_stereo[1]

with open(wav_path, 'wb') as f:
    f.write(b'RIFF')
    data_size = TOTAL_SAMPLES * 4
    f.write(struct.pack('<I', 36 + data_size))
    f.write(b'WAVEfmt ')
    f.write(struct.pack('<IHHIIHH', 16, 1, 2, SAMPLE_RATE, SAMPLE_RATE * 4, 4, 16))
    f.write(b'data')
    f.write(struct.pack('<I', data_size))
    f.write(interleaved.tobytes())

print(f"WAV saved: {wav_path} ({os.path.getsize(wav_path)} bytes)")

ogg_path = os.path.join(out_dir, "wind-glider-theme.ogg")
mp3_path = os.path.join(out_dir, "wind-glider-theme.mp3")

print("Encoding OGG Vorbis (Quality 6, 48kHz)...")
subprocess.run([
    'ffmpeg', '-y', '-i', wav_path,
    '-c:a', 'libvorbis', '-qscale:a', '6',
    '-metadata', 'title=Flight Over Azure Waters (晴空碧海之翼)',
    '-metadata', 'artist=Wind Glider OST Ensemble',
    '-metadata', 'album=Wind Glider: Sky & Sea Gliding',
    '-metadata', 'genre=Ghibli / Celtic Acoustic Folk',
    ogg_path
], check=True)

print("Encoding MP3 (VBR V0, 48kHz)...")
subprocess.run([
    'ffmpeg', '-y', '-i', wav_path,
    '-c:a', 'libmp3lame', '-qscale:a', '0',
    '-metadata', 'title=Flight Over Azure Waters (晴空碧海之翼)',
    '-metadata', 'artist=Wind Glider OST Ensemble',
    '-metadata', 'album=Wind Glider: Sky & Sea Gliding',
    '-metadata', 'genre=Ghibli / Celtic Acoustic Folk',
    mp3_path
], check=True)

if os.path.exists(wav_path):
    os.remove(wav_path)

print(f"Complete! Generated:\n  - {ogg_path} ({os.path.getsize(ogg_path)} bytes)\n  - {mp3_path} ({os.path.getsize(mp3_path)} bytes)")
