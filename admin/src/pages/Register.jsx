import { useState } from 'react';
import { Navigate, useNavigate, Link } from 'react-router-dom';
import { Bot, Loader2, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
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

    // Password strength indicators
    const hasMinLength = password.length >= 8;
    const hasLetter = /[A-Za-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const passwordsMatch = password && confirmPassword && password === confirmPassword;

    const handleRegister = async (e) => {
        e.preventDefault();
        setError('');

        // Client-side validation
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

            // Auto-login after registration
            localStorage.setItem('admin_token', data.access_token);
            localStorage.setItem('admin_name', data.name);
            localStorage.setItem('admin_client_id', data.client_id.toString());
            localStorage.setItem('is_superadmin', 'false');
            sessionStorage.setItem('login_toast', 'registered');

            // Redirect to Chatbot page so user creates their first bot
            navigate('/admin/chatbot');
        } catch (err) {
            setError(err.toString());
        } finally {
            setIsLoading(false);
        }
    };

    // Redirect if already logged in
    if (localStorage.getItem('admin_token')) {
        const isSuper = localStorage.getItem('is_superadmin') === 'true';
        return <Navigate to={isSuper ? "/superadmin/overview" : "/admin"} />;
    }

    const PasswordCheck = ({ met, label }) => (
        <div className={`flex items-center gap-1.5 text-xs transition-colors ${met ? 'text-green-500' : 'text-secondary-400'}`}>
            <CheckCircle2 size={12} className={met ? 'text-green-500' : 'text-secondary-300'} />
            {label}
        </div>
    );

    return (
        <div className="min-h-screen flex items-center justify-center bg-secondary-100 dark:bg-secondary-900 transition-colors relative overflow-hidden">
            {/* Ambient Background Glow */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary-500/10 rounded-full blur-[120px] pointer-events-none z-0"></div>

            <div className="bg-white dark:bg-secondary-800 p-8 rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.1)] dark:shadow-black/60 w-full max-w-md border border-secondary-200 dark:border-secondary-700 transition-colors relative z-10">
                {/* Header */}
                <div className="flex flex-col items-center mb-6">
                    <div className="w-16 h-16 bg-primary-600 dark:bg-primary-500 text-white rounded-full flex items-center justify-center mb-4 shadow-lg shadow-primary-200 dark:shadow-none">
                        <Bot size={32} />
                    </div>
                    <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Create your account</h1>
                    <p className="text-secondary-500 dark:text-secondary-400 mt-2 text-sm text-center">
                        Get started with your AI chatbot in minutes.
                    </p>
                </div>

                {/* Error Banner */}
                {error && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm font-medium text-center border border-red-100 dark:border-red-900/30">
                        {error}
                    </div>
                )}

                <form onSubmit={handleRegister} className="space-y-4">
                    {/* Full Name */}
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Full name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full px-4 py-2.5 rounded-xl border border-secondary-300 dark:border-secondary-600 bg-white dark:bg-secondary-700/50 text-secondary-900 dark:text-white focus:ring-4 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all shadow-sm"
                            placeholder="John Doe"
                            autoComplete="name"
                        />
                    </div>

                    {/* Email */}
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Email address</label>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-4 py-2.5 rounded-xl border border-secondary-300 dark:border-secondary-600 bg-white dark:bg-secondary-700/50 text-secondary-900 dark:text-white focus:ring-4 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all shadow-sm"
                            placeholder="you@company.com"
                            autoComplete="email"
                        />
                    </div>

                    {/* Password */}
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Password</label>
                        <div className="relative">
                            <input
                                type={showPassword ? 'text' : 'password'}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full px-4 py-2.5 pr-11 rounded-xl border border-secondary-300 dark:border-secondary-600 bg-white dark:bg-secondary-700/50 text-secondary-900 dark:text-white focus:ring-4 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all shadow-sm"
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
                        {/* Password strength indicators */}
                        {password.length > 0 && (
                            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                                <PasswordCheck met={hasMinLength} label="8+ characters" />
                                <PasswordCheck met={hasLetter} label="Has letter" />
                                <PasswordCheck met={hasNumber} label="Has number" />
                            </div>
                        )}
                    </div>

                    {/* Confirm Password */}
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Confirm password</label>
                        <input
                            type={showPassword ? 'text' : 'password'}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            className={`w-full px-4 py-2.5 rounded-xl border bg-white dark:bg-secondary-700/50 text-secondary-900 dark:text-white focus:ring-4 focus:ring-primary-500/20 outline-none transition-all shadow-sm ${
                                confirmPassword
                                    ? passwordsMatch
                                        ? 'border-green-400 focus:border-green-500'
                                        : 'border-red-300 focus:border-red-500'
                                    : 'border-secondary-300 dark:border-secondary-600 focus:border-primary-500'
                            }`}
                            placeholder="Re-enter your password"
                            autoComplete="new-password"
                        />
                        {confirmPassword && !passwordsMatch && (
                            <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
                        )}
                    </div>

                    {/* Terms */}
                    <p className="text-xs text-secondary-400 dark:text-secondary-500 text-center">
                        By creating an account, you agree to our{' '}
                        <a href="#" className="text-primary-500 hover:underline">Terms of Service</a>{' '}
                        and{' '}
                        <a href="#" className="text-primary-500 hover:underline">Privacy Policy</a>.
                    </p>

                    {/* Submit */}
                    <button
                        type="submit"
                        disabled={isLoading}
                        className="w-full py-2.5 px-4 bg-primary-600 dark:bg-primary-500 hover:bg-primary-700 dark:hover:bg-primary-600 text-white font-semibold rounded-xl shadow-lg shadow-primary-500/25 dark:shadow-none transition-all duration-200 active:scale-[0.98] active:translate-y-[1px] transform flex justify-center items-center disabled:opacity-70 disabled:cursor-not-allowed"
                    >
                        {isLoading ? <Loader2 size={20} className="animate-spin" /> : 'Create Account'}
                    </button>
                </form>

                {/* Sign in link */}
                <p className="text-center text-sm text-secondary-500 dark:text-secondary-400 mt-6">
                    Already have an account?{' '}
                    <Link to="/login" className="font-semibold text-primary-600 dark:text-primary-400 hover:underline">
                        Sign in
                    </Link>
                </p>
            </div>
        </div>
    );
}
