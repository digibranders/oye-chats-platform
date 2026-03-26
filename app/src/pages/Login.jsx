import { useState } from 'react';
import { Navigate, useNavigate, Link } from 'react-router-dom';
import { Bot, Loader2 } from 'lucide-react';
import { loginAdmin } from '../services/api';

export default function Login() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
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
            const data = await loginAdmin(email, password);

            // Save token & flag for post-login toast, navigate immediately
            localStorage.setItem('admin_token', data.access_token);
            localStorage.setItem('admin_name', data.name);
            localStorage.setItem('admin_client_id', data.client_id.toString());
            localStorage.setItem('is_superadmin', data.is_superadmin ? 'true' : 'false');
            sessionStorage.setItem('login_toast', '1');
            
            if (data.is_superadmin) {
                navigate('/superadmin/overview');
            } else {
                navigate('/admin');
            }
        } catch (err) {
            setError(err.toString());
        } finally {
            setIsLoading(false);
        }
    };

    if (localStorage.getItem('admin_token')) {
        const isSuper = localStorage.getItem('is_superadmin') === 'true';
        return <Navigate to={isSuper ? "/superadmin/overview" : "/admin"} />;
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-secondary-100 dark:bg-secondary-900 transition-colors relative overflow-hidden">
            {/* Ambient Background Glow */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary-500/10 rounded-full blur-[120px] pointer-events-none z-0"></div>

            <div className="bg-white dark:bg-secondary-800 p-8 rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.1)] dark:shadow-black/60 w-full max-w-md border border-secondary-200 dark:border-secondary-700 transition-colors relative z-10">
                <div className="flex flex-col items-center mb-8">
                    <div className="w-16 h-16 bg-primary-600 dark:bg-primary-500 text-white rounded-full flex items-center justify-center mb-4 shadow-lg shadow-primary-200 dark:shadow-none">
                        <Bot size={32} />
                    </div>
                    <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Admin Access</h1>
                    <p className="text-secondary-500 dark:text-secondary-400 mt-2 text-sm">Welcome back! Please enter your details.</p>
                </div>

                {error && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm font-medium text-center border border-red-100 dark:border-red-900/30">
                        {error}
                    </div>
                )}

                <form onSubmit={handleLogin} className="space-y-5">
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300 mb-1.5">Email address</label>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-4 py-2.5 rounded-xl border border-secondary-300 dark:border-secondary-600 bg-white dark:bg-secondary-700/50 text-secondary-900 dark:text-white focus:ring-4 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all shadow-sm"
                            placeholder="you@company.com"
                        />
                    </div>
                    <div>
                        <div className="flex justify-between items-center mb-1.5">
                            <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">Password</label>
                            <a href="#" className="text-sm font-medium text-secondary-500 hover:text-primary-600 transition-colors">Forgot password?</a>
                        </div>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-4 py-2.5 rounded-xl border border-secondary-300 dark:border-secondary-600 bg-white dark:bg-secondary-700/50 text-secondary-900 dark:text-white focus:ring-4 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all shadow-sm"
                            placeholder="••••••••"
                        />
                    </div>

                    <label className="flex items-center group cursor-pointer">
                        <div className="relative flex items-center justify-center">
                            <input 
                                type="checkbox" 
                                id="remember" 
                                className="peer appearance-none w-4 h-4 border border-secondary-300 dark:border-secondary-600 rounded bg-white dark:bg-secondary-800 checked:bg-primary-500 checked:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 transition-all cursor-pointer" 
                            />
                            <svg className="absolute w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <span className="ml-2.5 block text-sm font-medium text-secondary-700 dark:text-secondary-400 group-hover:text-secondary-900 dark:group-hover:text-white transition-colors">Remember for 30 days</span>
                    </label>

                    <button
                        type="submit"
                        disabled={isLoading}
                        className="w-full py-2.5 px-4 bg-primary-600 dark:bg-primary-500 hover:bg-primary-700 dark:hover:bg-primary-600 text-white font-semibold rounded-xl shadow-lg shadow-primary-500/25 dark:shadow-none transition-all duration-200 active:scale-[0.98] active:translate-y-[1px] transform flex justify-center items-center disabled:opacity-70 disabled:cursor-not-allowed"
                    >
                        {isLoading ? <Loader2 size={20} className="animate-spin" /> : 'Sign in'}
                    </button>
                </form>

                {/* Sign up link */}
                <p className="text-center text-sm text-secondary-500 dark:text-secondary-400 mt-6">
                    Don't have an account?{' '}
                    <Link to="/register" className="font-semibold text-primary-600 dark:text-primary-400 hover:underline">
                        Sign up
                    </Link>
                </p>
            </div>
        </div>
    );
}
