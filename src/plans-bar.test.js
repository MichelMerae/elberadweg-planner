// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPlansBar } from './plans-bar.js';

// Two plans, and a name with an ampersand: plan names are user text, so the
// escaping has to survive a round trip through the option label.
const PLANS = [
  { id: 'p1', name: 'My plan' },
  { id: 'p2', name: 'Slow & scenic' },
];

let el;
let callbacks;

function mount() {
  el = document.createElement('div');
  document.body.appendChild(el);
  callbacks = {
    onSelectPlan: vi.fn(),
    onRenamePlan: vi.fn(),
    onNewPlan: vi.fn(),
    onDuplicatePlan: vi.fn(),
    onDeletePlan: vi.fn(),
    onResetTrip: vi.fn(),
  };
  return createPlansBar({ el, callbacks });
}

function clickAction(action) {
  el.querySelector(`[data-plan-action="${action}"]`)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

function change(node) {
  node.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function select() {
  return el.querySelector('[data-plan-select]');
}

function nameField() {
  return el.querySelector('[data-plan-name]');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPlansBar - render', () => {
  it('lists every plan and selects the active one', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    const options = [...select().options];
    expect(options.map((o) => o.value)).toEqual(['p1', 'p2']);
    expect(options.map((o) => o.textContent)).toEqual(['My plan', 'Slow & scenic']);
    expect(select().value).toBe('p2');
  });

  it('shows the active plan name in the rename field', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });
    expect(nameField().value).toBe('Slow & scenic');
  });

  it('leaves the name field empty when no plan is active', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: null });
    expect(nameField().value).toBe('');
  });

  it('renders an empty bar with no arguments', () => {
    const bar = mount();
    bar.render();
    expect(select().options).toHaveLength(0);
    expect(nameField().value).toBe('');
  });

  it('escapes plan names', () => {
    const bar = mount();
    const hostile = '<img src=x onerror="alert(1)"> & "quoted"';
    bar.render({ plans: [{ id: 'p1', name: hostile }], activePlanId: 'p1' });

    expect(el.querySelector('img')).toBeNull();
    expect(select().options[0].textContent).toBe(hostile);
    expect(nameField().value).toBe(hostile);
  });

  it('escapes plan ids', () => {
    const bar = mount();
    bar.render({ plans: [{ id: '"><img src=x>', name: 'Sneaky' }], activePlanId: 'nope' });

    expect(el.querySelector('img')).toBeNull();
    expect(select().options[0].value).toBe('"><img src=x>');
  });
});

describe('createPlansBar - switching plans', () => {
  it('reports the chosen plan id', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    select().value = 'p1';
    change(select());

    expect(callbacks.onSelectPlan).toHaveBeenCalledWith('p1');
  });
});

describe('createPlansBar - renaming', () => {
  it('reports a trimmed new name', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    nameField().value = '  Fast run  ';
    change(nameField());

    expect(callbacks.onRenamePlan).toHaveBeenCalledWith('Fast run');
  });

  // A blank field is a slip, not a rename to "": restore what the plan is
  // actually called and tell main.js nothing happened.
  it('reverts an emptied name to the active plan name without reporting it', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    nameField().value = '   ';
    change(nameField());

    expect(nameField().value).toBe('Slow & scenic');
    expect(callbacks.onRenamePlan).not.toHaveBeenCalled();
  });

  it('reverts an emptied name to blank when no plan is active', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: null });

    nameField().value = 'typed then cleared';
    nameField().value = '';
    change(nameField());

    expect(nameField().value).toBe('');
    expect(callbacks.onRenamePlan).not.toHaveBeenCalled();
  });
});

describe('createPlansBar - actions', () => {
  it('reports New', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });
    clickAction('new');
    expect(callbacks.onNewPlan).toHaveBeenCalledTimes(1);
  });

  it('reports Duplicate', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });
    clickAction('duplicate');
    expect(callbacks.onDuplicatePlan).toHaveBeenCalledTimes(1);
  });

  it('asks before deleting, naming the plan', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    clickAction('delete');

    expect(confirm.mock.calls[0][0]).toContain('Slow & scenic');
    expect(callbacks.onDeletePlan).toHaveBeenCalledTimes(1);
  });

  it('keeps the plan when the delete confirm is dismissed', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    clickAction('delete');

    expect(callbacks.onDeletePlan).not.toHaveBeenCalled();
  });

  // Reset empties the plan you are working in; Delete destroys the plan itself.
  // Two different jobs sitting next to each other, so the labels have to say
  // which is which.
  it('labels the two destructive actions apart', () => {
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    expect(el.querySelector('[data-plan-action="reset"]').textContent).toBe('Reset trip');
    expect(el.querySelector('[data-plan-action="delete"]').textContent).toBe('Delete plan');
  });

  it('asks before resetting the trip, naming the plan and what goes', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    clickAction('reset');

    expect(confirm.mock.calls[0][0]).toContain('Slow & scenic');
    expect(confirm.mock.calls[0][0]).toMatch(/day/i);
    expect(callbacks.onResetTrip).toHaveBeenCalledTimes(1);
  });

  it('keeps the days when the reset confirm is dismissed', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    clickAction('reset');

    expect(callbacks.onResetTrip).not.toHaveBeenCalled();
  });

  it('does not reset when the plan is deleted, or delete when it is reset', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    clickAction('reset');
    expect(callbacks.onDeletePlan).not.toHaveBeenCalled();

    clickAction('delete');
    expect(callbacks.onResetTrip).toHaveBeenCalledTimes(1);
  });

  // Clicking the bar's own padding reaches the delegated listener with no button
  // under it. jsdom reports a listener that throws as a window `error` event
  // rather than rethrowing, so watch for it — otherwise a crash here would look
  // exactly like the no-op we want.
  it('ignores a click that hits no action', () => {
    const onError = vi.fn();
    window.addEventListener('error', onError);
    const bar = mount();
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    el.querySelector('.plans__bar').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    window.removeEventListener('error', onError);

    expect(onError).not.toHaveBeenCalled();
    expect(callbacks.onNewPlan).not.toHaveBeenCalled();
    expect(callbacks.onDuplicatePlan).not.toHaveBeenCalled();
    expect(callbacks.onDeletePlan).not.toHaveBeenCalled();
  });

  // main.js wires every callback, but the bar must not depend on that: an
  // unwired action is a no-op, not a TypeError that kills the listener.
  it('survives an unwired bar', () => {
    el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const bar = createPlansBar({ el });
    bar.render({ plans: PLANS, activePlanId: 'p2' });

    expect(() => {
      el.querySelector('[data-plan-action="new"]').click();
      el.querySelector('[data-plan-action="duplicate"]').click();
      el.querySelector('[data-plan-action="reset"]').click();
      el.querySelector('[data-plan-action="delete"]').click();
      el.querySelector('[data-plan-select]').dispatchEvent(new window.Event('change', { bubbles: true }));
      const field = el.querySelector('[data-plan-name]');
      field.value = 'Renamed';
      field.dispatchEvent(new window.Event('change', { bubbles: true }));
    }).not.toThrow();
  });
});
