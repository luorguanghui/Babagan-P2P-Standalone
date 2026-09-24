class NativeFrameGate {
  constructor(send, { maxInFlight = 1 } = {}) {
    this.send = send;
    this.maxInFlight = Math.max(1, maxInFlight);
    this.inFlight = 0;
    this.waiting = false;
    this.latest = null;
    this.dropped = 0;
    this.closed = false;
  }
  push(record) {
    if (this.closed) return;
    if (record.type !== 'frame') { this.send(record); return; }
    if (this.latest) this.dropped++;
    this.latest = record;
    this.flush();
  }
  ready() {
    if (!this.closed) {
      if (this.inFlight > 0) this.inFlight--;
      this.waiting = this.inFlight >= this.maxInFlight;
      this.flush();
    }
  }
  flush() {
    if (this.closed || this.inFlight >= this.maxInFlight || !this.latest) return;
    const record = this.latest;
    this.latest = null;
    this.inFlight++;
    this.waiting = this.inFlight >= this.maxInFlight;
    this.send(record);
  }
  stop() { this.closed = true; this.latest = null; }
}
module.exports = { NativeFrameGate };
