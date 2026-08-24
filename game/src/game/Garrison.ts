/**
 * The men in the jungle camps.
 *
 * Garrisons are not a wave and are not counted as one: they are standing on the
 * map before the first prep timer runs out and they stay on it until somebody
 * kills them. Clearing a camp is therefore worth doing and *stays* done for the
 * rest of the wave — the jungle only refills between waves, while the player is
 * back behind the parapet deciding whether the trip to the merchants is worth
 * it this time.
 *
 * This module owns nothing but the decision of who stands where. How they
 * behave once they are standing there is BotManager's business (see the Guard
 * state), and how they notice you is ai/stealth.ts.
 */

import type { BotManager } from '../ai/BotManager';
import type { OutpostSite } from '../voxel/outposts';
import { BotKind } from '../ai/botTypes';

/**
 * How many men a camp holds on a given wave.
 *
 * Small. A camp is an ambush, not a second front: four men who shoot first are
 * far more frightening than eight the player can hear coming, and every one of
 * them is a man not attacking the base.
 */
function garrisonSize(wave: number): number {
  return Math.min(5, 3 + Math.floor(wave / 5));
}

/**
 * Who is in it.
 *
 * A rifleman in every camp is the deliberate part: he is the one with the reach
 * to punish a player who breaks cover in the open, which is what makes creeping
 * along the treeline the right answer rather than a slower version of running.
 */
function garrisonKinds(wave: number, rand: () => number): BotKind[] {
  const kinds: BotKind[] = [BotKind.Rifleman];
  const n = garrisonSize(wave) - 1;
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (wave >= 4 && r < 0.25) kinds.push(BotKind.Shotgunner);
    else if (wave >= 3 && r < 0.5) kinds.push(BotKind.Raider);
    else kinds.push(BotKind.Grunt);
  }
  return kinds;
}

export class Garrison {
  constructor(
    private readonly bots: BotManager,
    private readonly rand: () => number = Math.random,
  ) {}

  /**
   * Mans every camp that is short of men, and returns how many were posted.
   *
   * Idempotent by design: it counts what is already alive at each post first,
   * so calling it every prep phase tops the camps up rather than stacking a
   * fresh garrison on top of the last one.
   */
  reinforce(sites: readonly OutpostSite[], wave: number): number {
    let posted = 0;

    for (const site of sites) {
      const held = this.countAt(site);
      const want = garrisonSize(wave);
      if (held >= want) continue;

      const kinds = garrisonKinds(wave, this.rand);
      for (let i = held; i < want; i++) {
        const kind = kinds[i % kinds.length];
        // The first man of an empty camp goes up the tower. He is the reason
        // the camp has reach: everyone else is waiting behind the berm for
        // something to come to them, and he is the one who finds it.
        const ok = i === 0
          ? this.postTower(site, wave) || this.post(site, kind, wave)
          : this.post(site, kind, wave);
        if (ok) posted++;
      }
    }

    return posted;
  }

  /**
   * Living men belonging to a camp.
   *
   * Measured against the camp rather than against an exact post, because the
   * spotter's post is the tower platform and not the middle of the ground --
   * matching exactly would leave him uncounted and put a second man up the
   * ladder every prep phase.
   */
  private countAt(site: OutpostSite): number {
    let n = 0;
    for (const b of this.bots.bots) {
      if (!b.alive || !b.garrison) continue;
      if (Math.hypot(b.postX - site.x, b.postZ - site.z) > site.radius + 2) continue;
      n++;
    }
    return n;
  }

  /**
   * Puts the spotter on the watchtower platform.
   *
   * His post radius is deliberately tiny: a man up a ladder who decides to
   * wander is a man who walks off a platform, and the whole value of him is
   * that he stays where the view is.
   */
  private postTower(site: OutpostSite, wave: number): boolean {
    const bot = this.bots.spawnGuard(
      BotKind.Rifleman, site.tower.x, site.tower.y, site.tower.z,
      1 + wave * 0.04, 1 + wave * 0.03,
      { x: site.tower.x, z: site.tower.z, radius: 1.2 },
    );
    return bot !== null;
  }

  /**
   * Puts one man somewhere inside a camp.
   *
   * Spread around the berm rather than dropped on the centre: a garrison that
   * spawns in a heap is one grenade, and men who are already apart when the
   * shooting starts are the ones who get to flank.
   */
  private post(site: OutpostSite, kind: BotKind, wave: number): boolean {
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = this.rand() * Math.PI * 2;
      const r = site.radius * (0.25 + this.rand() * 0.55);
      const bot = this.bots.spawnGuard(
        kind,
        site.x + Math.cos(a) * r,
        site.y,
        site.z + Math.sin(a) * r,
        // Camps do not scale the way waves do. They get a little tougher as the
        // run goes on so they stay a threat, but a player who has learned to
        // clear one should keep being able to.
        1 + wave * 0.04,
        1 + wave * 0.03,
        site,
      );
      if (bot) return true;
    }
    return false;
  }
}
