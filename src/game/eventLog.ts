export type GameEventName =
  | 'final_station_armed'
  | 'final_station_crossed'
  | 'finale_shown'
  | 'screenshot_created'
  | 'screenshot_saved'
  | 'expansion_view_open'
  | 'expansion_page_view'
  | 'expansion_return_game'
  | 'continue_game';

const STORAGE_KEY = 'board-race:events:v1';
const MAX_EVENTS = 80;

export function trackGameEvent(name: GameEventName, detail: Record<string, string | number | boolean> = {}): void {
  const event = { name, at: Date.now(), ...detail };
  window.dispatchEvent(new CustomEvent('board-race:event', { detail: event }));
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    const events = Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS + 1) : [];
    events.push(event);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Telemetry is local and optional. Gameplay must never depend on storage.
  }
}
