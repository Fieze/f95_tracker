const { AsyncLocalStorage } = require("async_hooks");

class OperationGate {
  constructor() {
    this.context = new AsyncLocalStorage();
    this.active = new Set();
    this.exclusive = false;
    this.closed = false;
  }
  run(operation) {
    if (this.context.getStore()?.active) return operation();
    if (this.closed || this.exclusive) throw new Error("Application is shutting down or importing data. Try again later.");
    const token = { active: true };
    const promise = this.context.run(token, async () => operation()).finally(() => { token.active = false; });
    this.active.add(promise);
    promise.then(() => this.active.delete(promise), () => this.active.delete(promise));
    return promise;
  }
  async runExclusive(operation) {
    if (this.closed || this.exclusive || this.active.size) throw new Error("Import requires all current operations to finish.");
    this.exclusive = true;
    const token = { active: true };
    const promise = this.context.run(token, async () => operation());
    this.active.add(promise);
    try { return await promise; }
    finally { this.active.delete(promise); token.active = false; this.exclusive = false; }
  }
  async drain() { await Promise.allSettled([...this.active]); }
}

module.exports = { OperationGate };
