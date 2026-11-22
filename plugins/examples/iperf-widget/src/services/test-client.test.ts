import {describe, expect, it, vi} from 'vitest';
import type {BackendClient} from '@mndw/sdk';
import {type ServerMessage, TestClient} from './test-client.js';

class FakeSocket {
  public readyState = 1;
  public sent: string[] = [];
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
  }

  public emit(data: unknown): void {
    this.onmessage?.({data: JSON.stringify(data)} as MessageEvent);
  }
}

describe('TestClient', () => {
  it('parses indexed ping samples and failed null slots from fake socket messages', () => {
    const socket = new FakeSocket();
    const backend = {socket: () => socket as unknown as WebSocket} as unknown as BackendClient;
    const client = new TestClient(backend);
    const messages: ServerMessage[] = [];
    const errors: Error[] = [];
    const unsubscribe = client.subscribe((message) => messages.push(message), (error) => errors.push(error));

    client.start({host: 'example.net', portFrom: 5201, portTo: 5201}, {duration: 5, streams: 1});
    socket.emit({type: 'pingSample', index: 0, ms: 12.4});
    socket.emit({type: 'pingSample', index: 1, ms: null});
    socket.emit({type: 'ping', pingMs: null, jitterMs: null});
    socket.emit({type: 'pingSample', index: 2, ms: '15'});

    expect(messages).toEqual([
      {type: 'pingSample', index: 0, ms: 12.4},
      {type: 'pingSample', index: 1, ms: null},
      {type: 'ping', pingMs: null, jitterMs: null},
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('pingSample');

    unsubscribe();
    client.close();
  });

  it('sends start and stop and delivers typed frames while reporting unknown frames', () => {
    const socket = new FakeSocket();
    const socketFactory = vi.fn(() => socket as unknown as WebSocket);
    const backend = {socket: socketFactory} as unknown as BackendClient;
    const client = new TestClient(backend);
    const messages: ServerMessage[] = [];
    const protocolErrors: Error[] = [];
    const unsubscribe = client.subscribe((message) => messages.push(message), (error) => protocolErrors.push(error));

    client.start({host: 'example.net', portFrom: 5201, portTo: 5209}, {duration: 10, streams: 4});
    socket.emit({type: 'phase', phase: 'download', port: 5201});
    socket.emit({type: 'unexpected'});
    client.stop();

    expect(socketFactory.mock.calls).toEqual([['test']]);
    expect(socket.sent).toEqual([
      JSON.stringify({type: 'start', host: 'example.net', portFrom: 5201, portTo: 5209, duration: 10, streams: 4}),
      JSON.stringify({type: 'stop'}),
    ]);
    expect(messages).toEqual([{type: 'phase', phase: 'download', port: 5201}]);
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]?.message).toContain('unexpected');

    unsubscribe();
    client.close();
  });

  it('waits for an opening socket before sending start', () => {
    const socket = new FakeSocket();

    socket.readyState = 0;

    const backend = {socket: () => socket as unknown as WebSocket} as unknown as BackendClient;
    const client = new TestClient(backend);

    client.start({host: 'example.net', portFrom: 5201, portTo: 5201}, {duration: 5, streams: 1});
    expect(socket.sent).toEqual([]);
    socket.readyState = 1;
    socket.onopen?.(new Event('open'));

    expect(socket.sent).toEqual([
      JSON.stringify({type: 'start', host: 'example.net', portFrom: 5201, portTo: 5201, duration: 5, streams: 1}),
    ]);
    client.close();
  });
});
