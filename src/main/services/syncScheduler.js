const MAX_BACKOFF_FACTOR = 8;

class SyncScheduler {
  constructor({ onTick, logger }) {
    this.onTick = onTick;
    this.logger = logger;
    this.timer = null;
    this.baseIntervalMs = 0;
    this.failures = 0;
  }

  start(intervalMinutes) {
    this.stop();
    this.baseIntervalMs = Math.max(Number(intervalMinutes) || 30, 5) * 60 * 1000;
    this.failures = 0;
    this.scheduleNext();
  }

  // Each failed tick doubles the wait (up to 8x) so an offline F95 or a rate limit is not hammered.
  scheduleNext() {
    const factor = Math.min(2 ** this.failures, MAX_BACKOFF_FACTOR);
    this.timer = setTimeout(() => this.tick(), this.baseIntervalMs * factor);
    this.timer.unref?.();
  }

  async tick() {
    this.timer = null;
    try {
      await this.onTick();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      try {
        await this.logger?.warn("Scheduled sync failed.", { message: error?.message, consecutiveFailures: this.failures });
      } catch { /* logging must never break the scheduler */ }
    }
    if (this.baseIntervalMs) this.scheduleNext();
  }

  stop() {
    this.baseIntervalMs = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  SyncScheduler
};
