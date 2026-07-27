// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createBanner } from './ui.js';

let el;

function mount() {
  el = document.createElement('div');
  el.hidden = true;
  document.body.appendChild(el);
  return createBanner({ el });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('createBanner', () => {
  it('shows a message', () => {
    const banner = mount();
    banner.show('The route data changed.');

    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain('The route data changed.');
  });

  it('escapes the message', () => {
    const banner = mount();
    banner.show('<img src=x onerror="alert(1)">');

    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  // Emptying matters as much as hiding: `.banner` carries its own padding and
  // border, so a hidden-but-populated banner reappears as a stray box the moment
  // anything overrides [hidden].
  it('hides and empties on dismiss', () => {
    const banner = mount();
    banner.show('The route data changed.');

    el.querySelector('.banner__dismiss').click();

    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');
  });

  it('hides and empties on hide()', () => {
    const banner = mount();
    banner.show('The route data changed.');

    banner.hide();

    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');
  });
});
