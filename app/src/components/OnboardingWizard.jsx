import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, BookOpen, Code2, Check, ArrowRight, ArrowLeft, Loader2, Sparkles, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { createBot, crawlWebsite } from '../services/api';
import { platforms } from '../data/platformIntegrations';
import PlatformSelector from './PlatformSelector';
import IntegrationGuide from './IntegrationGuide';

const steps = [
    { id: 'welcome', title: 'Welcome to OyeChats', icon: Sparkles },
    { id: 'create', title: 'Create Your Chatbot', icon: Bot },
    { id: 'knowledge', title: 'Add Knowledge', icon: BookOpen },
    { id: 'install', title: 'Install on Your Platform', icon: Code2 },
];

const overlayVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1 },
    exit: { opacity: 0 },
};

const cardVariants = {
    hidden: { opacity: 0, scale: 0.95, y: 20 },
    visible: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring', damping: 25, stiffness: 400 } },
    exit: { opacity: 0, scale: 0.95, y: 20, transition: { duration: 0.15 } },
};

const stepVariants = {
    enter: (direction) => ({ x: direction > 0 ? 80 : -80, opacity: 0 }),
    center: { x: 0, opacity: 1, transition: { type: 'spring', damping: 25, stiffness: 300 } },
    exit: (direction) => ({ x: direction > 0 ? -80 : 80, opacity: 0, transition: { duration: 0.15 } }),
};

