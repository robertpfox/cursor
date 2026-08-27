import api from './api.js';

/**
 * Shared client state plus the live event stream. Views subscribe to topics and
 * re-render the parts that changed instead of polling the API.
 */
class Store extends EventTarget {
  constructor() {
    super();
    this.session = null;
    this.counts = { approvals: 0, notifications: 0, activeRuns: 0, queuedRuns: 0 };
    this.connected = false;
    this.source = null;
    this.retryMs = 1000;
  }

  on(topic, handler) {
    const wrapped = (event) => handler(event.detail);
    this.addEventListener(topic, wrapped);
    return () => this.removeEventListener(topic, wrapped);
  }

  emit(topic, detail) {
    this.dispatchEvent(new CustomEvent(topic, { detail }));
  }

  async loadSession() {
    this.session = await api.get('/api/session');
    return this.session;
  }

  async refreshCounts() {
    const [approvals, notifications] = await Promise.all([
      api.get('/api/approvals').catch(() => []),
      api.get('/api/notifications?limit=1').catch(() => ({ unread: 0 })),
    ]);
    this.counts = { ...this.counts, approvals: approvals.length, notifications: notifications.unread };
    this.emit('counts', this.counts);
    return this.counts;
  }

  connect() {
    if (this.source) return;
    const source = new EventSource('/api/events');
    this.source = source;

    source.addEventListener('open', () => {
      this.connected = true;
      this.retryMs = 1000;
      this.emit('connection', true);
    });

    source.addEventListener('error', () => {
      this.connected = false;
      this.emit('connection', false);
      source.close();
      this.source = null;
      // Back off so a stopped server does not turn into a reconnect storm.
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 20_000);
    });

    const forward = (topic) =>
      source.addEventListener(topic, (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        this.emit(topic, payload);
        this.emit('any', payload);
      });

    for (const topic of [
      'hello',
      'run.created',
      'run.status',
      'run.step',
      'run.finished',
      'approval.created',
      'approval.decided',
      'notification',
    ]) {
      forward(topic);
    }

    this.on('hello', (payload) => {
      if (payload.counts) {
        this.counts = { ...this.counts, ...payload.counts };
        this.emit('counts', this.counts);
      }
    });
    this.on('approval.created', () => this.bumpApprovals(1));
    this.on('approval.decided', () => this.bumpApprovals(-1));
    this.on('notification', () => {
      this.counts = { ...this.counts, notifications: this.counts.notifications + 1 };
      this.emit('counts', this.counts);
    });
  }

  bumpApprovals(delta) {
    this.counts = { ...this.counts, approvals: Math.max(0, this.counts.approvals + delta) };
    this.emit('counts', this.counts);
  }

  disconnect() {
    this.source?.close();
    this.source = null;
    this.connected = false;
  }
}

export const store = new Store();
export default store;
