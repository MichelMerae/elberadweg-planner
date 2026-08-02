// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createBanner, createPickBanner } from './ui.js';

let el;

function mount() {
  el = document.createElement('div');
  el.hidden = true;
  document.body.appendChild(el);
  return createBanner({ el });
}

function mountPick() {
  el = document.createElement('div');
  el.hidden = true;
  document.body.appendChild(el);
  return createPickBanner({ el });
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

  // show() rebuilds the banner's DOM, so each × is a fresh node with exactly one
  // handler — and dismissing one must not leave the next show unable to close.
  it('rewires the dismiss button on every show', () => {
    const banner = mount();
    banner.show('first');
    banner.show('second');

    el.querySelector('.banner__dismiss').click();
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');

    banner.show('third');
    expect(el.hidden).toBe(false);
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

// The picking line above the map (spec §6/§8). Deliberately NOT createBanner: that one
// is a dismissable warning about the route data which main.js shows or hides from plan
// state on every save, so a prompt parked in it would be wiped by the first persist.
// This one is owned by the picking flow — no ×, an optional action button, and a tone
// for a refusal.
describe('createPickBanner', () => {
  it('shows the prompt and unhides', () => {
    const banner = mountPick();
    banner.show('Click the route where your trip starts · Esc to cancel');

    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain('Click the route where your trip starts');
  });

  // Both halves interpolate into ELEMENT CONTENT, where this payload really does parse
  // into an element — so `querySelector('img')` can fail, unlike the same payload
  // inside a title="…" (Task 8's fix round). Town names reach the action label from
  // OSM, which is the live path for the label half.
  it('escapes the text and the action label', () => {
    const banner = mountPick();
    banner.show('<img src=x onerror="alert(1)">', {
      action: { label: '<img src=x onerror="alert(2)">', onPress: () => {} },
    });

    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(el.querySelector('[data-action="pick-action"]').textContent).toBe(
      '<img src=x onerror="alert(2)">',
    );
  });

  // The offer is spent BEFORE the callback runs. Hiding afterwards leaves a taken
  // offer on screen over whatever the callback just said in this same line — and the
  // callback is what says it, so the order is the whole behaviour.
  it('spends the offer before the callback it triggers runs', () => {
    const banner = mountPick();
    const seen = [];
    banner.show('Nearest town is Hamburg, 0.4 km back.', {
      action: {
        label: 'Start at Hamburg instead',
        onPress: () => seen.push({ hidden: el.hidden, html: el.innerHTML }),
      },
    });

    el.querySelector('[data-action="pick-action"]').click();

    expect(seen).toEqual([{ hidden: true, html: '' }]);
  });

  it('hides and empties on hide()', () => {
    const banner = mountPick();
    banner.show('Click the route where your trip finishes');

    banner.hide();

    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('');
  });

  // A refusal (spec §8) arrives in the same box the prompt was in. classList.add
  // without the matching remove would leave every later hint red.
  it('marks a refused pick and unmarks the next hint', () => {
    const banner = mountPick();
    banner.show('That would leave a trip 2 km long.', { tone: 'error' });

    expect(el.classList.contains('banner--error')).toBe(true);

    banner.show('Click the route where your trip starts', { tone: 'hint' });

    expect(el.classList.contains('banner--error')).toBe(false);
  });

  it('renders no button when the prompt offers nothing to press', () => {
    const banner = mountPick();
    banner.show('Click the route where your trip starts · Esc to cancel');

    expect(el.querySelector('button')).toBeNull();
    expect(el.textContent).not.toContain('undefined');
  });
});
