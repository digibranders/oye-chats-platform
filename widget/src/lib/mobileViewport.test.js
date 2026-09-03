import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MOBILE_BREAKPOINT_PX,
    PANEL_STYLE_KEYS,
    VIEWPORT_SETTLE_DELAYS_MS,
    isPhoneLayout,
    panelStyleForViewport,
} from './mobileViewport.js';

test('panel covers exactly the visual viewport, keyboard up', () => {
    // iPhone 13 in Safari with the keyboard open: 390pt wide, 338pt left
    // above the keyboard, no pan.
    const style = panelStyleForViewport({ height: 338, width: 390, offsetTop: 0, offsetLeft: 0 });
    assert.deepEqual(style, { height: '338px', width: '390px', top: '0px', left: '0px', bottom: 'auto' });
});

test('panel follows a panned, zoomed visual viewport on both axes', () => {
    // Safari zoomed 16/14 into a 14px control and panned right: the visible
    // area is narrower than the page and starts 24 CSS px in from its left
    // edge. Pinning left at 0 here is what hung the panel off the left edge
    // and showed the host page down the right in production.
    const style = panelStyleForViewport({ height: 296, width: 341, offsetTop: 40, offsetLeft: 24 });
    assert.equal(style.left, '24px');
    assert.equal(style.top, '40px');
    assert.equal(style.width, '341px');
    assert.equal(style.height, '296px');
});

test('bottom is released so the explicit height wins', () => {
    // The CSS layer pins top and bottom; with an explicit height as well the
    // box would be over-constrained, so the inline style hands bottom back.
    assert.equal(panelStyleForViewport({ height: 1, width: 1, offsetTop: 0, offsetLeft: 0 }).bottom, 'auto');
});

test('the style keys list is exactly what the panel style writes', () => {
    const written = Object.keys(panelStyleForViewport({ height: 1, width: 1, offsetTop: 0, offsetLeft: 0 }));
    assert.deepEqual([...written].sort(), [...PANEL_STYLE_KEYS].sort());
});

test('the last settle pass lands after an Android keyboard animation', () => {
    // Android keyboards animate for about 300ms; Chrome can fire its resize
    // early with an intermediate height, so one pass must come after that.
    assert.ok(Math.max(...VIEWPORT_SETTLE_DELAYS_MS) > 300);
    assert.ok(Math.min(...VIEWPORT_SETTLE_DELAYS_MS) > 0);
});

test('phone layout matches the md breakpoint the stylesheet uses', () => {
    assert.equal(MOBILE_BREAKPOINT_PX, 768);
    assert.equal(isPhoneLayout(767), true);
    assert.equal(isPhoneLayout(768), false);
});
