import type { MuteStateStore } from '../storage/binding-store.ts';

/**
 * MuteService - manages session-level mute state for Lark chat sessions.
 * When a session is muted, the bridge will not respond to regular messages,
 * but will still respond to commands when the bot is @mentioned.
 */

export interface MuteService {
  isMuted(sessionId: string): boolean;
  mute(sessionId: string): void;
  unmute(sessionId: string): void;
  toggle(sessionId: string): boolean;
}

export function createMuteService(store?: MuteStateStore): MuteService {
  return {
    isMuted(sessionId: string): boolean {
      return store ? store.isMuted(sessionId) : false;
    },

    mute(sessionId: string): void {
      store?.mute(sessionId);
    },

    unmute(sessionId: string): void {
      store?.unmute(sessionId);
    },

    toggle(sessionId: string): boolean {
      if (store?.isMuted(sessionId)) {
        store.unmute(sessionId);
        return false;
      } else {
        store?.mute(sessionId);
        return true;
      }
    },
  };
}
