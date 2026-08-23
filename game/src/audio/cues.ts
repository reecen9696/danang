/**
 * What an enemy can be heard saying.
 *
 * Kept apart from the rest of audio/ on purpose: the AI raises these cues and
 * the AI also runs on the server, where there is no WebAudio and no DOM at all.
 * This module pulls in nothing, so BotManager can name a cue without dragging
 * an AudioContext into the server build.
 */
export const enum VoiceCue {
  /** Just laid eyes on the player. */
  Contact = 0,
  /** Moving up with no contact — chatter, calls between squadmates. */
  Advance = 1,
  /** Took a round and lived. */
  Hurt = 2,
  /**
   * Grenade in the air. There is deliberately no cue for being killed: the
   * death cry in Audio.ts is a purpose-recorded scream and owns that moment,
   * and a man cannot both scream and finish a sentence.
   */
  Grenade = 3,
}
