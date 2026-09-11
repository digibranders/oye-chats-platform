import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataLayerEvents } from '../../test/dataLayerEvents';
import { trackRegistrationSuccess } from './registration';
import { captureSignupIntent, readSignupIntent } from './signupIntent';

const registrationEvents = () => dataLayerEvents('registration_success');

describe('trackRegistrationSuccess', () => {
  afterEach(() => {
    delete window.dataLayer;
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('reports the sign-up method', () => {
    trackRegistrationSuccess({ clientId: 12, method: 'email' });

    expect(registrationEvents()).toEqual([{ event: 'registration_success', method: 'email' }]);
  });

  it('attaches the plan chosen on the pricing page, then forgets it', () => {
    captureSignupIntent(new URLSearchParams('plan=standard&billing=annual'));

    trackRegistrationSuccess({ clientId: 12, method: 'google' });

    expect(registrationEvents()).toEqual([
      { event: 'registration_success', method: 'google', plan_id: 'standard', billing_period: 'annual' },
    ]);
    expect(readSignupIntent()).toBeNull();
  });

  it('leaves out a billing period nobody chose', () => {
    captureSignupIntent(new URLSearchParams('plan=starter'));

    trackRegistrationSuccess({ clientId: 12, method: 'email' });

    expect(registrationEvents()).toEqual([
      { event: 'registration_success', method: 'email', plan_id: 'starter' },
    ]);
  });

  it('reports an account once, however many times it is asked', () => {
    // A double-invoked effect, a second tab, a refresh: none of them is a
    // second account.
    trackRegistrationSuccess({ clientId: 12, method: 'email' });
    trackRegistrationSuccess({ clientId: '12', method: 'email' });

    expect(registrationEvents()).toHaveLength(1);
  });

  it('reports two different accounts separately', () => {
    trackRegistrationSuccess({ clientId: 12, method: 'email' });
    trackRegistrationSuccess({ clientId: 13, method: 'email' });

    expect(registrationEvents()).toHaveLength(2);
  });

  it('still reports when the account id is unknown', () => {
    trackRegistrationSuccess({ clientId: null, method: 'email' });

    expect(registrationEvents()).toHaveLength(1);
  });

  it('still reports when storage refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    trackRegistrationSuccess({ clientId: 12, method: 'email' });

    expect(registrationEvents()).toHaveLength(1);
  });
});
