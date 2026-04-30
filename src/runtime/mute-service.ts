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

export function createMuteService(): MuteService {
  const mutedSessions = new Set<string>();

  return {
    isMuted(sessionId: string): boolean {
      return mutedSessions.has(sessionId);
    },

    mute(sessionId: string): void {
      mutedSessions.add(sessionId);
    },

    unmute(sessionId: string): void {
      mutedSessions.delete(sessionId);
    },

    toggle(sessionId: string): boolean {
      if (mutedSessions.has(sessionId)) {
        mutedSessions.delete(sessionId);
        return false;
      } else {
        mutedSessions.add(sessionId);
        return true;
      }
    },
  };
}
