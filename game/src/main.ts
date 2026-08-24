import './ui/styles.css';
import { Game } from './game/Game';
import { NetClient } from './net/NetClient';
import { GFX, installSpriteVars } from './ui/gfx';
import { CLASSES, DEFAULT_CLASS, type ClassId } from './player/classes';
import { WEAPONS } from './weapons/definitions';
import { money } from './ui/format';

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
const startLogo = el<HTMLImageElement>('start-logo');
const startBtn = el('start-btn');
const lobbyList = el('lobby-list');
const lobbyCount = el('lobby-count');
const classSelect = el('class-select');
const pauseScreen = el('pause');
const pauseStats = el('pause-stats');
const resumeBtn = el('resume-btn');
const gameOverScreen = el('gameover');
const goSub = el('go-sub');
const statsGrid = el('stats-grid');
const restartBtn = el('restart-btn');

// Served from `public/`, so the URL is resolved through the same base-aware
// helper the stylesheet's sprites go through rather than hardcoded here.
startLogo.src = GFX.logo;

const game = new Game(app);
game.hudRef.setVisible(false);

// Debug handle: lets you poke at the live game from the console.
(window as unknown as { game: Game }).game = game;

let ready = false;
/** Class you drop in as; picked on the title screen, changed in-run with TAB. */
let chosenClass: ClassId = DEFAULT_CLASS;
/** Local player name, once boot has settled on one. */
let playerName = '';
/** Poll handle for the title screen's roster; only runs while it's up. */
let lobbyTimer = 0;

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
  playerName = name;

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
    // The title screen sits over a live aerial shot of the spawn, so the world
    // has to be on screen before the overlay is revealed.
    game.startPreview();
    startLobbyPolling();
    chosenClass = game.classId;
    buildClassSelect();
    startScreen.classList.remove('hidden');
  } catch (err) {
    loadingText.textContent = `Failed to start: ${(err as Error).message}`;
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Title-screen class pick
// ---------------------------------------------------------------------------
/**
 * Which gun you land with, chosen before you drop.
 *
 * Deliberately only the class name and the weapon under it: at the title
 * screen the question is "which gun", and a wall of damage numbers is noise to
 * someone who has not played a round yet. The full cards -- role, stats, the
 * blurb -- are the in-run picker on TAB, where the choice is an informed one.
 */
function buildClassSelect(): void {
  classSelect.innerHTML = '';
  for (const def of CLASSES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pick';
    card.dataset.class = def.id;

    const name = document.createElement('div');
    name.className = 'pick-name';
    name.textContent = def.name;

    const gun = document.createElement('div');
    gun.className = 'pick-gun';
    gun.textContent = WEAPONS[def.weapon].name;

    card.append(name, gun);
    card.addEventListener('click', () => pickClass(def.id));
    classSelect.appendChild(card);
  }
  markChosenClass();
}

function pickClass(id: ClassId): void {
  chosenClass = id;
  // Applied straight away rather than at JOIN, so the loadout and the view
  // model are already holding the right gun when the run starts.
  game.chooseClass(id);
  markChosenClass();
}

function markChosenClass(): void {
  for (const card of Array.from(classSelect.children) as HTMLElement[]) {
    card.classList.toggle('active', card.dataset.class === chosenClass);
  }
}

// ---------------------------------------------------------------------------
// Title-screen lobby
// ---------------------------------------------------------------------------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
  ));
}

/**
 * Draws the player list under the logo.
 *
 * `lobbyRoster()` returning null means this build has no server to ask, which
 * is different from an empty room: the list says the servers aren't up yet
 * rather than claiming nobody is playing.
 */
function renderLobby(): void {
  const roster = game.lobbyRoster();

  if (!roster) {
    lobbyCount.textContent = '—';
    lobbyList.innerHTML = `
      <div class="lobby-row you"><i></i><span>${escapeHtml(playerName || 'You')}</span><em>SOLO</em></div>
      <div class="lobby-empty">Servers come online soon — for now you drop in alone.</div>`;
    return;
  }

  lobbyCount.textContent = String(roster.length);
  if (roster.length === 0) {
    lobbyList.innerHTML = '<div class="lobby-empty">Nobody in the delta yet. Be the first.</div>';
    return;
  }
  lobbyList.innerHTML = roster
    .map((p) => `<div class="lobby-row${p.you ? ' you' : ''}"><i></i>`
      + `<span>${escapeHtml(p.name)}</span>${p.you ? '<em>YOU</em>' : ''}</div>`)
    .join('');
}

function startLobbyPolling(): void {
  renderLobby();
  window.clearInterval(lobbyTimer);
  // The roster is a Colyseus state view with no change event exposed here, so
  // the title screen samples it instead. It stops the moment the run begins.
  lobbyTimer = window.setInterval(renderLobby, 2000);
}

function stopLobbyPolling(): void {
  window.clearInterval(lobbyTimer);
  lobbyTimer = 0;
}

// ---------------------------------------------------------------------------
// Screen transitions
// ---------------------------------------------------------------------------
function beginRun(): void {
  if (!ready) return;
  game.chooseClass(chosenClass);
  stopLobbyPolling();
  startScreen.classList.add('hidden');
  gameOverScreen.classList.add('hidden');
  game.start();
}

/**
 * ESC. The card is mostly a controls reference -- the run state is one line of
 * context above it, not the point of the screen.
 */
function showPause(): void {
  if (!game.running || game.paused) return;
  game.setPaused(true);
  pauseStats.textContent =
    `RAID ${game.currentWave} · ${money(game.points)} · ${game.runStats.kills} KILLS`;
  pauseScreen.classList.remove('hidden');
}

function hidePause(): void {
  pauseScreen.classList.add('hidden');
  game.setPaused(false);
}

game.onGameOver = (stats) => {
  goSub.textContent = `You survived ${stats.wave} raid${stats.wave === 1 ? '' : 's'}`;
  const rows: [string, string][] = [
    ['Raids survived', String(stats.wave)],
    ['Total earned', money(stats.points)],
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
