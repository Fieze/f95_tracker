class SyncScheduler {
  constructor({ onTick }) {
    this.onTick = onTick;
    this.timer = null;
  }

  start(intervalMinutes) {
    this.stop();
    const interval = Math.max(Number(intervalMinutes) || 30, 5) * 60 * 1000;
    this.timer = setInterval(() => {
      this.onTick().catch(() => {});
    }, interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  SyncScheduler
};
