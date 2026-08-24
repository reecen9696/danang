/**
 * Server entry point.
 *
 * Deliberately built on `@colyseus/core` + `@colyseus/ws-transport` rather than
 * the `colyseus` convenience barrel: that barrel eagerly imports the redis
 * presence/driver packages, which are declared as peer dependencies but aren't
 * needed for a single-process deployment.
 */
import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { DefenseRoom } from './rooms/DefenseRoom';

const port = Number(process.env.PORT) || 2567;

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

gameServer.listen(port).then(() => {
  console.log(`[ace-defense] listening on :${port}`);
  // PM2 (which is how Colyseus Cloud runs us) is configured with
  // `wait_ready: true`, so it holds the instance in "launching" until this
  // arrives. Under `node build/index.js` there is no parent to send to and
  // process.send is undefined — hence the guard.
  process.send?.('ready');
}).catch((err) => {
  console.error('[ace-defense] failed to start', err);
  process.exit(1);
});
