// Seeded, serializable PRNG (sfc32). All state is four uint32s so it can live
// inside GameState and survive JSON round-trips, which is what makes replays exact.

export type RngState = [number, number, number, number];

/** Hash an arbitrary seed string into 32 bits (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(a: number): () => number {
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

export function seedRng(seed: string | number): RngState {
  const base = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  const next = splitmix32(base);
  const s: RngState = [next(), next(), next(), next()];
  // Warm up so nearby seeds diverge quickly.
  for (let i = 0; i < 12; i++) nextU32(s);
  return s;
}

/** Advance the state in place and return a uint32. */
export function nextU32(s: RngState): number {
  let [a, b, c, d] = s;
  a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
  const t = (((a + b) >>> 0) + d) >>> 0;
  d = (d + 1) >>> 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) >>> 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) >>> 0;
  s[0] = a >>> 0; s[1] = b; s[2] = c; s[3] = d;
  return t;
}

/** Uniform integer in [0, 10000): compared against chances in basis points. */
export function rollBp(s: RngState): number {
  return nextU32(s) % 10000;
}
