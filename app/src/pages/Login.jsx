import { useState } from 'react';
import { Navigate, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Sparkles, Loader2, Mail, Lock, Eye, EyeOff, ArrowRight, Zap, BookOpen, BarChart3, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
import { loginAdmin, loginOperator } from '../services/api';
import { cn } from '../lib/utils';

const features = [
  { icon: BookOpen, title: 'Knowledge Base', desc: 'Train on your docs in minutes' },
  { icon: Zap, title: 'One-Line Embed', desc: 'Add to any website instantly' },
  { icon: BarChart3, title: 'Live Analytics', desc: 'Real-time insights & metrics' },
  { icon: Shield, title: 'Enterprise Ready', desc: 'SOC 2 compliant & secure' },
];

export default function Login() {
  const [email, setEmail] = useState('');
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
        const { clearTrialBannerDismissals } = await import('../utils/trialBanner');
        clearTrialBannerDismissals();
        localStorage.setItem('admin_token', data.access_token);
        localStorage.setItem('admin_name', data.name);
        localStorage.setItem('admin_client_id', data.client_id.toString());
        localStorage.setItem('auth_type', 'operator');
        localStorage.setItem('operator_role', data.role);
        localStorage.setItem('operator_id', data.operator_id.toString());
        localStorage.setItem('is_superadmin', 'false');
        localStorage.setItem('company_name', data.company_name || '');
        localStorage.setItem('company_website', data.website || '');
        localStorage.setItem('onboarding_complete', 'true');
        if (data.default_bot_id) {
          localStorage.setItem('selected_bot_id', data.default_bot_id.toString());
        }
        sessionStorage.setItem('login_toast', '1');
        loggedIn = true;
        // Operators are never affiliates by design — backend always
        // returns is_affiliate=false for X-Operator-Key principals. So
        // even when an affiliate_token is present we route to /support;
        // any logged-in affiliate redeeming an invite must use a client
        // login, not an operator login.
        navigate('/support');
      } catch {
        // Operator login failed — try admin login
      }

      if (!loggedIn) {
        const data = await loginAdmin(email, password);
        const { clearTrialBannerDismissals } = await import('../utils/trialBanner');
        clearTrialBannerDismissals();
        localStorage.setItem('admin_token', data.access_token);
        localStorage.setItem('admin_name', data.name);
        localStorage.setItem('admin_client_id', data.client_id.toString());
        localStorage.setItem('admin_is_verified', data.is_verified ? 'true' : 'false');
        localStorage.setItem('auth_type', 'client');
        localStorage.setItem('is_superadmin', data.is_superadmin ? 'true' : 'false');
        localStorage.setItem('company_name', data.company_name || '');
        localStorage.setItem('company_website', data.website || '');
        sessionStorage.setItem('login_toast', '1');

        if (!data.is_verified) {
          navigate(`/verify-email?email=${encodeURIComponent(email)}`);
        } else if (affiliateToken) {
          // Affiliate token always wins over the default landing target.
          navigate(`/affiliate-invite?token=${encodeURIComponent(affiliateToken)}`);
        } else if (data.is_superadmin) {
          navigate('/superadmin/overview');
        } else {
          navigate('/');
        }
      }
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (localStorage.getItem('admin_token')) {
    if (localStorage.getItem('admin_is_verified') === 'false') {
      const pending = localStorage.getItem('admin_pending_email') || '';
      return <Navigate to={`/verify-email${pending ? `?email=${encodeURIComponent(pending)}` : ''}`} replace />;
    }
    const isSuper = localStorage.getItem('is_superadmin') === 'true';
    const isOperator = localStorage.getItem('auth_type') === 'operator';
    // If an affiliate token is in the URL, keep routing it through the
    // invite landing — the recipient is already logged in and the page
    // will auto-fire accept-existing.
    if (affiliateToken && !isOperator) {
      return <Navigate to={`/affiliate-invite?token=${encodeURIComponent(affiliateToken)}`} />;
    }
    return <Navigate to={isSuper ? '/superadmin/overview' : isOperator ? '/support' : '/'} />;
  }

  return (
    <div className="min-h-screen flex bg-[#030D1F]">
      {/* Left Panel — Branding */}
      <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden auth-dark-panel">
        {/* Grid pattern like website hero */}
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {/* Radial glow like website hero */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.18) 0%, rgba(37,99,235,0.08) 40%, transparent 70%)', filter: 'blur(40px)' }} />

        {/* Floating orbs — website blue palette */}
        <div className="absolute top-20 -left-20 w-96 h-96 bg-blue-600/15 rounded-full blur-[100px] animate-[float_8s_ease-in-out_infinite]" />
        <div className="absolute bottom-20 right-10 w-80 h-80 bg-blue-400/10 rounded-full blur-[80px] animate-[float_6s_ease-in-out_infinite_reverse]" />
        <div className="absolute top-1/2 left-1/3 w-64 h-64 bg-cyan-500/8 rounded-full blur-[60px] animate-[float_10s_ease-in-out_infinite]" />

        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative z-10 flex items-center gap-3"
        >
          <div className="w-10 h-10 rounded-xl bg-blue-600/80 backdrop-blur-md border border-blue-400/30 flex items-center justify-center shadow-lg shadow-blue-500/30">
            <Sparkles size={20} className="text-white" />
          </div>
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
            <span className="bg-gradient-to-r from-blue-400 via-blue-300 to-cyan-400 bg-clip-text text-transparent">
              know your business
            </span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-white/45 text-lg mb-10 max-w-md leading-relaxed"
          >
            Deploy intelligent chatbots trained on your data. Capture leads, support customers, and grow revenue — all on autopilot.
          </motion.p>

          <div className="grid grid-cols-2 gap-3">
            {features.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.3 + i * 0.08 }}
                className="flex items-start gap-3 p-3.5 rounded-xl glass-card hover:bg-white/[0.06] transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-blue-500/15 border border-blue-400/20 flex items-center justify-center flex-shrink-0">
                  <f.icon size={15} className="text-blue-400" />
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-white">{f.title}</p>
                  <p className="text-[11px] text-surface-500 mt-0.5">{f.desc}</p>
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
            { val: '10K+', label: 'Active bots' },
            { val: '5M+', label: 'Conversations' },
            { val: '99.9%', label: 'Uptime' },
          ].map((s) => (
            <div key={s.label}>
              <p className="text-xl font-bold text-white">{s.val}</p>
              <p className="text-[11px] text-white/35 font-medium">{s.label}</p>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Right Panel — Form */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-[#030D1F]">
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[400px]"
        >
          {/* Mobile logo */}
          <div className="flex items-center gap-3 mb-10 lg:hidden">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-blue-400 text-white flex items-center justify-center shadow-lg shadow-blue-500/30">
              <Sparkles size={18} />
            </div>
            <span className="text-lg font-bold text-white">OyeChats</span>
          </div>

          <div className="mb-8">
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Welcome back
            </h1>
            <p className="text-white/45 mt-2 text-sm">
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

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-white/70 mb-1.5">
                Email address
              </label>
              <div className="relative group">
                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-blue-400 transition-colors" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white/[.04] text-white',
                    'border-white/[.08]',
                    'focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500/60',
                    'outline-none transition-all text-sm placeholder:text-white/25'
                  )}
                  placeholder="you@company.com"
                  tabIndex={1}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-[13px] font-medium text-white/70">
                  Password
                </label>
                <Link to="/forgot-password" tabIndex={5} className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
                  Forgot password?
                </Link>
              </div>
              <div className="relative group">
                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-blue-400 transition-colors" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-11 py-2.5 rounded-xl border bg-white/[.04] text-white',
                    'border-white/[.08]',
                    'focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500/60',
                    'outline-none transition-all text-sm placeholder:text-white/25'
                  )}
                  placeholder="Enter your password"
                  tabIndex={2}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors"
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
                  className="peer appearance-none w-4 h-4 border border-white/20 rounded bg-white/[.04] checked:bg-blue-600 checked:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/25 transition-all cursor-pointer"
                  tabIndex={3}
                />
                <svg className="absolute w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="text-sm text-white/45">Remember for 30 days</span>
            </label>

            <button
              type="submit"
              disabled={isLoading}
              className={cn(
                'w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl',
                'shadow-lg shadow-blue-500/30 transition-all active:scale-[0.98]',
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

          <p className="text-center text-sm text-white/40 mt-8">
            Don&apos;t have an account?{' '}
            <Link to="/register" tabIndex={6} className="font-semibold text-blue-400 hover:text-blue-300 transition-colors">
              Sign up free
            </Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
