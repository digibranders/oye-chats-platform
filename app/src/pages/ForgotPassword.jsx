import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Bot, Loader2, Mail, Lock, KeyRound, Eye, EyeOff, ArrowLeft } from 'lucide-react';
import { requestPasswordReset, resetPassword } from '../services/api';

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
            setError(err.toString());
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

        try {
            setIsLoading(true);
            const data = await resetPassword(email, otp, newPassword);
            setSuccess(data.message || 'Password successfully reset.');
            setTimeout(() => navigate('/login'), 2000);
        } catch (err) {
            setError(err.toString());
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex">
            {/* Left Panel — Branding (Hidden on Mobile) */}
            <div className="hidden lg:flex lg:w-[45%] xl:w-[40%] relative bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-800 text-white flex-col justify-between p-10 overflow-hidden">
                {/* Decorative orbs */}
                <div className="absolute top-20 -left-20 w-80 h-80 bg-white/10 rounded-full blur-3xl" />
                <div className="absolute bottom-10 right-10 w-60 h-60 bg-primary-400/20 rounded-full blur-3xl" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl" />

                <div className="relative z-10 flex items-center gap-3">
                    <div className="w-12 h-12 bg-white/10 backdrop-blur-md rounded-xl flex items-center justify-center border border-white/20 shadow-lg">
                        <Bot className="w-6 h-6 text-white" />
                    </div>
                    <h1 className="text-3xl font-extrabold tracking-tight">OyeChat</h1>
                </div>

                <div className="relative z-10 max-w-sm">
                    <h2 className="text-4xl font-bold mb-4 leading-tight">Get back to<br /><span className="text-blue-200">building your audience.</span></h2>
                    <p className="text-lg text-blue-100/90 leading-relaxed font-light">
                        Don't let a forgotten password slow you down. Reclaim your access and continue engaging with your customers securely.
                    </p>
                </div>
            </div>

            {/* Right Panel — Reset Form */}
            <div className="flex-1 flex flex-col justify-center px-6 py-12 lg:px-16 xl:px-24 bg-gray-50 relative">
                <div className="w-full max-w-md mx-auto relative z-10">
                    {/* Mobile Logo */}
                    <div className="lg:hidden flex items-center gap-3 mb-10 justify-center">
                        <div className="w-10 h-10 bg-primary-600 rounded-xl flex items-center justify-center shadow-md">
                            <Bot className="w-5 h-5 text-white" />
                        </div>
                        <h1 className="text-2xl font-extrabold text-gray-900 tracking-tight">OyeChat</h1>
                    </div>

                    <div className="bg-white p-8 sm:p-10 rounded-2xl shadow-xl border border-gray-100">
                        <div className="mb-8">
                            <Link to="/login" className="inline-flex items-center text-sm font-medium text-gray-500 hover:text-gray-700:text-gray-300 mb-6 transition-colors">
                                <ArrowLeft className="w-4 h-4 mr-2" /> Back to login
                            </Link>
                            <h2 className="text-3xl font-bold text-gray-900 tracking-tight mb-2">
                                {step === 1 ? 'Reset password' : 'Set new password'}
                            </h2>
                            <p className="text-sm text-gray-500">
                                {step === 1 
                                    ? "Enter your email address and we'll send you a recovery code." 
                                    : "Enter the code sent to your email and your new password."}
                            </p>
                        </div>

                        {error && (
                            <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-600 shadow-sm animate-in slide-in-from-top-2">
                                {error}
                            </div>
                        )}
                        {success && (
                            <div className="mb-6 p-4 rounded-xl bg-green-50 border border-green-200 text-sm text-green-600 shadow-sm animate-in slide-in-from-top-2">
                                {success}
                            </div>
                        )}

                        {step === 1 ? (
                            <form onSubmit={handleRequestReset} className="space-y-6">
                                <div className="space-y-1.5 focus-within:text-primary-600">
                                    <label htmlFor="email" className="block text-sm font-semibold text-gray-700">
                                        Email Address
                                    </label>
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 group-focus-within:text-primary-500 transition-colors">
                                            <Mail className="h-5 w-5" />
                                        </div>
                                        <input
                                            id="email"
                                            name="email"
                                            type="email"
                                            required
                                            tabIndex={1}
                                            className="block w-full pl-11 pr-3 py-3 border border-gray-300 bg-white rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow sm:text-sm text-gray-900 placeholder-gray-400 font-medium"
                                            placeholder="you@company.com"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                        />
                                    </div>
                                </div>
                                <button
                                    type="submit"
                                    disabled={isLoading}
                                    tabIndex={2}
                                    className="w-full flex justify-center items-center py-3.5 px-4 border border-transparent rounded-xl shadow-lg text-sm font-bold text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-70 disabled:cursor-not-allowed transition-all hover:scale-[1.02] active:scale-95 bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-700 hover:to-primary-600"
                                >
                                    {isLoading ? (
                                        <>
                                            <Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5" /> Processing...
                                        </>
                                    ) : (
                                        'Send recovery code'
                                    )}
                                </button>
                            </form>
                        ) : (
                            <form onSubmit={handleResetPassword} className="space-y-6">
                                <div className="space-y-1.5 focus-within:text-primary-600">
                                    <label htmlFor="otp" className="block text-sm font-semibold text-gray-700">
                                        Recovery Code
                                    </label>
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 group-focus-within:text-primary-500 transition-colors">
                                            <KeyRound className="h-5 w-5" />
                                        </div>
                                        <input
                                            id="otp"
                                            name="otp"
                                            type="text"
                                            required
                                            tabIndex={1}
                                            className="block w-full pl-11 pr-3 py-3 border border-gray-300 bg-white rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow sm:text-sm text-gray-900 placeholder-gray-400 font-medium"
                                            placeholder="6-digit code"
                                            value={otp}
                                            onChange={(e) => setOtp(e.target.value)}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-1.5 focus-within:text-primary-600">
                                    <label htmlFor="newPassword" className="block text-sm font-semibold text-gray-700">
                                        New Password
                                    </label>
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 group-focus-within:text-primary-500 transition-colors">
                                            <Lock className="h-5 w-5" />
                                        </div>
                                        <input
                                            id="newPassword"
                                            name="newPassword"
                                            type={showPassword ? "text" : "password"}
                                            required
                                            tabIndex={2}
                                            className="block w-full pl-11 pr-10 py-3 border border-gray-300 bg-white rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow sm:text-sm text-gray-900 placeholder-gray-400 font-medium"
                                            placeholder="••••••••"
                                            value={newPassword}
                                            onChange={(e) => setNewPassword(e.target.value)}
                                        />
                                        <button
                                            type="button"
                                            tabIndex={-1}
                                            className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-gray-600:text-gray-300 focus:outline-none focus:text-primary-600"
                                            onClick={() => setShowPassword(!showPassword)}
                                        >
                                            {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                                        </button>
                                    </div>
                                </div>

                                <button
                                    type="submit"
                                    disabled={isLoading}
                                    tabIndex={4}
                                    className="w-full flex justify-center items-center py-3.5 px-4 border border-transparent rounded-xl shadow-lg text-sm font-bold text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-70 disabled:cursor-not-allowed transition-all hover:scale-[1.02] active:scale-95 bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-700 hover:to-primary-600"
                                >
                                    {isLoading ? (
                                        <>
                                            <Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5" /> Updating...
                                        </>
                                    ) : (
                                        'Reset Password'
                                    )}
                                </button>
                            </form>
                        )}
                        
                    </div>
                </div>
            </div>
        </div>
    );
}
