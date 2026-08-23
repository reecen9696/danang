import './ui/styles.css';
import { Game } from './game/Game';
import { NetClient } from './net/NetClient';
import { installSpriteVars } from './ui/gfx';

// Must run before the first paint: the stylesheet reads the sprite URLs from
// custom properties rather than hardcoding paths it can't resolve.
installSpriteVars();

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e as T;
}

const app = el('app');
const loading = el('loading');
const loadingFill = el('loading-fill');
const loadingText = el('loading-text');
const startScreen = el('start');
const startBtn = el('start-btn');
const pauseScreen = el('pause');
const pauseStats = el('pause-stats');
const resumeBtn = el('resume-btn');
const gameOverScreen = el('gameover');
const goSub = el('go-sub');
const statsGrid = el('stats-grid');
const restartBtn = el('restart-btn');

const game = new Game(app);
game.hudRef.setVisible(false);

// Debug handle: lets you poke at the live game from the console.
(window as unknown as { game: Game }).game = game;

let ready = false;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const progress = (pct: number, label: string): void => {
  loadingFill.style.width = `${Math.round(pct * 100)}%`;
  loadingText.textContent = label;
};

/**
 * Where to find the server, and under what name.
 *
 * `?server=` overrides; otherwise we fall back to VITE_SERVER_URL baked in at
 * build time, and finally to localhost for development. Passing `?solo` forces
 * the original single-player path even when a server is configured.
 */
function netConfig(): { url: string | null; name: string } {
  const q = new URLSearchParams(location.search);
  if (q.has('solo')) return { url: null, name: '' };

  const explicit = q.get('server');
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  let url = explicit || configured || null;

  // A page served over https cannot open a ws:// socket.
  if (url && location.protocol === 'https:' && url.startsWith('ws://')) {
    url = 'wss://' + url.slice('ws://'.length);
  }

  const name = q.get('name')
    || localStorage.getItem('ace-name')
    || `Ace${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem('ace-name', name);
  return { url, name };
}

async function boot(): Promise<void> {
  const { url, name } = netConfig();

  try {
    if (url) {
      // Multiplayer: the server hands us the seed, so we connect *before*
      // generating terrain rather than regenerating it afterwards.
      progress(0.02, `Connecting to ${url}…`);
      const net = new NetClient();
      const init = await net.connect(url, name, {
        onInit: () => {},
        onVoxel: (op) => game.applyRemoteOp(op),
        onAnnounce: (m) => game.netAnnounce(m.text, m.tone),
        onBotFire: (m) => game.netBotFire(m),
        onBotVoice: (m) => game.netBotVoice(m),
        onShoot: () => {},
        onExplode: (m) => game.netExplode(m),
        onLeave: () => game.netDisconnected(),
      });

      progress(0.05, 'Generating shared terrain…');
      await game.init(progress, init.seed);
      game.attachNet(net, init);
    } else {
      await game.init(progress);
    }

    ready = true;
    loading.classList.add('hidden');
    startScreen.classList.remove('hidden');
  } catch (err) {
    loadingText.textContent = `Failed to start: ${(err as Error).message}`;
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Screen transitions
// ---------------------------------------------------------------------------
function beginRun(): void {
  if (!ready) return;
  startScreen.classList.add('hidden');
  gameOverScreen.classList.add('hidden');
  game.start();
}

function showPause(): void {
  if (!game.running || game.paused) return;
  game.setPaused(true);
  pauseStats.innerHTML = `
    <p>Wave <b>${game.currentWave}</b> &middot; <b>${game.points.toLocaleString()}</b> points
    &middot; <b>${game.runStats.kills}</b> kills</p>`;
  pauseScreen.classList.remove('hidden');
}

function hidePause(): void {
  pauseScreen.classList.add('hidden');
  game.setPaused(false);
}

game.onGameOver = (stats) => {
  goSub.textContent = `You survived ${stats.wave} wave${stats.wave === 1 ? '' : 's'}`;
  const rows: [string, string][] = [
    ['Waves survived', String(stats.wave)],
    ['Total points earned', stats.points.toLocaleString()],
    ['Kills', String(stats.kills)],
    ['Headshots', String(stats.headshots)],
    ['Accuracy', `${stats.accuracy}%`],
    ['Blocks placed', String(stats.blocksPlaced)],
    ['Blocks dug', String(stats.blocksDug)],
  ];
  statsGrid.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  gameOverScreen.classList.remove('hidden');
};

// Dev-only handle, so the game can be poked at from the console.
if (import.meta.env.DEV) (window as unknown as { game: unknown }).game = game;

startBtn.addEventListener('click', beginRun);
restartBtn.addEventListener('click', beginRun);
resumeBtn.addEventListener('click', hidePause);

// ESC pauses, but only when the shop isn't handling it.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  if (!game.running) return;
  if (game.menuOpen) return;
  if (game.paused) hidePause();
  else showPause();
});

// Losing pointer lock mid-combat should pause rather than leave you helpless.
document.addEventListener('pointerlockchange', () => {
  if (!game.running || game.paused) return;
  if (document.pointerLockElement) return;
  if (game.menuOpen) return;
  // Give the browser a beat: rapid lock/unlock cycles are normal on click.
  window.setTimeout(() => {
    if (game.running && !game.paused && !game.menuOpen && !document.pointerLockElement) showPause();
  }, 120);
});

// Clicking the canvas after an accidental unlock re-locks it.
app.addEventListener('click', () => {
  if (game.running && !game.paused && !game.menuOpen) game.inputRef.requestLock();
});

void boot();
