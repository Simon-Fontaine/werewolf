import { GamePhase, GameRole } from "@werewolf/database";

export interface GameState {
  id: string;
  code: string;
  name: string;
  phase: GamePhase;
  dayNumber: number;
  players: PlayerInfo[];
  phaseEndsAt?: Date;
  isHost: boolean;
  myRole?: GameRole;
  aliveCount: number;
  deadPlayers: PlayerInfo[];
}

export interface GameStateData extends GameState {
  state: string;
  minPlayers: number;
  maxPlayers: number;
  canStart: boolean;
}

export interface PlayerInfo {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl?: string;
  position: number;
  isAlive: boolean;
  role?: GameRole; // Only visible to player themselves or when revealed
  isHost: boolean;
}

export interface ActionResult {
  action: string;
  success: boolean;
  targetId?: string;
  prevented?: boolean;
  preventedBy?: string;
}

export interface VoteCount {
  playerId: string;
  votes: number;
  voters: string[];
}

export interface CreateGameOptions {
  name: string;
  minPlayers?: number;
  maxPlayers?: number;
  isPrivate?: boolean;
  password?: string;
  nightDuration?: number;
  dayDuration?: number;
  voteDuration?: number;
}
