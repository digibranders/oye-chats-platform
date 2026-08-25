import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom implements no layout, so it has no `scrollIntoView`. Any listbox that
// keeps its highlighted option in view calls it on mount, which would throw
// before a single assertion ran.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => {};
}

afterEach(() => {
  cleanup();
});
