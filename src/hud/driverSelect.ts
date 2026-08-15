import type { DriverProfile } from '../game/racers';
import { DRIVER_PROFILES, driverProfile } from '../game/racers';
import './driverSelect.css';

export class DriverSelect {
  readonly root: HTMLDivElement;
  private readonly mobileBackdrop: HTMLImageElement;
  private readonly portrait: HTMLImageElement;
  private readonly portraitIncoming: HTMLImageElement;
  private readonly identity: HTMLDivElement;
  private readonly name: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly mood: HTMLDivElement;
  private readonly quote: HTMLQuoteElement;
  private readonly strength: HTMLDivElement;
  private readonly weakness: HTMLDivElement;
  private readonly specialty: HTMLDivElement;
  private readonly radar: HTMLCanvasElement;
  private readonly radarWrap: HTMLDivElement;
  private readonly radarResizeObserver: ResizeObserver;
  private readonly rosterIndex: HTMLDivElement;
  private readonly controllerStatus: HTMLDivElement;
  private readonly coachButton: HTMLButtonElement;
  private readonly coachPanel: HTMLElement;
  private readonly coachState: HTMLSpanElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly previousLabel: HTMLElement;
  private readonly nextLabel: HTMLElement;
  private readonly cards = new Map<string, HTMLButtonElement>();
  private readonly dots = new Map<string, HTMLButtonElement>();
  private selectedProfile: DriverProfile;
  private readonly parent: HTMLElement;
  private carouselPointerId: number | null = null;
  private carouselStartX = 0;
  private suppressCarouselClick = false;
  private controllerStatusText = '';
  private controllerStatusTitle = '';
  private readonly desktopStageMedia: MediaQueryList;
  private readonly reducedMotionMedia: MediaQueryList;
  private readonly portraitLoads = new Map<string, Promise<void>>();
  private portraitAnimation: Animation | null = null;
  private detailAnimations: Animation[] = [];
  private transitionToken = 0;
  private transitionTimer = 0;
  private radarFrame = 0;
  private radarDisplayValues: number[];

