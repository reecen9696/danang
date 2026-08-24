/**
 * PM2 config. Colyseus Cloud runs the app through PM2 and looks for this file
 * at the repo root, next to package.json.
 *
 * `instances: 1` is deliberate, and not the value the Cloud template ships.
 * The template's `os.cpus().length` assumes @colyseus/tools, which offsets each
 * worker's port by NODE_APP_INSTANCE and puts the room registry behind a shared
 * presence. This server is built on bare @colyseus/core with local presence, so
 * a second worker would both fight for the same port and keep its own private
 * list of rooms — two players joining "the same" match could land on different
 * processes and never see each other. One process, one registry.
 */
module.exports = {
  apps: [
    {
      name: 'ace-defense',
      // Built by the root "build" script; ESM, resolved against server/package.json.
      script: 'server/build/index.js',
      time: true,
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      // The server calls process.send('ready') once the socket is actually
      // listening; without the longer window PM2 gives up during a cold start.
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 5000,
    },
  ],
};
