import { useRef, useState } from 'react';
import { Navigate, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Loader2, Eye, EyeOff, CheckCircle2, Mail, Lock, User, Building2, Globe, MapPin, ArrowRight, Zap, BookOpen, BarChart3, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
import { registerClient } from '../services/api';
import { clearTrialBannerDismissals } from '../utils/trialBanner';
import { setAuthBundle, getAuthItem } from '../utils/authStorage';
import { cn } from '../lib/utils';
import GoogleAuthButton from '../components/GoogleAuthButton';
import { COUNTRY_OPTIONS } from '../lib/countries';

const features = [
  { icon: BookOpen, title: 'Knowledge Base', desc: 'Train on your docs in minutes' },
  { icon: Zap, title: 'One-Line Embed', desc: 'Add to any website instantly' },
  { icon: BarChart3, title: 'Live Analytics', desc: 'Real-time insights & metrics' },
  { icon: Shield, title: 'Enterprise Ready', desc: 'Encrypted & secure by design' },
];

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [website, setWebsite] = useState('');
  const [billingCountry, setBillingCountry] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [termsHighlight, setTermsHighlight] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const termsCheckboxRef = useRef(null);
  const navigate = useNavigate();
  // Affiliate invite round-trip — see Login.jsx for the rationale. New
  // sign-ups arrived from the Partners invite landing get routed back
  // there so the accept-existing endpoint can wire the affiliate row.
  const [searchParams] = useSearchParams();
  const affiliateToken = searchParams.get('affiliate_token') || '';

  const hasMinLength = password.length >= 8;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const passwordsMatch = password && confirmPassword && password === confirmPassword;
  const strengthScore = [hasMinLength, hasLetter, hasNumber].filter(Boolean).length;

  // Shared "you must accept the Terms first" gate — used by both the
  // email/password submit and the Google OAuth button (which redirects the
  // full page, so it has to be blocked synchronously on click). Surfaces the
  // error banner AND highlights + scrolls to the checkbox itself, since
  // Google's button sits above the checkbox in the layout.
  const blockOnTerms = () => {
    setError('Terms required — please agree to the Terms and Privacy Policy to continue.');
    setTermsHighlight(true);
    termsCheckboxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    termsCheckboxRef.current?.focus();
  };

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
    if (!agreedToTerms) {
      blockOnTerms();
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

      // Navigate to email verification — the guard below also handles the
      // re-render case (setIsLoading(false) fires after navigate).
      navigate(`/verify-email?email=${encodeURIComponent(email.trim())}`);
    } catch (err) {
      setError(err.message || 'Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (getAuthItem('admin_token')) {
    if (getAuthItem('admin_is_verified') === 'false') {
      const pending = getAuthItem('admin_pending_email') || '';
      return <Navigate to={`/verify-email${pending ? `?email=${encodeURIComponent(pending)}` : ''}`} replace />;
    }
    if (affiliateToken) {
      return <Navigate to={`/affiliate-invite?token=${encodeURIComponent(affiliateToken)}`} />;
    }
    return <Navigate to="/" />;
  }

  const strengthColor = strengthScore === 3 ? 'bg-emerald-500' : strengthScore === 2 ? 'bg-amber-500' : strengthScore === 1 ? 'bg-rose-500' : 'bg-surface-200';

  const inputCls = cn(
    'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white text-surface-900',
    'border-surface-200 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
    'outline-none transition-all text-sm placeholder:text-surface-400'
  );

  return (
    <div className="min-h-screen flex bg-surface-50">
      {/* Left Panel — Branding */}
      <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden bg-gradient-to-br from-primary-600 via-primary-700 to-primary-800 text-white">
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.18) 0%, rgba(37,99,235,0.08) 40%, transparent 70%)', filter: 'blur(40px)' }} />
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
              Google OAuth is not configured. Gated on the Terms/Privacy
              checkbox below, same as the email/password form — Google is a
              full-page redirect, so the gate has to run on click via
              onBlockedClick rather than a disabled attribute. */}
          <div className="mb-4">
            <GoogleAuthButton
              label="Sign up with Google"
              mode="register"
              next={affiliateToken ? `/affiliate-invite?token=${encodeURIComponent(affiliateToken)}` : '/'}
              tabIndex={0}
              onBlockedClick={() => {
                if (agreedToTerms) return false;
                blockOnTerms();
                return true;
              }}
            />
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-surface-200" />
            <span className="text-xs text-surface-400 uppercase tracking-wider">or</span>
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
                  <input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} className={inputCls} placeholder="https://..." autoComplete="url" tabIndex={4} />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-[13px] font-medium text-surface-600 mb-1.5">
                Billing country <span className="text-surface-400 font-normal text-[11px]">(sets your currency)</span>
              </label>
              <div className="relative group">
                <MapPin size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                <select
                  value={billingCountry}
                  onChange={(e) => setBillingCountry(e.target.value)}
                  className={cn(inputCls, 'appearance-none cursor-pointer')}
                  tabIndex={5}
                >
                  <option value="" className="bg-white text-surface-900">Detect automatically</option>
                  {COUNTRY_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value} className="bg-white text-surface-900">
                      {c.label}
                    </option>
                  ))}
                </select>
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
                    'focus:ring-2 focus:ring-primary-500/20',
                    confirmPassword
                      ? passwordsMatch
                        ? 'border-emerald-500 focus:border-emerald-500'
                        : 'border-rose-400 focus:border-rose-500'
                      : 'border-surface-200 focus:border-primary-500'
                  )}
                  placeholder="Re-enter your password" autoComplete="new-password" tabIndex={7}
                />
              </div>
              {confirmPassword && !passwordsMatch && (
                <p className="text-xs text-rose-600 mt-1">Passwords do not match</p>
              )}
            </div>

            <label className="flex items-start gap-2.5 pt-1 cursor-pointer group">
              <div className="relative flex items-center justify-center mt-0.5 flex-shrink-0">
                <input
                  ref={termsCheckboxRef}
                  type="checkbox"
                  checked={agreedToTerms}
                  onChange={(e) => {
                    setAgreedToTerms(e.target.checked);
                    if (e.target.checked) {
                      setTermsHighlight(false);
                      setError('');
                    }
                  }}
                  className={cn(
                    'peer appearance-none w-4 h-4 border rounded bg-white',
                    'checked:bg-primary-600 checked:border-primary-600 focus:outline-none focus:ring-2 transition-all cursor-pointer',
                    termsHighlight
                      ? 'border-rose-500 ring-2 ring-rose-500/40'
                      : 'border-surface-300 focus:ring-primary-500/25'
                  )}
                  tabIndex={8}
                />
                <svg className="absolute w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className={cn('text-xs leading-relaxed', termsHighlight ? 'text-rose-600' : 'text-surface-500')}>
                {termsHighlight && <span className="font-semibold">Terms required — </span>}
                I agree to the{' '}
                <a
                  href="https://oyechats.com/legal/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                  className="text-primary-600 hover:text-primary-700"
                >
                  Terms
                </a>{' '}
                and{' '}
                <a
                  href="https://oyechats.com/legal/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                  className="text-primary-600 hover:text-primary-700"
                >
                  Privacy Policy
                </a>.
              </span>
            </label>

            <button
              type="submit" disabled={isLoading || !agreedToTerms}
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
