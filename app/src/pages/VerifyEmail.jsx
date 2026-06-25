import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Sparkles, Loader2, ArrowRight, RotateCcw, Mail } from 'lucide-react';
import { motion } from 'framer-motion';
import { verifyEmail, resendVerification } from '../services/api';
import { cn } from '../lib/utils';
import { getAuthItem, setAuthItem, removeAuthItem, clearAuthStorage } from '../utils/authStorage';

const RESEND_COOLDOWN = 30;
const OTP_LENGTH = 6;

export default function VerifyEmail() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const emailFromUrl = searchParams.get('email') || '';
  const email = emailFromUrl || getAuthItem('admin_pending_email') || '';

  const [otp, setOtp] = useState(Array(OTP_LENGTH).fill(''));
  const [error, setError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendSuccess, setResendSuccess] = useState(false);
  const inputRefs = useRef([]);

  useEffect(() => {
    if (!getAuthItem('admin_token')) {
      navigate('/login', { replace: true });
      return;
    }
    if (getAuthItem('admin_is_verified') === 'true') {
      navigate('/', { replace: true });
      return;
    }
    inputRefs.current[0]?.focus();
  }, [navigate]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const handleOtpChange = (index, value) => {
    // Accept only digits
    const digit = value.replace(/\D/g, '').slice(-1);
    const next = [...otp];
    next[index] = digit;
    setOtp(next);
    setError('');

    // Auto-advance to next box
    if (digit && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all filled
    if (digit && index === OTP_LENGTH - 1 && next.every(Boolean)) {
      handleVerify(next.join(''));
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace') {
      if (otp[index]) {
        const next = [...otp];
        next[index] = '';
        setOtp(next);
      } else if (index > 0) {
        inputRefs.current[index - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    const next = Array(OTP_LENGTH).fill('');
    pasted.split('').forEach((char, i) => { next[i] = char; });
    setOtp(next);
    const focusIndex = Math.min(pasted.length, OTP_LENGTH - 1);
    inputRefs.current[focusIndex]?.focus();
    if (pasted.length === OTP_LENGTH) {
      handleVerify(pasted);
    }
  };

  const handleVerify = async (code) => {
    if (!code || code.length < OTP_LENGTH) {
      setError('Please enter the full 6-digit code.');
      return;
    }
    if (!email) {
      setError('Email address missing. Please go back and log in again.');
      return;
    }
    setIsVerifying(true);
    setError('');
    try {
      await verifyEmail(email, code);
      setAuthItem('admin_is_verified', 'true');
      removeAuthItem('admin_pending_email');

      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || 'Invalid code. Please try again.');
      setOtp(Array(OTP_LENGTH).fill(''));
      inputRefs.current[0]?.focus();
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || isResending) return;
    if (!email) {
      setError('Email address missing. Please go back and log in again.');
      return;
    }
    setIsResending(true);
    setResendSuccess(false);
    setError('');
    try {
      await resendVerification(email);
      setResendCooldown(RESEND_COOLDOWN);
      setResendSuccess(true);
      setOtp(Array(OTP_LENGTH).fill(''));
      inputRefs.current[0]?.focus();
    } catch (err) {
      setError(err.message || 'Failed to resend. Please try again.');
    } finally {
      setIsResending(false);
    }
  };

  const maskedEmail = email
    ? email.replace(/^(.{2}).*(@.*)$/, (_, a, b) => `${a}***${b}`)
    : 'your email';

  return (
    <div className="min-h-screen flex bg-[#030D1F]">
      {/* Left panel — branding */}
      <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden">
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.18) 0%, rgba(37,99,235,0.08) 40%, transparent 70%)', filter: 'blur(40px)' }} />
        <div className="absolute top-20 -left-20 w-96 h-96 bg-blue-600/15 rounded-full blur-[100px] animate-[float_8s_ease-in-out_infinite]" />
        <div className="absolute bottom-20 right-10 w-80 h-80 bg-blue-400/10 rounded-full blur-[80px] animate-[float_6s_ease-in-out_infinite_reverse]" />

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

        <div className="relative z-10 my-auto">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="w-20 h-20 rounded-2xl bg-blue-500/15 border border-blue-400/20 flex items-center justify-center mb-8"
          >
            <Mail size={36} className="text-blue-400" />
          </motion.div>
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15 }}
            className="text-4xl xl:text-5xl font-bold text-white leading-[1.15] mb-4"
          >
            One step
            <br />
            <span className="bg-gradient-to-r from-blue-400 via-blue-300 to-cyan-400 bg-clip-text text-transparent">
              to go
            </span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-white/45 text-lg max-w-md leading-relaxed"
          >
            Verify your email to unlock your OyeChats dashboard and start building AI chatbots.
          </motion.p>
        </div>

        <div className="relative z-10" />
      </div>

      {/* Right panel — form */}
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

          {/* Icon */}
          <div className="w-14 h-14 rounded-2xl bg-blue-500/15 border border-blue-400/20 flex items-center justify-center mb-6">
            <Mail size={26} className="text-blue-400" />
          </div>

          <div className="mb-8">
            <h1 className="text-2xl font-bold text-white tracking-tight">Check your email</h1>
            <p className="text-white/45 mt-2 text-sm leading-relaxed">
              We sent a 6-digit code to{' '}
              <span className="text-white/70 font-medium">{maskedEmail}</span>.
              Enter it below to verify your account.
            </p>
          </div>

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              role="alert"
              className="mb-5 p-3.5 bg-rose-500/10 text-rose-400 rounded-xl text-sm font-medium border border-rose-500/20"
            >
              {error}
            </motion.div>
          )}

          {resendSuccess && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-5 p-3.5 bg-emerald-500/10 text-emerald-400 rounded-xl text-sm font-medium border border-emerald-500/20"
            >
              New code sent — check your inbox.
            </motion.div>
          )}

          {/* OTP input boxes */}
          <div className="flex gap-3 mb-6" onPaste={handlePaste}>
            {otp.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleOtpChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                className={cn(
                  'w-full aspect-square text-center text-xl font-bold rounded-xl border bg-white/[.04] text-white',
                  'outline-none transition-all',
                  digit
                    ? 'border-blue-500/60 ring-2 ring-blue-500/20'
                    : 'border-white/[.08] focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20',
                )}
                disabled={isVerifying}
                aria-label={`Digit ${i + 1}`}
              />
            ))}
          </div>

          <button
            onClick={() => handleVerify(otp.join(''))}
            disabled={isVerifying || otp.some((d) => !d)}
            className={cn(
              'w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl',
              'shadow-lg shadow-blue-500/30 transition-all active:scale-[0.98]',
              'flex justify-center items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm mb-4',
            )}
          >
            {isVerifying ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <>
                Verify email
                <ArrowRight size={15} />
              </>
            )}
          </button>

          <button
            onClick={handleResend}
            disabled={resendCooldown > 0 || isResending}
            className="w-full flex items-center justify-center gap-2 py-2.5 text-sm text-white/50 hover:text-white/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isResending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RotateCcw size={14} />
            )}
            {resendCooldown > 0
              ? `Resend code in ${resendCooldown}s`
              : isResending
              ? 'Sending…'
              : 'Resend code'}
          </button>

          <p className="text-center text-xs text-white/25 mt-6">
            Wrong account?{' '}
            <button
              onClick={() => {
                // Only wipe auth keys (not unrelated app state) so a
                // session-only login is fully cleared from both stores.
                clearAuthStorage();
                navigate('/login');
              }}
              className="text-blue-400 hover:text-blue-300 transition-colors"
            >
              Sign out
            </button>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
