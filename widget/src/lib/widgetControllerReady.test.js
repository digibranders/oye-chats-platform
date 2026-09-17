import test from 'node:test';
import assert from 'node:assert/strict';

import { __resetForTests, getController } from '../widget-controller.js';

// With `async` on the embed snippet, host-page code can subscribe after the
// widget has mounted. `ready` must still reach it.

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const fresh = () => {
    __resetForTests();
    return getController();
};

test('on("ready") before the widget mounts is called once, by the mount', async () => {
    const ctrl = fresh();
    const calls = [];
    ctrl.on('ready', (p) => calls.push(p));
    ctrl.emit('ready', { version: '1' });
    await tick();
    assert.deepEqual(calls, [{ version: '1' }]);
});

test('on("ready") after the widget mounted is called with the ready payload', async () => {
    const ctrl = fresh();
    ctrl.emit('ready', { version: '1' });
    const calls = [];
    ctrl.on('ready', (p) => calls.push(p));
    assert.deepEqual(calls, [], 'not called synchronously inside on()');
    await tick();
    assert.deepEqual(calls, [{ version: '1' }]);
});

test('once("ready") after the widget mounted is called exactly once', async () => {
    const ctrl = fresh();
    ctrl.emit('ready', { version: '1' });
    const calls = [];
    ctrl.once('ready', (p) => calls.push(p));
    await tick();
    ctrl.emit('ready', { version: '2' });
    await tick();
    assert.deepEqual(calls, [{ version: '1' }]);
});

test('a late handler removed before the replay fires is not called', async () => {
    const ctrl = fresh();
    ctrl.emit('ready', { version: '1' });
    const calls = [];
    const cb = (p) => calls.push(p);
    ctrl.on('ready', cb);
    ctrl.off('ready', cb);
    await tick();
    assert.deepEqual(calls, []);
});

test('after unmount, a new subscriber waits for the next mount', async () => {
    const ctrl = fresh();
    ctrl.emit('ready', { version: '1' });
    ctrl.resetReady();
    const calls = [];
    ctrl.on('ready', (p) => calls.push(p));
    await tick();
    assert.deepEqual(calls, [], 'nothing is mounted, so nothing is ready');
    ctrl.emit('ready', { version: '2' });
    assert.deepEqual(calls, [{ version: '2' }]);
});

test('a late on("ready") handler is not called twice when the widget remounts before the replay', async () => {
    const ctrl = fresh();
    ctrl.emit('ready', { version: '1' });
    const calls = [];
    ctrl.on('ready', (p) => calls.push(p));
    ctrl.resetReady();
    ctrl.emit('ready', { version: '2' });
    await tick();
    assert.deepEqual(calls, [{ version: '2' }]);
});

test('a late handler that throws does not break the replay for others', async () => {
    const ctrl = fresh();
    ctrl.emit('ready', { version: '1' });
    const calls = [];
    const originalError = console.error;
    console.error = () => {};
    try {
        ctrl.on('ready', () => { throw new Error('boom'); });
        ctrl.on('ready', (p) => calls.push(p));
        await tick();
    } finally {
        console.error = originalError;
    }
    assert.deepEqual(calls, [{ version: '1' }]);
});

test('other events are not replayed to late subscribers', async () => {
    const ctrl = fresh();
    ctrl.emit('open', undefined);
    const calls = [];
    ctrl.on('open', () => calls.push('open'));
    await tick();
    assert.deepEqual(calls, []);
});
