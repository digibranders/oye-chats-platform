import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Sparkles, Loader2, Mail, Lock, KeyRound, Eye, EyeOff, ArrowLeft, ArrowRight, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { requestPasswordReset, resetPassword } from '../services/api';
import { cn } from '../lib/utils';

const stepVariants = {
  enter: { opacity: 0, x: 20 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
};

export default function ForgotPassword() {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const navigate = useNavigate();

  const handleRequestReset = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!email) {
      setError('Please enter your email address.');
      return;
    }

    try {
      setIsLoading(true);
      const data = await requestPasswordReset(email);
      setSuccess(data.message || 'If an account exists, a reset link has been sent.');
      setStep(2);
    } catch (err) {
      setError(err.message || 'Failed to send reset code.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!otp || !newPassword) {
      setError('Please enter the reset code and your new password.');
      return;
    }
    if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setError('Password must be at least 8 characters and include a letter and a number.');
      return;
    }

    try {
      setIsLoading(true);
      const data = await resetPassword(email, otp, newPassword);
      setSuccess(data.message || 'Password successfully reset.');
      setStep(3);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err.message || 'Failed to reset password.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-surface-50">
      {/* Left Panel */}
      <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden bg-gradient-to-br from-[#17121f] via-[#14101e] to-[#0f0b15] text-white">
        {/* Grid pattern like website hero */}
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {/* Radial glow like website hero */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(162,28,175,0.18) 0%, rgba(162,28,175,0.08) 40%, transparent 70%)', filter: 'blur(40px)' }} />

        <div className="absolute top-20 -left-20 w-96 h-96 bg-primary-600/15 rounded-full blur-[100px] animate-[float_8s_ease-in-out_infinite]" />
        <div className="absolute bottom-20 right-10 w-80 h-80 bg-primary-400/10 rounded-full blur-[80px] animate-[float_6s_ease-in-out_infinite_reverse]" />

        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative z-10 flex items-center"
        >
          {/* White wordmark for the dark branding panel, the same asset Login
              and Register use. This page kept the older icon-plus-text lockup
              on an identical panel, so a customer resetting their password saw
              a different brand from the one they had just signed in against. */}
          <img src="/new_white.png" alt="OyeChats" className="h-9 w-auto object-contain" />
        </motion.div>

        <div className="relative z-10 my-auto max-w-sm">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-4xl xl:text-5xl font-bold text-white leading-[1.15] mb-4"
          >
            Get back to
            <br />
            <span className="bg-gradient-to-r from-primary-400 via-primary-300 to-primary-200 bg-clip-text text-transparent">
              building
            </span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-white/45 text-lg leading-relaxed"
          >
            Don&apos;t let a forgotten password slow you down. Reclaim your access and continue engaging with your customers.
          </motion.p>
        </div>

        <div className="relative z-10" />
      </div>

      {/* Right Panel */}
      <div className="flex-1 flex flex-col justify-center px-6 py-12 lg:px-16 xl:px-24 bg-surface-50 relative">
        <div className="w-full max-w-md mx-auto relative z-10">
          {/* Mobile Logo */}
          <div className="lg:hidden flex items-center gap-3 mb-10 justify-center">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center shadow-lg shadow-primary-500/20">
              <Sparkles size={20} />
            </div>
            <span className="text-xl font-bold text-surface-900 tracking-tight">OyeChats</span>
          </div>

          <div className="bg-white p-8 sm:p-10 rounded-2xl shadow-sm border border-surface-200">
            {/* Step indicator */}
            <div className="flex items-center gap-2 mb-6">
              {[1, 2, 3].map((s) => (
                <div
                  key={s}
                  className={cn(
                    'h-1 flex-1 rounded-full transition-all duration-500',
                    s <= step ? 'bg-primary-500' : 'bg-surface-200'
                  )}
                />
              ))}
            </div>

            <div className="mb-6">
              <Link
                to="/login"
                className="inline-flex items-center text-sm font-medium text-surface-500 hover:text-surface-700 mb-4 transition-colors"
              >
                <ArrowLeft className="w-4 h-4 mr-1.5" /> Back to login
              </Link>
              <h2 className="text-2xl font-bold text-surface-900 tracking-tight mb-1">
                {step === 1 ? 'Reset password' : step === 2 ? 'Enter recovery code' : 'All set!'}
              </h2>
              <p className="text-sm text-surface-500">
                {step === 1 && "Enter your email and we'll send you a recovery code."}
                {step === 2 && 'Enter the code sent to your email and choose a new password.'}
                {step === 3 && 'Your password has been successfully reset.'}
              </p>
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                role="alert"
                className="mb-5 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-600 font-medium"
              >
                {error}
              </motion.div>
            )}
            {success && step !== 3 && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                role="alert"
                className="mb-5 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-600 font-medium"
              >
                {success}
              </motion.div>
            )}

            <AnimatePresence mode="wait">
              {step === 1 && (
                <motion.form
                  key="step1"
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.2 }}
                  onSubmit={handleRequestReset}
                  className="space-y-5"
                >
                  <div>
                    <label className="block text-[13px] font-medium text-surface-600 mb-1.5">
                      Email Address
                    </label>
                    <div className="relative group">
                      <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                      <input
                        type="email" required tabIndex={1}
                        className={cn(
                          'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white text-surface-900',
                          'border-surface-200 focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)]',
                          'outline-none transition-all text-sm placeholder:text-surface-400'
                        )}
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>
                  </div>
                  <button
                    type="submit" disabled={isLoading} tabIndex={2}
                    className={cn(
                      'w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-xl',
                      'shadow-lg shadow-primary-500/25 transition-all active:scale-[0.98]',
                      'flex justify-center items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm'
                    )}
                  >
                    {isLoading ? <><Loader2 size={16} className="animate-spin" /> Sending...</> : <>Send recovery code <ArrowRight size={15} /></>}
                  </button>
                </motion.form>
              )}

              {step === 2 && (
                <motion.form
                  key="step2"
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.2 }}
                  onSubmit={handleResetPassword}
                  className="space-y-5"
                >
                  <div>
                    <label className="block text-[13px] font-medium text-surface-600 mb-1.5">
                      Recovery Code
                    </label>
                    <div className="relative group">
                      <KeyRound size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                      <input
                        type="text" required tabIndex={1}
                        className={cn(
                          'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white text-surface-900',
                          'border-surface-200 focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)]',
                          'outline-none transition-all text-sm placeholder:text-surface-400 font-mono tracking-widest'
                        )}
                        placeholder="000000"
                        value={otp}
                        onChange={(e) => setOtp(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleRequestReset}
                      disabled={isLoading}
                      className="mt-1.5 text-xs font-medium text-primary-600 hover:text-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Didn&apos;t receive a code? Resend
                    </button>
                  </div>

                  <div>
                    <label className="block text-[13px] font-medium text-surface-600 mb-1.5">
                      New Password
                    </label>
                    <div className="relative group">
                      <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 group-focus-within:text-primary-500 transition-colors" />
                      <input
                        type={showPassword ? 'text' : 'password'} required tabIndex={2}
                        className={cn(
                          'w-full pl-10 pr-11 py-2.5 rounded-xl border bg-white text-surface-900',
                          'border-surface-200 focus:ring-1 focus:ring-[var(--focus-ring)] focus:border-[var(--focus)]',
                          'outline-none transition-all text-sm placeholder:text-surface-400'
                        )}
                        placeholder="New password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                      />
                      <button
                        type="button" tabIndex={-1}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 transition-colors"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit" disabled={isLoading} tabIndex={3}
                    className={cn(
                      'w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-xl',
                      'shadow-lg shadow-primary-500/25 transition-all active:scale-[0.98]',
                      'flex justify-center items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm'
                    )}
                  >
                    {isLoading ? <><Loader2 size={16} className="animate-spin" /> Updating...</> : <>Reset Password <ArrowRight size={15} /></>}
                  </button>
                </motion.form>
              )}

              {step === 3 && (
                <motion.div
                  key="step3"
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  className="text-center py-6"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                    className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4"
                  >
                    <CheckCircle2 size={32} className="text-emerald-600" />
                  </motion.div>
                  <h3 className="text-lg font-bold text-surface-900 mb-1">Password Reset!</h3>
                  <p className="text-sm text-surface-500">Redirecting you to login...</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
