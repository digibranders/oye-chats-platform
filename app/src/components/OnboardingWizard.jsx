import { useState } from 'react';
import { Bot, BookOpen, Palette, Code2, Check, ArrowRight, ArrowLeft, Copy, Loader2, X, Sparkles } from 'lucide-react';
import { createBot, crawlWebsite } from '../services/api';

const steps = [
    { id: 'welcome', title: 'Welcome to OyeChats', icon: Sparkles },
    { id: 'create', title: 'Create Your Chatbot', icon: Bot },
    { id: 'knowledge', title: 'Add Knowledge', icon: BookOpen },
    { id: 'embed', title: 'Get Embed Code', icon: Code2 },
];

export default function OnboardingWizard({ onComplete, onRefreshBots }) {
    const [step, setStep] = useState(0);
    const [botName, setBotName] = useState('');
    const [botWebsite, setBotWebsite] = useState('');
    const [createdBot, setCreatedBot] = useState(null);
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);

    const handleCreateBot = async () => {
        if (!botName.trim()) return;
        setIsCreating(true); setError('');
        try {
            const result = await createBot({ name: botName.trim(), website: botWebsite.trim() || undefined });
            setCreatedBot(result);
            if (botWebsite.trim()) {
                crawlWebsite(botWebsite.trim(), result.bot_id).catch(() => { });
            }
            if (onRefreshBots) await onRefreshBots();
            setStep(2);
        } catch (err) {
            setError(typeof err === 'string' ? err : err?.detail || 'Failed to create bot');
        } finally { setIsCreating(false); }
    };

    const handleCopy = () => {
        const script = `<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="${createdBot?.bot_key}"></script>`;
        navigator.clipboard.writeText(script);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleFinish = () => {
        localStorage.setItem('onboarding_complete', 'true');
        onComplete();
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-secondary-950/80 backdrop-blur-md animate-fade-in">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-secondary-200 overflow-hidden animate-scale-in">
                {/* Progress */}
                <div className="flex items-center gap-1 px-6 pt-5">
                    {steps.map((s, i) => (
                        <div key={s.id} className={`flex-1 h-1 rounded-full transition-all ${i <= step ? 'bg-primary-500' : 'bg-secondary-200'}`} />
                    ))}
                </div>

                <div className="p-6">
                    {/* Step 0: Welcome */}
                    {step === 0 && (
                        <div className="text-center py-6 animate-fade-in">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center mx-auto mb-5 shadow-lg shadow-primary-500/20">
                                <Bot size={32} />
                            </div>
                            <h2 className="text-xl font-bold text-secondary-900 mb-2">Welcome to OyeChats</h2>
                            <p className="text-secondary-500 text-sm max-w-sm mx-auto mb-8">
                                Let's set up your first AI chatbot in just a few steps. It only takes a minute.
                            </p>
                            <button onClick={() => setStep(1)} className="flex items-center gap-2 mx-auto px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all">
                                Get Started <ArrowRight size={16} />
                            </button>
                        </div>
                    )}

                    {/* Step 1: Create Bot */}
                    {step === 1 && (
                        <div className="animate-fade-in">
                            <h2 className="text-lg font-bold text-secondary-900 mb-1">Name your chatbot</h2>
                            <p className="text-sm text-secondary-500 mb-5">This is the name your visitors will see</p>
                            {error && <div className="mb-4 p-3 bg-error-50 text-error-600 text-sm rounded-xl border border-error-500/20">{error}</div>}
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-secondary-700 mb-1.5">Bot Name</label>
                                    <input type="text" value={botName} onChange={(e) => setBotName(e.target.value)} placeholder="e.g. Support Bot, Sales Assistant..." className="w-full px-3.5 py-2.5 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm" maxLength={50} />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-secondary-700 mb-1.5">Website</label>
                                    <input type="url" value={botWebsite} onChange={(e) => setBotWebsite(e.target.value)} placeholder="https://yourwebsite.com" className="w-full px-3.5 py-2.5 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm" />
                                </div>
                            </div>
                            <div className="flex gap-3 mt-6">
                                <button onClick={() => setStep(0)} className="flex-1 py-2.5 border border-secondary-200 text-secondary-600 rounded-xl text-sm font-medium transition-colors hover:bg-secondary-50:bg-secondary-800">
                                    <ArrowLeft size={14} className="inline mr-1" /> Back
                                </button>
                                <button onClick={handleCreateBot} disabled={isCreating || !botName.trim()} className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all disabled:opacity-70 flex items-center justify-center gap-2">
                                    {isCreating ? <Loader2 size={16} className="animate-spin" /> : <>Create <ArrowRight size={14} /></>}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Step 2: Add Knowledge (skippable) */}
                    {step === 2 && (
                        <div className="animate-fade-in">
                            <h2 className="text-lg font-bold text-secondary-900 mb-1">Add knowledge</h2>
                            <p className="text-sm text-secondary-500 mb-5">Upload documents or crawl a website so your chatbot can answer questions. You can always do this later.</p>
                            <div className="bg-secondary-50 rounded-xl p-6 text-center border border-secondary-200 mb-5">
                                <BookOpen size={28} className="text-primary-500 mx-auto mb-3" />
                                <p className="text-sm text-secondary-600 font-medium">You can add documents from the Sources page</p>
                                <p className="text-xs text-secondary-400 mt-1">PDF, DOCX, TXT, or crawl any website</p>
                            </div>
                            <div className="flex gap-3">
                                <button onClick={() => setStep(3)} className="flex-1 py-2.5 border border-secondary-200 text-secondary-600 rounded-xl text-sm font-medium transition-colors hover:bg-secondary-50:bg-secondary-800">
                                    Skip for now
                                </button>
                                <button onClick={() => setStep(3)} className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all flex items-center justify-center gap-2">
                                    Continue <ArrowRight size={14} />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Step 3: Embed Code */}
                    {step === 3 && (
                        <div className="animate-fade-in">
                            <div className="flex items-center gap-3 mb-1">
                                <div className="w-8 h-8 rounded-full bg-success-50 flex items-center justify-center">
                                    <Check size={18} className="text-success-500" />
                                </div>
                                <h2 className="text-lg font-bold text-secondary-900">Your chatbot is ready!</h2>
                            </div>
                            <p className="text-sm text-secondary-500 mb-5 ml-11">Add this script to your website to embed the chatbot</p>

                            <div className="relative">
                                <pre className="bg-secondary-900 text-green-400 p-4 rounded-xl text-[11px] leading-relaxed overflow-x-auto border border-secondary-800 font-mono">
                                    {`<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="${createdBot?.bot_key || 'bot-xxx'}"></script>`}
                                </pre>
                                <button onClick={handleCopy} className="absolute top-2 right-2 flex items-center gap-1 px-2.5 py-1 bg-secondary-800 hover:bg-secondary-700 text-secondary-300 rounded-lg text-[10px] font-bold transition-colors">
                                    {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
                                </button>
                            </div>
                            <p className="text-[11px] text-secondary-400 mt-2">Paste this in your website's <code className="bg-secondary-100 px-1 py-0.5 rounded text-secondary-500">&lt;body&gt;</code> tag</p>

                            <button onClick={handleFinish} className="w-full mt-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all flex items-center justify-center gap-2">
                                Go to Dashboard <ArrowRight size={14} />
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