export default function OnboardingWizard({ onComplete, onRefreshBots }) {
    const [step, setStep] = useState(0);
    const [direction, setDirection] = useState(1);
    const [botName, setBotName] = useState('');
    const [botWebsite, setBotWebsite] = useState(localStorage.getItem('company_website') || '');
    const [createdBot, setCreatedBot] = useState(null);
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState('');
    const [selectedPlatform, setSelectedPlatform] = useState(null);
    const [copiedField, setCopiedField] = useState(null);
    const [env, setEnv] = useState('production');

    const goToStep = (next) => {
        setDirection(next > step ? 1 : -1);
        setStep(next);
    };

    const handleCreateBot = async () => {
        if (!botName.trim()) return;
        const website = botWebsite.trim();
        const normalizedWebsite = website && !/^https?:\/\//i.test(website) ? `https://${website}` : website;
        setIsCreating(true); setError('');
        try {
            const result = await createBot({ name: botName.trim(), website: normalizedWebsite || undefined });
            setCreatedBot(result);
            if (normalizedWebsite) {
                crawlWebsite(normalizedWebsite, result.bot_id).catch(() => { });
            }
            if (onRefreshBots) await onRefreshBots();
            goToStep(2);
        } catch (err) {
            setError(typeof err === 'string' ? err : err?.detail || 'Failed to create bot');
        } finally { setIsCreating(false); }
    };

    const handleCopy = (text, fieldId) => {
        navigator.clipboard.writeText(text);
        setCopiedField(fieldId);
        setTimeout(() => setCopiedField(null), 2000);
    };

    const handleFinish = () => {
        localStorage.setItem('onboarding_complete', 'true');
        onComplete();
    };

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-[200] flex items-center justify-center">
                <motion.div
                    className="absolute inset-0 bg-black/50 dark:bg-black/80 backdrop-blur-md"
                    variants={overlayVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                />
                <motion.div
                    className="bg-white dark:bg-surface-900 rounded-2xl shadow-2xl w-full max-w-2xl border border-surface-200 dark:border-surface-700 overflow-hidden relative"
                    variants={cardVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                >
                    {/* Close button */}
                    <button
                        onClick={handleFinish}
                        className="absolute top-4 right-4 z-10 p-1.5 rounded-lg text-surface-400 dark:text-surface-500 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                        aria-label="Close wizard"
                    >
                        <X size={18} />
                    </button>

                    {/* Progress */}
                    <div className="flex items-center gap-1 px-6 pt-5 pr-12">
                        {steps.map((s, i) => (
                            <div
                                key={s.id}
                                className={cn(
                                    'flex-1 h-1 rounded-full transition-all',
                                    i <= step
                                        ? 'bg-primary-500'
                                        : 'bg-surface-200 dark:bg-surface-700'
                                )}
                            />
                        ))}
                    </div>

                    <div className="p-6 max-h-[90vh] overflow-y-auto">
                        <AnimatePresence mode="wait" custom={direction}>
                            {/* Step 0: Welcome */}
                            {step === 0 && (
                                <motion.div
                                    key="step-0"
                                    custom={direction}
                                    variants={stepVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    className="text-center py-6"
                                >
                                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700 text-white flex items-center justify-center mx-auto mb-5 shadow-lg shadow-primary-500/20">
                                        <Bot size={32} />
                                    </div>
                                    <h2 className="text-xl font-bold text-surface-900 dark:text-surface-100 mb-2">Welcome to OyeChats</h2>
                                    <p className="text-surface-500 dark:text-surface-400 text-sm max-w-sm mx-auto mb-8">
                                        Let's set up your first AI chatbot in just a few steps. It only takes a minute.
                                    </p>
                                    <button
                                        onClick={() => goToStep(1)}
                                        className="flex items-center gap-2 mx-auto px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all"
                                    >
                                        Get Started <ArrowRight size={16} />
                                    </button>
                                </motion.div>
                            )}

                            {/* Step 1: Create Bot */}
                            {step === 1 && (
                                <motion.div
                                    key="step-1"
                                    custom={direction}
                                    variants={stepVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                >
                                    <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-1">Name your chatbot</h2>
                                    <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">This is the name your visitors will see</p>
                                    {error && (
                                        <div className="mb-4 p-3 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 text-sm rounded-xl border border-rose-500/20">
                                            {error}
                                        </div>
                                    )}
                                    <div className="space-y-4">
                                        <div>
                                            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">Bot Name</label>
                                            <input
                                                type="text"
                                                value={botName}
                                                onChange={(e) => setBotName(e.target.value)}
                                                placeholder="e.g. Support Bot, Sales Assistant..."
                                                className="w-full px-3.5 py-2.5 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder-surface-400 dark:placeholder-surface-500 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm"
                                                maxLength={50}
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">Website</label>
                                            <input
                                                type="text"
                                                value={botWebsite}
                                                onChange={(e) => setBotWebsite(e.target.value)}
                                                placeholder="https://yourwebsite.com"
                                                className="w-full px-3.5 py-2.5 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder-surface-400 dark:placeholder-surface-500 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm"
                                            />
                                        </div>
                                    </div>
                                    <div className="flex gap-3 mt-6">
                                        <button
                                            onClick={() => goToStep(0)}
                                            className="flex-1 py-2.5 border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 rounded-xl text-sm font-medium transition-colors hover:bg-surface-50 dark:hover:bg-surface-800"
                                        >
                                            <ArrowLeft size={14} className="inline mr-1" /> Back
                                        </button>
                                        <button
                                            onClick={handleCreateBot}
                                            disabled={isCreating || !botName.trim()}
                                            className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all disabled:opacity-70 flex items-center justify-center gap-2"
                                        >
                                            {isCreating ? <Loader2 size={16} className="animate-spin" /> : <>Create <ArrowRight size={14} /></>}
                                        </button>
                                    </div>
                                </motion.div>
                            )}

                            {/* Step 2: Add Knowledge (skippable) */}
                            {step === 2 && (
                                <motion.div
                                    key="step-2"
                                    custom={direction}
                                    variants={stepVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                >
                                    <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-1">Add knowledge</h2>
                                    <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">Upload documents or crawl a website so your chatbot can answer questions. You can always do this later.</p>
                                    <div className="bg-surface-50 dark:bg-surface-800 rounded-xl p-6 text-center border border-surface-200 dark:border-surface-700 mb-5">
                                        <BookOpen size={28} className="text-primary-500 mx-auto mb-3" />
                                        <p className="text-sm text-surface-600 dark:text-surface-300 font-medium">You can add documents from the Sources page</p>
                                        <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">PDF, DOCX, TXT, or crawl any website</p>
                                    </div>
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => goToStep(3)}
                                            className="flex-1 py-2.5 border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 rounded-xl text-sm font-medium transition-colors hover:bg-surface-50 dark:hover:bg-surface-800"
                                        >
                                            Skip for now
                                        </button>
                                        <button
                                            onClick={() => goToStep(3)}
                                            className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all flex items-center justify-center gap-2"
                                        >
                                            Continue <ArrowRight size={14} />
                                        </button>
                                    </div>
                                </motion.div>
                            )}

                            {/* Step 3: Platform Selection & Install Guide */}
                            {step === 3 && (
                                <motion.div
                                    key="step-3"
                                    custom={direction}
                                    variants={stepVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                >
                                    <div className="flex items-center gap-3 mb-1">
                                        <div className="w-8 h-8 rounded-full bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center">
                                            <Check size={18} className="text-emerald-500 dark:text-emerald-400" />
                                        </div>
                                        <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100">Your chatbot is ready!</h2>
                                    </div>
                                    <p className="text-sm text-surface-500 dark:text-surface-400 mb-5 ml-11">
                                        {selectedPlatform
                                            ? 'Follow the steps below to add it to your site'
                                            : 'Choose your platform to get installation instructions'}
                                    </p>

                                    {selectedPlatform ? (
                                        <IntegrationGuide
                                            platform={platforms.find((p) => p.id === selectedPlatform)}
                                            botKey={createdBot?.bot_key || 'bot-xxx'}
                                            env={env}
                                            onEnvChange={setEnv}
                                            onBack={() => setSelectedPlatform(null)}
                                            onCopy={handleCopy}
                                            copiedField={copiedField}
                                        />
                                    ) : (
                                        <PlatformSelector
                                            platforms={platforms}
                                            selectedId={null}
                                            onSelect={setSelectedPlatform}
                                        />
                                    )}

                                    <button
                                        onClick={handleFinish}
                                        className="w-full mt-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all flex items-center justify-center gap-2"
                                    >
                                        Go to Dashboard <ArrowRight size={14} />
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );
}
