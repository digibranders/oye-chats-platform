import { expect, test } from 'vitest';

test('test environment is configured', () => {
  expect(document.createElement('main')).toBeInstanceOf(HTMLElement);
});