  constructor(
    parent: HTMLElement,
    initialId: string,
    private readonly onSelect: (profile: DriverProfile, index: number, direction: -1 | 1) => void,
    onStart: () => void,
    private readonly onFirstInteraction?: () => void,
    private readonly onCoachToggle: () => void = () => {},
  ) {
    this.selectedProfile = driverProfile(initialId);
    this.radarDisplayValues = handlingValues(this.selectedProfile);
    this.parent = parent;
    this.desktopStageMedia = window.matchMedia('(pointer: fine) and (min-width: 1366px) and (min-height: 768px)');
    this.reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.root = element('div', 'driver-select', parent);
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', '选择晴空滑翔飞行员');
    // Mobile Chrome treats click as the reliable fullscreen user-activation
    // boundary. Pointerdown is still handled by the controls fallback, but
    // the contract selector retries from the actual click gesture.
    this.root.addEventListener('click', () => this.onFirstInteraction?.(), { capture: true });

    this.mobileBackdrop = document.createElement('img');
    this.mobileBackdrop.className = 'driver-mobile-backdrop';
    this.mobileBackdrop.alt = '';
    this.mobileBackdrop.draggable = false;
    this.mobileBackdrop.setAttribute('aria-hidden', 'true');
    this.mobileBackdrop.decoding = 'async';
    this.root.appendChild(this.mobileBackdrop);

    const header = element('div', 'driver-select-header', this.root);
    element('div', 'driver-select-kicker', header, '晴空滑翔竞速 // 选择你的飞行员');
    element('h1', 'driver-select-title', header, '选择你的飞行员');
    element('div', 'driver-select-objective', header, '穿越七道古代石门 · 展翼御风 · 冲向晴空终点站');

    const featured = element('section', 'driver-featured', this.root);
    featured.id = 'driver-featured';
    this.previousButton = element('button', 'driver-switch-control driver-switch-previous', featured);
    this.previousButton.type = 'button';
    this.previousButton.title = '上一位选手';
    this.previousButton.setAttribute('aria-controls', featured.id);
    element('span', 'driver-switch-icon', this.previousButton, '‹');
    this.previousLabel = element('small', 'driver-switch-label', this.previousButton);
    this.previousButton.addEventListener('click', () => this.move(-1));
    this.nextButton = element('button', 'driver-switch-control driver-switch-next', featured);
    this.nextButton.type = 'button';
    this.nextButton.title = '下一位选手';
    this.nextButton.setAttribute('aria-controls', featured.id);
    element('span', 'driver-switch-icon', this.nextButton, '›');
    this.nextLabel = element('small', 'driver-switch-label', this.nextButton);
    this.nextButton.addEventListener('click', () => this.move(1));
    this.rosterIndex = element('div', 'driver-roster-index', featured);
    this.rosterIndex.setAttribute('aria-live', 'polite');
    this.rosterIndex.setAttribute('aria-atomic', 'true');
    const portraitFrame = element('div', 'driver-portrait-frame', featured);
    this.portrait = document.createElement('img');
    this.portrait.className = 'driver-portrait driver-portrait-primary';
    this.portrait.alt = '';
    this.portrait.draggable = false;
    this.portrait.decoding = 'async';
    portraitFrame.appendChild(this.portrait);
    this.portraitIncoming = document.createElement('img');
    this.portraitIncoming.className = 'driver-portrait driver-portrait-incoming';
    this.portraitIncoming.alt = '';
    this.portraitIncoming.draggable = false;
    this.portraitIncoming.decoding = 'async';
    this.portraitIncoming.setAttribute('aria-hidden', 'true');
    portraitFrame.appendChild(this.portraitIncoming);
    this.mood = element('div', 'driver-mood', portraitFrame);

    this.identity = element('div', 'driver-identity', featured);
    this.specialty = element('div', 'driver-specialty', this.identity);
    this.name = element('div', 'driver-name', this.identity);
    this.meta = element('div', 'driver-meta', this.identity);
    this.quote = document.createElement('blockquote');
    this.quote.className = 'driver-quote';
    this.identity.appendChild(this.quote);
    this.strength = element('div', 'driver-pro driver-trait', this.identity);
    this.weakness = element('div', 'driver-con driver-trait', this.identity);

    this.radarWrap = element('div', 'driver-radar-wrap', featured);
    element('div', 'driver-radar-title', this.radarWrap, '实机性能修正 · 基准 0% · 单项最高 ±6%');
    this.radar = document.createElement('canvas');
    this.radar.className = 'driver-radar';
    this.radar.width = 320;
    this.radar.height = 260;
    this.radarWrap.appendChild(this.radar);
    this.radarResizeObserver = new ResizeObserver(() => {
      if (this.root.classList.contains('on')) this.drawRadar(this.selectedProfile, this.radarDisplayValues);
    });
    // Observe the stable layout container. Watching the canvas itself creates
    // a feedback loop because drawRadar also changes its intrinsic dimensions.
    this.radarResizeObserver.observe(this.radarWrap);

    const carousel = element('div', 'driver-carousel', this.root);
    const rail = element('div', 'driver-rail', carousel);
    for (const profile of DRIVER_PROFILES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'driver-card';
      button.dataset.driver = profile.id;
      button.setAttribute('aria-label', `${profile.name}，${profile.specialty}`);
      const img = document.createElement('img');
      img.src = profile.portraitUrl;
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.style.objectPosition = profile.portraitPosition;
      const decode = typeof img.decode === 'function' ? img.decode().catch(() => undefined) : Promise.resolve();
      this.portraitLoads.set(profile.id, decode);
      button.appendChild(img);
      const copy = element('span', 'driver-card-copy', button);
      element('strong', '', copy, profile.name);
      element('small', '', copy, `${profile.callsign} · ${profile.mood}`);
      button.addEventListener('click', () => {
        if (!this.suppressCarouselClick) this.select(profile.id);
      });
      rail.appendChild(button);
      this.cards.set(profile.id, button);
    }
    const dots = element('div', 'driver-dots', carousel);
    for (const profile of DRIVER_PROFILES) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'driver-dot';
      dot.dataset.driver = profile.id;
      dot.setAttribute('aria-label', `选择 ${profile.name}`);
      dot.addEventListener('click', () => this.select(profile.id));
      dots.appendChild(dot);
      this.dots.set(profile.id, dot);
    }
    carousel.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.pointerType === 'mouse' || this.carouselPointerId !== null) return;
      this.carouselPointerId = event.pointerId;
      this.carouselStartX = event.clientX;
      try { carousel.setPointerCapture?.(event.pointerId); } catch { /* synthetic/test pointers need no capture */ }
    });
    const finishSwipe = (event: PointerEvent) => {
      if (event.pointerId !== this.carouselPointerId) return;
      const delta = event.clientX - this.carouselStartX;
      this.carouselPointerId = null;
      if (Math.abs(delta) < 34) return;
      this.suppressCarouselClick = true;
      this.move(delta < 0 ? 1 : -1);
      window.setTimeout(() => { this.suppressCarouselClick = false; }, 0);
    };
    carousel.addEventListener('pointerup', finishSwipe);
    carousel.addEventListener('pointercancel', () => { this.carouselPointerId = null; });

    const footer = element('div', 'driver-select-footer', this.root);
    this.coachButton = element('button', 'driver-coach-button', footer);
    this.coachButton.type = 'button';
    this.coachButton.title = '驾驶标注与进阶规则';
    this.coachButton.setAttribute('aria-label', '打开驾驶标注与进阶规则');
    this.coachButton.setAttribute('aria-expanded', 'false');
    this.coachButton.textContent = '?';
    this.coachButton.addEventListener('click', () => {
      const open = !this.coachPanel.classList.contains('on');
      this.coachPanel.classList.toggle('on', open);
      this.coachButton.setAttribute('aria-expanded', String(open));
    });
    const go = element('button', 'driver-select-go', footer, 'GO · 签约出发');
    go.type = 'button';
    go.addEventListener('click', onStart);
    this.controllerStatus = element('div', 'driver-controller-status', footer);
    this.controllerStatus.setAttribute('role', 'status');
    this.controllerStatus.setAttribute('aria-live', 'polite');
    this.coachPanel = element('section', 'driver-coach-panel', this.root);
    this.coachPanel.setAttribute('aria-label', '驾驶标注与进阶规则');
    const coachHead = element('div', 'driver-coach-head', this.coachPanel);
    element('strong', '', coachHead, '驾驶标注');
    this.coachState = element('span', '', coachHead) as unknown as HTMLSpanElement;
    element('div', 'driver-coach-row', this.coachPanel, '下一局会在真实控件旁逐项标注；完成动作自动进入下一项，随时可跳过。');
    const advanced = document.createElement('details');
    advanced.className = 'driver-coach-advanced';
    const advancedSummary = document.createElement('summary');
    advancedSummary.textContent = '进阶规则';
    advanced.appendChild(advancedSummary);
    element('div', 'driver-coach-row', advanced, '黄线后松开才存入菱形；继续漂只延长水面 BOOST，基础飞行时间固定。');
    element('div', 'driver-coach-row', advanced, '左条随动作变化，右条是本次飞行剩余；备用菱形可续航 +2.4 秒。');
    element('div', 'driver-coach-row', advanced, '选手雷达会真实改变加速、转向、蓄力和空控，幅度最高 ±6%。');
    this.coachPanel.appendChild(advanced);
    const coachToggle = element('button', 'driver-coach-toggle', this.coachPanel, '开启逐步标注');
    coachToggle.type = 'button';
    coachToggle.addEventListener('click', () => {
      this.onCoachToggle();
      this.coachPanel.classList.remove('on');
      this.coachButton.setAttribute('aria-expanded', 'false');
    });
    window.addEventListener('resize', () => {
      if (!this.root.classList.contains('on')) return;
      this.drawRadar(this.selectedProfile, this.radarDisplayValues);
    });
    this.render();
  }

  setCoachStatus(status: string): void {
    const enabled = status === 'active';
    this.root.dataset.coachStatus = status;
    this.coachButton.classList.toggle('active', enabled);
    this.coachState.textContent = enabled ? '逐步标注已开启' : status === 'expert' ? '已通过三飞认证' : status === 'complete' ? '核心驾驶已掌握' : '逐步标注已关闭';
    const toggle = this.coachPanel.querySelector<HTMLButtonElement>('.driver-coach-toggle');
    if (toggle) toggle.textContent = enabled ? '关闭逐步标注' : '开启逐步标注';
  }

  updateControllerStatus(status: Record<string, number | string | boolean>): void {
    const connected = status.connected === true;
    this.controllerStatus.classList.toggle('on', connected);
    this.controllerStatus.classList.toggle('calibrating', Boolean(status.calibrationStep));
    if (!connected) {
      if (this.controllerStatusText) {
        this.controllerStatus.textContent = '';
        this.controllerStatusText = '';
        this.controllerStatusTitle = '';
      }
      return;
    }
    const count = Number(status.connectedCount) || 1;
    const fullLabel = String(status.id || '游戏手柄').replace(/\s*\([^)]*\)\s*$/, '');
    const label = fullLabel.slice(0, 18);
    const mode = status.mappingSource === 'custom' ? '已校准' : status.mappingSource === 'standard' ? '标准' : '待校准';
    const rumble = status.rumble ? ' · 震动' : '';
    const prompt = String(status.calibrationPrompt || '');
    const text = prompt || `PAD ${Number(status.index) + 1}/${count} · ${label} · ${mode}${rumble}`;
    const title = prompt || `手柄 ${Number(status.index) + 1}/${count} · ${fullLabel} · ${mode}${rumble}`;
    if (text !== this.controllerStatusText) {
      this.controllerStatus.textContent = text;
      this.controllerStatusText = text;
    }
    if (title !== this.controllerStatusTitle) {
      this.controllerStatus.title = title;
      this.controllerStatusTitle = title;
    }
  }

  get selectedId(): string {
    return this.selectedProfile.id;
  }

  show(): void {
    this.clearTransition(true);
    this.parent.classList.add('driver-select-active');
    this.root.classList.add('on');
    this.radarDisplayValues = handlingValues(this.selectedProfile);
    this.drawRadar(this.selectedProfile);
    requestAnimationFrame(() => {
      if (this.root.classList.contains('on')) this.drawRadar(this.selectedProfile);
    });
  }

  hide(): void {
    this.clearTransition(true);
    this.parent.classList.remove('driver-select-active');
    this.root.classList.remove('on');
  }

  select(id: string, notify = true, direction?: -1 | 1): void {
    const next = driverProfile(id);
    if (next.id === this.selectedProfile.id) return;
    const previous = this.selectedProfile;
    const previousIndex = DRIVER_PROFILES.findIndex((profile) => profile.id === this.selectedProfile.id);
    const nextIndex = DRIVER_PROFILES.findIndex((profile) => profile.id === next.id);
    const forward = (nextIndex - previousIndex + DRIVER_PROFILES.length) % DRIVER_PROFILES.length;
    const switchDirection = direction ?? (forward > 0 && forward <= DRIVER_PROFILES.length / 2 ? 1 : -1);
    this.clearTransition(true);
    this.selectedProfile = next;
    const desktopTransition = notify && this.desktopStageMedia.matches;
    this.render(!desktopTransition, !desktopTransition);
    if (notify) {
      this.root.dataset.switchDirection = String(switchDirection);
      if (desktopTransition) {
        this.animateDesktopSelection(previous, next, switchDirection);
      } else {
        this.startSimpleTransition();
      }
      this.onSelect(next, nextIndex, switchDirection);
    }
  }

  move(delta: number): void {
    const index = DRIVER_PROFILES.findIndex((profile) => profile.id === this.selectedProfile.id);
    const next = (index + delta + DRIVER_PROFILES.length) % DRIVER_PROFILES.length;
    this.select(DRIVER_PROFILES[next].id, true, delta < 0 ? -1 : 1);
  }

  private clearTransition(commitSelected: boolean): void {
    this.transitionToken++;
    this.portraitAnimation?.cancel();
    this.portraitAnimation = null;
    for (const animation of this.detailAnimations) animation.cancel();
    this.detailAnimations = [];
    cancelAnimationFrame(this.radarFrame);
    this.radarFrame = 0;
    if (this.transitionTimer) window.clearTimeout(this.transitionTimer);
    this.transitionTimer = 0;
    if (commitSelected) this.applyPortrait(this.portrait, this.selectedProfile);
    this.portraitIncoming.style.opacity = '0';
    this.portraitIncoming.style.clipPath = '';
    this.portraitIncoming.style.transform = '';
    this.portraitIncoming.removeAttribute('data-driver');
    this.root.classList.remove('switching');
    delete this.root.dataset.transitionMode;
  }

  private startSimpleTransition(): void {
    const token = ++this.transitionToken;
    this.root.dataset.transitionMode = 'simple';
    this.root.classList.add('switching');
    this.transitionTimer = window.setTimeout(() => {
      if (token !== this.transitionToken) return;
      this.root.classList.remove('switching');
      delete this.root.dataset.transitionMode;
      this.transitionTimer = 0;
    }, 460);
  }

  private animateDesktopSelection(previous: DriverProfile, next: DriverProfile, direction: -1 | 1): void {
    const token = ++this.transitionToken;
    this.root.dataset.transitionMode = 'desktop';
    // Leave scheduling headroom so the public 260 ms convergence contract is
    // still true while the browser is decoding images or presenting WebGL.
    this.transitionTimer = window.setTimeout(() => this.finishDesktopSelection(token, next), 220);
    if (this.reducedMotionMedia.matches) {
      this.finishDesktopSelection(token, next);
      return;
    }
    const ready = this.portraitLoads.get(next.id) ?? Promise.resolve();
    void ready.then(() => {
      if (token !== this.transitionToken || this.selectedProfile.id !== next.id || !this.root.classList.contains('on')) return;
      this.applyPortrait(this.portrait, previous);
      this.applyPortrait(this.portraitIncoming, next);
      this.portraitIncoming.dataset.driver = next.id;
      this.portraitIncoming.style.opacity = '1';
      this.root.classList.add('switching');
      const fromClip = direction > 0 ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)';
      const fromX = direction > 0 ? '6px' : '-6px';
      const portraitAnimation = this.portraitIncoming.animate([
        { clipPath: fromClip, transform: `translateX(${fromX})` },
        { clipPath: 'inset(0 0 0 0)', transform: 'translateX(0)' },
      ], {
        duration: 200,
        easing: 'cubic-bezier(.22,.72,.2,1)',
        fill: 'forwards',
      });
      this.portraitAnimation = portraitAnimation;
      const detailFrom = direction > 0 ? 4 : -4;
      this.detailAnimations = [this.identity, this.radarWrap].map((element, index) => element.animate([
        { opacity: 0.58, transform: `translateX(${detailFrom}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ], {
        duration: index === 0 ? 140 : 180,
        easing: 'ease-out',
      }));
      this.animateRadar(previous, next);
      portraitAnimation.onfinish = () => this.finishDesktopSelection(token, next);
    });
  }

  private finishDesktopSelection(token: number, profile: DriverProfile): void {
    if (token !== this.transitionToken || this.selectedProfile.id !== profile.id) return;
    if (this.transitionTimer) window.clearTimeout(this.transitionTimer);
    this.transitionTimer = 0;
    this.portraitAnimation?.cancel();
    this.portraitAnimation = null;
    for (const animation of this.detailAnimations) animation.cancel();
    this.detailAnimations = [];
    cancelAnimationFrame(this.radarFrame);
    this.radarFrame = 0;
    this.applyPortrait(this.portrait, profile);
    this.portraitIncoming.style.opacity = '0';
    this.portraitIncoming.style.clipPath = '';
    this.portraitIncoming.style.transform = '';
    this.portraitIncoming.removeAttribute('data-driver');
    this.radarDisplayValues = handlingValues(profile);
    this.drawRadar(profile);
    this.root.classList.remove('switching');
    delete this.root.dataset.transitionMode;
  }

  private animateRadar(previous: DriverProfile, next: DriverProfile): void {
    cancelAnimationFrame(this.radarFrame);
    const from = this.radarDisplayValues.length === 4 ? [...this.radarDisplayValues] : handlingValues(previous);
    const to = handlingValues(next);
    const started = performance.now();
    const frame = (now: number): void => {
      const t = Math.min(1, (now - started) / 180);
      const eased = 1 - (1 - t) * (1 - t);
      this.radarDisplayValues = to.map((value, index) => from[index] + (value - from[index]) * eased);
      this.drawRadar(next, this.radarDisplayValues);
      if (t < 1) this.radarFrame = requestAnimationFrame(frame);
      else this.radarFrame = 0;
    };
    this.radarFrame = requestAnimationFrame(frame);
  }

  private applyPortrait(image: HTMLImageElement, profile: DriverProfile): void {
    image.src = profile.portraitUrl;
    image.style.objectPosition = profile.portraitPosition;
    if (image === this.portrait) image.alt = `${profile.name}，${profile.age} 岁晴空飞行员`;
  }

  private render(updatePortrait = true, updateRadar = true): void {
    const profile = this.selectedProfile;
    this.root.dataset.selectedDriver = profile.id;
    this.root.style.setProperty('--driver-color', hex(profile.color));
    this.mobileBackdrop.src = profile.portraitUrl;
    if (updatePortrait) this.applyPortrait(this.portrait, profile);
    this.name.textContent = profile.name;
    this.meta.textContent = `${profile.callsign} // ${profile.age} 岁 // ${profile.pronouns}`;
    this.mood.textContent = `${profile.moodIcon} ${profile.mood}`;
    this.specialty.textContent = profile.specialty;
    this.quote.textContent = `“${profile.quote}”`;
    this.strength.textContent = `优势  ${profile.strength}`;
    this.weakness.textContent = `短板  ${profile.weakness}`;
    this.radar.setAttribute('aria-label', `${profile.name} 实际性能；${handlingSummary(profile)}`);
    const index = DRIVER_PROFILES.findIndex((item) => item.id === profile.id);
    this.rosterIndex.textContent = `选手 ${String(index + 1).padStart(2, '0')} / ${String(DRIVER_PROFILES.length).padStart(2, '0')}`;
    const previousId = DRIVER_PROFILES[(index - 1 + DRIVER_PROFILES.length) % DRIVER_PROFILES.length].id;
    const nextId = DRIVER_PROFILES[(index + 1) % DRIVER_PROFILES.length].id;
    const previousProfile = driverProfile(previousId);
    const nextProfile = driverProfile(nextId);
    this.previousLabel.textContent = previousProfile.name;
    this.nextLabel.textContent = nextProfile.name;
    this.previousButton.setAttribute('aria-label', `上一位选手，${previousProfile.name}`);
    this.nextButton.setAttribute('aria-label', `下一位选手，${nextProfile.name}`);
    for (const [id, card] of this.cards) {
      const selected = id === profile.id;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
      card.classList.toggle('carousel-prev', id === previousId);
      card.classList.toggle('carousel-next', id === nextId);
      card.classList.toggle('carousel-visible', id === profile.id || id === previousId || id === nextId);
    }
    for (const [id, dot] of this.dots) {
      const selected = id === profile.id;
      dot.classList.toggle('selected', selected);
      dot.setAttribute('aria-pressed', String(selected));
    }
    if (updateRadar) {
      this.radarDisplayValues = handlingValues(profile);
      this.drawRadar(profile);
    }
  }

  private drawRadar(profile: DriverProfile, displayedValues = handlingValues(profile)): void {
    const ctx = this.radar.getContext('2d');
    if (!ctx) return;
    const cssWidth = Math.max(1, Math.round(this.radar.clientWidth || 320));
    const cssHeight = Math.max(1, Math.round(this.radar.clientHeight || 260));
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (this.radar.width !== pixelWidth || this.radar.height !== pixelHeight) {
      this.radar.width = pixelWidth;
      this.radar.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssWidth;
    const h = cssHeight;
    const labels = ['加速', '转向', '漂移', '空控'];
    const values = displayedValues;
    if (this.desktopStageMedia.matches) {
      drawDesktopRadar(ctx, this.radar, profile, labels, values, w, h);
      return;
    }
    this.radar.dataset.layout = JSON.stringify({ mode: 'compact' });
    const cx = w * 0.5;
    const cy = h * 0.5 + 7;
    const radius = Math.min(w, h) * 0.35;
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = 'round';
    for (let ring = 1; ring <= 4; ring++) {
      polygon(ctx, cx, cy, radius * ring / 4, labels.length);
      ctx.strokeStyle = ring === 4 ? 'rgba(244,254,255,.55)' : 'rgba(244,254,255,.16)';
      ctx.lineWidth = ring === 4 ? 3 : 1;
      ctx.stroke();
    }
    for (let i = 0; i < labels.length; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / labels.length;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.strokeStyle = 'rgba(244,254,255,.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f4feff';
      ctx.font = '800 16px system-ui';
      const horizontal = Math.cos(a);
      const vertical = Math.sin(a);
      ctx.textAlign = horizontal > 0.25 ? 'right' : horizontal < -0.25 ? 'left' : 'center';
      ctx.textBaseline = vertical > 0.5 ? 'bottom' : vertical < -0.5 ? 'top' : 'middle';
      const labelX = horizontal > 0.25 ? w - 8 : horizontal < -0.25 ? 8 : cx;
      const labelY = vertical > 0.5 ? h - 6 : vertical < -0.5 ? 6 : cy;
      ctx.fillText(
        `${labels[i]} ${formatHandling(values[i])}`,
        labelX,
        labelY,
      );
    }
    ctx.beginPath();
    values.forEach((value, i) => {
      const a = -Math.PI / 2 + i * Math.PI * 2 / labels.length;
      const n = 0.58 + (value - 0.94) / 0.12 * 0.42;
      const x = cx + Math.cos(a) * radius * Math.max(0.58, Math.min(1, n));
      const y = cy + Math.sin(a) * radius * Math.max(0.58, Math.min(1, n));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = `${hex(profile.color)}77`;
    ctx.strokeStyle = hex(profile.color);
    ctx.lineWidth = 5;
    ctx.fill();
    ctx.stroke();
  }
}

function drawDesktopRadar(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  profile: DriverProfile,
  labels: string[],
  values: number[],
  w: number,
  h: number,
): void {
  const cx = w * 0.5;
  const cy = h * 0.5;
  const axisFontSize = clamp(Math.round(w * 0.04), 11, 16);
  const valueFontSize = axisFontSize + 3;
  const lineGap = clamp(Math.round(w * 0.012), 3, 5);
  const labelGap = clamp(Math.round(w * 0.03), 8, 14);
  const edgeInset = clamp(Math.round(w * 0.025), 6, 12);
  const valueLabels = values.map(formatHandling);

  const labelWidths = labels.map((label, index) => {
    ctx.font = `700 ${axisFontSize}px system-ui`;
    const axisWidth = ctx.measureText(label).width;
    ctx.font = `900 ${valueFontSize}px system-ui`;
    const valueWidth = ctx.measureText(valueLabels[index]).width;
    return Math.ceil(Math.max(axisWidth, valueWidth));
  });
  const sideLabelWidth = Math.max(labelWidths[1], labelWidths[3]);
  const labelBlockHeight = axisFontSize + lineGap + valueFontSize;
  const horizontalRadius = cx - edgeInset - sideLabelWidth - labelGap;
  const verticalRadius = cy - edgeInset - labelBlockHeight - labelGap;
  const radius = Math.max(36, Math.min(Math.min(w, h) * 0.35, horizontalRadius, verticalRadius));
  const polygonBounds = {
    left: cx - radius,
    right: cx + radius,
    top: cy - radius,
    bottom: cy + radius,
  };

  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  for (let ring = 1; ring <= 4; ring++) {
    polygon(ctx, cx, cy, radius * ring / 4, labels.length);
    ctx.strokeStyle = ring === 4 ? 'rgba(244,254,255,.55)' : 'rgba(244,254,255,.16)';
    ctx.lineWidth = ring === 4 ? 3 : 1;
    ctx.stroke();
  }
  for (let i = 0; i < labels.length; i++) {
    const a = -Math.PI / 2 + i * Math.PI * 2 / labels.length;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.strokeStyle = 'rgba(244,254,255,.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.beginPath();
  values.forEach((value, i) => {
    const a = -Math.PI / 2 + i * Math.PI * 2 / labels.length;
    const n = 0.58 + (value - 0.94) / 0.12 * 0.42;
    const x = cx + Math.cos(a) * radius * Math.max(0.58, Math.min(1, n));
    const y = cy + Math.sin(a) * radius * Math.max(0.58, Math.min(1, n));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = `${hex(profile.color)}77`;
  ctx.strokeStyle = hex(profile.color);
  ctx.lineWidth = 5;
  ctx.fill();
  ctx.stroke();

  const labelBounds = labels.map((label, index) => {
    const width = labelWidths[index];
    let x = cx;
    let top = cy - labelBlockHeight * 0.5;
    let textAlign: CanvasTextAlign = 'center';
    if (index === 0) top = polygonBounds.top - labelGap - labelBlockHeight;
    if (index === 1) {
      x = polygonBounds.right + labelGap;
      textAlign = 'left';
    }
    if (index === 2) top = polygonBounds.bottom + labelGap;
    if (index === 3) {
      x = polygonBounds.left - labelGap;
      textAlign = 'right';
    }
    const left = textAlign === 'left' ? x : textAlign === 'right' ? x - width : x - width * 0.5;
    ctx.textAlign = textAlign;
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(244,254,255,.68)';
    ctx.font = `700 ${axisFontSize}px system-ui`;
    ctx.fillText(label, x, top);
    ctx.fillStyle = '#f4feff';
    ctx.font = `900 ${valueFontSize}px system-ui`;
    ctx.fillText(valueLabels[index], x, top + axisFontSize + lineGap);
    return { label, left, right: left + width, top, bottom: top + labelBlockHeight };
  });

  canvas.dataset.layout = JSON.stringify({
    mode: 'desktop',
    width: w,
    height: h,
    radius,
    labelGap,
    polygon: polygonBounds,
    labels: labelBounds,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatHandling(value: number): string {
  const percent = Math.round((value - 1) * 100);
  return percent > 0 ? `+${percent}%` : `${percent}%`;
}

function handlingValues(profile: DriverProfile): number[] {
  return [
    profile.handling.acceleration,
    profile.handling.steering,
    profile.handling.driftCharge,
    profile.handling.airControl,
  ];
}

function handlingSummary(profile: DriverProfile): string {
  const h = profile.handling;
  return `加速 ${formatHandling(h.acceleration)}，转向 ${formatHandling(h.steering)}，` +
    `漂移 ${formatHandling(h.driftCharge)}，空控 ${formatHandling(h.airControl)}；这些数值直接影响本局物理，单项最高正负 6%`;
}

function polygon(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, sides: number): void {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + i * Math.PI * 2 / sides;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
