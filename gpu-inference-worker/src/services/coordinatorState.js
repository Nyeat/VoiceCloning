class CoordinatorState {
  constructor() {
    this.draining = false;
    this.modelKey = '';
    this.voiceProfileId = '';
    // 'boot' residency comes from the worker's own pre-warm: real, but provisional,
    // so an explicit coordinator registration may replace it.
    this.source = '';
    this.updatedAt = 0;
  }

  beginDrain() {
    if (this.draining) return false;
    this.draining = true;
    return true;
  }

  finishDrain() {
    this.draining = false;
  }

  assign({ modelKey = '', voiceProfileId = '', source = 'coordinator', now = Date.now() } = {}) {
    this.modelKey = String(modelKey || '').trim();
    this.voiceProfileId = String(voiceProfileId || '').trim();
    this.source = this.modelKey ? String(source || 'coordinator') : '';
    this.updatedAt = now;
  }

  snapshot() {
    return {
      draining: this.draining,
      modelKey: this.modelKey || null,
      voiceProfileId: this.voiceProfileId || null,
      residencySource: this.source || null,
      updatedAt: this.updatedAt || null,
    };
  }
}

// A different model may be registered over only a provisional (boot) residency.
export function registrationConflicts(snapshot = {}, requestedKey = '') {
  return Boolean(snapshot.modelKey && snapshot.modelKey !== requestedKey && snapshot.residencySource !== 'boot');
}

export const coordinatorState = new CoordinatorState();
