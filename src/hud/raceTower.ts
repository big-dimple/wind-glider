import type { RaceBattleEvent, RacerDefinition, RaceView } from '../contracts';
import { driverProfile } from '../game/racers';
import './raceTower.css';

export class RaceTower {
  readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly radio: HTMLDivElement;
  private definitions: readonly RacerDefinition[] = [];
  private readonly rows = new Map<number, HTMLDivElement>();
  private accumulator = 0;
  private radioTimer = 0;
  private messageIndex = 0;

  constructor(parent: HTMLElement) {
    this.root = node('div', 'race-tower', parent);
    node('div', 'race-tower-head', this.root, 'W.H.L // LIVE');
    this.list = node('div', 'race-tower-list', this.root);
    this.radio = node('div', 'race-radio', this.root);
    this.radio.setAttribute('aria-live', 'polite');
  }

  setRoster(definitions: readonly RacerDefinition[]): void {
    this.definitions = definitions;
    this.rows.clear();
    this.list.replaceChildren();
    for (const def of definitions) {
      const row = node('div', 'race-tower-row', this.list);
      row.dataset.id = String(def.id);
      const place = node('span', 'race-tower-place', row);
      place.textContent = String(def.startPlace).padStart(2, '0');
      const img = document.createElement('img');
      img.src = def.portraitUrl;
      img.alt = '';
      img.style.objectPosition = driverProfile(def.profileId).portraitPosition;
      row.appendChild(img);
      node('span', 'race-tower-name', row, def.name);
      node('span', 'race-tower-gap', row, 'GRID');
      row.style.setProperty('--racer-color', `#${def.color.toString(16).padStart(6, '0')}`);
      this.rows.set(def.id, row);
    }
  }

  update(dt: number, race: RaceView, flightFocus = false): void {
    this.root.classList.toggle('on', race.phase === 'racing' || race.phase === 'countdown' || race.phase === 'resume-countdown');
    // The grid introduction is useful during 3/2/1 and the opening seconds.
    // Once racing settles, retain only the player's immediate battle group.
    this.root.classList.toggle('compact', race.phase === 'racing' && race.raceTime > 3);
    this.root.classList.toggle('flight-focus', flightFocus);
    this.radioTimer = Math.max(0, this.radioTimer - dt);
    if (this.radioTimer === 0) this.radio.classList.remove('on');
    this.accumulator += dt;
    if (this.accumulator < 0.1) return;
    this.accumulator = 0;
    const order = [...race.racers].sort((a, b) => a.place - b.place);
    const player = race.racers.find((racer) => racer.isPlayer);
    for (let i = 0; i < order.length; i++) {
      const racer = order[i];
      const row = this.rows.get(racer.id);
      if (!row) continue;
      row.style.order = String(racer.place);
      row.classList.toggle('player', racer.isPlayer);
      row.classList.toggle('near-player', !!player && Math.abs(racer.place - player.place) <= 1);
      const place = row.querySelector<HTMLElement>('.race-tower-place');
      const gap = row.querySelector<HTMLElement>('.race-tower-gap');
      if (place) place.textContent = String(racer.place).padStart(2, '0');
      if (gap) {
        if (i === 0) gap.textContent = 'LEADER';
        else gap.textContent = `-${Math.max(0, order[i - 1].progress - racer.progress).toFixed(1)}m`;
      }
    }
  }

  announceGo(playerName: string): void {
    this.announce(`${playerName}，线路开放。先拿第一飞。`);
  }

  announceBattle(event: RaceBattleEvent): void {
    const name = event.opponents[0]?.name ?? '对手';
    const messages = event.kind === 'overtake'
      ? [`已超过 ${name}，守住内线。`, `${name} 在尾流里，别给回切。`]
      : [`${name} 已超过你，差距还在攻击窗。`, `盯住 ${name}，下一段出弯拿回来。`];
    this.announce(messages[this.messageIndex++ % messages.length]);
  }

  announceFlight(flights: number, best: number): void {
    const messages = flights === 3
      ? [`三飞认证。远海档案开启，BEST ${best}。`, '勋章到手。下一段线路已经开放。']
      : [`第 ${flights} 飞通过，艇况正常。`, `航门确认。本局 ${flights} 飞，继续。`];
    this.announce(messages[this.messageIndex++ % messages.length]);
  }

  announceCollision(opponent: string): void {
    this.announce(`与 ${opponent} 发生接触。艇体正常，继续压线。`);
  }

  private announce(message: string): void {
    this.radio.textContent = `TEAM // ${message}`;
    this.radio.classList.add('on');
    this.radioTimer = 3.2;
  }
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  parent.appendChild(el);
  return el;
}
