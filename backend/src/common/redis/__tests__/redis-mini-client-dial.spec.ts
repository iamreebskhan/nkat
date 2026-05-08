/**
 * Verifies the `dial` injection point used to swap the underlying
 * socket for tests OR for TLS in production. We can't easily run a
 * real Redis-over-TLS server in unit tests, but we CAN exercise the
 * dial-injection contract: a caller-supplied Duplex stream is wired
 * up correctly, the AUTH step runs over it, and pipelined replies
 * arrive in order.
 */
import { Duplex, PassThrough } from 'node:stream';
import { encodeArray, RedisMiniClient } from '../redis-mini-client';

/**
 * A pair of PassThroughs wired so writes from the client flow into the
 * server's read buffer; the server's writes flow back into the client's
 * read buffer. Closely mimics a real socket but stays in-process.
 */
function makeServerSocket(): {
  client: Duplex;
  serverInbound: PassThrough; // bytes the client sent
  serverWrite: (bytes: Buffer) => void; // server writes back to client
  emitConnect: () => void;
} {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = Duplex.from({
    readable: serverToClient,
    writable: clientToServer,
  });
  return {
    client,
    serverInbound: clientToServer,
    serverWrite: (bytes) => serverToClient.write(bytes),
    emitConnect: () => client.emit('connect'),
  };
}

describe('RedisMiniClient — dial injection', () => {
  it('uses the supplied dial function instead of net.connect', async () => {
    const { client, serverInbound, serverWrite, emitConnect } = makeServerSocket();
    const dialCalls: Array<[string, number]> = [];
    const c = new RedisMiniClient({
      host: 'fake-host',
      port: 6379,
      commandTimeoutMs: 2000,
      dial: (h, p) => {
        dialCalls.push([h, p]);
        return client;
      },
    });

    // Run the connect + eval round-trip in parallel with the fake server.
    const evalPromise = (async () => {
      // Defer slightly so the connect listener attaches first.
      await Promise.resolve();
      emitConnect();
      // Now wait for the eval write to land, then respond.
      await new Promise((r) => setTimeout(r, 10));
      // Reply with `:42\r\n` (RESP integer 42).
      serverWrite(Buffer.from(':42\r\n'));
    })();

    const result = await c.eval('return 42', 0);
    await evalPromise;

    expect(dialCalls).toEqual([['fake-host', 6379]]);
    expect(result).toBe(42);

    // The wire bytes the client sent should be a valid EVAL command.
    const sent = serverInbound.read() as Buffer | null;
    expect(sent).not.toBeNull();
    expect(sent!.toString('utf8')).toBe(encodeArray(['EVAL', 'return 42', '0']).toString('utf8'));
  });

  it('AUTH runs immediately after connect when password supplied', async () => {
    const { client, serverInbound, serverWrite, emitConnect } = makeServerSocket();
    const c = new RedisMiniClient({
      host: 'h',
      port: 6379,
      password: 'sekret',
      commandTimeoutMs: 2000,
      dial: () => client,
    });

    const flow = (async () => {
      await Promise.resolve();
      emitConnect();
      // Read the AUTH command, reply +OK.
      await new Promise((r) => setTimeout(r, 10));
      const auth = serverInbound.read() as Buffer | null;
      expect(auth!.toString('utf8')).toBe(encodeArray(['AUTH', 'sekret']).toString('utf8'));
      serverWrite(Buffer.from('+OK\r\n'));
      // Then the EVAL.
      await new Promise((r) => setTimeout(r, 10));
      const cmd = serverInbound.read() as Buffer | null;
      expect(cmd!.toString('utf8')).toBe(encodeArray(['EVAL', 'return 1', '0']).toString('utf8'));
      serverWrite(Buffer.from(':1\r\n'));
    })();

    const result = await c.eval('return 1', 0);
    await flow;
    expect(result).toBe(1);
  });

  it('rejects in-flight calls when the socket closes', async () => {
    const { client, emitConnect } = makeServerSocket();
    const c = new RedisMiniClient({
      host: 'h',
      port: 6379,
      commandTimeoutMs: 5000,
      dial: () => client,
    });

    const evalPromise = (async () => {
      await Promise.resolve();
      emitConnect();
      // Server never replies; instead, it closes mid-flight.
      await new Promise((r) => setTimeout(r, 20));
      client.emit('close');
    })();

    await expect(c.eval('return 1', 0)).rejects.toThrow(/socket closed/);
    await evalPromise;
  });

  it('per-command timeout fires when reply never arrives', async () => {
    const { client, emitConnect } = makeServerSocket();
    const c = new RedisMiniClient({
      host: 'h',
      port: 6379,
      commandTimeoutMs: 50, // 50ms
      dial: () => client,
    });

    const flow = (async () => {
      await Promise.resolve();
      emitConnect();
    })();

    await expect(c.eval('return 1', 0)).rejects.toThrow(/timed out/);
    await flow;
  });
});
