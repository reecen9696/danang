import * as THREE from 'three';
import {
  RENDER, PHYS, VITALS, WORLD_X, WORLD_Y, WORLD_Z, WATER_LEVEL, Mat, MATERIALS,
} from '../core/constants';
import { Input } from '../core/Input';
import { BOTS } from '../ai/botTypes';
import type { NetClient } from '../net/NetClient';
import { RemotePlayers } from '../net/RemotePlayers';
import type {
  BotFireMessage, BotVoiceMessage, ExplodeMessage, HurtMessage, InitMessage, VoxelOp,
} from '../net/protocol';
import { Renderer } from '../core/Renderer';
import { makeAceFog } from '../core/fog';
import { buildFlags } from '../fx/Flags';
import { Farmers } from '../fx/Farmers';
import { Rice } from '../fx/Rice';
import { Townsfolk, Carry } from '../fx/Townsfolk';
import { Ox } from '../fx/Ox';
import { Sky } from '../fx/Sky';
import { SunRig, makeShadowOnlyMaterial, ShadowQuality } from '../core/lighting';
import { VoxelWorld } from '../voxel/VoxelWorld';
import { ChunkManager } from '../voxel/ChunkManager';
import { generateWorld, prepareImportedMap, type MapLayout } from '../voxel/worldgen';
import { loadVxlFromUrl } from '../voxel/vxl';
import { raycastVoxels } from '../voxel/raycast';
import { palette, AIR, BUILD_HUES, BUILD_SHADES, COL_CORE, COL_SANDBAG, COL_STEEL } from '../voxel/palette';
import { Player, type MoveIntent } from '../player/Player';
import { Loadout, Slot, BUILDABLE } from '../player/Loadout';
import { ViewModel } from '../player/ViewModel';
import { WeaponId, HitZone, EXPLOSIONS, type ExplosionKind } from '../weapons/definitions';
import { type WeaponState } from '../weapons/WeaponState';
import { ProjectileSystem, ProjectileKind } from '../weapons/Projectiles';
import { BotManager, type BotImpact, type BotTarget } from '../ai/BotManager';
import { Bot, BotState, CORPSE_LIFE } from '../ai/Bot';
import { BotKind } from '../ai/botTypes';
import { NavGrid } from '../ai/NavGrid';
import { ParticleSystem } from '../fx/Particles';
import { TracerSystem } from '../fx/Tracers';
import { DecalSystem } from '../fx/Decals';
import { BloodSystem } from '../fx/Blood';
import { Economy, POINTS, ShopKind, ItemEffect, type ShopItem } from './Economy';
import {
  DeployableManager, DeployId, DEPLOYABLES, TURRET, occupies,
  type AmmoCrate, type DeployDef, type Turret,
} from './Deployables';
import { WaveManager, Phase } from './WaveManager';
import { BuildWheel } from '../ui/BuildWheel';
import { Garrison } from './Garrison';
import { visibilityOf } from '../ai/stealth';
import { Aggression, Rage } from './Aggression';
import { TunnelNetwork } from '../ai/TunnelNetwork';
import { HUD } from '../ui/HUD';
import { Minimap } from '../ui/Minimap';
import { ShopUI } from '../ui/Shop';
import { ClassId } from '../player/classes';
import { AudioEngine } from '../audio/Audio';
import { Radio } from '../audio/Radio';
import { Ambience } from '../audio/Ambience';
import { VillageMusic } from '../audio/VillageMusic';
import { Boombox, RadioButton } from '../fx/Boombox';
import { VoiceDirector } from '../audio/Voices';
import { VoiceCue } from '../audio/cues';

const TOWN_SHOP_RADIUS = 4.5;
/**
 * Half-extents of the shelf the village stands on, in blocks. What counts as
 * being in town, for the merchants and for the music alike.
 */
const TOWN_HALF_X = 26;
const TOWN_HALF_Z = 22;

/** How far away a radio button can still be pressed, in blocks. */
const RADIO_REACH = 3.5;
const REPAIR_HP_PER_BLOCK = 40;
/** How far away a deployable can be stood, from the eye. */
/**
 * Seconds the build key must be held before the wheel opens.
 *
 * Short enough that reaching for it feels immediate, long enough that a normal
 * tap — which is a few frames of key contact — never flashes a menu at you.
 */
const BUILD_WHEEL_HOLD = 0.17;

const DEPLOY_REACH = 7;
/** One quarter turn — the step Q and E rotate a deployable by. */
const HALF_TURN = Math.PI / 2;
/** Fraction of every reserve one pull from an ammo crate gives back. */
const CRATE_FRACTION = 0.5;
const REPAIR_RATE = 260;

/**
 * How far a shot carries as something an enemy can act on, in blocks.
 *
 * Not a mixing decision -- this is the radius inside which firing gives your
 * position away, and it is the price of every shot taken outside the wire. The
 * rifle is the loudest thing the player owns and the pistol the quietest, which
 * is the only reason to ever draw the pistol in the jungle.
 */
const GUN_NOISE: Partial<Record<WeaponId, number>> = {
  [WeaponId.Pistol]: 34,
  [WeaponId.SMG]: 46,
  [WeaponId.Shotgun]: 58,
  [WeaponId.Rifle]: 72,
  [WeaponId.Rocket]: 90,
  [WeaponId.MachineGun]: 84,
  [WeaponId.Thumper]: 76,
};

/**
 * The title-screen camera: a slow, high orbit of the spawn point.
 *
 * `height` over `radius` sets the tilt -- roughly 40 degrees down, which shows
 * the fort's layout the way a map does while still keeping the walls standing
 * up in frame rather than flattening them into a plan view.
 */
const PREVIEW = {
  radius: 38,
  height: 21,
  targetLift: 4,
  /** Radians per second. One full turn takes a little over three minutes. */
  orbitSpeed: 0.03,
  /** Where the orbit begins, so the first frame faces the town side. */
  startAngle: Math.PI * 0.75,
  /** Narrower than gameplay: less distortion at the frame edges. */
  fov: 52,
  /** The gameplay figure is tuned for eye level and hazes out an aerial shot. */
  fogDistance: 130,
} as const;

/** Hermite ease used by AoS to blend the sprint state. */
function smoothStep(x: number): number {
  return x * x * (3 - 2 * x);
}

const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

interface Merchant {
  kind: ShopKind;
  name: string;
  position: THREE.Vector3;
}

/**
 * Top-level game: owns the world, all subsystems and the frame loop.
 */
export class Game {
  readonly renderer: Renderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** Sun, sky ambient and the shadow map that follows the player. */
  private readonly sun = new SunRig();
  /** Block clouds and sun disc, re-centred on the eye every frame. */
  private sky: Sky | null = null;
  /**
   * Invisible stand-in for the local player's body: it writes neither colour
   * nor depth, so you see your own shadow on the ground without a torso being
   * drawn across the middle of the screen.
   */
  private playerShadowCaster!: THREE.Mesh;

  private readonly vmScene = new THREE.Scene();
  private readonly vmCamera: THREE.PerspectiveCamera;
  private readonly viewModel = new ViewModel();

  readonly world = new VoxelWorld();
  readonly chunks: ChunkManager;
  readonly player: Player;
  /**
   * The player, as the horde sees him.
   *
   * `BotManager` hunts a list of these rather than one hard-wired player,
   * because a server room has a squad to choose between. Single-player is the
   * degenerate case: one entry, pointing at the live position and velocity
   * vectors, with the mutable fields refreshed each frame.
   */
  private readonly botTarget: BotTarget = {
    id: '', pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    eyeY: 0, alive: true, visibility: 1,
  };
  readonly loadout = new Loadout();
  readonly economy = new Economy();
  readonly audio = new AudioEngine();
  /** Rations enemy chatter across the horde so it stays a squad, not a crowd. */
  private readonly voices = new VoiceDirector(this.audio);
  /** The boombox in the base, and the two songs on it. */
  readonly radio = new Radio(this.audio);
  /** Jungle bed, running under everything from the first frame of a run. */
  readonly ambience = new Ambience(this.audio);
  /** The song over the market square, heard only when you're down there. */
  readonly villageMusic = new VillageMusic(this.audio);
  private boombox: Boombox | null = null;
  /** The farmers out in the rice below the hill. Scenery, not actors. */
  private farmers: Farmers | null = null;
  /** The crop they are working, and the wind in it. */
  private rice: Rice | null = null;
  /** The merchants and the villagers around them. Scenery, like the farmers. */
  private townsfolk: Townsfolk | null = null;
  /** The village buffalo, grazing the open ground by the west gate. */
  private ox: Ox | null = null;
  /** Which of its buttons the player is looking at, or -1. */
  private aimedButton = -1;
  private readonly picker = new THREE.Raycaster();

  private layout!: MapLayout;
  private nav!: NavGrid;
  /**
   * Reused seed lists for the nav field: the core alone, or the core plus the
   * player. Preallocated because they're handed over every frame.
   */
  private readonly navSeeds = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  private readonly navSeedsCoreOnly = [{ x: 0, z: 0 }];
  /**
   * The player alone. Handed to the flow field once the valley stops caring
   * about the Core — see Aggression.huntsPlayer.
   */
  private readonly navSeedsPlayerOnly = [{ x: 0, z: 0 }];
  /** The tunnels under the valley, and every mouth cut into them so far. */
  private readonly tunnels = new TunnelNetwork();
  /** What the valley thinks of the player. Drives the schedule and the horde. */
  private readonly aggression = new Aggression();
  /** Seconds until angered locals may send another party of rats after you. */
  private hunterTimer = 0;
  private bots!: BotManager;
  private waves!: WaveManager;
  private projectiles!: ProjectileSystem;
  private particles!: ParticleSystem;
  private tracers!: TracerSystem;
  private decals!: DecalSystem;
  private blood!: BloodSystem;

  private readonly hud = new HUD();
  private readonly minimap: Minimap;
  private readonly shop: ShopUI;
  private readonly input: Input;

  private merchants: Merchant[] = [];
  private nearMerchant: Merchant | null = null;
  /** Turrets, ammo crates and the placement ghost. */
  private deployables!: DeployableManager;
  /** The crate the player is standing next to, if any. */
  private nearCrate: AmmoCrate | null = null;

  running = false;
  paused = false;
  private lastTime = 0;
  private accumulatedBlockDamage = 0;
  private readonly stats = { kills: 0, headshots: 0, blocksPlaced: 0, blocksDug: 0, shotsFired: 0, shotsHit: 0 };

  /**
   * Set only in multiplayer. When present the server owns the waves, the bots
   * and the world, and this client becomes a renderer plus an input source for
   * its own player. Null means the original single-player path, untouched.
   */
  private net: NetClient | null = null;
  private remotes: RemotePlayers | null = null;
  /** Terrain seed; overridden by the server's `init` before generation. */
  private seed = 1337;
  /** Suppresses re-sending an edit that arrived from the server. */
  private applyingRemoteOp = false;
  /** Bot slots present in the latest snapshot, so stale ones can be retired. */
  private readonly netBotSeen = new Set<number>();

  private readonly intent: MoveIntent = {
    forward: 0, strafe: 0, jump: false, sprint: false, crouch: false, sneak: false, aiming: false,
    speedScale: 1,
  };

  /** Eases 0..1 while sprinting; drives the AoS sprint camera bob. */
  private sprintState = 0;

  /** Title-screen flyover: see {@link startPreview}. */
  private previewing = false;
  private previewAngle = 0;
  private previewLast = 0;
  private readonly previewTarget = new THREE.Vector3();

  /** Mans the jungle camps. Built with the bots, in init. */
  private garrison: Garrison | null = null;
  /**
   * Seconds since the player last fired. A muzzle flash is the loudest thing
   * about a man, and it is the one part of being seen he controls completely.
   */
  private sinceFired = 99;

  private showPerf = false;
  private perfTimer = 0;
  private respawnTimer = 0;
  /** Seconds the build key has been held; past the threshold the wheel opens. */
  private buildHold = 0;
  private readonly buildWheel = new BuildWheel();
  private repairProgress = 0;

