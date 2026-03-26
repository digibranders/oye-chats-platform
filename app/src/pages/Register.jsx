import { useState } from 'react';
import { Navigate, useNavigate, Link } from 'react-router-dom';
import { Bot, Loader2, Eye, EyeOff, CheckCircle2, Mail, Lock, User, Zap, BookOpen, BarChart3 } from 'lucide-react';
import { registerClient } from '../services/api';

export default function Register() {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
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

    const handleRegister = async (e) => {
        e.preventDefault();
        setError('');

        if (!name.trim() || !email.trim() || !password || !confirmPassword) {
            setError('Please fill in all fields.');
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
            const data = await registerClient(name.trim(), email.trim(), password);

            localStorage.setItem('admin_token', data.access_token);
            localStorage.setItem('admin_name', data.name);
            localStorage.setItem('admin_client_id', data.client_id.toString());
            localStorage.setItem('is_superadmin', 'false');
            sessionStorage.setItem('login_toast', 'registered');

            navigate('/chatbot');
        } catch (err) {
            setError(err.toString());
        } finally {
            setIsLoading(false);
        }
    };

    if (localStorage.getItem('admin_token')) {
        const isSuper = localStorage.getItem('is_superadmin') === 'true';
        return <Navigate to={isSuper ? '/superadmin/overview' : '/'} />;
    }

    const PasswordCheck = ({ met, label }) => (
        <div className={`flex items-center gap-1.5 text-xs transition-colors ${met ? 'text-success-500' : 'text-secondary-400'}`}>
            <CheckCircle2 size={12} className={met ? 'text-success-500' : 'text-secondary-300 dark:text-secondary-600'} />
            {label}
        </div>
    );

    return (
        <div className="min-h-screen flex">
            {/* Left Panel — Branding */}
            <div className="hidden lg:flex lg:w-[45%] xl:w-[40%] relative bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-800 text-white flex-col justify-between p-10 overflow-hidden">
                {/* Decorative orbs */}
                <div className="absolute top-20 -left-20 w-80 h-80 bg-white/10 rounded-full blur-3xl" />
                <div className="absolute bottom-10 right-10 w-60 h-60 bg-primary-400/20 rounded-full blur-3xl" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl" />

                {/* Logo */}
                <div className="relative z-10 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-lg">
                        <Bot size={22} />
                    </div>
                    <span className="text-xl font-bold tracking-tight">OyeChat</span>
                </div>

                {/* Hero text */}
                <div className="relative z-10 my-auto">
                    <h2 className="text-4xl font-bold leading-tight mb-6">
                        AI chatbots that<br />
                        know your business
                    </h2>
                    <div className="space-y-4">
                        <div className="flex items-center gap-3 text-white/80">
                            <div className="w-9 h-9 rounded-lg bg-white/10 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                                <BookOpen size={18} />
                            </div>
                            <span className="text-[15px]">Train on your docs in minutes</span>
                        </div>
                        <div className="flex items-center gap-3 text-white/80">
                            <div className="w-9 h-9 rounded-lg bg-white/10 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                                <Zap size={18} />
                            </div>
                            <span className="text-[15px]">Embed anywhere with one line of code</span>
                        </div>
                        <div className="flex items-center gap-3 text-white/80">
                            <div className="w-9 h-9 rounded-lg bg-white/10 backdrop-blur-sm flex items-center justify-center flex-shrink-0">
                                <BarChart3 size={18} />
                            </div>
                            <span className="text-[15px]">Real-time analytics & insights</span>
                        </div>
                    </div>
                </div>

                {/* Social proof */}
                <div className="relative z-10">
                    <p className="text-white/50 text-sm font-medium mb-3">Trusted by growing businesses</p>
                    <div className="flex gap-4">
                        {[1, 2, 3, 4].map((i) => (
                            <div key={i} className="w-10 h-10 rounded-lg bg-white/10 backdrop-blur-sm" />
                        ))}
                    </div>
                </div>
            </div>

            {/* Right Panel — Form */}
            <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-white dark:bg-secondary-950">
                <div className="w-full max-w-md">
                    {/* Mobile logo */}
                    <div className="flex items-center gap-3 mb-8 lg:hidden">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center shadow-lg shadow-primary-500/20">
                            <Bot size={20} />
                        </div>
                        <span className="text-lg font-bold text-secondary-900 dark:text-white">OyeChat</span>
                    </div>

                    <div className="mb-6">
                        <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Get started free</h1>
                        <p className="text-secondary-500 dark:text-secondary-400 mt-2 text-sm">
                            Create your OyeChat account
                        </p>
                    </div>

                    {error && (
                        <div className="mb-4 p-3 bg-error-50 dark:bg-error-500/10 text-error-600 dark:text-error-500 rounded-xl text-sm font-medium border border-error-500/20">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleRegister} className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Full name</label>
                            <div className="relative">
                                <User size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary-400" />
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-900 text-secondary-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm"
                                    placeholder="John Doe"
                                    autoComplete="name"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Email address</label>
                            <div className="relative">
                                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary-400" />
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-900 text-secondary-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm"
                                    placeholder="you@company.com"
                                    autoComplete="email"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Password</label>
                            <div className="relative">
                                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary-400" />
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full pl-10 pr-11 py-2.5 rounded-xl border border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-900 text-secondary-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm"
                                    placeholder="Create a strong password"
                                    autoComplete="new-password"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-secondary-400 hover:text-secondary-600 dark:hover:text-secondary-300 transition-colors"
                                    tabIndex={-1}
                                >
                                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                </button>
                            </div>
                            {password.length > 0 && (
                                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                                    <PasswordCheck met={hasMinLength} label="8+ characters" />
                                    <PasswordCheck met={hasLetter} label="Has letter" />
                                    <PasswordCheck met={hasNumber} label="Has number" />
                                </div>
                            )}
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Confirm password</label>
                            <div className="relative">
                                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary-400" />
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    className={`w-full pl-10 pr-4 py-2.5 rounded-xl border bg-white dark:bg-secondary-900 text-secondary-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 outline-none transition-all text-sm ${
                                        confirmPassword
                                            ? passwordsMatch
                                                ? 'border-success-500 focus:border-success-500'
                                                : 'border-error-500 focus:border-error-500'
                                            : 'border-secondary-200 dark:border-secondary-800 focus:border-primary-500'
                                    }`}
                                    placeholder="Re-enter your password"
                                    autoComplete="new-password"
                                />
                            </div>
                            {confirmPassword && !passwordsMatch && (
                                <p className="text-xs text-error-500 mt-1">Passwords do not match</p>
                            )}
                        </div>

                        <p className="text-xs text-secondary-400 dark:text-secondary-500 text-center pt-1">
                            By creating an account, you agree to our{' '}
                            <a href="#" className="text-primary-600 dark:text-primary-400 hover:underline">Terms of Service</a>{' '}
                            and{' '}
                            <a href="#" className="text-primary-600 dark:text-primary-400 hover:underline">Privacy Policy</a>.
                        </p>

                        <button
                            type="submit"
                            disabled={isLoading}
                            className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-xl shadow-lg shadow-primary-500/20 transition-all active:scale-[0.98] flex justify-center items-center disabled:opacity-70 disabled:cursor-not-allowed text-sm"
                        >
                            {isLoading ? <Loader2 size={18} className="animate-spin" /> : 'Create Account'}
                        </button>
                    </form>

                    <p className="text-center text-sm text-secondary-500 dark:text-secondary-400 mt-6">
                        Already have an account?{' '}
                        <Link to="/login" className="font-semibold text-primary-600 dark:text-primary-400 hover:underline">
                            Sign in
                        </Link>
                    </p>
                </div>
            </div>
        </div>
    );
}
