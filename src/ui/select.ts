// Title + team select. Pick 4 of the 7 monsters, optionally set a seed.

import { MONSTERS } from '../core/monsters';
import { decodeReplay, type Replay } from '../core/replay';
import { el, esc, modal } from './dom';

const WORDS = ['ember', 'static', 'moss', 'quill', 'shade', 'tide', 'glint', 'ash', 'bloom', 'flux', 'umbra', 'spark'];

export function randomSeed(): string {
  // Only the *choice* of seed is random; everything after it is deterministic.
  const w = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${w()}-${w()}-${Math.floor(Math.random() * 1000)}`;
}

export function showSelect(
  host: HTMLElement,
  initial: string[],
  onStart: (team: string[], seed: string) => void,
  onReplay: (r: Replay) => void,
): void {
  const picks = [...initial];
  const screen = el('div', 'screen');
  screen.innerHTML = `
    <h1 class="title">WILD<span>LIGHT</span> TACTICS</h1>
    <p class="tagline">Nanite-touched animals fight for the Beacons. Pick 4. First to 15 points wins.</p>`;
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
      const i = picks.indexOf(m.id);
      if (i >= 0) picks.splice(i, 1);
      else if (picks.length < 4) picks.push(m.id);
      refresh();
    };
    roster.append(b);
    return { b, id: m.id };
  });
  screen.append(roster);

  const bar = el('div', 'start-bar');
  bar.innerHTML = `<label>Seed <input name="seed" autocomplete="off" spellcheck="false" /></label>`;
  const seedInput = bar.querySelector('input')!;
  seedInput.value = randomSeed();
  const replayBtn = el('button', 'ghost', 'Watch replay');
  const start = el('button', 'primary', 'Fight');
  bar.append(replayBtn, start);
  screen.append(bar);
  host.replaceChildren(screen);

  replayBtn.onclick = () => {
    const close = modal(`
      <h2>Watch replay</h2>
      <textarea placeholder="Paste a replay code"></textarea>
      <div class="btns"><button data-a="cancel">Cancel</button><button data-a="go" class="primary">Watch</button></div>`, {
      cancel: () => close(),
      go: () => {
        const code = (document.querySelector('.modal textarea') as HTMLTextAreaElement).value;
        try {
          const r = decodeReplay(code);
          close();
          onReplay(r);
        } catch {
          alert('That replay code could not be read.');
        }
      },
    });
  };
  start.onclick = () => onStart([...picks], seedInput.value.trim() || randomSeed());

  function refresh() {
    for (const { b, id } of cards) {
      const i = picks.indexOf(id);
      b.classList.toggle('on', i >= 0);
      b.querySelector('.pick')?.remove();
      if (i >= 0) b.insertAdjacentHTML('beforeend', `<span class="pick">${i + 1}</span>`);
    }
    start.disabled = picks.length !== 4;
    start.textContent = picks.length === 4 ? 'Fight' : `Pick ${4 - picks.length} more`;
  }
  refresh();
}