  onGameOver: ((stats: Record<string, number>) => void) | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);
    this.input = new Input(this.renderer.canvas);

    this.camera = new THREE.PerspectiveCamera(
      RENDER.fov, window.innerWidth / window.innerHeight, RENDER.near, RENDER.far,
    );
    this.camera.rotation.order = 'YXZ';

    // A narrower FOV than the world camera keeps the gun from distorting.
    this.vmCamera = new THREE.PerspectiveCamera(RENDER.vmFov, 1, 0.01, 8);
    this.vmScene.add(this.viewModel.group);

    this.scene.background = new THREE.Color(RENDER.skyColor);
    this.scene.fog = makeAceFog(RENDER.fogColor, RENDER.fogDistance);
    this.scene.add(this.sun.group);

    this.player = new Player(this.world);
    // Held by reference: the horde reads the same vectors the player moves.
    this.botTarget.pos = this.player.position;
    this.botTarget.vel = this.player.velocity;
    this.chunks = new ChunkManager(this.world);
    this.scene.add(this.chunks.group);

    this.minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement);
    this.shop = new ShopUI(this.economy);

    this.renderer.onResize = (w, h) => {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.vmCamera.aspect = w / h;
      this.vmCamera.updateProjectionMatrix();
      this.particles?.setViewportScale(h);
    };
    // The renderer sizes itself during construction, before the callback above
    // exists, so apply it once now or the viewmodel camera keeps aspect 1.
    this.renderer.onResize(this.renderer.displayWidth, this.renderer.displayHeight);

    this.setupShop();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  /**
   * Builds the world. In multiplayer `seed` comes from the server, so every
   * client generates byte-identical terrain and only edits need replicating.
   */
  async init(onProgress: (pct: number, label: string) => void, seed?: number): Promise<void> {
    if (seed !== undefined) this.seed = seed;
    // ?map=<url> imports a classic Ace of Spades .vxl instead of generating one.
    const mapUrl = new URLSearchParams(location.search).get('map');
    if (mapUrl) {
      onProgress(0.05, `Loading ${mapUrl}…`);
      await frame();
      try {
        await loadVxlFromUrl(this.world, mapUrl);
        onProgress(0.18, 'Preparing map…');
        await frame();
        this.layout = prepareImportedMap(this.world);
      } catch (err) {
        console.error('Map import failed, falling back to generated terrain:', err);
        onProgress(0.05, 'Map import failed — generating terrain…');
        await frame();
        this.layout = generateWorld(this.world, this.seed);
      }
    } else {
      onProgress(0.05, 'Generating terrain…');
      await frame();
      this.layout = generateWorld(this.world, this.seed);
    }
    this.world.rebuildHeights();

    // The network is already under the valley before anyone shoots at anyone:
    // the mouths carved by worldgen become the ones the horde comes up out of,
    // and the ones the player can go down.
    this.tunnels.clear();
    for (const h of this.layout.spiderHoles) {
      this.tunnels.add(h.x, h.z, h.floorY, h.standX, h.y, h.standZ, false);
    }

    onProgress(0.25, 'Building navigation…');
    await frame();
    this.nav = new NavGrid(this.world);
    this.nav.setSeeds([{ x: this.layout.baseCenter.x, z: this.layout.baseCenter.z }]);
    this.nav.rebuild();

    onProgress(0.3, 'Preparing systems…');
    this.particles = new ParticleSystem((x, y, z) => this.world.isSolid(x, y, z));
    this.particles.setViewportScale(window.innerHeight);
    this.tracers = new TracerSystem();
    this.decals = new DecalSystem(this.world);
    this.blood = new BloodSystem(this.world);
    this.scene.add(
      this.particles.points, this.tracers.lines, this.decals.group, this.blood.mesh,
    );
    // Flags are sub-voxel scenery rather than blocks, so they're mesh geometry
    // hung on the layout's flag sites instead of being written into the world.
    if (this.layout.flagSites.length > 0) {
      this.scene.add(buildFlags(this.layout.flagSites));
    }
    // The standing crop. Scenery for the same reason the flags are -- it is
    // finer than the grid and nothing should be able to stand on it -- but it
    // is the one piece of scenery in the map that changes a fight: get down in
    // a grown plot and the men crossing the field lose you (ai/BotManager).
    this.rice = new Rice(this.layout.ricePatches);
    this.scene.add(this.rice.mesh);
    // The village working the paddy below the hill. Client-side, like the
    // flags: nothing here collides or reaches the server. They can be shot,
    // and they run from anything that goes off near them, but that is resolved
    // entirely on this machine -- in multiplayer everyone's field empties on
    // their own screen, which is close enough for scenery.
    this.farmers = new Farmers({
      onStrike: (x, y, z) => this.mudSplash(x, y, z),
      // Half the field has a voice, and which voice it is follows the body:
      // the grown ones scream and the children scream like children. The
      // stagger is there because a field going up is not a chorus -- everyone
      // breaks a beat apart, and simultaneous cries read as one sample.
      onScream: (x, y, z, child) => this.audio.play(
        child ? 'scream-child' : 'scream-woman',
        this.distanceToPlayer(x, y, z),
        { delay: Math.random() * 0.22 },
      ),
    });
    this.scene.add(this.farmers.mesh);

    this.sky = new Sky();
    this.scene.add(this.sky.group);

    this.projectiles = new ProjectileSystem(this.world, {
      onExplode: (p, x, y, z) => this.explode(x, y, z, p.explosion, p.hostile, p.damageMultiplier),
      onTrail: (_p, x, y, z) => {
        this.particles.spawn(x, y, z, 0, 0.4, 0, 0.5, 0.5, 0.52, 0.45, 5, 0.5, -1, 1.6);
      },
      onBounce: (x, y, z) => this.audio.play('spade', this.distanceToPlayer(x, y, z)),
    });
    this.scene.add(this.projectiles.mesh);

    this.bots = new BotManager({
      world: this.world,
      nav: this.nav,
      // One man, because single-player is one man. The horde reads this list
      // the same way a server room's does; it just never has more than the
      // one entry in it.
      targets: [this.botTarget],
      objective: new THREE.Vector3(this.layout.baseCenter.x, this.layout.baseCenter.y, this.layout.baseCenter.z),
      onFire: (bot, tx, ty, tz) => this.botFire(bot, tx, ty, tz),
      onBreach: (bot, x, y, z) => this.botBreach(bot, x, y, z),
      onBuild: (bot, x, y, z, color, mat) => this.botBuild(bot, x, y, z, color, mat),
      onDig: (bot, x, y, z) => this.botDig(bot, x, y, z),
      onSpoil: (bot, x, y, z, strength) => this.spawnSpoil(bot, x, y, z, strength),
      onDeath: (bot) => this.onBotDeath(bot),
      onCorpseRest: (bot) => this.onCorpseRest(bot),
      onVoice: (bot, cue) => this.botVoice(bot, cue),
      tunnels: this.tunnels,
      aggression: 0,
    });
    this.scene.add(this.bots.mesh);
    this.garrison = new Garrison(this.bots);

    this.deployables = new DeployableManager(this.scene, this.world);

    this.waves = new WaveManager(this.bots, this.layout.spawnPoints, {
      onPhaseChange: (phase, wave) => this.onPhaseChange(phase, wave),
      onAnnounce: (t, tone) => {
        this.hud.showAnnounce(t, tone);
        this.hud.log(t, tone);
      },
      onWaveCleared: (wave) => this.onWaveCleared(wave),
    }, this.aggression);

    this.buildScenery();

    onProgress(0.35, 'Meshing chunks…');
    await this.chunks.meshAll((done, total) => {
      onProgress(0.35 + (done / total) * 0.6, `Meshing chunks… ${done}/${total}`);
    });

    onProgress(1, 'Ready');
  }

  // ---------------------------------------------------------------------------
  // Multiplayer
  // ---------------------------------------------------------------------------
  /**
   * Switches this client into multiplayer.
   *
   * Must be called after `init()` so the world already exists; the server's
   * edit log is replayed over it here.
   */
  attachNet(net: NetClient, init: InitMessage): void {
    this.net = net;
    this.remotes = new RemotePlayers();
    this.scene.add(this.remotes.mesh);

    // Catch up to the room: replay every edit made before we arrived.
    for (const op of init.ops) this.applyRemoteOp(op);
    // The ops marked their chunks dirty; the normal update pass remeshes them.
    this.chunks.update();

    this.player.position.set(init.spawn.x, init.spawn.y, init.spawn.z);
    this.layout.playerSpawn = init.spawn;
  }

  get isMultiplayer(): boolean {
    return this.net !== null;
  }

  /**
   * Who is in the room, for the title screen's player list.
   *
   * Null means there is no server on this build -- which is not the same as an
   * empty room, and the lobby says so rather than showing nobody online.
   */
  lobbyRoster(): { name: string; you: boolean }[] | null {
    if (!this.net) return null;
    const me = this.net.sessionId;
    return this.net.allPlayers().map((p) => ({ name: p.name, you: p.sessionId === me }));
  }

  /** Server-side announcement — same treatment as a local wave callout. */
  netAnnounce(text: string, tone: 'info' | 'good' | 'bad' | 'warn'): void {
    this.hud.showAnnounce(text, tone);
    this.hud.log(text, tone);
  }

  /**
   * A bot took a shot at somebody.
   *
   * Everyone renders the tracer; only the client that was actually aimed at
   * resolves the damage against itself, and its new hp travels back up in the
   * next move report.
   */
  netBotFire(m: BotFireMessage): void {
    const bot = this.bots.bots[m.slot];
    if (!bot || !bot.active) return;
    if (m.target && m.target === this.net?.sessionId) {
      this.botFire(bot, m.tx, m.ty, m.tz);
      return;
    }
    // Not our problem: draw the shot without resolving it.
    this.tracers.spawn(
      bot.position.x, bot.position.y + 2.0, bot.position.z,
      m.tx, m.ty, m.tz,
    );
    this.audio.play(
      this.soundForBotWeapon(bot.def.weapon),
      this.distanceToPlayer(bot.position.x, bot.position.y, bot.position.z),
    );
  }

  /**
   * You were shot by a squadmate.
   *
   * Friendly fire is on, so this resolves exactly like a bot's round: the
   * damage lands, the screen flashes, and the indicator points back at the
   * muzzle. The only difference is the kill feed, which names the man who did
   * it — being shot by your own side should never read as bad luck.
   */
  netHurt(m: HurtMessage): void {
    if (!this.player.alive) return;
    const wasAlive = this.player.alive;
    this.damagePlayer(m.damage, m.x, m.z);
    if (wasAlive && !this.player.alive) {
      this.hud.log(`${m.name} killed you`, 'bad');
    } else {
      this.hud.log(`${m.name} shot you`, 'warn');
    }
  }

  /**
   * An enemy shouting, over the wire.
   *
   * The AI is the server's, so the cue travels but the delivery doesn't: which
   * of that bot's recorded lines it becomes, and how loud it is from here, are
   * both decided locally — so two players in the same room hear the same man
   * from their own distance, which is the whole point.
   */
  netBotVoice(m: BotVoiceMessage): void {
    const bot = this.bots.bots[m.slot];
    if (!bot || !bot.active) return;
    this.botVoice(bot, m.cue);
  }

  /**
   * Another player's explosion.
   *
   * Effects only: the voxels it destroyed arrive separately as authoritative
   * ops, and any damage to us is resolved from our own simulation.
   */
  netExplode(m: ExplodeMessage): void {
    this.audio.play('explosion', this.distanceToPlayer(m.x, m.y, m.z));
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 6 + 2;
      const sp = Math.random() * 7 + 2;
      this.particles.spawn(
        m.x, m.y, m.z,
        Math.cos(a) * sp, up, Math.sin(a) * sp,
        1, 0.62, 0.24, 0.9,
        6, 0.7, 14, 0.9,
      );
    }
  }

  netDisconnected(): void {
    this.hud.log('Disconnected from server', 'bad');
    this.net = null;
  }

  /** Applies a voxel edit that came from the server. */
  applyRemoteOp(op: VoxelOp): void {
    this.applyingRemoteOp = true;
    if (op.op === 1) {
      this.world.remove(op.x, op.y, op.z);
    } else {
      this.world.set(op.x, op.y, op.z, op.color, op.mat);
    }
    this.applyingRemoteOp = false;
    this.decals.markDirty();
  }

  /**
   * Drives the bot pool from server snapshots instead of local AI.
   *
   * Slot indices match because both sides use the same fixed-size pool, so a
   * snapshot can be written straight into its slot.
   */
  private applyNetBots(dt: number): void {
    const net = this.net!;
    const pool = this.bots.bots;
    this.netBotSeen.clear();

    net.forEachBot((slot, s) => {
      const bot = pool[slot];
      if (!bot) return;
      this.netBotSeen.add(slot);
      if (!bot.active) {
        // First sighting of this slot: place it exactly, don't slide it in.
        bot.active = true;
        bot.position.set(s.x, s.y, s.z);
        bot.assignVoice(Math.random);
      }
      const wasState = bot.state;
      const wasX = bot.position.x;
      const wasZ = bot.position.z;
      bot.kind = s.kind;
      bot.def = BOTS[s.kind];
      bot.maxHp = s.maxHp;
      bot.hp = s.hp;
      bot.state = s.state;
      bot.yaw = s.yaw;
      // Ease toward the snapshot; state arrives well below frame rate.
      bot.position.x += (s.x - bot.position.x) * 0.35;
      bot.position.y += (s.y - bot.position.y) * 0.35;
      bot.position.z += (s.z - bot.position.z) * 0.35;
      // Chatter arrives as its own message; here we only keep the clock that
      // rations it running at the same rate the local AI would.
      bot.voiceTimer -= dt;
      // Same for the walk cycle: the snapshot says where the bot is, not how
      // it's moving, so the gait comes off the ground it just covered.
      if (bot.state !== BotState.Dying) this.bots.animate(bot, dt, wasX, wasZ);

      // Death is the server's call, but the fall is ours: the snapshot carries
      // where the body is, not which way it went over, so the ragdoll runs
      // locally at frame rate off the state change.
      if (bot.state === BotState.Dying) {
        if (wasState !== BotState.Dying) {
          bot.deathTimer = CORPSE_LIFE;
          bot.startRagdoll(Math.sin(bot.yaw), Math.cos(bot.yaw), 1, Math.random);
          this.onBotDeath(bot);
        }
        const settling = bot.settled;
        this.bots.animateCorpse(bot, Math.min(dt, 0.05));
        if (!settling && bot.fallPitch >= Math.PI * 0.5 - 1e-3) {
          bot.settled = true;
          this.onCorpseRest(bot);
        }
      }
    });

    for (let i = 0; i < pool.length; i++) {
      if (!this.netBotSeen.has(i) && pool[i].active) pool[i].active = false;
    }
    this.bots.refreshInstances();
  }

  /** Mirrors this player's transform and loadout up to the server. */
  private sendNetState(dt: number): void {
    const net = this.net!;
    const w = this.loadout.activeWeapon;
    net.sendMove(dt, {
      x: this.player.position.x,
      y: this.player.position.y,
      z: this.player.position.z,
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      hp: this.player.hp,
      alive: this.player.alive,
      slot: this.loadout.slot,
      weapon: String(w.def.id),
      sprinting: this.sprintState > 0.5,
    });
  }

  /** Water plane, merchant stalls and the Core marker. */
  private buildScenery(): void {
    const waterGeom = new THREE.PlaneGeometry(WORLD_X * 3, WORLD_Z * 3);
    const waterMat = new THREE.MeshBasicMaterial({
      color: 0x3d76a8, transparent: true, opacity: 0.66,
      depthWrite: false, fog: true, side: THREE.DoubleSide,
    });
    const water = new THREE.Mesh(waterGeom, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(WORLD_X / 2, WATER_LEVEL + 0.92, WORLD_Z / 2);
    water.renderOrder = 1;
    this.scene.add(water);

    // The merchants, and the rest of the village around them.
    //
    // Order matches the order the stalls are laid down the market street, so
    // which trade you find on which side of it is fixed by the map rather than
    // by whatever this loop happens to do.
    const merchantDefs: { kind: ShopKind; name: string; shirt: number }[] = [
      { kind: ShopKind.Weapons, name: 'WEAPON MERCHANT', shirt: 0x8f3a2e },
      { kind: ShopKind.Materials, name: 'MATERIALS MERCHANT', shirt: 0x2f5f86 },
      { kind: ShopKind.Defense, name: 'DEFENSE MERCHANT', shirt: 0x7d6f2c },
      { kind: ShopKind.Utility, name: 'UTILITY MERCHANT', shirt: 0x3f7a39 },
    ];

    // Same deal as the paddy: shootable, panicky, and entirely client-side.
    // The village has the same two voices the field has, and for the same
    // reason -- the person who cries out should sound like the person who was
    // shot at, not like a stock panic sample.
    this.townsfolk = new Townsfolk(merchantDefs.length + 10, {
      onScream: (x, y, z, child) => this.audio.play(
        child ? 'scream-child' : 'scream-woman',
        this.distanceToPlayer(x, y, z),
        { delay: Math.random() * 0.22 },
      ),
    });
    this.scene.add(this.townsfolk.mesh);

    this.layout.merchantSpots.forEach((spot, i) => {
      const def = merchantDefs[i % merchantDefs.length];
      this.townsfolk!.add({
        x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw,
        shirt: def.shirt, pose: 'counter', hat: i % 2 === 0,
        // The merchants are the shop. Rounds go through them and a panic goes
        // past them, because a stall you cannot buy from because you shot the
        // man behind it is a softlock rather than a consequence.
        killable: false,
      });
      this.merchants.push({
        kind: def.kind,
        name: def.name,
        position: new THREE.Vector3(spot.x, spot.y, spot.z),
      });
    });

    // Everyone else: they live here, so some of them are stood in their own
    // yards and some are walking the street between the stalls.
    const town = this.layout.townCenter;
    this.layout.villagerSpots.forEach((spot, i) => {
      const walker = i % 3 === 0;
      this.townsfolk!.add({
        x: spot.x, y: spot.y, z: spot.z,
        yaw: Math.atan2(town.x - spot.x, town.z - spot.z),
        scale: i % 5 === 4 ? 0.55 : 1,
        carry: walker ? Carry.Pole : (i % 4 === 1 ? Carry.Basket : Carry.None),
        wander: walker
          ? { x0: town.x - 20, z0: town.z - 2, x1: town.x + 20, z1: town.z + 2 }
          : undefined,
      });
    });

    // The buffalo, on the open grass inside the west gate -- the first thing
    // you walk past coming up the road, and the only thing in the village that
    // has no idea there is a war on.
    this.ox = new Ox({
      x: town.x - 18, y: town.y, z: town.z + 3,
      pasture: { x0: town.x - 23, z0: town.z - 6, x1: town.x - 13, z1: town.z + 6 },
    });
    this.scene.add(this.ox.mesh);

    this.placeBoombox();

    // A box the size of the player hitbox that only ever shows up in the shadow
    // map, so the player has a shadow of their own to see from first person.
    const casterGeom = new THREE.BoxGeometry(
      PHYS.playerRadius * 2, PHYS.heightStand, PHYS.playerRadius * 2,
    );
    this.playerShadowCaster = new THREE.Mesh(casterGeom, makeShadowOnlyMaterial());
    this.playerShadowCaster.castShadow = true;
    this.playerShadowCaster.receiveShadow = false;
    this.playerShadowCaster.frustumCulled = false;
    this.scene.add(this.playerShadowCaster);

  }

  /**
   * Stands the boombox somewhere sensible inside the wire.
   *
   * The base is scraped flat but not empty — there are sandbag walls and a Core
   * in the middle of it — so rather than trusting a fixed offset this walks a
   * ring around the centre and takes the first spot with solid ground at the
   * plateau's own height and room to stand something on it. It faces outward,
   * away from the Core, so you see the front of it on the way in rather than
   * having to walk around the thing.
   */
  private placeBoombox(): void {
    const base = this.layout.baseCenter;
    // Sweep outward from the spawn side, so the first spot that works is also
    // the one the player is most likely to walk into.
    for (let radius = 3; radius <= 10; radius++) {
      for (let step = 0; step < 16; step++) {
        const a = Math.PI / 2 + Math.ceil(step / 2) * (Math.PI / 8) * (step % 2 ? -1 : 1);
        const x = Math.round(base.x + Math.cos(a) * radius);
        const z = Math.round(base.z + Math.sin(a) * radius);
        if (this.world.surfaceHeight(x, z) !== base.y) continue;

        const cx = x + 0.5;
        const cz = z + 0.5;
        const len = Math.hypot(cx - base.x, cz - base.z) || 1;
        const fx = (cx - base.x) / len;
        const fz = (cz - base.z) / len;

        // Room where it stands and room where it faces. A boombox with its
        // buttons up against a sandbag wall is a boombox nobody can press, and
        // the base has plenty of wall in it.
        if (!this.standingRoom(x, z, base.y)) continue;
        if (!this.standingRoom(Math.round(cx + fx), Math.round(cz + fz), base.y)) continue;
        // It is wider than the cell it stands in, so check its shoulders too.
        if (!this.standingRoom(Math.round(cx - fz), Math.round(cz + fx), base.y)) continue;
        if (!this.standingRoom(Math.round(cx + fz), Math.round(cz - fx), base.y)) continue;

        this.boombox = new Boombox(cx, base.y, cz, Math.atan2(fx, fz));
        this.scene.add(this.boombox.group);
        return;
      }
    }
  }

  /** Solid ground and two clear blocks above it, at one column. */
  private standingRoom(x: number, z: number, y: number): boolean {
    return this.world.isSolid(x, y - 1, z)
      && !this.world.isSolid(x, y, z)
      && !this.world.isSolid(x, y + 1, z);
  }

  private setupShop(): void {
    this.shop.onBuy = (item) => this.buy(item);
    this.shop.onClose = () => {
      this.input.uiCapture = false;
      if (this.running && !this.paused) this.input.requestLock();
    };
    this.shop.isAvailable = (item) => {
      if (item.effect === ItemEffect.Scope) return this.loadout.hasWeapon(WeaponId.Rifle);
      return true;
    };
    this.shop.ownedLabel = (item) => {
      if (item.effect === ItemEffect.GiveBlocks && item.material !== undefined) {
        return `You have ${this.loadout.blocks[item.material]}`;
      }
      if (item.effect === ItemEffect.GiveDeployable && item.deployable !== undefined) {
        const carried = this.loadout.deployStock(item.deployable);
        const out = this.deployables.countOf(item.deployable);
        const cap = DEPLOYABLES[item.deployable].maxPlaced;
        return out > 0 && cap !== Infinity
          ? `Carrying ${carried} · ${out}/${cap} deployed`
          : `Carrying ${carried}`;
      }
      if (item.effect === ItemEffect.TurretAmmo) {
        return `${this.deployables.turrets.length} sentries out`;
      }
      if (item.effect === ItemEffect.RefillAmmo || item.effect === ItemEffect.AmmoBox) {
        const w = this.loadout.gun;
        return `${w.def.name} reserve ${w.stock}/${w.capacity}`;
      }
      if (item.effect === ItemEffect.Toughness) {
        const extra = Math.round(this.player.maxHp - VITALS.pool);
        return extra > 0 ? `+${extra}% tougher than issue` : 'Standard issue';
      }
      return null;
    };
  }

  /**
   * The class pick, made on the title screen before the run exists: no rack
   * sound and no HUD line, because there is no audio context and no HUD to
   * write to yet. It is the only place the class is chosen -- you drop in with
   * the gun you picked and that is the gun you fight the run with.
   */
  chooseClass(id: ClassId): void {
    if (!this.loadout.setClass(id)) return;
    this.viewModel.select(this.loadout.activeWeapon.id);
  }

  get classId(): ClassId {
    return this.loadout.classId;
  }

  // -------------------------------------------------------------------------
  // Menu preview
  // -------------------------------------------------------------------------
  /**
   * Slow aerial orbit of the base, rendered behind the title screen.
   *
   * It reuses the run's own scene and camera rather than a second render
   * target: nothing here simulates, so the cost is one draw of terrain the
   * boot sequence has already meshed. Fog is pushed back for the duration --
   * the gameplay figure is tuned for eye level and would bury a shot taken
   * from thirty blocks up in haze.
   */
  startPreview(): void {
    if (this.previewing || this.running) return;
    this.previewing = true;
    this.previewAngle = PREVIEW.startAngle;
    this.previewLast = performance.now();
    (this.scene.fog as THREE.Fog).far = PREVIEW.fogDistance;
    this.camera.fov = PREVIEW.fov;
    this.camera.updateProjectionMatrix();
    requestAnimationFrame(this.previewLoop);
  }

  /** Hands the camera and the fog back to the run. */
  stopPreview(): void {
    if (!this.previewing) return;
    this.previewing = false;
    (this.scene.fog as THREE.Fog).far = RENDER.fogDistance;
    this.camera.fov = RENDER.fov;
    this.camera.updateProjectionMatrix();
  }

  private readonly previewLoop = (now: number): void => {
    if (!this.previewing) return;
    requestAnimationFrame(this.previewLoop);

    const frameStart = performance.now();
    let dt = (now - this.previewLast) / 1000;
    this.previewLast = now;
    if (dt > 0.1) dt = 0.1;

    this.previewAngle += dt * PREVIEW.orbitSpeed;

    // Look at the spawn point itself, a little above the deck so the core and
    // the walls around it sit in frame rather than the dirt in front of them.
    const spawn = this.layout.playerSpawn;
    const target = this.previewTarget.set(spawn.x, spawn.y + PREVIEW.targetLift, spawn.z);
    this.camera.position.set(
      target.x + Math.sin(this.previewAngle) * PREVIEW.radius,
      target.y + PREVIEW.height,
      target.z + Math.cos(this.previewAngle) * PREVIEW.radius,
    );
    this.camera.lookAt(target);

    // The village keeps working while you read the controls; it's the only
    // thing on screen that moves, and a still frame reads as a screenshot.
    this.farmers?.update(dt);
    this.rice?.update(dt);
    this.townsfolk?.update(dt, this.camera.position.x, this.camera.position.y, this.camera.position.z);
    this.ox?.update(dt);
    this.chunks.setFocus(this.camera.position);
    this.chunks.update();

    this.sun.update(this.previewTarget);
    this.sky?.update(this.camera.position);

    const r = this.renderer.renderer;
    r.info.reset();
    r.clear();
    r.render(this.scene, this.camera);

    this.renderer.sample(performance.now() - frameStart);
  };

  // -------------------------------------------------------------------------
  // Run control
  // -------------------------------------------------------------------------
  start(): void {
    this.stopPreview();
    this.resetRun();
    this.running = true;
    this.paused = false;
    this.lastTime = performance.now();
    this.audio.resume();
    this.ambience.start();
    this.input.requestLock();
    this.hud.setVisible(true);
    this.aggression.reset();
    this.hunterTimer = 60;
    this.waves.startRun();
    this.manOutposts();
    requestAnimationFrame(this.loop);
  }

  private resetRun(): void {
    this.economy.reset();
    this.stats.kills = 0;
    this.stats.headshots = 0;
    this.stats.blocksPlaced = 0;
    this.stats.blocksDug = 0;
    this.stats.shotsFired = 0;
    this.stats.shotsHit = 0;
    this.bots.clear();
    this.projectiles.clear();
    this.particles.clear();
    this.tracers.clear();
    this.blood.clear();
    this.deployables.clear();
    this.loadout.clearDeployables();
    this.farmers?.respawn();
    this.townsfolk?.respawn();
    this.player.maxHp = 100;
    this.player.respawn(this.layout.playerSpawn.x, this.layout.playerSpawn.y + 1, this.layout.playerSpawn.z);
    this.player.yaw = Math.PI * 0.75;
    this.player.pitch = -0.05;
    this.viewModel.select(this.loadout.activeWeapon.id);
  }

  /**
   * Posts men at every jungle camp that is short of them.
   *
   * Single-player only. In multiplayer the horde is the server's, and a client
   * spawning its own garrison would be spawning men nobody else can see and the
   * server would sweep back out from under it on the next snapshot.
   */
  private manOutposts(): void {
    if (this.net || !this.garrison) return;
    const posted = this.garrison.reinforce(this.layout.outposts, Math.max(1, this.waves.wave));
    if (posted > 0) this.hud.log('Movement reported in the treeline', 'warn');
  }

  /**
   * How readable the player is this frame, and how close anyone is to acting
   * on it.
   *
   * The whole stealth system meets the rest of the game here: one number goes
   * out to the horde, one comes back for the HUD. Everything in between --
   * stance, speed, muzzle flash, who is facing which way -- is ai/stealth.ts
   * and BotManager's perception.
   */
  private updateStealth(dt: number): void {
    this.sinceFired += dt;

    const p = this.player;
    this.botTarget.visibility = visibilityOf({
      speed: Math.hypot(p.velocity.x, p.velocity.z) * PHYS.velocityScale,
      sprinting: p.sprinting,
      crouching: p.crouching,
      sneaking: this.intent.sneak,
      sinceFired: this.sinceFired,
    });

    // Footfalls. Sneaking is silent, walking barely carries, and running
    // through the trees is the second loudest thing the player can do.
    if (!this.intent.sneak && !p.airborne) {
      const noise = p.sprinting ? 15 : 8;
      if (Math.hypot(p.velocity.x, p.velocity.z) * PHYS.velocityScale > 2) {
        this.bots.hearNoise(p.position.x, p.position.z, noise, dt * 0.5);
      }
    }

    const { level, spotted } = this.bots.detection;
    this.hud.setDetection(level, spotted);
  }

  setPaused(on: boolean): void {
    this.paused = on;
    if (on) {
      this.input.exitLock();
    } else {
      this.lastTime = performance.now();
      this.input.requestLock();
      this.audio.resume();
      // Covers the case where the very first gesture was the pause menu, so
      // start() ran above with no context to attach to.
      this.ambience.start();
    }
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------
  private readonly loop = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);

    const frameStart = performance.now();
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > 0.1) dt = 0.1;

    if (!this.paused) this.update(dt);
    this.render();

    this.renderer.sample(performance.now() - frameStart);
    this.input.endFrame();
  };

  private update(dt: number): void {
    this.handleHotkeys(dt);

    if (this.player.alive) {
      this.updateLook();
      this.buildIntent();
      this.player.update(dt, this.intent);
      // Movement carries on while the wheel is up — you should be able to keep
      // running for cover while you pick — but the trigger does not, or every
      // flick of the mouse would also be a shot fired at the floor.
      if (!this.buildWheel.open) this.handleActions(dt);
    } else {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.doRespawn();
    }

    this.loadout.update(dt, (w) => this.onReloadStep(w));

    this.aggression.update(dt);
    this.updateHunters(dt);

    // Keep what the horde is hunting in sync with the player.
    this.botTarget.eyeY = this.player.eyeY;
    this.botTarget.alive = this.player.alive && this.player.invulnerable <= 0;
    const ctx = (this.bots as unknown as { ctx: { aggression: number } }).ctx;
    ctx.aggression = this.aggression.value;

    // The flow field is seeded on both objectives, so bots route at whichever of
    // the core and the player is cheaper to reach rather than always funnelling
    // to one point. Seeds are cheap; only the rebuild inside nav.update costs.
    //
    // Past a certain amount of anger the Core comes off the list entirely. That
    // is the whole of "they hunt you down": the field stops describing a route
    // to your base and starts describing a route to you, and every man on the
    // map is reading it.
    this.navSeeds[0].x = this.navSeedsCoreOnly[0].x = this.layout.baseCenter.x;
    this.navSeeds[0].z = this.navSeedsCoreOnly[0].z = this.layout.baseCenter.z;
    this.navSeeds[1].x = this.navSeedsPlayerOnly[0].x = this.player.position.x;
    this.navSeeds[1].z = this.navSeedsPlayerOnly[0].z = this.player.position.z;
    this.nav.setSeeds(
      !this.player.alive ? this.navSeedsCoreOnly
        : this.aggression.huntsPlayer ? this.navSeedsPlayerOnly
          : this.navSeeds,
    );

    if (this.net) {
      // Server-authoritative: no local AI, no local wave clock. Bots and the
      // wave schedule arrive as snapshots; we only render and report.
      this.applyNetBots(dt);
      this.sendNetState(dt);
      this.remotes!.begin();
      this.net.forEachRemote((r) => this.remotes!.apply(r));
      this.remotes!.end(dt);
    } else {
      this.nav.update(dt);
      this.bots.update(dt);
    }
    this.voices.update(dt);
    this.updateRadio(dt);
    // The village's own song, which is there because the village is, not
    // because anyone switched it on.
    this.villageMusic.setListener(this.distanceOutsideTown(), dt);
    this.farmers?.update(dt);
    this.rice?.update(dt);
    this.projectiles.update(dt);
    this.particles.update(dt);
    this.tracers.update(dt);
    this.decals.update();
    this.blood.update(dt);
    if (!this.net) this.waves.update(dt);

    // Sentries fire on their own clock, in single-player and in multiplayer
    // alike: they're local kit, like the blocks you place, and the damage they
    // do is reported the same way a bullet of yours is.
    this.deployables.update(dt, this.bots, (t, target, muzzle) => this.turretFire(t, target, muzzle), tmpVec2);
    this.updateDeployGhost();

    this.chunks.setFocus(this.player.position);
    this.chunks.update();

    // The village watches you walk through it, so it needs to know where you
    // are before the camera moves.
    this.townsfolk?.update(
      dt, this.player.position.x, this.player.position.y, this.player.position.z,
    );
    this.ox?.update(dt);

    this.updateCamera(dt);
    this.updateMerchantPrompt();
    this.updateStealth(dt);
    this.updateHud(dt);

    this.minimap.update(
      dt, this.player.position.x, this.player.position.z, this.player.yaw,
      this.bots,
      { x: this.layout.baseCenter.x, z: this.layout.baseCenter.z },
      { x: this.layout.townCenter.x, z: this.layout.townCenter.z },
      this.isInTown(),
    );

    if (this.showPerf) {
      this.perfTimer -= dt;
      if (this.perfTimer <= 0) {
        this.perfTimer = 0.25;
        this.updatePerf();
      }
    }
  }

  /**
   * Keeps the shadow box centred on the player and the player's own
   * shadow-caster box sitting on their feet.
   */
  private updateLighting(): void {
    const p = this.player.position;
    this.sun.update(p);

    this.playerShadowCaster.visible = this.player.alive;
    if (this.player.alive) {
      // `player.position` is the foot position; the box is centred.
      this.playerShadowCaster.scale.y = this.player.height / PHYS.heightStand;
      this.playerShadowCaster.position.set(p.x, p.y + this.player.height / 2, p.z);
      this.playerShadowCaster.updateMatrixWorld();
    }
  }

  private render(): void {
    // Driven from render rather than update so the shadow box is correct even
    // on frames where the simulation is paused.
    this.updateLighting();
    // Same reason: the sky has to track the eye on paused frames too, or it
    // slides off as soon as the camera is moved without a simulation step.
    this.sky?.update(this.camera.position);

    const r = this.renderer.renderer;
    r.info.reset();
    r.clear();
    r.render(this.scene, this.camera);
    // Second pass over a cleared depth buffer keeps the gun out of walls.
    // Colour is deliberately NOT cleared here — that would wipe the world.
    r.clearDepth();
    r.render(this.vmScene, this.vmCamera);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  private handleHotkeys(dt: number): void {
    const inp = this.input;

    if (inp.wasPressed('F3')) {
      this.showPerf = this.hud.togglePerf();
    }

    if (inp.wasPressed('F4')) {
      const q = this.sun.cycleShadowQuality();
      this.hud.log(
        q === ShadowQuality.Off ? 'Shadows off' : `Shadows: ${this.sun.qualityLabel}`,
        'info',
      );
    }

    // A menu, a pause or a death closes the wheel outright: it is a thing you
    // are holding a key down for, and none of those states are ones you are
    // still holding a key down through.
    if (this.buildWheel.open && (this.shop.open || this.menuOpen || !this.player.alive)) {
      this.buildWheel.hide();
      this.buildHold = 0;
    }

    if (this.shop.open) {
      if (inp.wasPressed('Escape') || inp.wasPressed('KeyE') || inp.wasPressed('KeyB')) this.shop.close();
      return;
    }

    // Gun on 1. Everything else is a tool, and a tool is something you go and
    // get; the gun is something you should already be holding.
    if (inp.wasPressed('Digit1')) {
      if (this.loadout.slot === Slot.Gun) { this.loadout.cycleGun(1); this.audio.play('rack'); }
      this.selectSlot(Slot.Gun);
    }
    if (inp.wasPressed('Digit2')) this.selectSlot(Slot.Spade);
    if (inp.wasPressed('Digit3')) this.selectSlot(Slot.Block);
    if (inp.wasPressed('Digit4')) this.selectSlot(Slot.Grenade);
    this.updateBuildKey(dt);

    if (inp.wasPressed('KeyR')) {
      const w = this.loadout.activeWeapon;
      if (w.beginReload()) this.playReload(w);
    }

    if (inp.wasPressed('KeyQ')) {
      if (this.loadout.slot === Slot.Build) this.rotateDeploy(-1);
      else this.loadout.cycleMaterial(1);
    }
    if (inp.wheelDelta !== 0) {
      const dir = inp.wheelDelta > 0 ? 1 : -1;
      if (this.loadout.slot === Slot.Block) this.loadout.cycleMaterial(dir);
      else if (this.loadout.slot === Slot.Build) this.loadout.cycleDeployable(dir);
      else { this.loadout.cycleGun(dir); this.audio.play('rack'); }
    }

    // Colour palette (AoS-style arrow-key cycling).
    if (inp.wasPressed('ArrowLeft')) { this.loadout.colorHue = (this.loadout.colorHue + BUILD_HUES - 1) % BUILD_HUES; this.loadout.useMaterialColor = false; }
    if (inp.wasPressed('ArrowRight')) { this.loadout.colorHue = (this.loadout.colorHue + 1) % BUILD_HUES; this.loadout.useMaterialColor = false; }
    if (inp.wasPressed('ArrowUp')) { this.loadout.colorShade = Math.min(BUILD_SHADES - 1, this.loadout.colorShade + 1); this.loadout.useMaterialColor = false; }
    if (inp.wasPressed('ArrowDown')) { this.loadout.colorShade = Math.max(0, this.loadout.colorShade - 1); this.loadout.useMaterialColor = false; }
    if (inp.wasPressed('KeyC')) this.loadout.useMaterialColor = !this.loadout.useMaterialColor;

    if (inp.wasPressed('KeyG') && this.loadout.grenades.stock > 0) {
      this.selectSlot(Slot.Grenade);
    }

    if (inp.wasPressed('KeyE') || inp.wasPressed('KeyB')) {
      // E rotates while you're holding something to place -- but anything you
      // could actually press E *on* still wins, and the prompt says which it
      // is, so standing at a merchant never leaves you unable to open it.
      if (this.loadout.slot === Slot.Build && inp.wasPressed('KeyE')
        && this.loadout.deployStock(this.loadout.deploySelected) > 0
        && !this.hasInteractTarget()) {
        this.rotateDeploy(1);
      } else {
        this.interact();
      }
    }
  }

  /**
   * The build key: tap to equip, hold to choose.
   *
   * The split is what makes one key do both jobs without either getting in the
   * other's way. A tap is the fast path — put down another of whatever I was
   * putting down — and never shows a menu. Past the hold threshold the wheel
   * opens and the key becomes a modifier: mouse movement is steering the
   * picker rather than the player, and letting go commits.
   */
  private updateBuildKey(dt: number): void {
    const inp = this.input;
    const held = inp.isDown('Digit5');

    if (inp.wasPressed('Digit5')) {
      this.buildHold = 0;
      this.selectSlot(Slot.Build);
    }

    if (held && !this.buildWheel.open) {
      this.buildHold += dt;
      if (this.buildHold >= BUILD_WHEEL_HOLD) {
        this.buildWheel.show(this.loadout);
        this.audio.play('rack');
      }
    }

    if (this.buildWheel.open) {
      // The wheel eats the mouse while it's up. Zeroing the deltas here rather
      // than gating updateLook keeps the ownership in one place: whoever
      // consumes the movement is responsible for spending it.
      this.buildWheel.move(inp.mouseDX, inp.mouseDY);
      inp.mouseDX = 0;
      inp.mouseDY = 0;
    }

    if (!inp.wasReleased('Digit5')) return;

    const picked = this.buildWheel.open ? this.buildWheel.highlighted : null;
    this.buildWheel.hide();
    this.buildHold = 0;
    if (picked === null) return;

    this.loadout.deploySelected = picked;
    this.selectSlot(Slot.Build);
    this.audio.play('rack');
    if (this.loadout.deployStock(picked) === 0) {
      this.hud.log(`No ${DEPLOYABLES[picked].name.toLowerCase()} — buy one at a merchant`, 'warn');
    }
  }

  /**
   * Is E currently pointed at something? Rotation only takes the key if not.
   *
   * With a deployable in hand E is a rotate key, so anything E can interact
   * with has to be something you are actually standing at or aiming into.
   */
  private hasInteractTarget(): boolean {
    if (this.shop.open) return true;
    if (this.aimedButton >= 0) return true;
    return Boolean(this.nearCrate || this.nearMerchant);
  }

  private rotateDeploy(dir: number): void {
    this.loadout.rotateDeployable(dir);
    this.audio.play('rack');
  }

  private selectSlot(slot: Slot): void {
    if (this.loadout.slot === slot) return;
    this.loadout.activeWeapon.cancelReload();
    this.loadout.slot = slot;
    this.viewModel.select(this.loadout.activeWeapon.id);
    if (slot === Slot.Gun) this.audio.play('rack');
  }

  /**
   * Reload audio is two recordings — magazine out, magazine in — pinned to the
   * ends of the weapon's own reload window, so it stays in sync even with the
   * Fast Reload upgrade. Shell-at-a-time guns get one shell per step instead.
   */
  private playReload(w: WeaponState): void {
    const window = w.def.reloadTime * this.loadout.reloadModifier();
    if (w.def.reloadSlow) {
      this.audio.play('shell-load', 0, { fit: window });
      return;
    }
    if (!w.def.reloadOut && !w.def.reloadIn) {
      this.audio.play('reload');
      return;
    }
    if (w.def.reloadOut) this.audio.play(w.def.reloadOut, 0, { fit: window * 0.5 });
    if (w.def.reloadIn) this.audio.play(w.def.reloadIn, 0, { endAt: window, fit: window * 0.6 });
  }

  /** One shell seated: load the next, or slam the action shut when we're full. */
  private onReloadStep(w: WeaponState): void {
    if (!w.def.reloadSlow) return;
    if (w.reloading) this.playReload(w);
    else this.audio.play('bolt-release');
  }

  private updateLook(): void {
    const inp = this.input;
    if (!inp.locked) return;
    // Aiming down sights slows the turn rate proportionally to the zoom.
    const zoom = this.viewModel.adsAmount;
    const sens = inp.sensitivity * (1 - zoom * 0.55);
    this.player.yaw -= inp.mouseDX * sens;
    this.player.pitch -= (inp.invertY ? -1 : 1) * inp.mouseDY * sens;
    const limit = Math.PI / 2 - 0.01;
    this.player.pitch = Math.max(-limit, Math.min(limit, this.player.pitch));
  }

  private buildIntent(): void {
    const inp = this.input;
    const i = this.intent;
    i.forward = (inp.isDown('KeyW') ? 1 : 0) - (inp.isDown('KeyS') ? 1 : 0);
    i.strafe = (inp.isDown('KeyD') ? 1 : 0) - (inp.isDown('KeyA') ? 1 : 0);
    i.jump = inp.isDown('Space');
    i.sprint = inp.isDown('ShiftLeft') || inp.isDown('ShiftRight');
    i.crouch = inp.isDown('ControlLeft') || inp.isDown('ControlRight');
    i.sneak = inp.isDown('KeyV');
    i.aiming = inp.mouseRight && this.isGunSlot();

    // Light Boots: 15% more ground speed. This has to scale acceleration --
    // the movement code normalises the input vector, so scaling the axes there
    // would do nothing.
    i.speedScale = this.loadout.speedBoost ? 1.15 : 1;
  }

  private isGunSlot(): boolean {
    return this.loadout.slot === Slot.Gun;
  }

  // -------------------------------------------------------------------------
  // Player actions
  // -------------------------------------------------------------------------
  private handleActions(dt: number): void {
    if (this.shop.open || !this.input.locked) return;
    const inp = this.input;
    const loadout = this.loadout;

    switch (loadout.slot) {
      case Slot.Spade:
        if (inp.mouseLeftPressed || (inp.mouseLeft && loadout.spade.cooldown <= 0)) this.swingSpade();
        break;

      case Slot.Block:
        if (inp.mouseRightPressed) this.sampleColor();
        if (inp.mouseLeft) this.useBlockTool(dt);
        else this.repairProgress = 0;
        break;

      case Slot.Gun: {
        const w = loadout.gun;
        const wantFire = w.def.automatic ? inp.mouseLeft : inp.mouseLeftPressed;
        if (wantFire) this.fireGun();
        break;
      }

      case Slot.Grenade:
        if (inp.mouseLeftPressed) this.throwGrenade();
        break;

      case Slot.Build:
        if (inp.mouseLeftPressed) this.placeDeployable();
        break;
    }
  }

  private swingSpade(): void {
    const spade = this.loadout.spade;
    if (!spade.consume()) return;
    this.viewModel.fire(0.02, 0);
    this.audio.play('spade');

    this.player.getEye(tmpEye);
    this.player.getLookDirection(tmpDir);

    // Melee takes priority over digging.
    const botHit = this.bots.raycast(tmpEye.x, tmpEye.y, tmpEye.z, tmpDir.x, tmpDir.y, tmpDir.z, spade.def.range);
    const voxHit = raycastVoxels(this.world, tmpEye.x, tmpEye.y, tmpEye.z, tmpDir.x, tmpDir.y, tmpDir.z, spade.def.range);

    if (botHit && (!voxHit.hit || botHit.distance < voxHit.distance)) {
      const zone = this.zoneFor(botHit.bot, botHit.zoneY);
      const dmg = spade.def.damage[zone];
      // A spade puts its whole weight behind the swing, so it throws a body
      // further than a rifle round does.
      this.applyBotDamage(botHit.bot, dmg, zone, true, {
        x: tmpEye.x + tmpDir.x * botHit.distance,
        y: tmpEye.y + tmpDir.y * botHit.distance,
        z: tmpEye.z + tmpDir.z * botHit.distance,
        dirX: tmpDir.x, dirZ: tmpDir.z, force: 1.5,
      });
      return;
    }

    if (voxHit.hit) {
      const mat = this.world.materialAt(voxHit.x, voxHit.y, voxHit.z);
      if (MATERIALS[mat].indestructible) return;
      const color = this.world.get(voxHit.x, voxHit.y, voxHit.z);
      const res = this.world.dig(voxHit.x, voxHit.y, voxHit.z);
      if (res.applied === 0) return;

      this.decals.markDirty();

      if (res.destroyed) {
        this.stats.blocksDug++;
        this.spawnBlockDebris(voxHit.x, voxHit.y, voxHit.z, color, 10);
        this.audio.play('dig');
      } else {
        // Chips fly on every swing that doesn't break through, so a tough
        // material reads as "keep going" rather than "nothing happened".
        this.spawnBlockDebris(voxHit.x, voxHit.y, voxHit.z, color, 3);
      }
    }
  }

  private useBlockTool(dt: number): void {
    this.player.getEye(tmpEye);
    this.player.getLookDirection(tmpDir);
    const hit = raycastVoxels(
      this.world, tmpEye.x, tmpEye.y, tmpEye.z, tmpDir.x, tmpDir.y, tmpDir.z,
      this.loadout.blockTool.def.range,
    );
    if (!hit.hit) { this.repairProgress = 0; return; }

    const hp = this.world.hpAt(hit.x, hit.y, hit.z);
    const max = this.world.maxHpAt(hit.x, hit.y, hit.z);

    // Aiming at a damaged block repairs it; aiming at an intact one builds.
    if (hp < max && !MATERIALS[this.world.materialAt(hit.x, hit.y, hit.z)].indestructible) {
      this.repairBlock(hit.x, hit.y, hit.z, dt);
      return;
    }

    if (this.loadout.blockTool.cooldown > 0) return;
    this.placeBlock(hit.px, hit.py, hit.pz);
  }

  private repairBlock(x: number, y: number, z: number, dt: number): void {
    const loadout = this.loadout;
    const amount = REPAIR_RATE * dt;
    const restored = this.world.repair(x, y, z, amount);
    if (restored <= 0) return;

    this.repairProgress += restored;
    this.decals.markDirty();
    this.waves.repairedThisWave = true;

    // Charge a block for every REPAIR_HP_PER_BLOCK restored.
    while (this.repairProgress >= REPAIR_HP_PER_BLOCK) {
      this.repairProgress -= REPAIR_HP_PER_BLOCK;
      if (!loadout.consumeBlock()) {
        // Out of material — undo the rest of this tick's repair.
        this.hud.setPrompt('Out of blocks — buy more from the Materials Merchant');
        return;
      }
      this.audio.play('place', 0);
    }
  }

  private placeBlock(x: number, y: number, z: number): void {
    if (y < 0 || y >= WORLD_Y) return;
    if (this.world.get(x, y, z) !== AIR) return;
    if (!this.canPlaceAt(x, y, z)) return;
    if (this.loadout.blockCount <= 0) {
      this.audio.play('deny');
      this.hud.setPrompt('Out of blocks — buy more from the Materials Merchant');
      return;
    }
    if (!this.loadout.consumeBlock()) return;

    this.world.set(x, y, z, this.loadout.placementColor, this.loadout.material);
    this.net?.sendVoxel({
      op: 0, x, y, z,
      color: this.loadout.placementColor,
      mat: this.loadout.material,
    });
    this.loadout.blockTool.cooldown = this.loadout.blockTool.def.delay;
    this.stats.blocksPlaced++;
    this.audio.play('place');
  }

  /** Blocks may not be placed inside the player. */
  private canPlaceAt(x: number, y: number, z: number): boolean {
    const r = PHYS.playerRadius;
    const p = this.player.position;
    const h = this.player.height;
    return !(x + 1 > p.x - r && x < p.x + r
      && z + 1 > p.z - r && z < p.z + r
      && y + 1 > p.y && y < p.y + h);
  }

  private sampleColor(): void {
    this.player.getEye(tmpEye);
    this.player.getLookDirection(tmpDir);
    const hit = raycastVoxels(this.world, tmpEye.x, tmpEye.y, tmpEye.z, tmpDir.x, tmpDir.y, tmpDir.z, 32);
    if (!hit.hit) return;
    const color = this.world.get(hit.x, hit.y, hit.z);
    const mat = this.world.materialAt(hit.x, hit.y, hit.z);
    this.loadout.useMaterialColor = false;
    // Find the palette entry so the swatch and future placements match.
    this.loadout.colorHue = 0;
    this.loadout.colorShade = 0;
    const target = [palette[color * 3], palette[color * 3 + 1], palette[color * 3 + 2]];
    let best = Infinity;
    for (let h = 0; h < BUILD_HUES; h++) {
      for (let s = 0; s < BUILD_SHADES; s++) {
        const i = 16 + h * BUILD_SHADES + s;
        const d = (palette[i * 3] - target[0]) ** 2 + (palette[i * 3 + 1] - target[1]) ** 2 + (palette[i * 3 + 2] - target[2]) ** 2;
        if (d < best) { best = d; this.loadout.colorHue = h; this.loadout.colorShade = s; }
      }
    }
    if (BUILDABLE.includes(mat as Mat) && this.loadout.blocks[mat] > 0) this.loadout.material = mat as Mat;
    this.audio.play('place');
  }

  private fireGun(): void {
    const w = this.loadout.gun;
    if (w.isEmpty) {
      if (w.stock > 0) {
        if (w.beginReload()) this.playReload(w);
      } else if (this.input.mouseLeftPressed) {
        this.audio.play('deny');
      }
      return;
    }
    if (!w.consume()) return;

    this.stats.shotsFired++;
    this.sinceFired = 0;
    this.viewModel.fire(w.def.recoil[0], w.def.muzzleFlash);
    this.audio.play(w.def.sound);
    // The shot carries a great deal further than the flash does. This is the
    // one thing that reaches through terrain, which is what stops the answer
    // to every camp being "shoot it from the trees and stay hidden".
    this.bots.hearNoise(
      this.player.position.x, this.player.position.z,
      GUN_NOISE[w.id] ?? 46, 0.55,
    );
    // Bolt-action and pump guns cycle between shots.
    if (w.def.cycle) this.audio.play(w.def.cycle, 0, { delay: Math.min(0.18, w.def.delay * 0.4) });

    // Recoil kicks the view up and slightly sideways.
    const ads = this.viewModel.adsAmount;
    this.player.pitch += w.def.recoil[0] * (1 - ads * 0.4);
    this.player.yaw += (Math.random() - 0.5) * w.def.recoil[1] * 2;

    const moving = Math.hypot(this.player.velocity.x, this.player.velocity.z);
    const spread = w.currentSpread(moving, this.player.airborne, ads > 0.5);

    this.player.getEye(tmpEye);
    let anyHit = false;
    let anyKill = false;

    for (let p = 0; p < w.def.pellets; p++) {
      this.player.getLookDirection(tmpDir);
      applySpread(tmpDir, spread);
      const res = this.hitscan(
        tmpEye.x, tmpEye.y, tmpEye.z, tmpDir.x, tmpDir.y, tmpDir.z,
        w.def.range, w.def.damage, w.def.blockDamage, false, 1,
      );
      if (res.hitBot) anyHit = true;
      if (res.killed) anyKill = true;
    }

    if (anyHit) {
      this.stats.shotsHit++;
      this.hud.showHitmarker(anyKill);
    }
  }

  private throwGrenade(): void {
    const g = this.loadout.grenades;
    if (g.stock <= 0) { this.audio.play('deny'); return; }
    if (g.cooldown > 0) return;
    g.stock--;
    g.cooldown = g.def.delay;

    this.player.getEye(tmpEye);
    this.player.getLookDirection(tmpDir);
    const speed = 22;
    this.projectiles.spawn(
      ProjectileKind.Grenade, 'grenade',
      tmpEye.x + tmpDir.x * 0.6, tmpEye.y + tmpDir.y * 0.6, tmpEye.z + tmpDir.z * 0.6,
      tmpDir.x * speed + this.player.velocity.x * 8,
      tmpDir.y * speed + 4,
      tmpDir.z * speed + this.player.velocity.z * 8,
      2.6, false, 1,
    );
    this.viewModel.fire(0.03, 0);
    this.audio.play('throw');
    if (g.stock === 0) this.selectSlot(Slot.Gun);
  }

  // -------------------------------------------------------------------------
  // Combat resolution
  // -------------------------------------------------------------------------
  /**
   * Traces one bullet against bots, the people in the paddy and voxels,
   * applying damage to whichever is closer. Shared by the player and every bot.
   */
  private hitscan(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    range: number,
    damage: readonly [number, number, number, number],
    blockDamage: number,
    hostile: boolean,
    damageMultiplier: number,
  ): { hitBot: boolean; killed: boolean } {
    const vox = raycastVoxels(this.world, ox, oy, oz, dx, dy, dz, range);
    const voxDist = vox.hit ? vox.distance : range;

    let hitBot = false;
    let hitCivilian = false;
    let killed = false;
    let endX = ox + dx * voxDist;
    let endY = oy + dy * voxDist;
    let endZ = oz + dz * voxDist;

    if (hostile) {
      // Enemy bullets only test against the player.
      const hit = this.raycastPlayer(ox, oy, oz, dx, dy, dz, voxDist);
      if (hit >= 0) {
        endX = ox + dx * hit; endY = oy + dy * hit; endZ = oz + dz * hit;
        const zone = hit >= 0 && (oy + dy * hit) > this.player.position.y + this.player.height * 0.8
          ? HitZone.Head : HitZone.Torso;
        this.damagePlayer(Math.round(damage[zone] * damageMultiplier), ox, oz);
        hitBot = true;
      }
    } else {
      const bot = this.bots.raycast(ox, oy, oz, dx, dy, dz, voxDist);
      // Friendly fire is on, so a squadmate is swept alongside the enemy and
      // whichever is nearer takes the round. A man who walks in front of your
      // muzzle gets shot; that is the whole feature.
      const mate = this.remotes?.raycast(ox, oy, oz, dx, dy, dz, voxDist) ?? null;
      const mateFirst = mate !== null && (bot === null || mate.distance < bot.distance);

      if (mateFirst) {
        endX = ox + dx * mate!.distance;
        endY = oy + dy * mate!.distance;
        endZ = oz + dz * mate!.distance;
        const zone = this.zoneForPlayer(mate!.zoneY, mate!.footY);
        const dmg = Math.round(damage[zone] * damageMultiplier);
        this.net?.sendPlayerHit({
          target: mate!.sessionId, damage: dmg, zone, x: ox, z: oz,
        });
        // The victim owns the hp, so the shooter only gets to see that the
        // round landed — `hitBot` drives the hitmarker back in the caller.
        this.blood.spatter(endX, endY, endZ, 2, 0.8);
        hitBot = true;
      } else if (bot) {
        endX = ox + dx * bot.distance; endY = oy + dy * bot.distance; endZ = oz + dz * bot.distance;
        const zone = this.zoneFor(bot.bot, bot.zoneY);
        killed = this.applyBotDamage(
          bot.bot, Math.round(damage[zone] * damageMultiplier), zone, false,
          { x: endX, y: endY, z: endZ, dirX: dx, dirZ: dz, force: 1 },
        );
        hitBot = true;
      }

      // Civilians are tested last and only by a round that hit nothing else.
      // The field is behind the enemy from the parapet and the market is off
      // to the side of them, so anyone here was found by a round that missed
      // whatever it was aimed at -- which is exactly the round that ought to
      // be able to find them.
      if (!hitBot) {
        const field = this.farmers?.raycast(ox, oy, oz, dx, dy, dz, voxDist) ?? null;
        const street = this.townsfolk?.raycast(ox, oy, oz, dx, dy, dz, voxDist) ?? null;
        // Whichever of the two is nearer takes it, so a villager standing
        // behind a farmer is covered by them the way you would expect.
        const inField = field !== null && (street === null || field.distance <= street.distance);
        const hit = inField ? field! : street;
        if (hit) {
          endX = ox + dx * hit.distance;
          endY = oy + dy * hit.distance;
          endZ = oz + dz * hit.distance;
          const dmg = Math.round(damage[HitZone.Torso] * damageMultiplier);
          const died = inField
            ? this.farmers!.hit(field!, dmg, ox, oz)
            : this.townsfolk!.hit(street!, dmg, ox, oz);
          this.civilianShot(died, hit.scale, endX, endY, endZ, dx, dz);
          hitCivilian = true;
        }
      }
    }

    // A round going anywhere near the field puts the whole of it to flight,
    // whether or not it was aimed at anybody in it. Shooting over their heads
    // is not free either, just cheap.
    if (!hostile) {
      const scared = (this.farmers?.alarm(endX, endZ, 26) ?? 0)
        + (this.townsfolk?.alarm(endX, endZ, 26) ?? 0);
      if (scared > 0) this.onRageCrossed(this.aggression.civiliansScared());
    }

    if (!hitBot && !hitCivilian && vox.hit) {
      this.damageBlock(vox.x, vox.y, vox.z, blockDamage * damageMultiplier, hostile);
      // Impact puff in the surface colour.
      const color = this.world.get(vox.x, vox.y, vox.z);
      this.spawnImpact(endX, endY, endZ, vox.nx, vox.ny, vox.nz, color);
    }

    this.tracers.spawn(
      ox + dx * 0.6, oy + dy * 0.6, oz + dz * 0.6,
      endX, endY, endZ,
      hostile ? 1 : 1, hostile ? 0.6 : 0.92, hostile ? 0.35 : 0.62,
    );

    return { hitBot, killed };
  }

  /**
   * Which part of a squadmate a round found.
   *
   * Against the standing height, because crouch is not replicated — the same
   * reason the remote hitbox is the standing one. The thresholds match
   * `zoneFor` so a headshot is a headshot whoever is on the end of it.
   */
  private zoneForPlayer(y: number, footY: number): HitZone {
    const rel = (y - footY) / PHYS.heightStand;
    if (rel > 0.78) return HitZone.Head;
    if (rel < 0.36) return HitZone.Legs;
    return HitZone.Torso;
  }

  private zoneFor(bot: Bot, y: number): HitZone {
    // Against the crouched height, so ducking behind a wall moves the head
    // zone down with the head rather than leaving it floating over the bot.
    const rel = (y - bot.position.y) / bot.poseHeight;
    if (rel > 0.78) return HitZone.Head;
    if (rel < 0.36) return HitZone.Legs;
    return HitZone.Torso;
  }

  /**
   * Resolves a hit on a bot.
   *
   * `impact` is where the round went through and which way it was travelling.
   * It's what puts blood on the part that was actually hit and knocks a killed
   * bot over away from the shooter, so every caller that knows it should pass
   * it; a blast that catches a bot from nowhere in particular can leave it out.
   */
  private applyBotDamage(
    bot: Bot, damage: number, zone: HitZone, melee: boolean, impact?: BotImpact,
  ): boolean {
    // In multiplayer the server owns bot health: report the hit and let the
    // snapshot bring the new value back, rather than diverging locally.
    if (this.net) {
      this.net.sendBotHit(this.bots.bots.indexOf(bot), damage);
    }
    const killed = this.bots.damage(bot, damage, impact);

    this.economy.award(POINTS.hit);
    this.audio.play(zone === HitZone.Head ? 'headshot' : 'hit');

    // Blood spray, thrown out of the wound and on through the body.
    const y = impact ? impact.y
      : bot.position.y + bot.poseHeight * (zone === HitZone.Head ? 0.85 : 0.55);
    const hx = impact ? impact.x : bot.position.x;
    const hz = impact ? impact.z : bot.position.z;
    const dx = impact ? impact.dirX : 0;
    const dz = impact ? impact.dirZ : 0;
    // Fine droplets rather than one big cloud — a spray of them reads as blood
    // where a few fat puffs read as a smoke grenade.
    for (let i = 0; i < (killed ? 22 : 9); i++) {
      this.particles.spawn(
        hx, y, hz,
        dx * 6 + (Math.random() - 0.5) * 7,
        Math.random() * 5,
        dz * 6 + (Math.random() - 0.5) * 7,
        0.5, 0.05, 0.05, 0.95, 0.7 + Math.random() * 0.7, 0.45 + Math.random() * 0.4,
        26, 0.8, true,
      );
    }
    // Some of it reaches the floor, so a firefight marks the ground even where
    // nobody has gone down yet.
    this.blood.spatter(
      bot.position.x + dx * 0.6, y, bot.position.z + dz * 0.6,
      killed ? 4 : 2, killed ? 1.4 : 0.9,
    );

    if (killed) {
      let award = bot.def.points;
      if (zone === HitZone.Head) { award += POINTS.headshotBonus; this.stats.headshots++; }
      if (melee) award += POINTS.meleeBonus;
      this.economy.award(award);
      // Nothing is announced on the kill -- no floating +points, no HEADSHOT /
      // SPADE KILL / enemy-name callout. The bonuses still land and still count
      // towards the end-of-run stats, they just stay off the HUD.
      this.stats.kills++;
    }

    return killed;
  }

  /**
   * A round has found a civilian -- in the paddy or in the market, it is the
   * same round and the same crime, so it is the same code.
   *
   * Nothing is scored for it and nothing is announced beyond a line in the
   * log: shooting one of them is not a kill, it is a thing that happened, and
   * the game's only comment on it is that the place empties and stays empty
   * until the next morning.
   */
  private civilianShot(
    killed: boolean, s: number,
    x: number, y: number, z: number,
    dirX: number, dirZ: number,
  ): void {
    for (let i = 0; i < (killed ? 18 : 8); i++) {
      this.particles.spawn(
        x, y, z,
        dirX * 5 + (Math.random() - 0.5) * 6,
        Math.random() * 4,
        dirZ * 5 + (Math.random() - 0.5) * 6,
        0.5, 0.05, 0.05, 0.95, 0.6 + Math.random() * 0.6, 0.4 + Math.random() * 0.35,
        24, 0.8, true,
      );
    }
    this.blood.spatter(x, y, z, killed ? 3 : 2, killed ? 1.2 * s : 0.8 * s);

    if (killed) {
      this.blood.pool(x, y - 0.9, z, 1.2 * s + Math.random() * 0.4, CORPSE_LIFE + 14);
      // Pitched up for the smaller bodies, which is the whole of what the game
      // says about who was out there.
      this.audio.play('death-cry', this.distanceToPlayer(x, y, z), { rate: s < 0.7 ? 1.5 : 1.05 });
      this.hud.log(`Civilian killed  (${this.aggression.civiliansKilled})`, 'bad');
      this.onRageCrossed(this.aggression.civilianKilled());
      // Somebody runs and somebody talks. A party goes into the ground for you
      // before the next raid is due.
      this.hunterTimer = Math.min(this.hunterTimer, 12);
    } else {
      this.audio.play('hit', this.distanceToPlayer(x, y, z));
      this.onRageCrossed(this.aggression.civilianWounded());
    }
  }

  /**
   * Announces a step up in how the valley is taking this.
   *
   * Only the crossings are announced, never the number: the player should feel
   * the game change under them and be told why, not be handed a meter to
   * optimise against.
   */
  private onRageCrossed(level: number): void {
    switch (level) {
      case Rage.Roused:
        // No banner for the first step up -- it arrives as a line in the log
        // and as men who are harder to shake, which is how the player ought to
        // notice it. The louder two still get the screen.
        this.hud.log('The village has seen what you are doing.', 'bad');
        break;
      case Rage.Angry:
        this.hud.showAnnounce('THEY ARE COMING FOR YOU', 'bad');
        this.hud.log('They have stopped caring about the Core.', 'bad');
        break;
      case Rage.Hunting:
        this.hud.showAnnounce('THE GROUND IS THEIRS', 'bad');
        this.hud.log('Watch the earth. They are under it.', 'bad');
        break;
      default:
        break;
    }
  }

  /**
   * Sends parties of tunnel rats after the player between raids.
   *
   * This is the part of the anger the player meets first, and it is deliberately
   * off the schedule: a raid you can see coming is a fight, but four men coming
   * up out of the paddy while you are at the merchant is a consequence.
   */
  private updateHunters(dt: number): void {
    if (this.waves.phase === Phase.GameOver) return;
    const rage = this.aggression.value;
    if (rage < 0.25) return;

    this.hunterTimer -= dt;
    if (this.hunterTimer > 0) return;

    const party = 1 + Math.floor(rage * 4);
    const sent = this.waves.sendHunters(party);
    // Angrier means sooner. At the top of the scale it's most of a minute.
    this.hunterTimer = (95 - rage * 45) * (0.75 + Math.random() * 0.5);
    if (sent > 0 && this.aggression.huntsPlayer) {
      this.hud.log('Something is moving under the field.', 'warn');
    }
  }

  private damageBlock(x: number, y: number, z: number, amount: number, hostile: boolean): void {
    const isCore = this.world.materialAt(x, y, z) === Mat.Core;
    const color = this.world.get(x, y, z);
    const res = this.world.damage(x, y, z, amount);
    if (res.applied === 0) return;

    // Applied locally for responsiveness, then reported so the server's copy
    // (and everyone else's) converges. Damage arriving *from* the server is
    // replayed through applyRemoteOp and must not bounce back.
    if (!this.applyingRemoteOp) this.net?.sendBlockDamage(x, y, z, amount);

    this.decals.markDirty();

    if (hostile) {
      this.accumulatedBlockDamage += res.applied;
      this.waves.baseDamagedThisWave = true;
    }

    if (res.destroyed) {
      this.spawnBlockDebris(x, y, z, color, 14);
      this.audio.play('blockbreak', this.distanceToPlayer(x, y, z));
      if (isCore) this.onCoreDestroyed();
    }
  }

  // -------------------------------------------------------------------------
  // Explosions
  // -------------------------------------------------------------------------
  explode(x: number, y: number, z: number, kind: ExplosionKind, hostile: boolean, damageMultiplier: number): void {
    const def = EXPLOSIONS[kind];
    const r = def.radius;
    this.audio.play('explosion', this.distanceToPlayer(x, y, z));

    // --- voxels ---
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(WORLD_X - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(WORLD_Y - 1, Math.ceil(y + r));
    const z0 = Math.max(0, Math.floor(z - r));
    const z1 = Math.min(WORLD_Z - 1, Math.ceil(z + r));
    const r2 = r * r;

    for (let vy = y0; vy <= y1; vy++) {
      for (let vz = z0; vz <= z1; vz++) {
        for (let vx = x0; vx <= x1; vx++) {
          if (this.world.get(vx, vy, vz) === AIR) continue;
          const dx = vx + 0.5 - x;
          const dy = vy + 0.5 - y;
          const dz = vz + 0.5 - z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          // Linear falloff from the centre.
          const falloff = 1 - Math.sqrt(d2) / r;
          this.damageBlock(vx, vy, vz, def.blockDamage * falloff * damageMultiplier, hostile);
        }
      }
    }

    // --- bots ---
    this.bots.forEachInRadius(x, y, z, r, (bot, dist) => {
      const falloff = 1 - dist / r;
      const dmg = Math.round(def.playerDamage * falloff * damageMultiplier);
      if (dmg <= 0) return;
      if (!hostile) {
        // A blast throws a body outward from the centre, hard, and tears it up
        // where it faced the explosion.
        const bx = bot.position.x - x;
        const bz = bot.position.z - z;
        const len = Math.max(0.001, Math.hypot(bx, bz));
        this.applyBotDamage(bot, dmg, HitZone.Torso, false, {
          x: bot.position.x - (bx / len) * 0.3,
          y: bot.position.y + bot.poseHeight * 0.5,
          z: bot.position.z - (bz / len) * 0.3,
          dirX: bx / len, dirZ: bz / len, force: 1 + falloff * 1.8,
        });
      } else {
        // Friendly fire between bots is off; enemy blasts don't hurt them.
        void bot;
      }
    });

    // --- deployables ---
    // A rocket landing in the base wrecks the sentry it lands on, so turrets
    // are something to defend rather than something to hide behind.
    for (const wrecked of this.deployables.damageInRadius(x, y, z, r, def.playerDamage * damageMultiplier)) {
      this.spawnBlockDebris(wrecked.vx, wrecked.vy, wrecked.vz, COL_STEEL, 18);
      this.audio.play('blockbreak', this.distanceToPlayer(wrecked.x, wrecked.vy, wrecked.z));
      this.hud.log('A deployable was destroyed', 'bad');
    }

    // --- the field and the market ---
    // A blast does not distinguish, and neither the people in the paddy nor
    // the ones in the street have anything to get behind. Everything within
    // earshot runs, whether it was touched or not, which is most of what an
    // explosion does to a village.
    let civilianDead = 0;
    const dmg = def.playerDamage * damageMultiplier;
    const caught = [
      ...(this.farmers?.blast(x, y, z, r, dmg) ?? []),
      ...(this.townsfolk?.blast(x, y, z, r, dmg) ?? []),
    ];
    for (const person of caught) {
      this.blood.pool(
        person.x, person.y + 0.2, person.z,
        1.2 * person.scale + Math.random() * 0.4, CORPSE_LIFE + 14,
      );
      this.audio.play(
        'death-cry', this.distanceToPlayer(person.x, person.y, person.z),
        { rate: person.scale < 0.7 ? 1.5 : 1.05 },
      );
      civilianDead++;
    }
    // A shell into the field is the same crime several times over, and it is
    // counted that way — one of these does more to the valley than a run of
    // rifle rounds ever could.
    if (civilianDead > 0 && !hostile) {
      let crossed = -1;
      for (let i = 0; i < civilianDead; i++) {
        crossed = Math.max(crossed, this.aggression.civilianKilled());
      }
      this.hud.log(
        `${civilianDead} civilian${civilianDead === 1 ? '' : 's'} killed`
        + `  (${this.aggression.civiliansKilled})`,
        'bad',
      );
      this.onRageCrossed(crossed);
      this.hunterTimer = Math.min(this.hunterTimer, 8);
    }

    // --- player ---
    const pdx = this.player.position.x - x;
    const pdy = this.player.position.y + this.player.height * 0.5 - y;
    const pdz = this.player.position.z - z;
    const pd = Math.hypot(pdx, pdy, pdz);
    if (pd < r && this.player.alive) {
      const falloff = 1 - pd / r;
      this.damagePlayer(Math.round(def.playerDamage * falloff * damageMultiplier), x, z);
      // Blast knockback.
      const push = def.force * falloff;
      const len = Math.max(0.5, pd);
      this.player.velocity.x += (pdx / len) * push;
      this.player.velocity.y += (pdy / len) * push + push * 0.35;
      this.player.velocity.z += (pdz / len) * push;
      this.player.airborne = true;
    }

    // --- fx ---
    for (let i = 0; i < 42; i++) {
      const a = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      const s = 6 + Math.random() * 18;
      this.particles.spawn(
        x, y, z,
        Math.sin(p) * Math.cos(a) * s, Math.cos(p) * s * 0.8 + 4, Math.sin(p) * Math.sin(a) * s,
        1, 0.65 + Math.random() * 0.3, 0.25, 0.95,
        5 + Math.random() * 5, 0.35 + Math.random() * 0.5, 14, 1.4,
      );
    }
    for (let i = 0; i < 20; i++) {
      this.particles.spawn(
        x + (Math.random() - 0.5) * 3, y + Math.random() * 2, z + (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 3,
        0.28, 0.27, 0.26, 0.55,
        14 + Math.random() * 10, 1.4 + Math.random(), -2, 1.2,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Bot callbacks
  // -------------------------------------------------------------------------
  private botFire(bot: Bot, tx: number, ty: number, tz: number): void {
    const def = bot.def;
    const weapon = def.weapon;
    const wdef = { ...(weapon === WeaponId.Rocket ? EXPLOSIONS.rocket : null) };
    void wdef;

    const ox = bot.position.x;
    const oy = bot.eyeY;
    const oz = bot.position.z;

    // Lead slightly and scatter based on the archetype's accuracy.
    tmpVec.set(tx - ox, ty - oy, tz - oz);
    const dist = tmpVec.length();
    if (dist < 0.001) return;
    tmpVec.divideScalar(dist);

    // The AI owns the aim cone: it widens while a bot is still settling onto a
    // target or moving, and again for suppressive fire. See BotManager.updateAim.
    applySpread(tmpVec, bot.aimSpread);

    this.audio.play(this.soundForBotWeapon(weapon), this.distanceToPlayer(ox, oy, oz));

    // Muzzle flash puff so you can see where fire is coming from.
    this.particles.spawn(
      ox + tmpVec.x, oy + tmpVec.y, oz + tmpVec.z,
      tmpVec.x * 3, tmpVec.y * 3 + 1, tmpVec.z * 3,
      1, 0.85, 0.5, 0.8, 4, 0.08, 2, 2,
    );

    if (weapon === WeaponId.Rocket) {
      const speed = bot.kind === BotKind.Tank || bot.kind === BotKind.Boss ? 46 : 34;
      this.projectiles.spawn(
        ProjectileKind.Rocket,
        bot.kind === BotKind.Tank || bot.kind === BotKind.Boss ? 'tankShell' : 'rocket',
        ox + tmpVec.x * 1.4, oy + tmpVec.y * 1.4, oz + tmpVec.z * 1.4,
        tmpVec.x * speed, tmpVec.y * speed, tmpVec.z * speed,
        6, true, bot.damageMultiplier,
      );
      return;
    }

    if (weapon === WeaponId.Grenade) {
      this.botVoice(bot, VoiceCue.Grenade);
      // Lob it in an arc so it clears walls.
      const flat = Math.hypot(tx - ox, tz - oz);
      const speed = Math.min(30, 9 + flat * 0.9);
      this.projectiles.spawn(
        ProjectileKind.Grenade, 'grenade',
        ox + tmpVec.x, oy + 1, oz + tmpVec.z,
        tmpVec.x * speed, 11 + flat * 0.22, tmpVec.z * speed,
        2.4, true, bot.damageMultiplier,
      );
      return;
    }

    const { damage, blockDamage, range, pellets } = this.botWeaponStats(weapon);
    for (let p = 0; p < pellets; p++) {
      tmpVec2.copy(tmpVec);
      if (pellets > 1) applySpread(tmpVec2, 0.05);
      this.hitscan(ox, oy, oz, tmpVec2.x, tmpVec2.y, tmpVec2.z, range, damage, blockDamage, true, bot.damageMultiplier);
    }
  }

  private botWeaponStats(weapon: WeaponId): {
    damage: readonly [number, number, number, number];
    blockDamage: number;
    range: number;
    pellets: number;
  } {
    switch (weapon) {
      case WeaponId.SMG: return { damage: [16, 34, 11, 11], blockDamage: 20, range: 120, pellets: 1 };
      case WeaponId.Rifle: return { damage: [32, 62, 21, 21], blockDamage: 40, range: 200, pellets: 1 };
      case WeaponId.Shotgun: return { damage: [11, 15, 7, 7], blockDamage: 14, range: 40, pellets: 6 };
      default: return { damage: [14, 28, 10, 10], blockDamage: 14, range: 90, pellets: 1 };
    }
  }

  private soundForBotWeapon(weapon: WeaponId): string {
    switch (weapon) {
      case WeaponId.SMG: return 'smg';
      case WeaponId.Rifle: return 'rifle';
      case WeaponId.Shotgun: return 'shotgun';
      case WeaponId.Rocket: return 'rocket';
      case WeaponId.Grenade: return 'throw';
      default: return 'pistol';
    }
  }

  private botBreach(bot: Bot, x: number, y: number, z: number): void {
    this.damageBlock(x, y, z, bot.def.breachPower * bot.damageMultiplier, true);
    this.audio.play(bot.def.sapper ? 'dig' : 'spade', this.distanceToPlayer(x, y, z));
    const color = this.world.get(x, y, z);
    if (color !== AIR) this.spawnBlockDebris(x, y, z, color, 4);
  }

  /**
   * Takes a voxel out whole, for the shaft a tunnel rat cuts to come up
   * through.
   *
   * Deliberately not routed through the breach path: breaching is a fight with
   * a wall and takes as long as the wall's hit points say it takes, and an
   * ambush that has to wait on a hit point bar is not an ambush. The block goes,
   * the earth flies, and the man is out of the ground a second later.
   */
  private botDig(bot: Bot, x: number, y: number, z: number): void {
    const color = this.world.get(x, y, z);
    if (color === AIR) return;
    // Big enough to take anything diggable in one, which is what makes it read
    // as a shaft opening rather than a wall being worn down. Material the world
    // calls indestructible still refuses it, and the AI checked for that before
    // choosing the column.
    this.damageBlock(x, y, z, 100000, true);
    this.spawnBlockDebris(x, y, z, color, 5);
    void bot;
  }

  /**
   * Earth turning over where something is moving underneath it.
   *
   * This is the only warning a tunnel rat gives, so it is drawn on the surface
   * above the man rather than on the man: a line of spoil crossing the paddy
   * toward the wire, with nothing visible making it.
   */
  private spawnSpoil(bot: Bot, x: number, y: number, z: number, strength: number): void {
    if (this.distanceToPlayer(x, y, z) > 70) return;

    const color = this.world.get(Math.floor(x), Math.floor(y) - 1, Math.floor(z));
    const r = color === AIR ? 0.42 : palette[color * 3] / 255;
    const g = color === AIR ? 0.34 : palette[color * 3 + 1] / 255;
    const b = color === AIR ? 0.24 : palette[color * 3 + 2] / 255;

    const n = strength > 0.6 ? 7 : 2;
    for (let i = 0; i < n; i++) {
      this.particles.spawn(
        x + (Math.random() - 0.5) * 0.9, y, z + (Math.random() - 0.5) * 0.9,
        (Math.random() - 0.5) * 3.5,
        1.6 + Math.random() * 4.5 * strength,
        (Math.random() - 0.5) * 3.5,
        r, g, b, 1,
        2.2 + Math.random() * 2.5, 0.35 + Math.random() * 0.5 * strength,
        22, 0.7, true,
      );
    }
    if (strength >= 0.8 && bot.submerged > 0.72) {
      this.audio.play('dig', this.distanceToPlayer(x, y, z));
    }
  }

  /**
   * Places one block of an enemy blueprint. Refusing a placement (rather than
   * skipping the whole structure) lets the bot carry on with the rest of the
   * site, so a ramp built around an awkward rock still gets finished.
   */
  private botBuild(bot: Bot, x: number, y: number, z: number, color: number, material: Mat): boolean {
    if (y < 1 || y >= WORLD_Y) return false;
    if (this.world.get(x, y, z) !== AIR) return false;
    // Never let a bot brick the player inside a block.
    if (!this.canPlaceAt(x, y, z)) return false;

    this.world.set(x, y, z, color, material);
    this.audio.play('place', this.distanceToPlayer(x, y, z));
    this.particles.spawn(
      x + 0.5, y + 0.5, z + 0.5,
      (Math.random() - 0.5) * 1.5, 1.2, (Math.random() - 0.5) * 1.5,
      0.55, 0.5, 0.42, 0.5, 3, 0.35, 3, 1,
    );
    void bot;
    return true;
  }

  /**
   * An enemy shouting something. The director decides whether the horde has
   * room for another line right now; the bot only gets to ask, and goes quiet
   * for a while either way so the same man isn't the one talking every time.
   */
  private botVoice(bot: Bot, cue: VoiceCue): void {
    if (bot.voiceTimer > 0) return;
    const spoken = this.voices.say(
      cue, bot.voice, bot.voicePitch,
      this.distanceToPlayer(bot.position.x, bot.eyeY, bot.position.z),
    );
    // Swallowed lines only earn a short pause, so a bot that was talked over
    // gets another go rather than staying silent for the next ten seconds.
    bot.voiceTimer = spoken ? 7 + Math.random() * 9 : 0.8;
  }

  private onBotDeath(bot: Bot): void {
    // Pitched to the same man who was shouting a second ago, so the cry belongs
    // to him rather than to the horde.
    this.audio.play(
      'death-cry',
      this.distanceToPlayer(bot.position.x, bot.eyeY, bot.position.z),
      { rate: bot.voicePitch },
    );
  }

  /**
   * A body has finished falling. It bleeds out where it landed, which leaves
   * the ground marked as somewhere a fight happened long after the body itself
   * has gone.
   */
  private onCorpseRest(bot: Bot): void {
    const s = bot.def.scale;
    const x = bot.position.x + bot.fallDirX * 0.8 * s;
    const z = bot.position.z + bot.fallDirZ * 0.8 * s;
    // The pool goes where the body is lying, not where its feet stopped.
    this.blood.pool(x, bot.position.y + 0.6, z, 1.5 * s + Math.random() * 0.5, CORPSE_LIFE + 14);
    // A last splash as it hits, low and flat, so the landing has some weight.
    for (let i = 0; i < 12; i++) {
      this.particles.spawn(
        x, bot.position.y + 0.25, z,
        (Math.random() - 0.5) * 4, Math.random() * 1.8, (Math.random() - 0.5) * 4,
        0.5, 0.05, 0.05, 0.9, 0.6 + Math.random() * 0.6, 0.4 + Math.random() * 0.35,
        24, 1.2, true,
      );
    }
    this.audio.play('hit', this.distanceToPlayer(x, bot.position.y, z));
  }

  // -------------------------------------------------------------------------
  // Player damage / death
  // -------------------------------------------------------------------------
  private damagePlayer(amount: number, fromX: number, fromZ: number): void {
    if (!this.player.alive || this.player.invulnerable > 0) return;
    const died = this.player.damage(amount);
    this.hud.flashDamage(amount / this.player.maxHp);
    this.audio.play('hurt');

    // Direction indicator relative to where the player is looking.
    const worldAngle = Math.atan2(fromX - this.player.position.x, fromZ - this.player.position.z);
    this.hud.showDamageDirection(-(worldAngle - this.player.yaw));

    if (died) this.onPlayerDeath();
  }

  /**
   * Going down is not a life spent -- there is no life counter. You lose the
   * ground you were holding and the walk back, and the wave keeps coming; the
   * run itself only ends when the Core falls.
   */
  private onPlayerDeath(): void {
    this.audio.play('death');
    this.hud.showAnnounce('YOU DIED', 'bad');
    this.hud.log('Regrouping at the base…', 'bad');
    this.respawnTimer = 5;
  }

  private doRespawn(): void {
    const s = this.layout.playerSpawn;
    this.player.respawn(s.x, s.y + 1, s.z);
    this.hud.log('Respawned at the base', 'good');
  }

  private onCoreDestroyed(): void {
    this.hud.showAnnounce('THE CORE HAS FALLEN', 'bad');
    this.endRun('Your Core was destroyed.');
  }

  private endRun(reason: string): void {
    this.radio.pause();
    this.villageMusic.stop();
    // The bed keeps running under the game-over screen. Cutting it makes the
    // silence land as a bug rather than as a beat; the next start() is a no-op.

    this.waves.gameOver();
    this.input.exitLock();
    this.hud.log(reason, 'bad');
    this.onGameOver?.({
      wave: this.waves.wave,
      points: this.economy.totalEarned,
      kills: this.stats.kills,
      headshots: this.stats.headshots,
      blocksPlaced: this.stats.blocksPlaced,
      blocksDug: this.stats.blocksDug,
      accuracy: this.stats.shotsFired > 0 ? Math.round((this.stats.shotsHit / this.stats.shotsFired) * 100) : 0,
    });
  }

  // -------------------------------------------------------------------------
  // Phase handling
  // -------------------------------------------------------------------------
  private onPhaseChange(phase: Phase, wave: number): void {
    switch (phase) {
      case Phase.Prep:
        this.hud.log('The line has gone quiet — repair, build and shop', 'good');
        this.player.heal(this.player.maxHp);
        this.loadout.refillAllAmmo();
        // The village comes back out: whoever ran for the trees is back at
        // work or back on the street, and the dead are not. The field being
        // worked and the market being open again is the clock on the whole
        // run — and the reason it is worth counting what you did to them last
        // time, because they come back and you can do it again.
        this.farmers?.respawn();
        this.townsfolk?.respawn();
        // And the jungle refills. Camps you cleared during the raid are
        // manned again by the time the next one comes, which is what keeps a
        // trip to the merchants a decision rather than a formality -- but they
        // stay cleared for the whole of a raid, so clearing one buys something
        // real.
        this.manOutposts();
        break;
      case Phase.Combat:
        this.audio.play('wave');
        if (this.shop.open) this.shop.close();
        break;
      case Phase.Cleared:
        this.audio.play('clear');
        break;
      case Phase.GameOver:
        break;
    }
    void wave;
  }

  private onWaveCleared(wave: number): void {
    let bonus = POINTS.waveClear * wave;
    // Not "cleared" any more — nothing is cleared. The raid has spent itself
    // and whatever is still walking around out there is still walking around.
    const left = this.bots.livingCount;
    this.hud.showAnnounce('ATTACK BROKEN', 'good');
    if (left > 0) this.hud.log(`${left} still in the valley`, 'warn');

    if (!this.waves.baseDamagedThisWave) {
      bonus += POINTS.noBaseDamageBonus;
      this.hud.log(`Base untouched  +${POINTS.noBaseDamageBonus}`, 'good');
    }
    if (!this.waves.repairedThisWave) {
      bonus += POINTS.noRepairBonus;
      this.hud.log(`No repairs needed  +${POINTS.noRepairBonus}`, 'good');
    }

    this.economy.award(bonus);
    this.hud.showPoints(bonus, 'WAVE BONUS');
    this.hud.log(`Wave ${wave} cleared  +${bonus}`, 'good');
  }

  // -------------------------------------------------------------------------
  // Merchants
  // -------------------------------------------------------------------------
  private isInTown(): boolean {
    return this.distanceOutsideTown() === 0;
  }

  /**
   * How far outside the village the player is, in blocks, and zero anywhere on
   * it. Measured against the shelf the village stands on rather than a circle
   * around the middle of it: the huts at the ends of the street are as much
   * the village as the market square is.
   */
  private distanceOutsideTown(): number {
    const dx = Math.abs(this.player.position.x - this.layout.townCenter.x) - TOWN_HALF_X;
    const dz = Math.abs(this.player.position.z - this.layout.townCenter.z) - TOWN_HALF_Z;
    return Math.max(0, dx, dz);
  }

  /**
   * Keeps the boombox honest: it's an object standing in one place, so what
   * you hear of it depends on where you are, and its level meter has to follow
   * what the speaker is actually doing.
   */
  private updateRadio(dt: number): void {
    const box = this.boombox;
    if (!box) return;
    this.radio.setListener(
      this.distanceToPlayer(box.speaker.x, box.speaker.y, box.speaker.z),
      dt,
    );
    box.update(dt, this.radio.level, this.radio.playing);
  }

  /**
   * Which radio button the player is pointing at, or -1.
   *
   * A raycast against the two button meshes rather than a proximity check: they
   * are a hand's width apart, and the whole point of two buttons is that you
   * choose between them.
   */
  private pickRadioButton(): number {
    const box = this.boombox;
    if (!box || !this.player.alive) return -1;
    if (this.distanceToPlayer(box.speaker.x, box.speaker.y, box.speaker.z) > RADIO_REACH + 2) {
      return -1;
    }
    this.player.getEye(tmpEye);
    this.player.getLookDirection(tmpDir);
    this.picker.set(tmpEye, tmpDir);
    this.picker.near = 0;
    this.picker.far = RADIO_REACH;
    const hits = this.picker.intersectObjects(box.buttons, false);
    if (hits.length === 0) return -1;
    return box.buttons.indexOf(hits[0].object as THREE.Mesh);
  }

  private updateMerchantPrompt(): void {
    this.aimedButton = this.shop.open ? -1 : this.pickRadioButton();
    this.boombox?.setAimed(this.aimedButton);

    this.nearMerchant = null;
    let best = TOWN_SHOP_RADIUS;
    for (const m of this.merchants) {
      const d = m.position.distanceTo(this.player.position);
      if (d < best) { best = d; this.nearMerchant = m; }
    }

    this.nearCrate = this.player.alive
      ? this.deployables.crateNear(this.player.position.x, this.player.position.y, this.player.position.z)
      : null;

    if (this.shop.open) { this.hud.setPrompt(''); return; }

    // Aiming at a button beats standing near a merchant: you had to point at it.
    if (this.aimedButton === RadioButton.Play) {
      this.hud.setPrompt(`<kbd>E</kbd> Radio — ${this.radio.playing ? 'pause' : 'play'}`);
      return;
    }
    if (this.aimedButton === RadioButton.Skip) {
      this.hud.setPrompt('<kbd>E</kbd> Radio — next track');
      return;
    }

    if (this.nearCrate) {
      this.hud.setPrompt(
        `<kbd>E</kbd> Ammo Crate — ${this.nearCrate.charges} resuppl${this.nearCrate.charges === 1 ? 'y' : 'ies'} left`,
      );
      return;
    }

    if (this.nearMerchant) {
      if (this.waves.phase === Phase.Combat) {
        this.hud.setPrompt(`${this.nearMerchant.name} — closed during combat`);
      } else {
        this.hud.setPrompt(`<kbd>E</kbd> ${this.nearMerchant.name}`);
      }
      return;
    }

    if (this.loadout.slot === Slot.Build && this.loadout.totalDeployables > 0) {
      const def = DEPLOYABLES[this.loadout.deploySelected];
      this.hud.setPrompt(
        `<kbd>LMB</kbd> place ${def.name} · <kbd>Q</kbd>/<kbd>E</kbd> rotate · hold <kbd>5</kbd> to pick`
        + ` — ${this.loadout.deployStock(def.id)} left`,
      );
      return;
    }

    // Show a repair hint when aiming at damaged blocks with the block tool.
    if (this.loadout.slot === Slot.Block) {
      this.player.getEye(tmpEye);
      this.player.getLookDirection(tmpDir);
      const hit = raycastVoxels(this.world, tmpEye.x, tmpEye.y, tmpEye.z, tmpDir.x, tmpDir.y, tmpDir.z, 8);
      if (hit.hit) {
        const hp = this.world.hpAt(hit.x, hit.y, hit.z);
        const max = this.world.maxHpAt(hit.x, hit.y, hit.z);
        if (hp < max) {
          this.hud.setPrompt(`Hold <kbd>LMB</kbd> to repair — ${Math.round((hp / max) * 100)}%`);
          return;
        }
      }
    }

    this.hud.setPrompt('');
  }

  private interact(): void {
    if (this.shop.open) { this.shop.close(); return; }

    if (this.aimedButton >= 0) { this.pressRadio(this.aimedButton); return; }

    // Crates come before merchants: the whole point of one is that it works
    // where and when a merchant does not.
    if (this.nearCrate) { this.useAmmoCrate(this.nearCrate); return; }

    if (this.nearMerchant) {
      if (this.waves.phase === Phase.Combat) {
        this.audio.play('deny');
        this.hud.log('Merchants are closed during combat', 'warn');
        return;
      }
      this.input.uiCapture = true;
      this.input.exitLock();
      this.shop.show(this.nearMerchant.kind, this.nearMerchant.name);
      return;
    }

    // Nothing else E does. There is no readying up: the valley picks its own
    // moment, and E is for the people and the boxes that are standing in front
    // of you.
  }

  /** Works one of the two buttons on the front of the boombox. */
  private pressRadio(button: number): void {
    this.boombox?.press(button);
    this.audio.play('place');

    if (button === RadioButton.Skip) {
      const track = this.radio.next();
      if (track) this.hud.log(`Radio — ${track.title}`, 'info');
      return;
    }

    const playing = this.radio.toggle();
    if (playing === null) return;
    this.hud.log(playing ? `Radio — ${this.radio.track.title}` : 'Radio off', 'info');
  }

  // -------------------------------------------------------------------------
  // Deployables
  // -------------------------------------------------------------------------
  /**
   * Where the thing in the deploy slot would land, or null if nowhere.
   *
   * Placement works off the block the player is looking at, exactly like the
   * block tool: the deployable stands in the air voxel against the face that
   * was hit, and the footprint check makes sure it has ground under all of it.
   */
  private aimDeploySpot(): { vx: number; vy: number; vz: number; alongX: boolean; yaw: number } | null {
    this.player.getEye(tmpEye);
    this.player.getLookDirection(tmpDir);
    const hit = raycastVoxels(
      this.world, tmpEye.x, tmpEye.y, tmpEye.z, tmpDir.x, tmpDir.y, tmpDir.z, DEPLOY_REACH,
    );
    if (!hit.hit) return null;

    // Snap to the quarter turn you're facing, then add whatever Q and E have
    // nudged it by. A barricade goes *across* your facing, so it's a wall
    // between you and what you're looking at rather than a line pointing at it.
    const facing = Math.round(Math.atan2(tmpDir.x, tmpDir.z) / HALF_TURN);
    const turns = (facing + this.loadout.deployRotation + 8) % 4;
    return {
      vx: hit.px, vy: hit.py, vz: hit.pz,
      alongX: turns % 2 === 0,
      yaw: turns * HALF_TURN,
    };
  }

  /** Redraws the ghost showing where the next deployable would stand. */
  private updateDeployGhost(): void {
    if (this.loadout.slot !== Slot.Build || !this.player.alive || this.shop.open) {
      this.deployables.hideGhost();
      return;
    }
    const id = this.loadout.deploySelected;
    const def = DEPLOYABLES[id];
    const spot = this.aimDeploySpot();
    if (!spot) { this.deployables.hideGhost(); return; }

    const ok = this.loadout.deployStock(id) > 0
      && !this.deployables.atCapacity(id)
      && this.deployables.fits(def, spot.vx, spot.vy, spot.vz, spot.alongX)
      && this.deployFootprintClearOfPlayer(def, spot.vx, spot.vy, spot.vz, spot.alongX);
    this.deployables.showGhost(def, spot.vx, spot.vy, spot.vz, spot.alongX, ok);
  }

  /** Nothing may be dropped on the player's own head. */
  private deployFootprintClearOfPlayer(
    def: DeployDef, vx: number, vy: number, vz: number, alongX: boolean,
  ): boolean {
    const half = (def.width - 1) / 2;
    for (let i = -half; i <= half; i++) {
      const cx = vx + (alongX ? i : 0);
      const cz = vz + (alongX ? 0 : i);
      for (let h = 0; h < def.height; h++) {
        if (!occupies(def, i + half, h)) continue;
        if (!this.canPlaceAt(cx, vy + h, cz)) return false;
      }
    }
    return true;
  }

  private placeDeployable(): void {
    const id = this.loadout.deploySelected;
    const def = DEPLOYABLES[id];

    if (this.loadout.deployStock(id) <= 0) {
      this.audio.play('deny');
      this.hud.setPrompt(`No ${def.name.toLowerCase()}s — buy them from the Defense Merchant`);
      return;
    }
    if (this.deployables.atCapacity(id)) {
      this.audio.play('deny');
      this.hud.log(`${def.name} limit reached (${def.maxPlaced} out)`, 'warn');
      return;
    }

    const spot = this.aimDeploySpot();
    if (!spot
      || !this.deployables.fits(def, spot.vx, spot.vy, spot.vz, spot.alongX)
      || !this.deployFootprintClearOfPlayer(def, spot.vx, spot.vy, spot.vz, spot.alongX)) {
      this.audio.play('deny');
      this.hud.setPrompt('No room for that here — needs flat ground and clearance');
      return;
    }

    if (def.pattern) this.stampBarricade(def, spot.vx, spot.vy, spot.vz, spot.alongX);
    else if (id === DeployId.Turret) this.deployables.addTurret(spot.vx, spot.vy, spot.vz, spot.yaw);
    else this.deployables.addCrate(spot.vx, spot.vy, spot.vz, spot.yaw);

    this.loadout.consumeDeployable(id);
    this.loadout.blockTool.cooldown = this.loadout.blockTool.def.delay;
    this.audio.play('place');
    this.hud.log(`${def.name} deployed`, 'good');

    // Running out of the kind you had selected switches you to something you
    // still have, rather than leaving you clicking on an empty slot.
    if (this.loadout.deployStock(id) === 0 && this.loadout.totalDeployables > 0) {
      this.loadout.cycleDeployable(1);
    }
  }

  /**
   * Writes a barricade into the voxel world as sandbags.
   *
   * It is deliberately real terrain rather than a prop: it collides, it takes
   * fire, bots path around it and tear at it, and the block tool patches it
   * back up. Reinforced HP with a sandbag colour.
   */
  private stampBarricade(def: DeployDef, vx: number, vy: number, vz: number, alongX: boolean): void {
    const half = (def.width - 1) / 2;
    for (let i = -half; i <= half; i++) {
      const x = vx + (alongX ? i : 0);
      const z = vz + (alongX ? 0 : i);
      for (let h = 0; h < def.height; h++) {
        if (!occupies(def, i + half, h)) continue;
        const y = vy + h;
        if (this.world.get(x, y, z) !== AIR) continue;
        this.world.set(x, y, z, COL_SANDBAG, Mat.Reinforced);
        this.net?.sendVoxel({ op: 0, x, y, z, color: COL_SANDBAG, mat: Mat.Reinforced });
        this.stats.blocksPlaced++;
      }
    }
  }

  /**
   * One round out of a turret.
   *
   * Deliberately not routed through `applyBotDamage`: that plays the player's
   * own hit confirmation, and a sentry chattering away across the base would
   * fill the mix with hitmarker ticks that weren't the player's doing. A
   * turret kill still pays, at half rate — it's the turret's work, not yours.
   */
  private turretFire(turret: Turret, target: Bot, muzzle: THREE.Vector3): void {
    const tx = target.position.x;
    const ty = target.position.y + target.poseHeight * 0.55;
    const tz = target.position.z;

    this.tracers.spawn(muzzle.x, muzzle.y, muzzle.z, tx, ty, tz, 0.85, 1, 0.7);
    this.particles.spawn(
      muzzle.x, muzzle.y, muzzle.z, 0, 1.2, 0,
      0.08, 1, 0.85, 0.45, 0.9, 0.35, 22, 0.6,
    );
    this.audio.play('smg', this.distanceToPlayer(muzzle.x, muzzle.y, muzzle.z));

    const dx = tx - muzzle.x;
    const dz = tz - muzzle.z;
    const len = Math.max(0.001, Math.hypot(dx, dz));
    const killed = this.bots.damage(target, TURRET.damage, {
      x: tx, y: ty, z: tz, dirX: dx / len, dirZ: dz / len, force: 1,
    });
    this.blood.spatter(tx, ty, tz, killed ? 3 : 1, killed ? 1.2 : 0.8);

    this.economy.award(Math.round(POINTS.hit * 0.5));
    if (killed) {
      this.economy.award(Math.round(target.def.points * 0.5));
      this.stats.kills++;
    }
    if (turret.dry) this.hud.log('Sentry out of ammo — buy a Turret Drum', 'warn');
  }

  /** Takes a resupply out of the crate the player is standing at. */
  private useAmmoCrate(crate: AmmoCrate): void {
    if (!crate.take()) {
      this.audio.play('deny');
      return;
    }
    this.loadout.addAmmoFraction(CRATE_FRACTION);
    this.deployables.refillTurrets();
    this.audio.play('reload');
    this.hud.log(
      crate.empty ? 'Resupplied — crate empty' : `Resupplied — ${crate.charges} left in the crate`,
      'good',
    );
    if (crate.empty) this.deployables.remove(crate);
  }

  private buy(item: ShopItem): boolean {
    if (!this.economy.canAfford(item)) {
      this.audio.play('deny');
      return false;
    }
    if (!this.economy.buy(item)) return false;

    switch (item.effect) {
      case ItemEffect.RefillAmmo: {
        this.loadout.refillAllAmmo();
        const reloaded = this.deployables.refillTurrets();
        if (reloaded > 0) this.hud.log(`${reloaded} sentr${reloaded === 1 ? 'y' : 'ies'} reloaded`, 'good');
        break;
      }
      case ItemEffect.AmmoBox:
        this.loadout.refillAllAmmo();
        this.loadout.addAmmoFraction(0.5);
        break;
      case ItemEffect.Bandolier:
        this.loadout.applyBandolier();
        break;
      case ItemEffect.GiveDeployable:
        if (item.deployable !== undefined) {
          this.loadout.addDeployable(item.deployable, item.amount ?? 1);
          this.loadout.deploySelected = item.deployable;
        }
        break;
      case ItemEffect.TurretAmmo: {
        const n = this.deployables.refillTurrets();
        this.hud.log(
          n > 0 ? `${n} sentr${n === 1 ? 'y' : 'ies'} reloaded` : 'No sentries out to reload',
          n > 0 ? 'good' : 'warn',
        );
        break;
      }
      case ItemEffect.GiveGrenades:
        this.loadout.grenades.stock = Math.min(
          this.loadout.grenades.def.maxStock,
          this.loadout.grenades.stock + (item.amount ?? 3),
        );
        break;
      case ItemEffect.GiveBlocks:
        if (item.material !== undefined) {
          this.loadout.addBlocks(item.material, item.amount ?? 0);
          this.loadout.material = item.material;
        }
        break;
      case ItemEffect.RepairAll:
        this.repairAll();
        break;
      case ItemEffect.Toughness:
        // A bigger pool is more hits before you go down, not a bigger number:
        // nothing anywhere shows it, you just last longer in the open.
        this.player.maxHp += item.amount ?? 25;
        this.player.heal(item.amount ?? 25);
        break;
      case ItemEffect.FastReload:
        this.loadout.fastReload = true;
        break;
      case ItemEffect.Speed:
        this.loadout.speedBoost = true;
        break;
      case ItemEffect.Scope:
        this.loadout.scoped = true;
        break;
    }

    this.audio.play('buy');
    return true;
  }

  private repairAll(): void {
    let restored = 0;
    for (const idx of Array.from(this.world.damagedVoxels)) {
      const x = idx % WORLD_X;
      const rest = (idx / WORLD_X) | 0;
      const z = rest % WORLD_Z;
      const y = (rest / WORLD_Z) | 0;
      restored += this.world.repair(x, y, z, 100000);
    }
    this.decals.markDirty();
    this.hud.log(`Repaired ${Math.round(restored)} HP of damage`, 'good');
  }

  // -------------------------------------------------------------------------
  // Camera / HUD
  // -------------------------------------------------------------------------
  private updateCamera(dt: number): void {
    const p = this.player;

    // Sprint ramps in faster than it ramps out, as in AoS.
    const sprintTarget = p.sprinting && !p.airborne ? 1 : 0;
    this.sprintState = sprintTarget > this.sprintState
      ? Math.min(1, this.sprintState + dt * 4)
      : Math.max(0, this.sprintState - dt * 3);
    const sp = smoothStep(this.sprintState);

    // AoS sprint bob: a yaw sway, a matching roll, and a short pitch kick on
    // each footfall. Small numbers -- it reads as speed, not as camera shake.
    const walk = p.bobPhase * Math.PI * 2;
    const bobYaw = Math.sin(walk) * 0.01 * sp;
    const bobRoll = -Math.sin(walk) * 0.005 * sp;
    let kick = Math.cos(walk);
    kick *= kick; kick *= kick; kick *= kick;
    const bobPitch = kick * 0.01 * sp;

    this.camera.position.set(p.position.x, p.eyeY, p.position.z);
    this.camera.rotation.set(p.pitch + bobPitch, p.yaw + bobYaw, bobRoll);

    // ADS zoom.
    const w = this.loadout.activeWeapon;
    const wantAds = this.input.mouseRight && this.isGunSlot() && w.def.adsFov > 0;
    let targetFov: number = RENDER.fov + RENDER.sprintFov * sp;
    if (wantAds) {
      targetFov = w.id === WeaponId.Rifle && this.loadout.scoped ? 22 : w.def.adsFov;
    }
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14);
    this.camera.updateProjectionMatrix();

    // The gun renders through its own camera, so that one has to zoom too --
    // otherwise the world magnifies while the ironsights stay hipfire-sized
    // and nothing lines up. Held wider than the world at rest so the model
    // doesn't fisheye, matched to it exactly once the sights are up.
    const vmTargetFov = wantAds ? targetFov : RENDER.vmFov;
    this.vmCamera.fov += (vmTargetFov - this.vmCamera.fov) * Math.min(1, dt * 14);
    this.vmCamera.updateProjectionMatrix();

    const moveSpeed = Math.hypot(p.velocity.x, p.velocity.z) * PHYS.velocityScale;
    this.viewModel.update(
      dt, this.input.mouseDX, this.input.mouseDY,
      moveSpeed, !p.airborne, wantAds, w.reloading,
    );

    // Footsteps, at the AoS cadence (one per 1/0.3 world units travelled).
    if (!p.airborne && p.lastStepDistance > PHYS.stepDistance) {
      p.lastStepDistance = 0;
      if (!this.intent.sneak) this.audio.play('step');
    }
  }

  private updateHud(dt: number): void {
    this.hud.update(dt);
    this.hud.setVitals(this.player.hurt, this.player.recovering);
    this.hud.updatePoints(this.economy.points);
    this.hud.updateLoadout(this.loadout);
    this.hud.updateCompass(this.player.yaw);

    const w = this.loadout.activeWeapon;
    const moving = Math.hypot(this.player.velocity.x, this.player.velocity.z);
    const spread = w.def.spread > 0
      ? w.currentSpread(moving, this.player.airborne, this.viewModel.adsAmount > 0.5)
      : 0;
    this.hud.updateCrosshair(spread * 900);
  }

  private updatePerf(): void {
    const info = this.renderer.renderer.info;
    this.hud.setPerf(
      `fps        ${this.renderer.fps.toFixed(0)}\n` +
      `cpu/frame  ${this.renderer.medianFrameMs().toFixed(2)} ms\n` +
      `res scale  ${(this.renderer.scale * 100).toFixed(0)}%\n` +
      `draw calls ${info.render.calls}\n` +
      `triangles  ${(info.render.triangles / 1000).toFixed(1)}k\n` +
      `chunks     ${this.chunks.group.children.length} (${this.chunks.pendingCount} queued)\n` +
      `workers    ${this.chunks.workerCount}\n` +
      `bots       ${this.bots.livingCount} in ${this.bots.squadCount} squads\n` +
      `navfield   ${this.nav.lastRebuildMs.toFixed(2)} ms\n` +
      `particles  ${this.particles.activeCount}\n` +
      `damaged    ${this.world.damagedVoxels.size}\n` +
      `pos        ${this.player.position.x.toFixed(1)}, ${this.player.position.y.toFixed(1)}, ${this.player.position.z.toFixed(1)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  /**
   * The spray a hoe throws up out of a flooded plot.
   *
   * Skipped entirely past a short range: there are a dozen blades going into
   * the mud out there, and at fifty blocks the splash is a pixel that isn't
   * worth a particle slot the guns might want.
   */
  private mudSplash(x: number, y: number, z: number): void {
    if (this.distanceToPlayer(x, y, z) > 34) return;
    for (let i = 0; i < 3; i++) {
      this.particles.spawn(
        x + (Math.random() - 0.5) * 0.3, y, z + (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 1.6, 1.4 + Math.random() * 1.4, (Math.random() - 0.5) * 1.6,
        0.34, 0.29, 0.22, 0.85,
        2.4, 0.45,
      );
    }
  }

  private distanceToPlayer(x: number, y: number, z: number): number {
    return Math.hypot(
      x - this.player.position.x,
      y - this.player.position.y,
      z - this.player.position.z,
    );
  }

  /** Ray vs the player's AABB. Returns the hit distance, or -1. */
  private raycastPlayer(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): number {
    if (!this.player.alive || this.player.invulnerable > 0) return -1;
    const r = PHYS.playerRadius;
    const p = this.player.position;
    let t0 = 0;
    let t1 = maxDist;

    const slab = (o: number, d: number, lo: number, hi: number): boolean => {
      if (Math.abs(d) < 1e-8) return o >= lo && o <= hi;
      const inv = 1 / d;
      let a = (lo - o) * inv;
      let b = (hi - o) * inv;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      return t0 <= t1;
    };

    if (!slab(ox, dx, p.x - r, p.x + r)) return -1;
    if (!slab(oy, dy, p.y, p.y + this.player.height)) return -1;
    if (!slab(oz, dz, p.z - r, p.z + r)) return -1;
    return t0 >= 0 ? t0 : -1;
  }

  private spawnBlockDebris(x: number, y: number, z: number, color: number, count: number): void {
    const r = palette[color * 3] / 255;
    const g = palette[color * 3 + 1] / 255;
    const b = palette[color * 3 + 2] / 255;
    for (let i = 0; i < count; i++) {
      this.particles.spawn(
        x + Math.random(), y + Math.random(), z + Math.random(),
        (Math.random() - 0.5) * 9, Math.random() * 7, (Math.random() - 0.5) * 9,
        r, g, b, 1,
        3 + Math.random() * 3, 0.8 + Math.random() * 0.8, 24, 0.5, true,
      );
    }
  }

  private spawnImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, color: number): void {
    const r = palette[color * 3] / 255;
    const g = palette[color * 3 + 1] / 255;
    const b = palette[color * 3 + 2] / 255;
    for (let i = 0; i < 5; i++) {
      this.particles.spawn(
        x + nx * 0.05, y + ny * 0.05, z + nz * 0.05,
        nx * 4 + (Math.random() - 0.5) * 5,
        ny * 4 + Math.random() * 4,
        nz * 4 + (Math.random() - 0.5) * 5,
        r, g, b, 1,
        2.5 + Math.random() * 2, 0.35 + Math.random() * 0.35, 24, 0.6,
      );
    }
  }

  /** Exposed for the pause menu / stats screens. */
  get currentWave(): number { return this.waves.wave; }
  get points(): number { return this.economy.points; }
  get runStats(): Readonly<typeof this.stats> { return this.stats; }
  get hudRef(): HUD { return this.hud; }
  get inputRef(): Input { return this.input; }
  get shopOpen(): boolean { return this.shop.open; }
  /** UI that has taken the pointer on purpose; suppresses the auto-pause. */
  get menuOpen(): boolean { return this.shop.open; }
}

/**
 * Cone-scatter a normalised direction in place.
 *
 * The basis vectors are scratch of their own rather than the shared tmpVec
 * pair: callers pass those in as `dir`, and building the basis on top of the
 * vector being scattered collapses it to zero — which is a shot that travels
 * nowhere and hits nothing.
 */
const spreadU = new THREE.Vector3();
const spreadV = new THREE.Vector3();

function applySpread(dir: THREE.Vector3, spread: number): void {
  if (spread <= 0) return;
  // Uniform-ish disc scatter around the aim axis.
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * spread;
  // Build a basis perpendicular to dir.
  const ax = Math.abs(dir.y) < 0.99 ? 0 : 1;
  spreadU.set(ax, ax === 0 ? 1 : 0, 0).cross(dir).normalize();
  spreadV.copy(dir).cross(spreadU).normalize();
  dir.addScaledVector(spreadU, Math.cos(a) * r);
  dir.addScaledVector(spreadV, Math.sin(a) * r);
  dir.normalize();
}

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export { Phase, COL_CORE, BotState };
