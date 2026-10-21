// The rules version. Bump it whenever a change would make an old action log
// replay differently (rules, maps, tie-breaks). Older versions stay supported
// where it's cheap, so saved replays keep working.
//
// v2: line of sight, per-map team size and score, void terrain.
// v3: more rock and high ground on every map; speed ties alternate between
//     teams, starting with a team chosen by the seed (v2 always favored Blue).
export const RULES_VERSION = 3;
