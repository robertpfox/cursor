import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub that backs the live activity stream. Every run step,
 * approval request and status change is published here; the SSE endpoint
 * forwards matching events to connected dashboards and phones.
 */
class Bus extends EventEmitter {
  publish(topic, payload) {
    const event = { topic, at: new Date().toISOString(), ...payload };
    this.emit(topic, event);
    this.emit('*', event);
    return event;
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);

export default bus;
