import { describe, expect, it } from 'vitest';

import { RfbServer } from '../src/desktop/rfb/index.js';
import { fixture, loadFrame, SyntheticCapture } from './rfb-test-client.js';

interface Recording {
  frame: string;
  client: string[];
  input: string[];
}

describe('recorded noVNC sessions', () => {
  it.each(['novnc-1.7.0-session.json'])(
    'replays %s to the same input',
    async (name) => {
      const recording = fixture(name) as Recording;
      const capture = new SyntheticCapture(loadFrame(recording.frame));
      const server = new RfbServer(capture.backend());
      const socket = server.open();
      const received: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => received.push(chunk));
      await new Promise((resolve) => socket.once('data', resolve));
      for (const message of recording.client) {
        socket.write(Buffer.from(message, 'hex'));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(socket.destroyed).toBe(false);
      expect(capture.input).toEqual(recording.input);
      expect(Buffer.concat(received).length).toBeGreaterThan(0);
      server.close();
    },
  );
});
