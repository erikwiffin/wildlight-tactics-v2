import type { AbilityDef, MonsterDef } from './types';

const melee = (id: string, name: string, desc: string, power: number, extra: Partial<AbilityDef> = {}): AbilityDef => ({
  id,
  name,
  desc,
  minRange: 1,
  maxRange: 1,
  area: { shape: 'single' },
  affects: 'enemies',
  acc: 9000,
  vertical: 2,
  cooldown: 0,
  needsUnitTarget: true,
  effects: [{ kind: 'damage', stat: 'atk', power }],
  ...extra,
});

export const MONSTERS: MonsterDef[] = [
  {
    id: 'rhino',
    name: 'Bulwark Rhino',
    animal: 'Black rhinoceros',
    role: 'tank',
    blurb: 'Nanite plating grows over its hide like armor. It holds Beacons that nobody else can.',
    color: 0x8a8f99,
    stats: { hp: 125, atk: 17, def: 16, mag: 4, res: 10, spd: 6, move: 3, jump: 1 },
    abilities: [
      melee('gore', 'Gore', 'Horn strike.', 100),
      melee('ram', 'Ram', 'Hits and shoves the target 2 hexes. Slamming into something deals extra damage.', 80, {
        cooldown: 2,
        effects: [{ kind: 'damage', stat: 'atk', power: 80 }, { kind: 'push', dist: 2 }],
      }),
      {
        id: 'plate',
        name: 'Plate Up',
        desc: 'Grows a 30-point nanite shield and raises DEF by 50% for 2 turns.',
        minRange: 0, maxRange: 0, area: { shape: 'single' }, affects: 'self', cooldown: 3,
        effects: [
          { kind: 'status', status: 'shield', turns: 3, amount: 30 },
          { kind: 'status', status: 'fortify', turns: 2, amount: 50 },
        ],
      },
      {
        id: 'stomp',
        name: 'Quake Stomp',
        desc: 'Damages adjacent enemies and knocks their next turn back (CT -25).',
        minRange: 0, maxRange: 0, area: { shape: 'radius', radius: 1 }, affects: 'enemies',
        acc: 8500, cooldown: 3,
        effects: [{ kind: 'damage', stat: 'atk', power: 55 }, { kind: 'ctShift', amount: -25 }],
      },
    ],
  },
  {
    id: 'fox',
    name: 'Phase Fox',
    animal: 'Red fox',
    role: 'skirmisher',
    blurb: 'Its swarm folds space for split seconds. Fast, slippery, and fragile.',
    color: 0xe0702a,
    stats: { hp: 82, atk: 16, def: 8, mag: 8, res: 8, spd: 9, move: 5, jump: 2 },
    abilities: [
      melee('bite', 'Bite', 'Quick bite.', 100),
      {
        id: 'phase',
        name: 'Phase Strike',
        desc: 'Blinks next to an enemy up to 4 hexes away and strikes.',
        minRange: 2, maxRange: 4, area: { shape: 'single' }, affects: 'enemies', acc: 9000, cooldown: 2,
        needsUnitTarget: true,
        effects: [{ kind: 'leap' }, { kind: 'damage', stat: 'atk', power: 85 }],
      },
      melee('rend', 'Rend', 'Tearing bite that poisons for 3 turns (8/turn).', 70, {
        cooldown: 2,
        effects: [{ kind: 'damage', stat: 'atk', power: 70 }, { kind: 'status', status: 'poison', turns: 3, amount: 8 }],
      }),
      melee('hamstring', 'Hamstring', 'Low strike that halves the target\'s Speed for 2 turns.', 60, {
        cooldown: 3,
        effects: [{ kind: 'damage', stat: 'atk', power: 60 }, { kind: 'status', status: 'slow', turns: 2 }],
      }),
    ],
  },
  {
    id: 'moth',
    name: 'Lumen Moth',
    animal: 'Atlas moth',
    role: 'support',
    blurb: 'Sheds glowing nanite dust that knits wounds closed.',
    color: 0xe8d36a,
    stats: { hp: 70, atk: 6, def: 6, mag: 16, res: 14, spd: 7, move: 4, jump: 3 },
    abilities: [
      {
        id: 'dust', name: 'Sting Dust', desc: 'Short-range magic jab.',
        minRange: 1, maxRange: 3, area: { shape: 'single' }, affects: 'enemies', acc: 9000, cooldown: 0,
        los: true, needsUnitTarget: true, effects: [{ kind: 'damage', stat: 'mag', power: 55 }],
      },
      {
        id: 'mend', name: 'Mend', desc: 'Heals one ally.',
        minRange: 0, maxRange: 3, area: { shape: 'single' }, affects: 'allies', cooldown: 1,
        needsUnitTarget: true, effects: [{ kind: 'heal', power: 140 }],
      },
      {
        id: 'bloom', name: 'Nanite Bloom', desc: 'Charges, then heals and cleanses allies in a radius.',
        minRange: 0, maxRange: 4, area: { shape: 'radius', radius: 1 }, affects: 'allies', cooldown: 3,
        chargeSpeed: 12, effects: [{ kind: 'heal', power: 90 }, { kind: 'cleanse' }],
      },
      {
        id: 'regen', name: 'Regen Swarm', desc: 'Ally regenerates 12 HP per turn for 3 turns.',
        minRange: 0, maxRange: 3, area: { shape: 'single' }, affects: 'allies', cooldown: 2,
        needsUnitTarget: true, effects: [{ kind: 'status', status: 'regen', turns: 3, amount: 12 }],
      },
    ],
  },
  {
    id: 'porcupine',
    name: 'Quill Porcupine',
    animal: 'Crested porcupine',
    role: 'zoner',
    blurb: 'Fires nanite-tipped quills that take root as spike fields.',
    color: 0x6b4f3a,
    stats: { hp: 100, atk: 14, def: 13, mag: 10, res: 10, spd: 6, move: 3, jump: 1 },
    abilities: [
      melee('jab', 'Quill Jab', 'Point-blank quill strike.', 100),
      {
        id: 'volley', name: 'Quill Volley', desc: 'Rains quills on a small area.',
        minRange: 2, maxRange: 4, area: { shape: 'radius', radius: 1 }, affects: 'enemies', acc: 8000, cooldown: 2,
        effects: [{ kind: 'damage', stat: 'atk', power: 55 }],
      },
      {
        id: 'spikes', name: 'Spike Field', desc: 'Seeds spikes on a radius-1 area. Enemies that step in take 14 and stop. Lasts a while.',
        minRange: 1, maxRange: 3, area: { shape: 'radius', radius: 1 }, affects: 'tiles', cooldown: 4,
        effects: [{ kind: 'hazard', ticks: 60, damage: 14 }],
      },
      {
        id: 'bristle', name: 'Bristle', desc: 'Melee attackers take 12 damage for 3 turns.',
        minRange: 0, maxRange: 0, area: { shape: 'single' }, affects: 'self', cooldown: 3,
        effects: [{ kind: 'status', status: 'thorns', turns: 3, amount: 12 }],
      },
    ],
  },
  {
    id: 'eel',
    name: 'Arc Eel',
    animal: 'Electric eel',
    role: 'ranged',
    blurb: 'Its swarm turns bioelectricity into lightning. Floats on a halo of static.',
    color: 0x3fb6d9,
    stats: { hp: 74, atk: 8, def: 7, mag: 18, res: 10, spd: 7, move: 3, jump: 2 },
    abilities: [
      {
        id: 'zap', name: 'Zap', desc: 'Ranged shock.',
        minRange: 2, maxRange: 4, area: { shape: 'single' }, affects: 'enemies', acc: 8500, cooldown: 0,
        los: true, needsUnitTarget: true, effects: [{ kind: 'damage', stat: 'mag', power: 75 }],
      },
      {
        id: 'lance', name: 'Arc Lance', desc: 'Lightning pierces every enemy in a straight line of 5. Rock and high walls stop it.',
        minRange: 1, maxRange: 1, area: { shape: 'ray', length: 5 }, affects: 'enemies', acc: 8500, cooldown: 2,
        effects: [{ kind: 'damage', stat: 'mag', power: 80 }],
      },
      {
        id: 'storm', name: 'Storm Call', desc: 'Charges, then strikes a radius-1 area hard.',
        minRange: 2, maxRange: 5, area: { shape: 'radius', radius: 1 }, affects: 'enemies', acc: 9500, cooldown: 3,
        chargeSpeed: 10, effects: [{ kind: 'damage', stat: 'mag', power: 120 }],
      },
      {
        id: 'static', name: 'Static Snare', desc: 'Light shock that stuns the target, skipping their next turn.',
        minRange: 1, maxRange: 3, area: { shape: 'single' }, affects: 'enemies', acc: 7000, cooldown: 4,
        los: true, needsUnitTarget: true, effects: [{ kind: 'damage', stat: 'mag', power: 35 }, { kind: 'status', status: 'stun', turns: 1 }],
      },
    ],
  },
  {
    id: 'lynx',
    name: 'Shade Lynx',
    animal: 'Eurasian lynx',
    role: 'assassin',
    blurb: 'Its fur bends light. You only see it when it wants you to.',
    color: 0x5a4a7a,
    stats: { hp: 80, atk: 20, def: 8, mag: 4, res: 7, spd: 8, move: 4, jump: 2 },
    abilities: [
      melee('claw', 'Claw', 'Raking claws.', 100),
      melee('ambush', 'Ambush', 'Brutal strike with +25% extra damage from the rear.', 125, {
        cooldown: 2,
        effects: [{ kind: 'damage', stat: 'atk', power: 125, rearBonus: 25 }],
      }),
      {
        id: 'pounce', name: 'Pounce', desc: 'Leaps next to an enemy 2-3 hexes away and strikes.',
        minRange: 2, maxRange: 3, area: { shape: 'single' }, affects: 'enemies', acc: 9000, cooldown: 2,
        needsUnitTarget: true, effects: [{ kind: 'leap' }, { kind: 'damage', stat: 'atk', power: 80 }],
      },
      {
        id: 'camo', name: 'Optic Camo', desc: 'Cannot be targeted from more than 1 hex away for 2 turns. Ends when it attacks.',
        minRange: 0, maxRange: 0, area: { shape: 'single' }, affects: 'self', cooldown: 4,
        effects: [{ kind: 'status', status: 'camo', turns: 2 }],
      },
    ],
  },
  {
    id: 'octopus',
    name: 'Ink Octopus',
    animal: 'Common octopus',
    role: 'controller',
    blurb: 'Walks on land on nanite-stiffened arms. Its ink jams other swarms.',
    color: 0xb5466b,
    stats: { hp: 88, atk: 11, def: 9, mag: 15, res: 13, spd: 7, move: 3, jump: 2 },
    abilities: [
      {
        id: 'lash', name: 'Lash', desc: 'Tentacle whip with reach 2.',
        minRange: 1, maxRange: 2, area: { shape: 'single' }, affects: 'enemies', acc: 9000, cooldown: 0,
        los: true, needsUnitTarget: true, effects: [{ kind: 'damage', stat: 'atk', power: 90 }],
      },
      {
        id: 'pull', name: 'Tentacle Pull', desc: 'Drags an enemy 2 hexes toward the octopus.',
        minRange: 2, maxRange: 4, area: { shape: 'single' }, affects: 'enemies', acc: 8500, cooldown: 2,
        los: true, needsUnitTarget: true, effects: [{ kind: 'damage', stat: 'mag', power: 35 }, { kind: 'pull', dist: 2 }],
      },
      {
        id: 'ink', name: 'Ink Cloud', desc: 'Slows enemies in a radius for 2 turns.',
        minRange: 1, maxRange: 3, area: { shape: 'radius', radius: 1 }, affects: 'enemies', acc: 8500, cooldown: 3,
        effects: [{ kind: 'damage', stat: 'mag', power: 30 }, { kind: 'status', status: 'slow', turns: 2 }],
      },
      {
        id: 'jam', name: 'Nanite Jam', desc: 'Scrambles a swarm: target loses 50 CT.',
        minRange: 1, maxRange: 3, area: { shape: 'single' }, affects: 'enemies', acc: 8000, cooldown: 3,
        los: true, needsUnitTarget: true, effects: [{ kind: 'damage', stat: 'mag', power: 30 }, { kind: 'ctShift', amount: -50 }],
      },
    ],
  },
];

export const MONSTER_BY_ID: Record<string, MonsterDef> = Object.fromEntries(MONSTERS.map((m) => [m.id, m]));

export function getAbility(defId: string, abilityId: string): AbilityDef {
  const a = MONSTER_BY_ID[defId]?.abilities.find((x) => x.id === abilityId);
  if (!a) throw new Error(`Unknown ability ${defId}/${abilityId}`);
  return a;
}

/** Ability ids are unique across the roster, so an id alone identifies one. */
export function abilityById(abilityId: string): AbilityDef {
  for (const m of MONSTERS) {
    const a = m.abilities.find((x) => x.id === abilityId);
    if (a) return a;
  }
  throw new Error(`Unknown ability ${abilityId}`);
}
