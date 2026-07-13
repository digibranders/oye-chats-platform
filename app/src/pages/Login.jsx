import { useState } from 'react';
import { Navigate, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Loader2, Mail, Lock, Eye, EyeOff, ArrowRight, Zap, BookOpen, BarChart3, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
import { loginAdmin, loginOperator } from '../services/api';
import { clearTrialBannerDismissals } from '../utils/trialBanner';
import { setAuthBundle, getAuthItem } from '../utils/authStorage';
import { cn } from '../lib/utils';
import GoogleAuthButton from '../components/GoogleAuthButton';

const features = [
  { icon: BookOpen, title: 'Knowledge Base', desc: 'Train on your docs in minutes' },
  { icon: Zap, title: 'One-Line Embed', desc: 'Add to any website instantly' },
  { icon: BarChart3, title: 'Live Analytics', desc: 'Real-time insights & metrics' },
  { icon: Shield, title: 'Enterprise Ready', desc: 'Encrypted & secure by design' },
];

export default function Login() {
  // Read the initial email from the URL up front so ``useState``'s lazy
  // initializer captures it before the first render — the invite airlock
  // routes here as ``/login?next=/invite/<token>&email=<invited_email>``
  // and pre-filling saves the invitee from retyping their own email. Not
  // locked so someone using their own credentials with a different email
  // can still edit; the airlock's email-match check catches any drift on
  // the return trip.
  const [initialSearchParams] = useSearchParams();
  const _initialEmail = (initialSearchParams.get('email') || '').trim();
  const [email, setEmail] = useState(_initialEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const navigate = useNavigate();
  // Affiliate invite round-trip: if the user arrived via the Partners
  // invite landing page, we route them back there after login so the
  // accept-existing flow can fire. The token stays in the URL — never
  // touches localStorage, so a stale token can't haunt later logins.
  const [searchParams] = useSearchParams();
  const affiliateToken = searchParams.get('affiliate_token') || '';
  // Deep-link round-trip target. Push-notification clicks land at
  // `/support?session=<id>`; an intervening auth bounce would lose that
  // context. ProtectedRoute appends `?next=` when redirecting unauthenticated
  // users here so we can navigate to the original target after login.
  const rawNext = searchParams.get('next') || '';
  // Only honour same-origin relative paths — anything starting with `//`,
  // a protocol, or an external host is rejected to prevent open-redirect
  // attacks via a crafted notification payload.
  const safeNext = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '';

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Please enter both email and password.');
      return;
    }

    try {
      setIsLoading(true);
      let loggedIn = false;

      try {
        const data = await loginOperator(email, password);
        // Fresh login → clear any banner dismissals carried over from a
        // previous account in this tab. Done before the toast flag so a
        // failed read can't accidentally suppress the new user's banner.
        clearTrialBannerDismissals();
        // ``rememberMe`` drives where the auth bundle lands: localStorage
        // (persists across browser restarts) when checked, sessionStorage
        // (cleared on tab close) when not. All keys go to the SAME store
        // so the user-info bundle stays consistent with the token.
        setAuthBundle(
          {
            admin_token: data.access_token,
            admin_name: data.name,
            admin_client_id: data.client_id,
            auth_type: 'operator',
            operator_role: data.role,
            operator_id: data.operator_id,
            is_superadmin: 'false',
            company_name: data.company_name || '',
            company_website: data.website || '',
            onboarding_complete: 'true',
            selected_bot_id: data.default_bot_id ?? undefined,
          },
          rememberMe,
        );
        sessionStorage.setItem('login_toast', '1');
        loggedIn = true;
        // Operators are never affiliates by design — backend always
        // returns is_affiliate=false for X-Operator-Key principals. So
        // even when an affiliate_token is present we route to the deep-link
        // target (push-notification round-trip) or /support; any logged-in
        // affiliate redeeming an invite must use a client login.
        navigate(safeNext || '/support');
      } catch {
        // Operator login failed — try admin login
      }

      if (!loggedIn) {
        const data = await loginAdmin(email, password);
        clearTrialBannerDismissals();
        setAuthBundle(
          {
            admin_token: data.access_token,
            admin_name: data.name,
            admin_client_id: data.client_id,
            admin_is_verified: data.is_verified ? 'true' : 'false',
            auth_type: 'client',
            is_superadmin: data.is_superadmin ? 'true' : 'false',
            company_name: data.company_name || '',
            company_website: data.website || '',
          },
          rememberMe,
        );
        sessionStorage.setItem('login_toast', '1');

        if (!data.is_verified) {
          navigate(`/verify-email?email=${encodeURIComponent(email)}`);
        } else if (affiliateToken) {
          // Affiliate token always wins over the default landing target.
          navigate(`/affiliate-invite?token=${encodeURIComponent(affiliateToken)}`);
        } else if (safeNext) {
          // Deep-link round-trip (e.g. push-notification click landed on
          // /support?session=<id> before auth bounced through here).
          navigate(safeNext);
        } else {
          // Super-admins log into the dedicated console at admin.oyechats.com,
          // not this dashboard — route them to "/" like any other client.
          navigate('/');
        }
      }
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (getAuthItem('admin_token')) {
    if (getAuthItem('admin_is_verified') === 'false') {
      const pending = getAuthItem('admin_pending_email') || '';
      // Preserve the deep-link ``next`` (e.g. ``/invite/<token>``) through
      // the verification bounce so an already-logged-in but unverified user
      // clicking an invite link still lands on the airlock after OTP entry.
      const verifyParams = new URLSearchParams();
      if (pending) verifyParams.set('email', pending);
      if (safeNext) verifyParams.set('next', safeNext);
      const q = verifyParams.toString();
      return <Navigate to={`/verify-email${q ? `?${q}` : ''}`} replace />;
    }
    const isOperator = localStorage.getItem('auth_type') === 'operator';
    // Deep-link ``next`` wins over defaults — invite airlock, push-notification
    // click, etc. Without this, an already-logged-in user clicking an invite
    // link would get bounced straight to their dashboard instead of the
    // airlock, losing the invite context they intended to act on.
    if (safeNext) {
      return <Navigate to={safeNext} replace />;
    }
    // If an affiliate token is in the URL, keep routing it through the
    // invite landing — the recipient is already logged in and the page
    // will auto-fire accept-existing.
    if (affiliateToken && !isOperator) {
      return <Navigate to={`/affiliate-invite?token=${encodeURIComponent(affiliateToken)}`} />;
    }
    return <Navigate to={isOperator ? '/support' : '/'} />;
  }

  return (
    <div className="min-h-screen flex bg-surface-50">
      {/* Left Panel — Branding */}
      <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden bg-gradient-to-br from-[#17121f] via-[#14101e] to-[#0f0b15] text-white">
        {/* Grid pattern like website hero */}
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {/* Radial glow like website hero */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(162,28,175,0.18) 0%, rgba(162,28,175,0.08) 40%, transparent 70%)', filter: 'blur(40px)' }} />

        {/* Floating orbs — website blue palette */}
        <div className="absolute top-20 -left-20 w-96 h-96 bg-primary-600/15 rounded-full blur-[100px] animate-[float_8s_ease-in-out_infinite]" />
        <div className="absolute bottom-20 right-10 w-80 h-80 bg-primary-400/10 rounded-full blur-[80px] animate-[float_6s_ease-in-out_infinite_reverse]" />
        <div className="absolute top-1/2 left-1/3 w-64 h-64 bg-primary-500/8 rounded-full blur-[60px] animate-[float_10s_ease-in-out_infinite]" />

        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative z-10 flex items-center gap-1"
        >
          <img src="/logo-icon.png" alt="OyeChats" className="h-12 w-auto object-contain" />
          <span className="text-xl font-bold text-white tracking-tight">OyeChats</span>
        </motion.div>

        {/* Hero content */}
        <div className="relative z-10 my-auto">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-4xl xl:text-5xl font-bold text-white leading-[1.15] mb-4"
          >
            AI chatbots that
            <br />
            <span className="bg-gradient-to-r from-primary-400 via-primary-300 to-primary-200 bg-clip-text text-transparent">
              know your business
            </span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-white/45 text-lg mb-10 max-w-md leading-relaxed"
          >
            Deploy intelligent chatbots trained on your data. Capture leads, support customers, and grow revenue. All on autopilot.
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

        {/* Bottom stats */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.7 }}
          className="relative z-10 flex items-center gap-8"
        >
          {[
            { val: 'RAG', label: 'Answers from your docs' },
            { val: 'Live', label: 'Human handoff built in' },
            { val: 'Secure', label: 'Encrypted in transit' },
          ].map((s) => (
            <div key={s.label}>
              <p className="text-xl font-bold text-white">{s.val}</p>
              <p className="text-[11px] text-white/35 font-medium">{s.label}</p>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Right Panel — Form */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-surface-50">
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[400px]"
        >
          {/* Mobile logo */}
          <div className="flex items-center gap-1 mb-10 lg:hidden">
            <img src="/logo-icon.png" alt="OyeChats" className="h-11 w-auto object-contain" />
            <span className="text-lg font-bold text-surface-900">OyeChats</span>
          </div>

          <div className="mb-8">
            <h1 className="text-2xl font-bold text-surface-900 tracking-tight">
              Welcome back
            </h1>
            <p className="text-surface-500 mt-2 text-sm">
              Sign in to your account to continue
            </p>
          </div>

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              role="alert"
              className="mb-5 p-3.5 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-xl text-sm font-medium border border-rose-200 dark:border-rose-500/20"
            >
              {error}
            </motion.div>
          )}

          {/* Google OAuth — same backend endpoint as the signup page. The
              button hides itself if /auth/google/status returns enabled=false,
              so misconfigured envs degrade gracefully. */}
          <div className="mb-5">
            {/* Preserve the deep-link ``next`` (e.g. ``/invite/<token>``)
                so a Google sign-in from the invite airlock lands the user
                BACK on the airlock to accept, not on the dashboard root.
                ``safeNext`` is already open-redirect validated above; the
                affiliate-token fallback stays as a lower-priority default
                for the standalone affiliate-invite flow. */}
            <GoogleAuthButton
              label="Sign in with Google"
              mode="login"
              next={safeNext || (affiliateToken ? `/affiliate-invite?token=${encodeURIComponent(affiliateToken)}` : '/')}
              tabIndex={0}
            />
          </div>

          <div className="flex items-center gap-3 mb-5">
            <div className="flex-1 h-px bg-surface-200" />
            <span className="text-xs text-surface-400 uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-surface-200" />
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-surface-600 mb-1.5">
                Email address
              </label>
              <div className="relative group">
                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white text-surface-900',
                    'border-surface-200',
                    'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
                    'outline-none transition-all text-sm placeholder:text-surface-400'
                  )}
                  placeholder="you@company.com"
                  tabIndex={1}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-[13px] font-medium text-surface-600">
                  Password
                </label>
                <Link to="/forgot-password" tabIndex={5} className="text-xs font-medium text-primary-600 hover:text-primary-700 transition-colors">
                  Forgot password?
                </Link>
              </div>
              <div className="relative group">
                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-11 py-2.5 rounded-xl border bg-white text-surface-900',
                    'border-surface-200',
                    'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
                    'outline-none transition-all text-sm placeholder:text-surface-400'
                  )}
                  placeholder="Enter your password"
                  tabIndex={2}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 transition-colors"
                  tabIndex={0}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2.5 cursor-pointer group">
              <div className="relative flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="peer appearance-none w-4 h-4 border border-surface-300 rounded bg-white checked:bg-primary-600 checked:border-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-500/25 transition-all cursor-pointer"
                  tabIndex={3}
                />
                <svg className="absolute w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="text-sm text-surface-500">Remember for 30 days</span>
            </label>

            <button
              type="submit"
              disabled={isLoading}
              className={cn(
                'w-full py-2.5 bg-primary-600 hover:bg-primary-500 text-white font-semibold rounded-xl',
                'shadow-lg shadow-primary-500/30 transition-all active:scale-[0.98]',
                'flex justify-center items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm'
              )}
              tabIndex={4}
            >
              {isLoading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <>
                  Sign in
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>

          <p className="text-center text-sm text-surface-500 mt-8">
            Don&apos;t have an account?{' '}
            <Link to="/register" tabIndex={6} className="font-semibold text-primary-600 hover:text-primary-700 transition-colors">
              Sign up free
            </Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
