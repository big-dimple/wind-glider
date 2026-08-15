import type { AudioSettings, GameAudio } from './audio';
import './mixerControls.css';

const ROWS: ReadonlyArray<{ key: keyof Pick<AudioSettings, 'master' | 'music' | 'sfx' | 'ambience'>; label: string }> = [
  { key: 'master', label: '总音量' },
  { key: 'music', label: '摇滚' },
  { key: 'sfx', label: '音效' },
  { key: 'ambience', label: '环境事件' },
];

export class MixerControls {
  private readonly root: HTMLDivElement;
  private readonly toggle: HTMLButtonElement;
  private readonly mute: HTMLButtonElement;
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly values = new Map<string, HTMLOutputElement>();
  private hapticsButton: HTMLButtonElement | null = null;

  constructor(parent: HTMLElement, private readonly audio: GameAudio) {
    const root = document.createElement('div');
    root.className = 'audio-mixer';
    root.innerHTML = '<button class="audio-mixer-toggle" type="button" aria-label="声音设置">SOUND</button>';
    this.root = root;
    this.toggle = root.querySelector<HTMLButtonElement>('.audio-mixer-toggle')!;
    const panel = document.createElement('div');
    panel.className = 'audio-mixer-panel';
    panel.setAttribute('aria-label', '声音设置');
    root.appendChild(panel);

    const settings = audio.getSettings();
    for (const row of ROWS) {
      const label = document.createElement('label');
      label.className = 'audio-mixer-row';
      const text = document.createElement('span');
      text.textContent = row.label;
      const value = document.createElement('output');
      value.textContent = `${inputPercent(settings[row.key])}%`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.value = String(Math.round(settings[row.key] * 100));
      input.setAttribute('aria-label', row.label);
      let lastPreview = 0;
      const preview = (): void => {
        const now = performance.now();
        if (now - lastPreview < 180) return;
        lastPreview = now;
        audio.audition(row.key);
      };
      input.addEventListener('pointerdown', () => {
        audio.resume();
        preview();
      });
      input.addEventListener('input', () => {
        audio.resume();
        audio.setSettings({ [row.key]: Number(input.value) / 100 });
        value.textContent = `${input.value}%`;
        preview();
      });
      label.append(text, input, value);
      panel.appendChild(label);
      this.inputs.set(row.key, input);
      this.values.set(row.key, value);
    }

    this.mute = document.createElement('button');
    this.mute.className = 'audio-mixer-mute';
    this.mute.type = 'button';
    this.mute.addEventListener('click', () => {
      audio.resume();
      audio.toggleMute();
      this.sync();
    });
    panel.appendChild(this.mute);

    this.toggle.addEventListener('click', () => {
      audio.resume();
      root.classList.toggle('open');
      this.toggle.setAttribute('aria-expanded', String(root.classList.contains('open')));
    });
    this.toggle.setAttribute('aria-expanded', 'false');
    parent.appendChild(root);
    this.sync();
  }

  attachHaptics(getEnabled: () => boolean, setEnabled: (enabled: boolean) => void): void {
    if (this.hapticsButton) return;
    const button = document.createElement('button');
    button.className = 'audio-mixer-haptics';
    button.type = 'button';
    button.addEventListener('click', () => {
      const enabled = !getEnabled();
      setEnabled(enabled);
      this.syncHaptics(enabled);
    });
    this.root.querySelector('.audio-mixer-panel')?.appendChild(button);
    this.hapticsButton = button;
    this.syncHaptics(getEnabled());
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('visible', visible);
    if (!visible) {
      this.root.classList.remove('open');
      this.toggle.setAttribute('aria-expanded', 'false');
    }
  }

  sync(): void {
    const settings = this.audio.getSettings();
    this.mute.textContent = settings.muted ? '开启声音' : '静音';
    this.mute.classList.toggle('muted', settings.muted);
    for (const row of ROWS) {
      const input = this.inputs.get(row.key);
      const value = this.values.get(row.key);
      if (input && document.activeElement !== input) input.value = String(inputPercent(settings[row.key]));
      if (value && document.activeElement !== input) value.textContent = `${inputPercent(settings[row.key])}%`;
    }
  }

  private syncHaptics(enabled: boolean): void {
    if (!this.hapticsButton) return;
    this.hapticsButton.textContent = enabled ? '体感反馈 · 开' : '体感反馈 · 关';
    this.hapticsButton.classList.toggle('off', !enabled);
    this.hapticsButton.setAttribute('aria-pressed', String(enabled));
  }
}

const inputPercent = (value: number): number => Math.round(value * 100);
