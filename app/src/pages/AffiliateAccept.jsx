import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
    Sparkles, Loader2, Eye, EyeOff, CheckCircle2, Mail, Lock, User,
    Building2, Globe, ArrowRight, AlertCircle, Gift,
} from 'lucide-react';
import { acceptAffiliateInvite, lookupAffiliateInvite } from '../services/api';
import { cn } from '../lib/utils';

/**
 * Magic-link landing page for affiliate invites.
 *
 * Flow:
 *  1. Read ``?token=`` from the URL.
 *  2. GET /affiliate-invites/lookup → returns email + expires_at, OR
 *     surfaces a typed error (not-found / expired / used).
 *  3. Render a slim signup form with email pre-filled (read-only).
 *  4. POST /affiliate-invites/accept → backend creates Client + Affiliate
 *     atomically, returns an access_token shaped like /auth/register.
 *  5. Store credentials in localStorage and redirect to /affiliate.
 *
 * Already-authenticated users get redirected to /affiliate immediately —
 * a logged-in customer shouldn't see the onboarding form. If they were
 * supposed to be enrolled, the super admin should have used the
 * existing-customer invite path (which triggers the welcome email, not
 * a magic link).
 */
export default function AffiliateAccept() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const token = searchParams.get('token') || '';

    const [invite, setInvite] = useState(null);
    const [lookupError, setLookupError] = useState(null);
    const [isLookingUp, setIsLookingUp] = useState(true);

    const [name, setName] = useState('');
    const [companyName, setCompanyName] = useState('');
    const [website, setWebsite] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [isAccepting, setIsAccepting] = useState(false);

    const hasMinLength = password.length >= 8;
    const hasLetter = /[A-Za-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const passwordsMatch = password && confirmPassword && password === confirmPassword;
    const strengthScore = [hasMinLength, hasLetter, hasNumber].filter(Boolean).length;
    const strengthColor =
        strengthScore === 3 ? 'bg-emerald-500'
        : strengthScore === 2 ? 'bg-amber-500'
        : strengthScore === 1 ? 'bg-rose-500'
        : 'bg-white/10';

    useEffect(() => {
        if (!token) {
            setLookupError({ message: 'No invite token in the URL.', status: 400 });
            setIsLookingUp(false);
            return;
        }
        let cancelled = false;
        lookupAffiliateInvite(token)
            .then((data) => { if (!cancelled) setInvite(data); })
            .catch((err) => { if (!cancelled) setLookupError(err); })
            .finally(() => { if (!cancelled) setIsLookingUp(false); });
        return () => { cancelled = true; };
    }, [token]);

    // If already logged in, bounce to the affiliate dashboard. The user
    // arrived here via a stale tab or someone else's link.
    if (localStorage.getItem('admin_token')) {
        return <Navigate to="/affiliate" replace />;
    }

    const handleAccept = async (e) => {
        e.preventDefault();
        setError('');
        if (!name.trim() || !password || !confirmPassword) {
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
            setIsAccepting(true);
            const data = await acceptAffiliateInvite({
                token,
                name: name.trim(),
                password,
                companyName: companyName.trim() || null,
                website: website.trim() || null,
            });
            // Same login persistence as /auth/register, plus is_affiliate flag.
            localStorage.setItem('admin_token', data.access_token);
            localStorage.setItem('admin_name', data.name);
            localStorage.setItem('admin_client_id', data.client_id.toString());
            localStorage.setItem('auth_type', 'client');
            localStorage.setItem('is_superadmin', 'false');
            sessionStorage.setItem('login_toast', 'registered');
            navigate('/affiliate');
        } catch (err) {
            setError(err.message || 'Could not accept the invite.');
        } finally {
            setIsAccepting(false);
        }
    };

    const inputCls =
        'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white/[.04] text-white border-white/[.08] '
        + 'focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500/60 outline-none transition-all '
        + 'text-sm placeholder:text-white/25';

    return (
        <div className="min-h-screen flex bg-[#030D1F]">
            {/* Left Panel — Branding (same shape as Register.jsx for visual continuity) */}
            <div className="hidden lg:flex lg:w-[48%] relative flex-col justify-between p-12 overflow-hidden auth-dark-panel">
                <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none" style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.18) 0%, rgba(37,99,235,0.08) 40%, transparent 70%)', filter: 'blur(40px)' }} />

                <div className="relative z-10 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-600/80 backdrop-blur-md border border-blue-400/30 flex items-center justify-center shadow-lg shadow-blue-500/30">
                        <Sparkles size={20} className="text-white" />
                    </div>
                    <span className="text-xl font-bold text-white tracking-tight">OyeChats</span>
                </div>

                <div className="relative z-10 my-auto max-w-md">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/15 border border-blue-400/25 text-blue-300 text-[11px] font-bold uppercase tracking-wider mb-4">
                        <Gift size={11} /> Affiliate invite
                    </div>
                    <h2 className="text-4xl xl:text-5xl font-bold text-white leading-[1.15] mb-4">
                        Welcome to the
                        <br />
                        <span className="bg-gradient-to-r from-blue-400 via-blue-300 to-cyan-400 bg-clip-text text-transparent">
                            referral program
                        </span>
                    </h2>
                    <p className="text-white/45 text-lg max-w-md leading-relaxed">
                        Set up your account, create referral codes, and track every signup
                        they bring in — from a single dashboard.
                    </p>
                </div>
            </div>

            {/* Right Panel */}
            <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-[#030D1F] overflow-y-auto">
                <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                    className="w-full max-w-[400px] my-auto"
                >
                    <div className="flex items-center gap-3 mb-8 lg:hidden">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-blue-400 text-white flex items-center justify-center shadow-lg shadow-blue-500/30">
                            <Sparkles size={18} />
                        </div>
                        <span className="text-lg font-bold text-white">OyeChats</span>
                    </div>

                    {/* Lookup states */}
                    {isLookingUp ? (
                        <div className="flex flex-col items-center justify-center py-16">
                            <Loader2 size={32} className="animate-spin text-blue-400" />
                            <p className="text-white/45 text-sm mt-3">Validating invite…</p>
                        </div>
                    ) : lookupError ? (
                        <div>
                            <div className="mb-4 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
                                <div className="flex items-start gap-2.5">
                                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-sm font-medium">
                                            {lookupError.status === 410
                                                ? 'This invite has expired or already been used'
                                                : 'Invite link is invalid'}
                                        </p>
                                        <p className="text-[12px] mt-1 text-rose-300/80">{lookupError.message}</p>
                                    </div>
                                </div>
                            </div>
                            <p className="text-sm text-white/45 text-center">
                                Already have an account?{' '}
                                <Link to="/login" className="font-semibold text-blue-400 hover:text-blue-300">Sign in</Link>
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="mb-6">
                                <h1 className="text-2xl font-bold text-white tracking-tight">Set up your account</h1>
                                <p className="text-white/45 mt-2 text-sm">Almost there — pick a password and you&apos;re in.</p>
                            </div>

                            {/* Pre-filled (read-only) email + expiry chip */}
                            <div className="mb-4 p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-300">
                                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-blue-300/80">
                                    <Mail size={12} /> Invite for
                                </div>
                                <p className="text-sm font-mono font-semibold text-blue-200 mt-1 truncate">{invite.email}</p>
                                {invite.expires_at && (
                                    <p className="text-[11px] text-blue-300/60 mt-1">
                                        Expires {new Date(invite.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                    </p>
                                )}
                            </div>

                            {error && (
                                <motion.div
                                    initial={{ opacity: 0, y: -8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    role="alert"
                                    className="mb-4 p-3.5 bg-rose-500/10 text-rose-400 rounded-xl text-sm font-medium border border-rose-500/20"
                                >
                                    {error}
                                </motion.div>
                            )}

                            <form onSubmit={handleAccept} className="space-y-3.5">
                                <div>
                                    <label className="block text-[13px] font-medium text-white/70 mb-1.5">Full name</label>
                                    <div className="relative group">
                                        <User size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-blue-400 transition-colors" />
                                        <input
                                            type="text"
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                            className={inputCls}
                                            placeholder="John Doe"
                                            autoComplete="name"
                                            tabIndex={1}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-[13px] font-medium text-white/70 mb-1.5">
                                            Company <span className="text-white/30 font-normal text-[11px]">(optional)</span>
                                        </label>
                                        <div className="relative group">
                                            <Building2 size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-blue-400 transition-colors" />
                                            <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className={inputCls} placeholder="Acme Inc." autoComplete="organization" tabIndex={2} />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-[13px] font-medium text-white/70 mb-1.5">
                                            Website <span className="text-white/30 font-normal text-[11px]">(optional)</span>
                                        </label>
                                        <div className="relative group">
                                            <Globe size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-blue-400 transition-colors" />
                                            <input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} className={inputCls} placeholder="https://..." autoComplete="url" tabIndex={3} />
                                        </div>
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-[13px] font-medium text-white/70 mb-1.5">Password</label>
                                    <div className="relative group">
                                        <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-blue-400 transition-colors" />
                                        <input
                                            type={showPassword ? 'text' : 'password'} value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            className={cn(inputCls, 'pr-11')}
                                            placeholder="Create a strong password" autoComplete="new-password" tabIndex={4}
                                        />
                                        <button
                                            type="button" onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors"
                                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                                        >
                                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                        </button>
                                    </div>
                                    {password.length > 0 && (
                                        <div className="mt-2 space-y-2">
                                            <div className="flex gap-1">
                                                {[1, 2, 3].map((i) => (
                                                    <div key={i} className={cn('h-1 flex-1 rounded-full transition-all duration-300', i <= strengthScore ? strengthColor : 'bg-white/10')} />
                                                ))}
                                            </div>
                                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                                                {[
                                                    { met: hasMinLength, label: '8+ characters' },
                                                    { met: hasLetter, label: 'Has letter' },
                                                    { met: hasNumber, label: 'Has number' },
                                                ].map((check) => (
                                                    <div key={check.label} className={cn('flex items-center gap-1.5 text-xs transition-colors', check.met ? 'text-emerald-400' : 'text-white/35')}>
                                                        <CheckCircle2 size={12} className={check.met ? 'text-emerald-400' : 'text-white/25'} />
                                                        {check.label}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div>
                                    <label className="block text-[13px] font-medium text-white/70 mb-1.5">Confirm password</label>
                                    <div className="relative group">
                                        <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-blue-400 transition-colors" />
                                        <input
                                            type={showPassword ? 'text' : 'password'} value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            className={cn(
                                                'w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white/[.04] text-white outline-none transition-all text-sm placeholder:text-white/25 focus:ring-2 focus:ring-blue-500/25',
                                                confirmPassword
                                                    ? passwordsMatch
                                                        ? 'border-emerald-500/60 focus:border-emerald-500'
                                                        : 'border-rose-500/60 focus:border-rose-500'
                                                    : 'border-white/[.08] focus:border-blue-500/60',
                                            )}
                                            placeholder="Re-enter your password" autoComplete="new-password" tabIndex={5}
                                        />
                                    </div>
                                    {confirmPassword && !passwordsMatch && (
                                        <p className="text-xs text-rose-400 mt-1">Passwords do not match</p>
                                    )}
                                </div>

                                <button
                                    type="submit"
                                    disabled={isAccepting}
                                    className={cn(
                                        'w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl',
                                        'shadow-lg shadow-blue-500/30 transition-all active:scale-[0.98]',
                                        'flex justify-center items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed text-sm',
                                    )}
                                    tabIndex={6}
                                >
                                    {isAccepting ? (
                                        <Loader2 size={18} className="animate-spin" />
                                    ) : (
                                        <>Accept invite & open dashboard <ArrowRight size={15} /></>
                                    )}
                                </button>
                            </form>

                            <p className="text-center text-sm text-white/40 mt-6">
                                Already have an account?{' '}
                                <Link to="/login" tabIndex={7} className="font-semibold text-blue-400 hover:text-blue-300 transition-colors">
                                    Sign in
                                </Link>
                            </p>
                        </>
                    )}
                </motion.div>
            </div>
        </div>
    );
}
