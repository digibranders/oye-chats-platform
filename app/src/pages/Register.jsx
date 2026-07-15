import { useState } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Loader2, Eye, EyeOff, CheckCircle2, Mail, Lock, User, Building2, Globe, MapPin, ArrowRight, Zap, BookOpen, BarChart3, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
import { registerClient } from '../services/api';
import { clearTrialBannerDismissals } from '../utils/trialBanner';
import { setAuthBundle } from '../utils/authStorage';
import { cn } from '../lib/utils';
import GoogleAuthButton from '../components/GoogleAuthButton';
import { COUNTRY_OPTIONS } from '../lib/countries';
import Select from '../components/ui/Select';
import { STUDIO_ENABLED } from '../utils/flags';

// Billing-country choices for the custom Select. An empty-value first option
// keeps "Detect automatically" (currency inferred from the request IP) both
// selectable and revertable — value '' shows this label, any code shows the
// picked country. Built once at module load (COUNTRY_OPTIONS is static).
const BILLING_COUNTRY_OPTIONS = [
  { value: '', label: 'Detect automatically', search: 'detect automatically auto' },
  ...COUNTRY_OPTIONS,
];

const features = [
  { icon: BookOpen, title: 'Knowledge Base', desc: 'Train on your docs in minutes' },
  { icon: Zap, title: 'One-Line Embed', desc: 'Add to any website instantly' },
  { icon: BarChart3, title: 'Live Analytics', desc: 'Real-time insights & metrics' },
  { icon: Shield, title: 'Enterprise Ready', desc: 'Encrypted & secure by design' },
];

