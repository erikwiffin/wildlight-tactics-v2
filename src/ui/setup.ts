// Setup: mode, map, AI styles, team picks, seed.

import { aiTeam, STRATEGIES } from '../core/ai';
import { hexKey } from '../core/hex';
import { MAP_LIST, MAPS } from '../core/map';
import { MONSTER_BY_ID, MONSTERS } from '../core/monsters';
import type { MapDef, StrategyId } from '../core/types';
import { agentAvailable } from '../agent/agent';
import { el, esc } from './dom';
import { loadPrefs, savePrefs, type Prefs } from './store';

const WORDS = ['ember', 'static', 'moss', 'quill', 'shade', 'tide', 'glint', 'ash', 'bloom', 'flux', 'umbra', 'spark'];

export function randomSeed(): string {
  // Only the *choice* of seed is random; everything after it is deterministic.
  const w = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${w()}-${w()}-${Math.floor(Math.random() * 1000)}`;
}

export interface SetupResult {
  prefs: Prefs;
  seed: string;
}

export function showSetup(host: HTMLElement, onStart: (r: SetupResult) => void, onLibrary: () => void): void {
  const prefs = loadPrefs();
  if (!MAPS[prefs.mapId]) prefs.mapId = 'arena';
  const screen = el('div', 'screen');
  screen.innerHTML = `
    <h1 class="title">WILD<span>LIGHT</span> TACTICS</h1>
    <p class="tagline">Nanite-touched animals fight for the Beacons.</p>`;

  // Mode
  const modeRow = el('div', 'segmented');
  modeRow.setAttribute('role', 'tablist');
  const modeBtns = (['play', 'aivai'] as const).map((m) => {
    const b = el('button', '', m === 'play' ? 'You vs AI' : 'AI vs AI');
    b.setAttribute('role', 'tab');
    b.onclick = () => {
      prefs.mode = m;
      refresh();
    };
    modeRow.append(b);
    return { b, m };
  });

  // Map
  const mapSection = section('Map');
  const mapGrid = el('div', 'maps');
  const mapCards = MAP_LIST.map((m) => {
    const b = el('button', 'map-card');
    const c = document.createElement('canvas');
    c.width = 480; // drawn at 2x for sharp edges on phones
    c.height = 300;
    drawMiniMap(c, m);
    b.append(c);
    const info = el('div', 'map-info');
    info.innerHTML = `<h3>${esc(m.name)}</h3><div class="map-tags"><span>${m.teamSize}v${m.teamSize}</span><span>${m.beacons.length} Beacons</span><span>to ${m.scoreToWin}</span></div><p>${esc(m.blurb)}</p>`;
    b.append(info);
    b.onclick = () => {
      prefs.mapId = m.id;
      prefs.picks = prefs.picks.slice(0, m.teamSize);
      refresh();
    };
    mapGrid.append(b);
    return { b, id: m.id };
  });
  mapSection.append(mapGrid);

  // Control (You vs AI only)
  const controlSection = section('How you play');
  const controlRow = el('div', 'chips');
  const controlHint = el('p', 'hint');
  const agent = { ok: false, reason: 'Checking for the Claude agent…' };
  const controlBtns = (
    [
      ['direct', 'Tap commands', 'You move and act with every unit yourself.'],
      ['orders', 'Give orders (Claude)', 'Write or say a standing order per unit; Claude Haiku plays your turns.'],
    ] as const
  ).map(([id, label, desc]) => {
    const b = el('button', 'chip-btn', label);
    b.title = desc;
    b.onclick = () => {
      prefs.control = id;
      refresh();
    };
    controlRow.append(b);
    return { b, id, desc };
  });
  controlSection.append(controlRow, controlHint);
  void agentAvailable().then((r) => {
    agent.ok = r.ok;
    agent.reason = r.reason ?? '';
    refresh();
  });

  // AI styles
  const styleSection = section('AI style');
  const styleHost = el('div', 'styles');
  styleSection.append(styleHost);

  // Team
  const teamSection = section('Your team');
  const teamHint = el('p', 'hint');
  const roster = el('div', 'roster');
  const cards = MONSTERS.map((m) => {
    const b = el('button', 'mcard');
    const s = m.stats;
    b.innerHTML = `
      <div class="role">${m.role}</div>
      <h3>${esc(m.name)}</h3>
      <p>${esc(m.blurb)}</p>
      <div class="kit">${m.abilities.map((a) => esc(a.name)).join(' · ')}</div>
      <div class="nums"><span>HP ${s.hp}</span><span>SPD ${s.spd}</span><span>MOV ${s.move}</span><span>JMP ${s.jump}</span></div>`;
    b.onclick = () => {
      const i = prefs.picks.indexOf(m.id);
      if (i >= 0) prefs.picks.splice(i, 1);
      else if (prefs.picks.length < MAPS[prefs.mapId].teamSize) prefs.picks.push(m.id);
      refresh();
    };
    roster.append(b);
    return { b, id: m.id };
  });
  teamSection.append(teamHint, roster);
  const aiTeams = el('div', 'ai-teams');
  teamSection.append(aiTeams);

  // Start bar
  const bar = el('div', 'start-bar');
  bar.innerHTML = `<label for="seed">Seed</label>`;
  const seedInput = el('input');
  seedInput.id = 'seed';
  seedInput.autocomplete = 'off';
  seedInput.spellcheck = false;
  seedInput.value = randomSeed();
  const reroll = el('button', 'ghost icon-btn', '🎲');
  reroll.setAttribute('aria-label', 'New random seed');
  reroll.onclick = () => {
    seedInput.value = randomSeed();
    refresh();
  };
  seedInput.oninput = () => refresh();
  const libBtn = el('button', 'ghost', 'Library');
  libBtn.onclick = () => onLibrary();
  const start = el('button', 'primary');
  start.onclick = () => {
    savePrefs(prefs);
    onStart({ prefs: { ...prefs, picks: [...prefs.picks] }, seed: seedInput.value.trim() || randomSeed() });
  };
  const seedRow = el('div', 'seed-row');
  seedRow.append(seedInput, reroll);
  bar.append(seedRow, libBtn, start);

  screen.append(modeRow, mapSection, controlSection, styleSection, teamSection, bar);
  host.replaceChildren(screen);

  function styleRow(label: string, value: StrategyId, set: (s: StrategyId) => void): HTMLElement {
    const row = el('div', 'style-row');
    row.append(el('div', 'style-label', label));
    const chips = el('div', 'chips');
    for (const s of STRATEGIES) {
      const b = el('button', 'chip-btn', s.name);
      b.title = s.desc;
      b.setAttribute('aria-pressed', String(s.id === value));
      b.onclick = () => {
        set(s.id);
        refresh();
      };
      chips.append(b);
    }
    row.append(chips, el('div', 'hint', STRATEGIES.find((s) => s.id === value)!.desc));
    return row;
  }

  function refresh(): void {
    const map = MAPS[prefs.mapId];
    const seed = seedInput.value.trim() || 'seed';
    for (const { b, m } of modeBtns) b.setAttribute('aria-selected', String(prefs.mode === m));
    for (const { b, id } of mapCards) b.classList.toggle('on', id === prefs.mapId);
    styleHost.replaceChildren();
    if (prefs.mode === 'play') {
      styleHost.append(styleRow('Opponent', prefs.enemy, (s) => (prefs.enemy = s)));
    } else {
      styleHost.append(
        styleRow('Blue', prefs.blue, (s) => (prefs.blue = s)),
        styleRow('Orange', prefs.orange, (s) => (prefs.orange = s)),
      );
    }
    const play = prefs.mode === 'play';
    controlSection.hidden = !play;
    for (const { b, id } of controlBtns) {
      b.setAttribute('aria-pressed', String(prefs.control === id));
      if (id === 'orders') b.disabled = !agent.ok;
    }
    const ordersBlocked = prefs.control === 'orders' && !agent.ok;
    controlHint.textContent = ordersBlocked
      ? `Orders mode is unavailable: ${agent.reason}`
      : controlBtns.find((c) => c.id === prefs.control)!.desc + (agent.ok ? '' : ` Orders mode needs the local dev server with an API key (${agent.reason}).`);
    teamSection.querySelector('.section-title')!.textContent = play ? 'Your team' : 'Teams';
    roster.hidden = !play;
    teamHint.hidden = !play;
    teamHint.textContent = `Pick ${map.teamSize}. ${map.name} is ${map.teamSize}v${map.teamSize}.`;
    for (const { b, id } of cards) {
      const i = prefs.picks.indexOf(id);
      b.classList.toggle('on', i >= 0);
      b.querySelector('.pick')?.remove();
      if (i >= 0) b.insertAdjacentHTML('beforeend', `<span class="pick">${i + 1}</span>`);
    }
    const teamLine = (label: string, cls: string, ids: string[]) =>
      `<div class="team-line ${cls}"><b>${esc(label)}</b> ${ids.map((id) => `<span>${esc(MONSTER_BY_ID[id].name)}</span>`).join('')}</div>`;
    if (play) {
      aiTeams.innerHTML = teamLine('Opponent drafts', 't1', aiTeam(seed, prefs.enemy, map.teamSize, '1'));
    } else {
      aiTeams.innerHTML =
        teamLine('Blue drafts', 't0', aiTeam(seed, prefs.blue, map.teamSize, '0')) +
        teamLine('Orange drafts', 't1', aiTeam(seed, prefs.orange, map.teamSize, '1'));
    }
    const need = map.teamSize - prefs.picks.length;
    start.disabled = (play && need !== 0) || (play && ordersBlocked);
    start.textContent = !play ? 'Watch match' : need === 0 ? 'Fight' : `Pick ${need} more`;
  }
  refresh();
}

function section(title: string): HTMLElement {
  const s = el('section', 'setup-section');
  s.append(el('h2', 'section-title', title));
  return s;
}

/** Flat top-down preview of a map: heights, rock, lava, Beacons, spawns. */
function drawMiniMap(c: HTMLCanvasElement, m: MapDef): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const S3 = Math.sqrt(3);
  const pts = m.tiles.map((t) => ({ t, x: S3 * (t.q + t.r / 2), y: 1.5 * t.r }));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs) - 1, Math.max(...xs) + 1, Math.min(...ys) - 1, Math.max(...ys) + 1];
  const k = Math.min(c.width / (maxX - minX), c.height / (maxY - minY));
  const ox = (c.width - (maxX - minX) * k) / 2 - minX * k;
  const oy = (c.height - (maxY - minY) * k) / 2 - minY * k;
  const heights = ['#3f5a3e', '#56724b', '#71845a', '#93936a'];
  const beacon = new Set(m.beacons.map(hexKey));
  const spawn0 = new Set(m.spawns[0].map(hexKey));
  const spawn1 = new Set(m.spawns[1].map(hexKey));
  const hex = (x: number, y: number, r: number) => {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    ctx.closePath();
  };
  for (const { t, x, y } of pts) {
    const px = ox + x * k, py = oy + y * k;
    hex(px, py, k * 0.98);
    const key = hexKey(t);
    ctx.fillStyle = t.terrain === 'blocked' ? '#2b2a31' : t.terrain === 'void' ? '#d9541e' : t.terrain === 'rough' ? '#6e5236' : heights[Math.min(t.h, 3)];
    if (spawn0.has(key)) ctx.fillStyle = '#1f7f99';
    if (spawn1.has(key)) ctx.fillStyle = '#a5532c';
    ctx.fill();
    if (beacon.has(key)) {
      hex(px, py, k * 0.55);
      ctx.fillStyle = '#f2f2f2';
      ctx.fill();
    }
  }
}
