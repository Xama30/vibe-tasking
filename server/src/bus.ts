import { EventEmitter } from 'node:events';

export interface BusMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * In-process pub/sub feeding the SSE endpoint. Single-user local app, so an
 * EventEmitter is the right amount of machinery — no broker, no polling.
 */
class Bus extends EventEmitter {
  publish(message: BusMessage): void {
    this.emit('message', message);
  }

  subscribe(listener: (message: BusMessage) => void): () => void {
    this.on('message', listener);
    return () => this.off('message', listener);
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);
