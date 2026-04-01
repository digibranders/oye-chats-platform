import { useState } from 'react';
import { Navigate, useNavigate, Link } from 'react-router-dom';
import { Bot, Loader2, Mail, Lock, Zap, BookOpen, BarChart3, Eye, EyeOff } from 'lucide-react';
import { loginAdmin, loginOperator } from '../services/api';

export default function Login() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
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

            // Try operator login first, then fall back to admin login.
            // This auto-detects account type by email — no toggle needed.
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
                // Operators join an existing workspace — the onboarding wizard is for workspace owners only.
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
                    <span className="text-xl font-bold tracking-tight">OyeChats</span>
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
            <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-white">
                <div className="w-full max-w-md">
                    {/* Mobile logo */}
                    <div className="flex items-center gap-3 mb-10 lg:hidden">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center shadow-lg shadow-primary-500/20">
                            <Bot size={20} />
                        </div>
                        <span className="text-lg font-bold text-secondary-900">OyeChats</span>
                    </div>

                    <div className="mb-8">
                        <h1 className="text-2xl font-bold text-secondary-900">Welcome back</h1>
                        <p className="text-secondary-500 mt-2 text-sm">
                            Sign in to your OyeChats account
                        </p>
                    </div>

                    {error && (
                        <div className="mb-5 p-3 bg-error-50 text-error-600 rounded-xl text-sm font-medium border border-error-500/20">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-secondary-700 mb-1.5">
                                Email address
                            </label>
                            <div className="relative">
                                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary-400" />
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm"
                                    placeholder="you@company.com"
                                    tabIndex={1}
                                />
                            </div>
                        </div>

                        <div>
                            <div className="flex justify-between items-center mb-1.5">
                                <label className="block text-sm font-medium text-secondary-700">
                                    Password
                                </label>
                                <Link to="/forgot-password" tabIndex={5} className="text-xs font-medium text-primary-600 hover:underline">
                                    Forgot password?
                                </Link>
                            </div>
                            <div className="relative">
                                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary-400" />
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full pl-10 pr-11 py-2.5 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm"
                                    placeholder="Enter your password"
                                    tabIndex={2}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-secondary-400 hover:text-secondary-600:text-secondary-300 transition-colors"
                                    tabIndex={-1}
                                >
                                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                </button>
                            </div>
                        </div>

                        <label className="flex items-center gap-2.5 cursor-pointer group">
                            <div className="relative flex items-center justify-center">
                                <input
                                    type="checkbox"
                                    className="peer appearance-none w-4 h-4 border border-secondary-300 rounded bg-white checked:bg-primary-600 checked:border-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-500/20 transition-all cursor-pointer"
                                    tabIndex={3}
                                />
                                <svg className="absolute w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                            <span className="text-sm text-secondary-600">Remember for 30 days</span>
                        </label>

                        <button
                            type="submit"
                            disabled={isLoading}
                            className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-xl shadow-lg shadow-primary-500/20 transition-all active:scale-[0.98] flex justify-center items-center disabled:opacity-70 disabled:cursor-not-allowed text-sm"
                            tabIndex={4}
                        >
                            {isLoading ? <Loader2 size={18} className="animate-spin" /> : 'Sign in'}
                        </button>
                    </form>

                    <p className="text-center text-sm text-secondary-500 mt-8">
                        Don't have an account?{' '}
                        <Link to="/register" tabIndex={6} className="font-semibold text-primary-600 hover:underline">
                            Sign up
                        </Link>
                    </p>
                </div>
            </div>
        </div>
    );
}
