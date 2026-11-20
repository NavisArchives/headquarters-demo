// The phone tab bar (Liquid Glass, 14 Nov; NIRMATA's brief): the lens that
// slides behind the current tab, and the shrink while a list scrolls.
// phone.css draws it; this only moves the lens and toggles .is-compact.
import { el } from './dom.js';

const PHONE_BAR = '(max-width: 480px)';
let lensFrom = null; // where the lens sat before this screen, so it slides from there

/** Should the bar be compact after a scroll? Down past the top shrinks it,
 *  up or near the top brings it back, a small jitter changes nothing. */
export function compactAfter(compact, y, delta) {
  if (y < 24) return false;
  if (delta > 8) return true;
  if (delta < -8) return false;
  return compact;
}

/** Put the soft pill behind the current tab. It starts where it last was and
 *  slides (CSS, transform only); with nothing current it fades out. */
export function placeLens(nav) {
  if (typeof window === 'undefined' || !nav) return;
  const lens = el('span', 'lens');
  lens.setAttribute('aria-hidden', 'true');
  nav.prepend(lens);
  const place = (animate) => {
    if (!lens.isConnected) { window.removeEventListener('resize', onResize); return; }
    const current = [...nav.querySelectorAll('button[aria-current="page"]')].find((b) => b.offsetWidth > 0);
    if (!current) { lens.hidden = true; return; }
    lens.hidden = false;
    lens.classList.toggle('is-still', !animate);
    lens.style.setProperty('--lens-w', `${current.offsetWidth}px`);
    lens.style.setProperty('--lens-x', `${current.offsetLeft}px`);
    lensFrom = current.offsetLeft;
  };
  const onResize = () => place(false);
  window.addEventListener('resize', onResize);
  if (lensFrom !== null) {
    lens.classList.add('is-still');
    lens.style.setProperty('--lens-x', `${lensFrom}px`);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => place(lensFrom !== null)));
}

/** Scrolling down a list shrinks the bar to its icons; scrolling up, or being
 *  near the top, brings it back. Never with reduced motion, never above 480 px. */
export function watchBarScroll() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function' || typeof document === 'undefined') return;
  const phone = window.matchMedia(PHONE_BAR);
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  const last = new WeakMap();
  document.addEventListener('scroll', (event) => {
    const nav = document.getElementById('nav');
    if (!nav) return;
    if (!phone.matches || still.matches) { nav.classList.remove('is-compact'); return; }
    const target = event.target === document ? document.scrollingElement : event.target;
    if (!target || typeof target.scrollTop !== 'number') return;
    const y = target.scrollTop;
    const delta = y - (last.get(target) ?? y);
    last.set(target, y);
    nav.classList.toggle('is-compact', compactAfter(nav.classList.contains('is-compact'), y, delta));
  }, { capture: true, passive: true });
}
