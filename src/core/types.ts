import type { Dir, Hex } from './hex';
import type { RngState } from './rng';

export type TeamId = 0 | 1;
/** blocked = rock (impassable, blocks sight); void = pit/lava (impassable, open sight). */
export type Terrain = 'normal' | 'rough' | 'blocked' | 'void';

export interface Tile {
  q: number;
  r: number;
  h: number; // 0..3
  terrain: Terrain;
}

export interface MapDef {
  id: string;
  name: string;
  blurb: string;
  teamSize: number;
  scoreToWin: number;
  tiles: Tile[];
  beacons: Hex[];
  spawns: [Hex[], Hex[]];
  /** Default facing for each team's spawn. */
  spawnFacing: [Dir, Dir];
}

export interface Stats {
  hp: number;
  atk: number;
  def: number;
  mag: number;
  res: number;
  spd: number;
  move: number;
  jump: number;
}

export type Role = 'tank' | 'skirmisher' | 'support' | 'zoner' | 'ranged' | 'assassin' | 'controller';

export type StatusId = 'slow' | 'stun' | 'poison' | 'regen' | 'shield' | 'thorns' | 'camo' | 'fortify';

export type Effect =
  | { kind: 'damage'; stat: 'atk' | 'mag'; power: number; rearBonus?: number }
  | { kind: 'heal'; power: number }
  | { kind: 'push'; dist: number }
  | { kind: 'pull'; dist: number }
  | { kind: 'status'; status: StatusId; turns: number; amount?: number }
  | { kind: 'ctShift'; amount: number }
  | { kind: 'cleanse' }
  | { kind: 'hazard'; ticks: number; damage: number }
  /** Caster leaps to the free hex next to the target that is closest to it. */
  | { kind: 'leap' };

/** Who an ability's area affects. */
export type Affects = 'enemies' | 'allies' | 'all' | 'self' | 'tiles';

export interface AbilityDef {
  id: string;
  name: string;
  desc: string;
  /** Range from caster to the targeted hex. 0 = self. */
  minRange: number;
  maxRange: number;
  /** Area: radius around target, or a ray of `length` in the target's direction. */
  area: { shape: 'single' } | { shape: 'radius'; radius: number } | { shape: 'ray'; length: number };
  affects: Affects;
  /** Base accuracy in basis points. Omit for abilities that always land (heals, self buffs). */
  acc?: number;
  /** Max height difference for range-1 abilities (melee reach). */
  vertical?: number;
  cooldown: number;
  /** If set, the ability charges in the CT queue at this speed before resolving. */
  chargeSpeed?: number;
  /** Ability needs a unit (any team) on the targeted hex. */
  needsUnitTarget?: boolean;
  /** Direct shot: needs a clear line of sight (terrain and units block). */
  los?: boolean;
  /** Ability needs the targeted hex to be empty. */
  needsEmptyTarget?: boolean;
  effects: Effect[];
}

export interface MonsterDef {
  id: string;
  name: string;
  animal: string;
  role: Role;
  blurb: string;
  stats: Stats;
  abilities: AbilityDef[]; // [0] is the basic attack
  color: number;
}

export interface Status {
  id: StatusId;
  turns: number;
  amount: number;
}

export interface Unit {
  id: number;
  defId: string;
  team: TeamId;
  pos: Hex;
  facing: Dir;
  hp: number;
  maxHp: number;
  ct: number;
  alive: boolean;
  statuses: Status[];
  cooldowns: Record<string, number>;
}

export interface PendingCast {
  id: number;
  caster: number;
  ability: string;
  target: Hex;
  charge: number;
  speed: number;
}

export interface Hazard {
  pos: Hex;
  team: TeamId; // owner; hurts the other team
  damage: number;
  expiresAt: number; // global tick
}

export interface Beacon {
  pos: Hex;
  owner: TeamId | null;
}

export interface TurnState {
  unit: number;
  moved: boolean;
  acted: boolean;
}

export type StrategyId = 'balanced' | 'aggressive' | 'defensive' | 'objective';

export interface MatchConfig {
  rulesVersion: number;
  seed: string;
  mapId: string;
  teams: [string[], string[]];
  /** Who controls each side: an AI strategy, or null for a human. Metadata only; rules ignore it. */
  ai?: [StrategyId | null, StrategyId | null];
}

export interface GameState {
  config: MatchConfig;
  rng: RngState;
  tick: number;
  units: Unit[];
  beacons: Beacon[];
  score: [number, number];
  pulseCt: number;
  pulses: number;
  pending: PendingCast[];
  nextCastId: number;
  hazards: Hazard[];
  turn: TurnState | null;
  winner: TeamId | 'draw' | null;
  /** Rules v3+: the team that wins the next speed tie between teams (alternates). */
  tieTeam?: TeamId;
  /** Number of actions applied so far (handy for UI and debugging). */
  actionCount: number;
}

export type Action =
  | { type: 'move'; unit: number; to: Hex }
  | { type: 'ability'; unit: number; ability: string; target: Hex }
  | { type: 'end'; unit: number; facing: Dir };

export type GameEvent =
  | { type: 'turnStart'; unit: number }
  | { type: 'move'; unit: number; path: Hex[] }
  | { type: 'abilityUsed'; unit: number; ability: string; target: Hex }
  | { type: 'castStart'; cast: PendingCast }
  | { type: 'castResolve'; castId: number; unit: number; ability: string; target: Hex }
  | { type: 'castFizzle'; castId: number }
  | { type: 'hit'; unit: number; source: number; amount: number; arc: Arc }
  | { type: 'miss'; unit: number; source: number }
  | { type: 'heal'; unit: number; amount: number }
  | { type: 'shieldAbsorb'; unit: number; amount: number }
  | { type: 'displace'; unit: number; path: Hex[] }
  | { type: 'collision'; unit: number; amount: number }
  | { type: 'hazardHit'; unit: number; amount: number }
  | { type: 'statusAdd'; unit: number; status: StatusId }
  | { type: 'statusTick'; unit: number; status: StatusId; amount: number }
  | { type: 'stunned'; unit: number }
  | { type: 'ctShift'; unit: number; amount: number }
  | { type: 'hazardPlaced'; tiles: Hex[]; team: TeamId }
  | { type: 'ko'; unit: number }
  | { type: 'capture'; beacon: number; team: TeamId }
  | { type: 'pulse'; score: [number, number]; gained: [number, number] }
  | { type: 'facing'; unit: number; facing: Dir }
  | { type: 'gameOver'; winner: TeamId | 'draw' };

export type Arc = 'front' | 'flank' | 'rear';
