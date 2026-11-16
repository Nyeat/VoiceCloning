// Live-chat activity for the GPU idle-stop check. The gateway runs on the fixed
// GPU, so an open conversation is a reason to keep that GPU on even when no
// training or synthesis is running on it.
export const ACTIVITY_PATH = '/api/live/session/activity';

export function createSessionActivity(now = () => Date.now()) {
  let open = 0;
  let lastActivityAt = now();
  return {
    opened() { open += 1; lastActivityAt = now(); },
    touched() { lastActivityAt = now(); },
    closed() { open = Math.max(0, open - 1); lastActivityAt = now(); },
    status() {
      const at = now();
      return {
        busy: open > 0,
        liveSessions: open,
        lastActivityAt,
        // An open conversation is never idle, however quiet it has been.
        idleMs: open > 0 ? 0 : Math.max(0, at - lastActivityAt),
        trainingStatus: 'idle',
        inferenceStatus: open > 0 ? 'generating' : 'idle',
      };
    },
  };
}

export const sessionActivity = createSessionActivity();
