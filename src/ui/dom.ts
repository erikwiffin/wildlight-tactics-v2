export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Show a modal. Buttons with data-a="name" call handlers[name]. Returns close(). */
export function modal(html: string, handlers: Record<string, () => void>): () => void {
  const bg = el('div', 'modal-bg');
  const box = el('div', 'modal');
  box.innerHTML = html;
  bg.append(box);
  document.body.append(bg);
  // Tapping outside a dismissable modal (one with a close handler) closes it.
  bg.addEventListener('click', (e) => {
    if (e.target === bg && handlers.close) handlers.close();
  });
  box.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a && handlers[a]) handlers[a]();
  });
  return () => bg.remove();
}
