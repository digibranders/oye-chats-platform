import { describe, expect, it, vi, beforeEach } from 'vitest';

/** Only the URL matters here: that a junk override is dropped before it is sent. */
const get = vi.fn();
vi.mock('axios', () => ({
  default: {
    create: () => ({ get, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } }),
  },
}));

const { detectCountry } = await import('./api');

describe('detectCountry ?country= passthrough', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: { country: 'IN' } });
  });

  it('forwards a valid two-letter code', async () => {
    await detectCountry('IN');
    expect(get).toHaveBeenCalledWith('/auth/detect-country?country=IN');
  });

  it('uppercases a lowercase code', async () => {
    await detectCountry('in');
    expect(get).toHaveBeenCalledWith('/auth/detect-country?country=IN');
  });

  it.each([null, undefined, '', '   ', 'India', 'I', 'INDIA', '12', 'I<'])(
    'drops %p rather than round-tripping it',
    async (bad) => {
      await detectCountry(bad as string | null);
      expect(get).toHaveBeenCalledWith('/auth/detect-country');
    },
  );
});
