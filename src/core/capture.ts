import machoMedalUrl from '../assets/achievements/macho-medal.webp';

export interface CaptureCard {
  kind: 'medal' | 'finale';
  title: string;
  kicker: string;
  lines: readonly string[];
  /** Optional transparent celebration layer, composited over the live frame. */
  overlayCanvas?: HTMLCanvasElement;
}

export class CaptureService {
  private readonly medal = new Image();

  constructor(private readonly source: HTMLCanvasElement) {
    this.medal.decoding = 'async';
    this.medal.src = machoMedalUrl;
  }

  async create(card: CaptureCard): Promise<Blob> {
    const width = Math.max(960, Math.min(1920, this.source.width));
    const height = Math.round(width * this.source.height / Math.max(1, this.source.width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Capture canvas is unavailable');

    // Copy the rendered WebGL frame synchronously while its backbuffer is valid.
    ctx.drawImage(this.source, 0, 0, width, height);
    if (card.kind === 'medal') {
      ctx.fillStyle = 'rgba(4, 7, 24, 0.36)';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(8, 13, 42, 0.9)';
      ctx.fillRect(width * 0.08, height * 0.12, width * 0.84, height * 0.76);
      ctx.strokeStyle = '#ffcf4a';
      ctx.lineWidth = Math.max(5, width / 220);
      ctx.strokeRect(width * 0.08, height * 0.12, width * 0.84, height * 0.76);
    } else {
      ctx.fillStyle = 'rgba(4, 7, 24, 0.12)';
      ctx.fillRect(0, 0, width, height);
      const vignette = ctx.createRadialGradient(width * .5, height * .42, 0, width * .5, height * .42, width * .72);
      vignette.addColorStop(0, 'rgba(255, 207, 74, .06)');
      vignette.addColorStop(1, 'rgba(4, 7, 24, .26)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, width, height);
      if (card.overlayCanvas) ctx.drawImage(card.overlayCanvas, 0, 0, width, height);
    }

    if (card.kind === 'medal') {
      try {
        if (!this.medal.complete) await this.medal.decode();
        const artH = height * 0.43;
        const artW = artH * (this.medal.naturalWidth / Math.max(1, this.medal.naturalHeight));
        ctx.drawImage(this.medal, (width - artW) / 2, height * 0.14, artW, artH);
      } catch {
        // The text card remains a valid screenshot if the decorative asset fails.
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = card.kind === 'medal' ? '#55e7ff' : '#ffcf4a';
    ctx.font = `900 ${Math.round(width * 0.019)}px Arial, sans-serif`;
    ctx.fillText(card.kicker, width / 2, height * (card.kind === 'medal' ? 0.59 : 0.3));
    ctx.fillStyle = '#f4feff';
    ctx.font = `900 ${Math.round(width * 0.064)}px Arial Black, Arial, sans-serif`;
    ctx.fillText(card.title, width / 2, height * (card.kind === 'medal' ? 0.68 : 0.46));
    ctx.font = `800 ${Math.round(width * 0.021)}px Arial, sans-serif`;
    card.lines.forEach((line, index) => {
      ctx.fillStyle = index === 0 ? '#39ff88' : '#f4feff';
      ctx.fillText(line, width / 2, height * (card.kind === 'medal' ? 0.78 : 0.6) + index * width * 0.032);
    });
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png');
    });
  }

  async saveOrShare(blob: Blob, filename: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
    const file = new File([blob], filename, { type: 'image/png' });
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: 'Board Race' });
        return 'shared';
      } catch (error) {
        if ((error as DOMException).name !== 'AbortError') throw error;
        return 'cancelled';
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'downloaded';
  }
}