export default function Register() {
  const [initialSearchParams] = useSearchParams();
  // Pre-fill from URL — the invite airlock routes new invitees here as
  // ``/register?next=/invite/<token>&email=<invite_email>``. We pre-fill
  // but DON'T lock the field: the invitee might genuinely want to sign up
  // under a different email (e.g. work vs personal), and the airlock's
  // email-match check handles the mismatch cleanly on the return trip.
  const _initialEmail = (initialSearchParams.get('email') || '').trim();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(_initialEmail);
  const [companyName, setCompanyName] = useState('');
  const [website, setWebsite] = useState('');
  const [billingCountry, setBillingCountry] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Email/password is the secondary signup path — revealed behind a "Continue
  // with email" disclosure so Google SSO stays the primary call-to-action.
  // Auto-expanded when an email is pre-filled (invite airlock round-trip).
  const [showEmailForm, setShowEmailForm] = useState(Boolean(_initialEmail));
  const navigate = useNavigate();
  // Affiliate invite round-trip — see Login.jsx for the rationale. New
  // sign-ups arrived from the Partners invite landing get routed back
  // there so the accept-existing endpoint can wire the affiliate row.
  const [searchParams] = useSearchParams();
  const affiliateToken = searchParams.get('affiliate_token') || '';
  // Deep-link round-trip target. Invite airlock routes here as
  // ``/register?next=/invite/<token>&email=<invite_email>`` so a fresh
  // signup lands back on the airlock to auto-accept. Also honoured by the
  // Google button below so OAuth signup survives the same round-trip.
  const rawNext = searchParams.get('next') || '';
  // Same open-redirect guard as Login.jsx — only relative same-origin paths.
  const safeNext = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '';

  const hasMinLength = password.length >= 8;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const passwordsMatch = password && confirmPassword && password === confirmPassword;
  const strengthScore = [hasMinLength, hasLetter, hasNumber].filter(Boolean).length;

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim() || !email.trim() || !password || !confirmPassword) {
      setError('Please fill in all required fields.');
      return;
    }
    if (name.trim().length < 2) {
      setError('Name must be at least 2 characters.');
      return;
    }
    if (!hasMinLength || !hasLetter || !hasNumber) {
      setError('Password does not meet the requirements below.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    try {
      setIsLoading(true);
      const data = await registerClient(
        name.trim(),
        email.trim(),
        password,
        companyName.trim() || null,
        website.trim() || null,
        billingCountry || null,
      );

      // Register defaults to ``persistent=true`` — newly signed-up
      // customers should stay logged in across browser restarts unless
      // they explicitly opt out via Login → Remember me.
      setAuthBundle({
        admin_token: data.access_token,
        admin_name: data.name,
        admin_client_id: data.client_id,
        admin_is_verified: 'false',
        admin_pending_email: email.trim(),
        auth_type: 'client',
        is_superadmin: 'false',
        company_name: data.company_name || '',
        company_website: data.website || '',
      });
      sessionStorage.setItem('login_toast', 'registered');

      // Mirror Login.jsx — clear any stale trial-banner dismissals from a
      // prior session on this device so the freshly-registered client sees
      // the trial banner immediately instead of inheriting a "dismissed"
      // flag set by a previous account.
      clearTrialBannerDismissals();

      // Email verification is no longer a hard wall for ORGANIC signups: the
      // new client lands straight in the product and is nudged by the
      // dismissible VerifyEmailBanner (verification stays enforced
      // server-side on billing/invite mutations). Invite/affiliate
      // deep-links are preserved so recipients still round-trip back to their
      // airlock; only organic (no deep-link) signups skip into the app.
      if (safeNext) {
        navigate(safeNext);
      } else if (affiliateToken) {
        navigate(`/affiliate-invite?token=${encodeURIComponent(affiliateToken)}`);
      } else {
        navigate(STUDIO_ENABLED ? '/build' : '/');
      }
    } catch (err) {
      // Detect the "email already registered" backend rejection so we can
      // offer a one-click redirect to Login with the current query params
      // preserved (invite ``next``, invited ``email``, etc.). Common flow
      // for an invitee who forgot they already have an OyeChats account —
      // without this hint they'd stall on the register page with a generic
      // error and no obvious next step. Server surfaces this as a 409 with
      // a message containing "already"; we broaden slightly for resilience.
      const msg = err?.message || '';
      const looksLikeEmailTaken = err?.status === 409 || /already/i.test(msg) || /email exists|registered/i.test(msg);
      if (looksLikeEmailTaken) {
        // Route to /login with the same next/email so the invite airlock
        // round-trip continues seamlessly after they sign in.
        const params = new URLSearchParams();
        if (email.trim()) params.set('email', email.trim());
        if (safeNext) params.set('next', safeNext);
        setError(''); // clear form error; the redirect explains everything
        navigate(`/login?${params.toString()}`, { replace: true });
        return;
      }
      setError(msg || 'Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // NOTE: /register intentionally has NO "already authenticated → redirect"
  // guard. It's the target of the marketing site's "Start free" CTA, so it
  // must always render the form. The old guard redirected on mere token
  // PRESENCE — a stale/server-invalidated token (common after a session
  // lapse) sent the visitor to "/", which then 401'd and bounced them to
  // /login, trapping the sign-up flow. New users, stale-token users, and
  // logged-in users all reliably land on the form now.

  const strengthColor = strengthScore === 3 ? 'bg-emerald-500' : strengthScore === 2 ? 'bg-amber-500' : strengthScore === 1 ? 'bg-rose-500' : 'bg-surface-200';

  const inputCls = cn(
    'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white text-surface-900',
    'border-surface-200 focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)]',
    'outline-none transition-all text-sm placeholder:text-surface-400'
  );

  return (
    <div className="min-h-screen flex bg-surface-50">
      {/* Left Panel — Branding */}
      <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden bg-gradient-to-br from-[#17121f] via-[#14101e] to-[#0f0b15] text-white">
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(162,28,175,0.18) 0%, rgba(162,28,175,0.08) 40%, transparent 70%)', filter: 'blur(40px)' }} />
        <div className="absolute top-20 -left-20 w-96 h-96 bg-primary-600/15 rounded-full blur-[100px] animate-[float_8s_ease-in-out_infinite]" />
        <div className="absolute bottom-20 right-10 w-80 h-80 bg-primary-400/10 rounded-full blur-[80px] animate-[float_6s_ease-in-out_infinite_reverse]" />

        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative z-10 flex items-center gap-1"
        >
          <img src="/logo-icon.png" alt="OyeChats" className="h-12 w-auto object-contain" />
          <span className="text-xl font-bold text-white tracking-tight">OyeChats</span>
        </motion.div>

        <div className="relative z-10 my-auto">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-4xl xl:text-5xl font-bold text-white leading-[1.15] mb-4"
          >
            Start building
            <br />
            <span className="bg-gradient-to-r from-primary-400 via-primary-300 to-primary-200 bg-clip-text text-transparent">
              in minutes
            </span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-white/45 text-lg mb-10 max-w-md leading-relaxed"
          >
            Create your free account and deploy your first AI chatbot today. No credit card required.
          </motion.p>

          <div className="grid grid-cols-2 gap-3">
            {features.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.3 + i * 0.08 }}
                className="flex items-start gap-3 p-3.5 rounded-xl bg-white/10 border border-white/15 hover:bg-white/[0.16] transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-white/15 border border-white/20 flex items-center justify-center flex-shrink-0">
                  <f.icon size={15} className="text-white" />
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-white">{f.title}</p>
                  <p className="text-[11px] text-white/60 mt-0.5">{f.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.7 }}
          className="relative z-10 flex items-center gap-8"
        >
          {[
            { val: 'Free', label: 'To get started' },
            { val: '< 5min', label: 'Setup time' },
            { val: '24/7', label: 'AI support' },
          ].map((s) => (
            <div key={s.label}>
              <p className="text-xl font-bold text-white">{s.val}</p>
              <p className="text-[11px] text-white/35 font-medium">{s.label}</p>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Right Panel — Form */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-surface-50 overflow-y-auto">
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[400px] my-auto"
        >
          <div className="flex items-center gap-1 mb-8 lg:hidden">
            <img src="/logo-icon.png" alt="OyeChats" className="h-11 w-auto object-contain" />
            <span className="text-lg font-bold text-surface-900">OyeChats</span>
          </div>

          <div className="mb-6">
            <h1 className="text-2xl font-bold text-surface-900 tracking-tight">Get started free</h1>
            <p className="text-surface-500 mt-2 text-sm">Create your OyeChats account</p>
          </div>

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              role="alert"
              className="mb-4 p-3.5 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-xl text-sm font-medium border border-rose-200 dark:border-rose-500/20"
            >
              {error}
            </motion.div>
          )}

          {/* Google OAuth signup — backend uses the same endpoint as login;
              it decides "new account" vs "returning" by looking up the
              provider subject + email. Hidden when the server reports
              Google OAuth is not configured. */}
          <div className="mb-3">
            <GoogleAuthButton
              label="Sign up with Google"
              mode="register"
              // Same precedence as Login.jsx: honor an explicit ``next``
              // (invite airlock, push-notification round-trip) first, fall
              // back to the affiliate-invite deep link, then to root.
              next={safeNext || (affiliateToken ? `/affiliate-invite?token=${encodeURIComponent(affiliateToken)}` : '/')}
              tabIndex={0}
            />
          </div>

          {/* Implicit consent — the industry-standard pattern (Google, Stripe,
              Vercel, Linear, Notion): one statement covering BOTH signup
              methods, no checkbox, buttons never disabled. Signing up is the
              consenting action; this notice sits under the primary CTA so it's
              always visible regardless of whether the email form is expanded. */}
          <p className="mb-4 text-xs leading-relaxed text-surface-500">
            By signing up, you agree to our{' '}
            <a
              href="https://oyechats.com/legal/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-600 hover:text-primary-700 font-medium"
            >
              Terms
            </a>{' '}
            and{' '}
            <a
              href="https://oyechats.com/legal/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-600 hover:text-primary-700 font-medium"
            >
              Privacy Policy
            </a>.
          </p>

          {/* Secondary email/password path, disclosed on demand. All fields
              and handlers are unchanged; only the Terms gate was lifted out
              (above) so it stays reachable while collapsed. */}
          {!showEmailForm ? (
            <>
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-surface-200" />
                <span className="text-xs text-surface-400 uppercase tracking-wider">or</span>
                <div className="flex-1 h-px bg-surface-200" />
              </div>
              <button
                type="button"
                onClick={() => setShowEmailForm(true)}
                className={cn(
                  'w-full py-2.5 rounded-xl border border-surface-200 bg-white text-surface-700',
                  'font-medium text-sm hover:bg-surface-50 transition-colors',
                  'flex items-center justify-center gap-2'
                )}
                tabIndex={0}
              >
                <Mail size={16} className="text-surface-400" />
                Continue with email
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-surface-200" />
                <span className="text-xs text-surface-400 uppercase tracking-wider">or sign up with email</span>
                <div className="flex-1 h-px bg-surface-200" />
              </div>

              <form onSubmit={handleRegister} className="space-y-3.5">
            <div>
              <label className="block text-[13px] font-medium text-surface-600 mb-1.5">Full name</label>
              <div className="relative group">
                <User size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="John Doe" autoComplete="name" tabIndex={1} />
              </div>
            </div>

            <div>
              <label className="block text-[13px] font-medium text-surface-600 mb-1.5">Email address</label>
              <div className="relative group">
                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="you@company.com" autoComplete="email" tabIndex={2} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-surface-600 mb-1.5">
                  Company <span className="text-surface-400 font-normal text-[11px]">(optional)</span>
                </label>
                <div className="relative group">
                  <Building2 size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                  <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className={inputCls} placeholder="Acme Inc." autoComplete="organization" tabIndex={3} />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-surface-600 mb-1.5">
                  Website <span className="text-surface-400 font-normal text-[11px]">(optional)</span>
                </label>
                <div className="relative group">
                  <Globe size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                  <input
                    type="url"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    onBlur={(e) => {
                      // Auto-prepend https:// so a bare host (e.g. www.oyechats.com)
                      // passes the native URL validation instead of erroring. We
                      // only add the protocol — no validation/clearing — so partial
                      // input the user is still working on is never discarded.
                      const v = e.target.value.trim();
                      if (v && !/^https?:\/\//i.test(v)) setWebsite(`https://${v}`);
                    }}
                    className={inputCls}
                    placeholder="www.example.com"
                    autoComplete="url"
                    tabIndex={4}
                  />
                </div>
              </div>
            </div>

            <div>
              <label htmlFor="billingCountry" className="block text-[13px] font-medium text-surface-600 mb-1.5">
                Billing country <span className="text-surface-400 font-normal text-[11px]">(sets your currency)</span>
              </label>
              <div className="relative group">
                <MapPin size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 z-10 pointer-events-none text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <Select
                  id="billingCountry"
                  value={billingCountry}
                  onChange={setBillingCountry}
                  options={BILLING_COUNTRY_OPTIONS}
                  placeholder="Detect automatically"
                  searchable
                  light
                  className="pl-10 pr-4 py-2.5 rounded-xl"
                />
              </div>
              <p className="mt-1 text-[11px] text-surface-400">India is billed in ₹ INR; other countries in $ USD.</p>
            </div>

            <div>
              <label className="block text-[13px] font-medium text-surface-600 mb-1.5">Password</label>
              <div className="relative group">
                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input
                  type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                  className={cn(inputCls, 'pr-11')}
                  placeholder="Create a strong password" autoComplete="new-password" tabIndex={6}
                />
                <button
                  type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {password.length > 0 && (
                <div className="mt-2 space-y-2">
                  <div className="flex gap-1">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className={cn('h-1 flex-1 rounded-full transition-all duration-300', i <= strengthScore ? strengthColor : 'bg-surface-200')} />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {[
                      { met: hasMinLength, label: '8+ characters' },
                      { met: hasLetter, label: 'Has letter' },
                      { met: hasNumber, label: 'Has number' },
                    ].map((check) => (
                      <div key={check.label} className={cn('flex items-center gap-1.5 text-xs transition-colors', check.met ? 'text-emerald-600' : 'text-surface-400')}>
                        <CheckCircle2 size={12} className={check.met ? 'text-emerald-600' : 'text-surface-300'} />
                        {check.label}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-[13px] font-medium text-surface-600 mb-1.5">Confirm password</label>
              <div className="relative group">
                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input
                  type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white text-surface-900',
                    'outline-none transition-all text-sm placeholder:text-surface-400',
                    'focus:ring-1 focus:ring-[var(--focus-ring)]',
                    confirmPassword
                      ? passwordsMatch
                        ? 'border-emerald-500 focus:border-emerald-500'
                        : 'border-rose-400 focus:border-rose-500'
                      : 'border-surface-200 focus:border-[var(--focus)]'
                  )}
                  placeholder="Re-enter your password" autoComplete="new-password" tabIndex={7}
                />
              </div>
              {confirmPassword && !passwordsMatch && (
                <p className="text-xs text-rose-600 mt-1">Passwords do not match</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className={cn(
                'w-full py-2.5 bg-primary-600 hover:bg-primary-500 text-white font-semibold rounded-xl',
                'shadow-lg shadow-primary-500/30 transition-all active:scale-[0.98]',
                'flex justify-center items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm'
              )}
              tabIndex={9}
            >
              {isLoading ? <Loader2 size={18} className="animate-spin" /> : <>Create Account <ArrowRight size={15} /></>}
            </button>
              </form>
            </>
          )}

          <p className="text-center text-sm text-surface-500 mt-6">
            Already have an account?{' '}
            <Link to="/login" tabIndex={10} className="font-semibold text-primary-600 hover:text-primary-700 transition-colors">
              Sign in
            </Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
