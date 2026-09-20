/**
 * The widget catalogue.
 *
 * Small, but it guards a real regression: `WINDOW_TYPES` was once missing
 * WEB_BROWSER and MEETING_TIMER while both widgets shipped and were spawned by
 * the control bar, so every lookup keyed off this map fell through to the
 * "Window 🪟" default. Nothing crashed, two windows were just anonymous — the
 * class of bug a test notices and a person does not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WINDOW_TYPES, WIDGETS, widgetMeta } from '../src/constants/channel-config.js';

test('every window type the control bar can open has presentation to go with it', () => {
  // The list the control bar offers, kept here so adding a widget to one and not
  // the other fails.
  const offered = ['CODE_EDITOR', 'WHITEBOARD', 'NOTES', 'WEB_BROWSER', 'MEETING_TIMER'];

  assert.deepEqual(Object.keys(WINDOW_TYPES).sort(), [...offered].sort());
  assert.deepEqual(Object.keys(WIDGETS).sort(), [...offered].sort());

  for (const type of offered) {
    // The key and its value must match, since call sites use both interchangeably.
    assert.equal(WINDOW_TYPES[type], type);

    const meta = widgetMeta(type);
    assert.equal(typeof meta.title, 'string');
    assert.ok(meta.title.length > 0);
    assert.notEqual(meta.title, 'Window', `${type} fell through to the default title`);
    assert.ok(meta.icon, `${type} has no icon`);
    assert.equal(meta.collaborative, true);
  }
});

test('an unknown type gets a neutral window rather than undefined', () => {
  for (const input of ['NOT_A_WIDGET', undefined, null, '']) {
    assert.deepEqual(widgetMeta(input), { title: 'Window', icon: '🪟', collaborative: false });
  }
});

test('the catalogue is frozen, so no caller can rename a widget for everyone', () => {
  assert.ok(Object.isFrozen(WINDOW_TYPES));
  assert.ok(Object.isFrozen(WIDGETS));
});
