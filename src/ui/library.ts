// Saved matches: watch, share, rename, delete, import.

import { MAPS } from '../core/map';
import { decodeReplay, type Replay } from '../core/replay';
import { parseMatchLog } from './matchlog';
import { el, esc, modal } from './dom';
import { micButton } from './speech';
import { cap, copyText } from './match';
import { deleteMatch, isCurrentRules, loadLibrary, renameMatch, type SavedMatch } from './store';

export function showLibrary(host: HTMLElement, onWatch: (r: Replay) => void, onBack: () => void): void {
  const screen = el('div', 'screen');
  const head = el('div', 'lib-head');
  const back = el('button', 'ghost', '← Setup');
  back.onclick = onBack;
  const importBtn = el('button', '', 'Import code');
  head.append(back, el('h1', 'lib-title', 'Match library'), importBtn);
  const list = el('div', 'lib-list');
  screen.append(head, list);
  host.replaceChildren(screen);

  importBtn.onclick = () => {
    const close = modal(`
      <h2>Import replay</h2>
      <textarea id="import-code" placeholder="Paste a replay code or match log"></textarea>
      <div class="hint" id="import-msg"></div>
      <div class="btns"><button data-a="cancel">Cancel</button><button data-a="go" class="primary">Watch</button></div>`, {
      cancel: () => close(),
      go: () => {
        const ta = document.getElementById('import-code') as HTMLTextAreaElement;
        try {
          const r = parseMatchLog(ta.value).replay;
          close();
          onWatch(r);
        } catch {
          document.getElementById('import-msg')!.textContent = 'That code could not be read. Copy the whole code from a match menu or end screen.';
        }
      },
    });
  };

  const render = () => {
    const lib = loadLibrary();
    list.replaceChildren();
    if (!lib.length) {
      const empty = el('div', 'lib-empty');
      empty.innerHTML = `<h3>No saved matches yet</h3><p class="hint">Every match you play or watch AI-vs-AI is saved here when it ends. You can also import a replay code someone shared with you.</p>`;
      list.append(empty);
      return;
    }
    for (const m of lib) list.append(row(m));
  };

  const row = (m: SavedMatch): HTMLElement => {
    const item = el('div', 'lib-item');
    const map = MAPS[m.mapId]?.name ?? m.mapId;
    const vsAi = m.mode === 'play' || m.mode === 'orders';
    const sides = vsAi
      ? `You${m.mode === 'orders' ? ' (orders)' : ''} vs ${cap(m.ai[1] ?? 'balanced')} AI`
      : `${cap(m.ai[0] ?? 'balanced')} vs ${cap(m.ai[1] ?? 'balanced')}`;
    const result = m.winner === null ? 'In progress' : m.winner === 'draw' ? 'Draw' : vsAi ? (m.winner === 0 ? 'Victory' : 'Defeat') : m.winner === 0 ? 'Blue won' : 'Orange won';
    const date = new Date(m.savedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const name = el('div', 'lib-name', m.name);
    const meta = el('div', 'lib-meta');
    meta.innerHTML = `<span class="lib-result r${m.winner === null ? 'u' : m.winner}">${result} ${m.score[0]}–${m.score[1]}</span><span>${esc(map)}</span><span>${esc(sides)}</span><span>${m.actions} actions</span><span>${esc(date)}</span>${isCurrentRules(m) ? '' : '<span class="warn">Older rules: may not replay</span>'}`;
    const btns = el('div', 'lib-btns');
    const watch = el('button', 'primary', 'Watch');
    watch.onclick = () => {
      try {
        onWatch(decodeReplay(m.code));
      } catch {
        meta.insertAdjacentHTML('beforeend', '<span class="warn">This saved code is damaged.</span>');
      }
    };
    const copy = el('button', '', 'Copy code');
    copy.onclick = () => {
      copyText(m.code);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy code'), 1200);
    };
    const copyLog = m.log ? el('button', '', 'Copy log') : null;
    if (copyLog) {
      copyLog.title = 'Every action plus each Claude turn: paste it to Claude to debug';
      copyLog.onclick = () => {
        copyText(m.log!);
        copyLog.textContent = 'Copied';
        setTimeout(() => (copyLog.textContent = 'Copy log'), 1200);
      };
    }
    const rename = el('button', '', 'Rename');
    rename.onclick = () => {
      const input = el('input', 'lib-rename');
      input.value = m.name;
      input.id = `rename-${m.id}`;
      input.setAttribute('aria-label', 'Match name');
      const save = () => {
        renameMatch(m.id, input.value.trim() || m.name);
        render();
      };
      input.onkeydown = (e) => e.key === 'Enter' && save();
      input.onblur = save;
      const wrap = el('div', 'order-field');
      wrap.append(input);
      const mic = micButton(input);
      if (mic) {
        // Keep the field open while dictating; save when dictation ends or on Enter.
        input.onblur = null;
        mic.addEventListener('pointerdown', (e) => e.preventDefault());
        wrap.append(mic);
        const done = el('button', 'primary', 'Save');
        done.onclick = save;
        wrap.append(done);
      }
      name.replaceWith(wrap);
      input.focus();
      input.select();
    };
    const del = el('button', 'ghost', 'Delete');
    del.onclick = () => {
      if (del.dataset.armed) {
        deleteMatch(m.id);
        render();
      } else {
        del.dataset.armed = '1';
        del.textContent = 'Tap again to delete';
        del.classList.add('danger');
      }
    };
    btns.append(...[watch, copy, copyLog, rename, del].filter((b): b is HTMLButtonElement => !!b));
    item.append(name, meta, btns);
    return item;
  };

  render();
}
