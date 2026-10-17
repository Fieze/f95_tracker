class ArchiveQueue {
  constructor({ prepare, run, onError }) {
    this.prepare = prepare;
    this.run = run;
    this.onError = onError;
    this.jobs = new Map();
    this.pending = [];
    this.running = null;
    this.closed = false;
  }
  async enqueue(job) {
    if (this.closed) throw new Error("Archive queue is shutting down.");
    if (this.jobs.has(job.jobId)) return this.jobs.get(job.jobId).receipt;
    const entry = { ...job };
    this.jobs.set(job.jobId, entry);
    entry.ready = Promise.resolve().then(() => this.prepare(job));
    entry.receipt = entry.ready.then(() => ({ jobId: job.jobId, status: "queued" }));
    this.pending.push(entry);
    this.start();
    return entry.receipt;
  }
  start() {
    if (this.running || this.closed || !this.pending.length) return;
    this.running = (async () => {
      while (!this.closed && this.pending.length) {
        const job = this.pending.shift();
        try { await job.ready; if (!this.closed) await this.run(job); }
        catch (error) { await this.onError?.(error, job); }
        finally { this.jobs.delete(job.jobId); }
      }
    })().finally(() => { this.running = null; this.start(); });
  }
  hasGame(gameId) { return [...this.jobs.values()].some((job) => job.gameId === Number(gameId)); }
  hasJob(jobId) { return this.jobs.has(Number(jobId)); }
  get busy() { return this.jobs.size > 0; }
  async waitIdle() {
    await Promise.all([...this.jobs.values()].map((job) => job.receipt));
    while (this.running) await this.running;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.jobs.values()].map((job) => job.receipt));
    await this.running;
    this.pending = [];
    this.jobs.clear();
  }
}

module.exports = { ArchiveQueue };
