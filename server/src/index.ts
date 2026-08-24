/**
 * Server entry point.
 *
 * Deliberately built on `@colyseus/core` + `@colyseus/ws-transport` rather than
 * the `colyseus` convenience barrel: that barrel eagerly imports the redis
 * presence/driver packages, which are declared as peer dependencies but aren't
 * needed for a single-process deployment.
 */
import http from 'http';
import net from 'net';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { DefenseRoom } from './rooms/DefenseRoom';

/**
 * Colyseus Cloud fronts every instance with NGINX and proxies to a **unix
 * socket**, not a TCP port. It never sets PORT, so a server that binds
 * `PORT || 2567` comes up perfectly healthy and NGINX still answers 502 —
 * nothing is listening where it looks. `@colyseus/tools` hides this; we are on
 * bare `@colyseus/core`, so we honour the same contract by hand.
 *
 * The socket is named for the port the instance *would* have used, offset by
 * the PM2 worker index. With `instances: 1` that is always 2567.
 */
const onCloud = process.env.COLYSEUS_CLOUD !== undefined;
const port = onCloud
  ? 2567 + Number(process.env.NODE_APP_INSTANCE || 0)
  : Number(process.env.PORT) || 2567;

const app = express();
app.use(cors());
app.use(express.json());

// Colyseus Cloud probes this to decide whether the instance is healthy.
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: 'defense' });
});

const httpServer = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    // Reap dead connections. Without this a browser tab that navigates away
    // without a clean close leaves a ghost player standing in the room, which
    // other clients keep rendering.
    pingInterval: 4000,
    pingMaxRetries: 3,
  }),
});

gameServer.define('defense', DefenseRoom);

/**
 * An instance killed hard leaves its socket file behind, and the next bind
 * fails on a file nothing is actually listening to. Probe it: a refused
 * connection means it is stale and safe to unlink, a successful one means a
 * live process owns the socket and we must not steal it.
 */
function clearStaleSocket(path: string) {
  return new Promise<void>((resolve, reject) => {
    const probe = net.createConnection({ path })
      .on('connect', () => {
        probe.end();
        reject(new Error(`EADDRINUSE: another process is listening on ${path}`));
      })
      .on('error', () => fs.unlink(path, () => resolve()));
  });
}

async function start() {
  if (onCloud) {
    const socketPath = `/run/colyseus/${port}.sock`;
    await clearStaleSocket(socketPath);
    // @colyseus/core types listen() as (port: number, hostname?: string), but
    // it hands both straight to http.Server.listen, and Node reads a non-numeric
    // string in the first slot as a pipe path. The 0 just fills the hostname
    // parameter; Node ignores it once a path is in play.
    await gameServer.listen(socketPath as unknown as number, 0 as unknown as string);
    console.log(`[ace-defense] listening on ${socketPath}`);
  } else {
    await gameServer.listen(port);
    console.log(`[ace-defense] listening on :${port}`);
  }

  // PM2 is configured with `wait_ready: true`, so it holds the instance in
  // "launching" until this arrives. Under a plain `node build/index.js` there
  // is no parent to send to and process.send is undefined — hence the guard.
  process.send?.('ready');
}

start().catch((err) => {
  console.error('[ace-defense] failed to start', err);
  process.exit(1);
});
