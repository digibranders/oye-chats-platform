import { afterEach, describe, expect, it } from 'vitest';
import { captureSignupIntent, clearSignupIntent, readSignupIntent } from './signupIntent';

describe('signup intent', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('keeps the plan and billing period the pricing page sent', () => {
    captureSignupIntent(new URLSearchParams('plan=standard&billing=annual'));

    expect(readSignupIntent()).toEqual({ planId: 'standard', billingPeriod: 'annual' });
  });

  it('keeps a plan that arrived without a billing period', () => {
    captureSignupIntent(new URLSearchParams('plan=starter'));

    expect(readSignupIntent()).toEqual({ planId: 'starter', billingPeriod: null });
  });

  it('drops a billing period it does not recognise and keeps the plan', () => {
    captureSignupIntent(new URLSearchParams('plan=starter&billing=weekly'));

    expect(readSignupIntent()).toEqual({ planId: 'starter', billingPeriod: null });
  });

  it('refuses a plan value that is not a plan id', () => {
    // The value is forwarded to Google Analytics verbatim, so anything a crafted
    // link could put there must not survive the trip.
    captureSignupIntent(new URLSearchParams('plan=%3Cscript%3E'));
    captureSignupIntent(new URLSearchParams(`plan=${'a'.repeat(65)}`));

    expect(readSignupIntent()).toBeNull();
  });

  it('leaves an earlier intent alone when the URL carries no plan', () => {
    // Register -> Sign in -> back to Register drops the query string.
    captureSignupIntent(new URLSearchParams('plan=professional&billing=monthly'));
    captureSignupIntent(new URLSearchParams(''));

    expect(readSignupIntent()).toEqual({ planId: 'professional', billingPeriod: 'monthly' });
  });

  it('lets a newer plan replace an older one', () => {
    captureSignupIntent(new URLSearchParams('plan=starter&billing=monthly'));
    captureSignupIntent(new URLSearchParams('plan=professional'));

    expect(readSignupIntent()).toEqual({ planId: 'professional', billingPeriod: null });
  });

  it('ignores a stored value it did not write', () => {
    sessionStorage.setItem('oyechats_signup_intent', '{"planId":42}');

    expect(readSignupIntent()).toBeNull();
  });

  it('forgets the intent once cleared', () => {
    captureSignupIntent(new URLSearchParams('plan=standard'));
    clearSignupIntent();

    expect(readSignupIntent()).toBeNull();
  });
});
