import { useState } from 'react';
import { Navigate, useNavigate, Link } from 'react-router-dom';
import { Sparkles, Loader2, Eye, EyeOff, CheckCircle2, Mail, Lock, User, Building2, Globe, ArrowRight, Zap, BookOpen, BarChart3, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
import { registerClient } from '../services/api';
import { cn } from '../lib/utils';

const features = [
  { icon: BookOpen, title: 'Knowledge Base', desc: 'Train on your docs in minutes' },
  { icon: Zap, title: 'One-Line Embed', desc: 'Add to any website instantly' },
  { icon: BarChart3, title: 'Live Analytics', desc: 'Real-time insights & metrics' },
  { icon: Shield, title: 'Enterprise Ready', desc: 'SOC 2 compliant & secure' },
];

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [website, setWebsite] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

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
      const data = await registerClient(name.trim(), email.trim(), password, companyName.trim() || null, website.trim() || null);

      localStorage.setItem('admin_token', data.access_token);
      localStorage.setItem('admin_name', data.name);
      localStorage.setItem('admin_client_id', data.client_id.toString());
      localStorage.setItem('auth_type', 'client');
      localStorage.setItem('is_superadmin', 'false');
      localStorage.setItem('company_name', data.company_name || '');
      localStorage.setItem('company_website', data.website || '');
      sessionStorage.setItem('login_toast', 'registered');

      navigate('/chatbot');
    } catch (err) {
      setError(err.message || 'Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (localStorage.getItem('admin_token')) {
    const isSuper = localStorage.getItem('is_superadmin') === 'true';
    return <Navigate to={isSuper ? '/superadmin/overview' : '/'} />;
  }

  const strengthColor = strengthScore === 3 ? 'bg-emerald-500' : strengthScore === 2 ? 'bg-amber-500' : strengthScore === 1 ? 'bg-rose-500' : 'bg-surface-200';

  return (
    <div className="min-h-screen flex bg-surface-950">
      {/* Left Panel — Branding */}
      <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden">
        <div className="absolute inset-0 gradient-mesh" />
        <div className="absolute inset-0 noise-overlay" />

        <div className="absolute top-20 -left-20 w-96 h-96 bg-primary-500/20 rounded-full blur-[100px] animate-[float_8s_ease-in-out_infinite]" />
        <div className="absolute bottom-20 right-10 w-80 h-80 bg-violet-500/15 rounded-full blur-[80px] animate-[float_6s_ease-in-out_infinite_reverse]" />

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

        <div className="relative z-10 my-auto">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-4xl xl:text-5xl font-bold text-white leading-[1.15] mb-4"
          >
            Start building
            <br />
            <span className="bg-gradient-to-r from-primary-400 via-violet-400 to-sky-400 bg-clip-text text-transparent">
              in minutes
            </span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-surface-400 text-lg mb-10 max-w-md leading-relaxed"
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
                className="flex items-start gap-3 p-3.5 rounded-xl bg-white/[0.06] backdrop-blur-sm border border-white/[0.08]"
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
              <p className="text-[11px] text-surface-500 font-medium">{s.label}</p>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Right Panel — Form */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-white dark:bg-surface-950 overflow-y-auto">
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[400px] my-auto"
        >
          <div className="flex items-center gap-3 mb-8 lg:hidden">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center shadow-lg shadow-primary-500/20">
              <Sparkles size={18} />
            </div>
            <span className="text-lg font-bold text-surface-900 dark:text-white">OyeChats</span>
          </div>

          <div className="mb-6">
            <h1 className="text-2xl font-bold text-surface-900 dark:text-white tracking-tight">Get started free</h1>
            <p className="text-surface-500 mt-2 text-sm">Create your OyeChats account</p>
          </div>

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className="mb-4 p-3.5 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-xl text-sm font-medium border border-rose-200 dark:border-rose-500/20"
            >
              {error}
            </motion.div>
          )}

          <form onSubmit={handleRegister} className="space-y-3.5">
            <div>
              <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300 mb-1.5">Full name</label>
              <div className="relative group">
                <User size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input
                  type="text" value={name} onChange={(e) => setName(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                    'border-surface-200 dark:border-surface-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400',
                    'outline-none transition-all text-sm placeholder:text-surface-400'
                  )}
                  placeholder="John Doe" autoComplete="name" tabIndex={1}
                />
              </div>
            </div>

            <div>
              <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300 mb-1.5">Email address</label>
              <div className="relative group">
                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input
                  type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                    'border-surface-200 dark:border-surface-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400',
                    'outline-none transition-all text-sm placeholder:text-surface-400'
                  )}
                  placeholder="you@company.com" autoComplete="email" tabIndex={2}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                  Company <span className="text-surface-400 font-normal text-[11px]">(optional)</span>
                </label>
                <div className="relative group">
                  <Building2 size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                  <input
                    type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)}
                    className={cn(
                      'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                      'border-surface-200 dark:border-surface-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400',
                      'outline-none transition-all text-sm placeholder:text-surface-400'
                    )}
                    placeholder="Acme Inc." autoComplete="organization" tabIndex={3}
                  />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                  Website <span className="text-surface-400 font-normal text-[11px]">(optional)</span>
                </label>
                <div className="relative group">
                  <Globe size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                  <input
                    type="url" value={website} onChange={(e) => setWebsite(e.target.value)}
                    className={cn(
                      'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                      'border-surface-200 dark:border-surface-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400',
                      'outline-none transition-all text-sm placeholder:text-surface-400'
                    )}
                    placeholder="https://..." autoComplete="url" tabIndex={4}
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300 mb-1.5">Password</label>
              <div className="relative group">
                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input
                  type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-11 py-2.5 rounded-xl border bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                    'border-surface-200 dark:border-surface-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400',
                    'outline-none transition-all text-sm placeholder:text-surface-400'
                  )}
                  placeholder="Create a strong password" autoComplete="new-password" tabIndex={5}
                />
                <button
                  type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {password.length > 0 && (
                <div className="mt-2 space-y-2">
                  {/* Strength bar */}
                  <div className="flex gap-1">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className={cn('h-1 flex-1 rounded-full transition-all duration-300', i <= strengthScore ? strengthColor : 'bg-surface-200 dark:bg-surface-800')} />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {[
                      { met: hasMinLength, label: '8+ characters' },
                      { met: hasLetter, label: 'Has letter' },
                      { met: hasNumber, label: 'Has number' },
                    ].map((check) => (
                      <div key={check.label} className={cn('flex items-center gap-1.5 text-xs transition-colors', check.met ? 'text-emerald-600 dark:text-emerald-400' : 'text-surface-400')}>
                        <CheckCircle2 size={12} className={check.met ? 'text-emerald-500' : 'text-surface-300 dark:text-surface-600'} />
                        {check.label}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-[13px] font-medium text-surface-700 dark:text-surface-300 mb-1.5">Confirm password</label>
              <div className="relative group">
                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <input
                  type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  className={cn(
                    'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-surface-900 text-surface-900 dark:text-white',
                    'outline-none transition-all text-sm placeholder:text-surface-400',
                    'focus:ring-2 focus:ring-primary-500/20',
                    confirmPassword
                      ? passwordsMatch
                        ? 'border-emerald-500 focus:border-emerald-500'
                        : 'border-rose-500 focus:border-rose-500'
                      : 'border-surface-200 dark:border-surface-800 focus:border-primary-500 dark:focus:border-primary-400'
                  )}
                  placeholder="Re-enter your password" autoComplete="new-password" tabIndex={6}
                />
              </div>
              {confirmPassword && !passwordsMatch && (
                <p className="text-xs text-rose-500 mt-1">Passwords do not match</p>
              )}
            </div>

            <p className="text-xs text-surface-400 text-center pt-1">
              By creating an account, you agree to our{' '}
              <a href="#" tabIndex={-1} className="text-primary-600 dark:text-primary-400 hover:underline">Terms</a>{' '}
              and{' '}
              <a href="#" tabIndex={-1} className="text-primary-600 dark:text-primary-400 hover:underline">Privacy Policy</a>.
            </p>

            <button
              type="submit" disabled={isLoading}
              className={cn(
                'w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-xl',
                'shadow-lg shadow-primary-500/25 transition-all active:scale-[0.98]',
                'flex justify-center items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm'
              )}
              tabIndex={7}
            >
              {isLoading ? <Loader2 size={18} className="animate-spin" /> : <>Create Account <ArrowRight size={15} /></>}
            </button>
          </form>

          <p className="text-center text-sm text-surface-500 mt-6">
            Already have an account?{' '}
            <Link to="/login" tabIndex={8} className="font-semibold text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors">
              Sign in
            </Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
