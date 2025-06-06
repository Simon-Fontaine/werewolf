import { GameRole } from "@werewolf/database";

export const GAME_CONFIG = {
  // Timing (in seconds)
  phases: {
    lobby: { min: 30, max: 300 },
    night: { default: 90, min: 30, max: 180 },
    day: { default: 180, min: 60, max: 300 },
    voting: { default: 60, min: 30, max: 120 },
  },

  // Player limits
  players: {
    min: 5,
    max: 15,
    optimalMin: 8,
    optimalMax: 12,
  },

  // Role distribution based on player count
  roleDistribution: {
    5: { werewolves: 1, seer: 1, villagers: 3 },
    6: { werewolves: 1, seer: 1, witch: 1, villagers: 3 },
    7: { werewolves: 2, seer: 1, witch: 1, villagers: 3 },
    8: { werewolves: 2, seer: 1, witch: 1, hunter: 1, villagers: 3 },
    9: { werewolves: 2, seer: 1, witch: 1, hunter: 1, villagers: 4 },
    10: { werewolves: 2, seer: 1, witch: 1, hunter: 1, guard: 1, villagers: 4 },
    11: { werewolves: 3, seer: 1, witch: 1, hunter: 1, guard: 1, villagers: 4 },
    12: {
      werewolves: 3,
      seer: 1,
      witch: 1,
      hunter: 1,
      guard: 1,
      cupid: 1,
      villagers: 4,
    },
    13: {
      werewolves: 3,
      seer: 1,
      witch: 1,
      hunter: 1,
      guard: 1,
      cupid: 1,
      villagers: 5,
    },
    14: {
      werewolves: 4,
      seer: 1,
      witch: 1,
      hunter: 1,
      guard: 1,
      cupid: 1,
      villagers: 5,
    },
    15: {
      werewolves: 4,
      seer: 1,
      witch: 1,
      hunter: 1,
      guard: 1,
      cupid: 1,
      villagers: 6,
    },
  },

  // Special role configurations
  roleAbilities: {
    [GameRole.WITCH]: { healPotions: 1, poisonPotions: 1 },
    [GameRole.POISONER]: { poisonPotions: 2 },
    [GameRole.BLACK_WOLF]: { convertUses: 1 },
    [GameRole.WHITE_WOLF]: { devourCooldown: 2 }, // Every 2 nights
    [GameRole.DICTATOR]: { coupAttempts: 1 },
  },
};
