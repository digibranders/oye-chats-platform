import { useState } from 'react';
import { Navigate, useNavigate, Link } from 'react-router-dom';
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
        navigate('/support');
      } catch {
        // Operator login failed — try admin login
      }

      if (!loggedIn) {
        const data = await loginAdmin(email, password);
        localStorage.setItem('admin_token', data.access_token);
        localStorage.setItem('admin_name', data.name);
        localStorage.setItem('admin_client_id', data.client_id.toString());
        localStorage.setItem('auth_type', 'client');
        localStorage.setItem('is_superadmin', data.is_superadmin ? 'true' : 'false');
        localStorage.setItem('company_name', data.company_name || '');
        localStorage.setItem('company_website', data.website || '');
        sessionStorage.setItem('login_toast', '1');

        if (data.is_superadmin) {
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
    const isSuper = localStorage.getItem('is_superadmin') === 'true';
    const isOperator = localStorage.getItem('auth_type') === 'operator';
    return <Navigate to={isSuper ? '/superadmin/overview' : isOperator ? '/support' : '/'} />;
  }

  return (
    <div className="min-h-screen flex bg-surface-950">
      {/* Left Panel — Branding */}
      <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden">
        {/* Animated gradient mesh background */}
        <div className="absolute inset-0 gradient-mesh" />
        <div className="absolute inset-0 noise-overlay" />

        {/* Floating orbs */}
        <div className="absolute top-20 -left-20 w-96 h-96 bg-primary-500/20 rounded-full blur-[100px] animate-[float_8s_ease-in-out_infinite]" />
        <div className="absolute bottom-20 right-10 w-80 h-80 bg-violet-500/15 rounded-full blur-[80px] animate-[float_6s_ease-in-out_infinite_reverse]" />
        <div className="absolute top-1/2 left-1/3 w-64 h-64 bg-sky-500/10 rounded-full blur-[60px] animate-[float_10s_ease-in-out_infinite]" />

        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative z-10 flex items-center gap-3"
        >
          <div className="w-10 h-10 rounded-xl bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center shadow-lg">
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
            <span className="bg-gradient-to-r from-primary-400 via-violet-400 to-sky-400 bg-clip-text text-transparent">
              know your business
            </span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-surface-400 text-lg mb-10 max-w-md leading-relaxed"
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
                className="flex items-start gap-3 p-3.5 rounded-xl bg-white/[0.06] backdrop-blur-sm border border-white/[0.08] hover:bg-white/[0.1] transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                  <f.icon size={15} className="text-primary-400" />
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
              <p className="text-[11px] text-surface-500 font-medium">{s.label}</p>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Right Panel — Form */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-white dark:bg-surface-950">
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[400px]"
        >
          {/* Mobile logo */}
          <div className="flex items-center gap-3 mb-10 lg:hidden">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center shadow-lg shadow-primary-500/20">
              <Sparkles size={18} />
            </div>
            <span className="text-lg font-bold text-surface-900 dark:text-white">OyeChats</span>
          </div>

          <div className="mb-8">
            <h1 className="text-2xl font-bold text-surface-900 dark:text-white tracking-tight">
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

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                Email address
              </label>
              <div className="relative group">
                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                    'border-surface-200 dark:border-surface-800',
                    'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400',
                    'outline-none transition-all text-sm placeholder:text-surface-400 dark:placeholder:text-surface-500'
                  )}
                  placeholder="you@company.com"
                  tabIndex={1}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300">
                  Password
                </label>
                <Link to="/forgot-password" tabIndex={5} className="text-xs font-medium text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors">
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
                    'w-full pl-10 pr-11 py-2.5 rounded-xl border bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                    'border-surface-200 dark:border-surface-800',
                    'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400',
                    'outline-none transition-all text-sm placeholder:text-surface-400 dark:placeholder:text-surface-500'
                  )}
                  placeholder="Enter your password"
                  tabIndex={2}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 transition-colors"
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
                  className="peer appearance-none w-4 h-4 border border-surface-300 dark:border-surface-700 rounded bg-white dark:bg-surface-900 checked:bg-primary-600 checked:border-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-500/20 transition-all cursor-pointer"
                  tabIndex={3}
                />
                <svg className="absolute w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="text-sm text-surface-600 dark:text-surface-400">Remember for 30 days</span>
            </label>

            <button
              type="submit"
              disabled={isLoading}
              className={cn(
                'w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-xl',
                'shadow-lg shadow-primary-500/25 transition-all active:scale-[0.98]',
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
            <Link to="/register" tabIndex={6} className="font-semibold text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors">
              Sign up free
            </Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
