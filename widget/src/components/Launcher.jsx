import { useState, useEffect, useRef } from 'react';
import { Bot, ChevronDown, X, ArrowUp } from 'lucide-react';

const Launcher = ({ isOpen, toggleChat, settings, onBubbleSend }) => {
    const launcherName = settings?.launcher_name || "Have Questions?";
    const launcherLogo = settings?.launcher_logo;
    const avatarType = settings?.avatar_type || 'upload';
    const primaryColor = settings?.primary_color || '#2B66BC';
    const botName = settings?.bot_name || 'AI Assistant';
    const [isScrolling, setIsScrolling] = useState(false);
    const scrollTimer = useRef(null);

    // Greeting bubble state
    const [showGreeting, setShowGreeting] = useState(false);
    const [bubbleInput, setBubbleInput] = useState('');
    const [greetingDismissed, setGreetingDismissed] = useState(() => {
        try { return sessionStorage.getItem('oyechats_greeting_dismissed') === '1'; } catch { return false; }
    });

    useEffect(() => {
        const handleScroll = () => {
            setIsScrolling(true);
            clearTimeout(scrollTimer.current);
            scrollTimer.current = setTimeout(() => setIsScrolling(false), 600);
        };

        window.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            window.removeEventListener('scroll', handleScroll);
            clearTimeout(scrollTimer.current);
        };
    }, []);

    // Show greeting bubble after 3s, only if not dismissed and chat not open
    useEffect(() => {
        if (isOpen || greetingDismissed) return;
        const timer = setTimeout(() => setShowGreeting(true), 3000);
        return () => clearTimeout(timer);
    }, [isOpen, greetingDismissed]);

    const dismissGreeting = (e) => {
        e.stopPropagation();
        setShowGreeting(false);
        setGreetingDismissed(true);
        try { sessionStorage.setItem('oyechats_greeting_dismissed', '1'); } catch { /* noop */ }
    };

    const handleBubbleSend = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!bubbleInput.trim()) return;
        onBubbleSend?.(bubbleInput.trim());
        setBubbleInput('');
        setShowGreeting(false);
    };

    const renderBotIcon = () => {
        if (avatarType === 'orb') {
            const oc = settings?.orb_color || primaryColor;
            return (
                <div
                    className="w-full h-full rounded-full"
                    style={{
                        background: `radial-gradient(circle at 35% 35%, ${oc}44, ${oc}bb, ${oc})`,
                        boxShadow: `0 0 12px ${oc}55`
                    }}
                />
            );
        }
        if (avatarType === 'mascot') {
            return (
                <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: primaryColor }}>
                    <Bot size={28} className="text-white" />
                </div>
            );
        }
        if (launcherLogo && launcherLogo !== "null") {
            return (
                <img
                    src={launcherLogo}
                    alt="Launcher"
                    className="w-full h-full object-cover"
                />
            );
        }
        return (
            <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: primaryColor }}>
                <Bot size={28} className="text-white" />
            </div>
        );
    };

    // Small avatar for the greeting bubble
    const renderSmallAvatar = () => {
        if (avatarType === 'orb') {
            const oc = settings?.orb_color || primaryColor;
            return (
                <div
                    className="w-7 h-7 rounded-full flex-shrink-0"
                    style={{ background: `radial-gradient(circle at 35% 35%, ${oc}44, ${oc}bb, ${oc})` }}
                />
            );
        }
        if (launcherLogo && launcherLogo !== "null") {
            return <img src={launcherLogo} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />;
        }
        return (
            <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: primaryColor }}>
                <Bot size={14} className="text-white" />
            </div>
        );
    };

    const greetingMessage = settings?.greeting_message || 'Hi! Let us know if you have any questions.';
    const hasBubbleText = bubbleInput.trim().length > 0;

    return (
        <div className="relative flex flex-col items-end">
            {/* Pre-chat greeting bubble — desktop only, replaces tooltip */}
            {showGreeting && !isOpen && (
                <div
                    className="hidden md:block absolute bottom-full mb-4 right-0 w-[280px] bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden"
                    style={{ animation: 'fadeUp 0.3s ease-out' }}
                >
                    {/* Bubble header */}
                    <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
                        {renderSmallAvatar()}
                        <span className="text-[13px] font-semibold text-[#16202C] flex-1">{botName}</span>
                        <button
                            onClick={dismissGreeting}
                            className="w-5 h-5 flex items-center justify-center text-gray-300 hover:text-gray-500 transition-colors"
                            aria-label="Dismiss"
                        >
                            <X size={12} />
                        </button>
                    </div>
                    {/* Greeting text */}
                    <p className="text-[13px] text-gray-500 leading-relaxed px-4 pb-3">{greetingMessage}</p>
                    {/* Mini input */}
                    <form onSubmit={handleBubbleSend} className="px-3 pb-3">
                        <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5">
                            <input
                                type="text"
                                value={bubbleInput}
                                onChange={(e) => setBubbleInput(e.target.value)}
                                placeholder="Type a message..."
                                className="flex-1 text-[13px] text-[#16202C] placeholder:text-gray-400 bg-transparent outline-none"
                            />
                            <button
                                type="submit"
                                disabled={!hasBubbleText}
                                className={`w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full transition-all ${
                                    hasBubbleText ? 'text-white' : 'text-gray-300'
                                }`}
                                style={hasBubbleText ? { backgroundColor: primaryColor } : undefined}
                                aria-label="Send"
                            >
                                <ArrowUp size={12} />
                            </button>
                        </div>
                    </form>
                    {/* Arrow pointing down to launcher */}
                    <div className="absolute -bottom-2 right-7 w-4 h-4 bg-white transform rotate-45 border-r border-b border-gray-100" />
                </div>
            )}

            {/* Tooltip — visible only when greeting bubble is not showing */}
            {!showGreeting && (
                <div className={`hidden md:block absolute bottom-full mb-4 mr-2 bg-white px-4 py-2 rounded-xl shadow-lg border border-gray-100 transition-opacity duration-200 whitespace-nowrap ${!isOpen && !isScrolling ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                    <div className="text-sm font-medium text-gray-700">
                        <b>{launcherName}</b>
                    </div>
                    <div className="absolute -bottom-2 right-6 w-4 h-4 bg-white transform rotate-45 border-r border-b border-gray-100" />
                </div>
            )}

            {/* Pulse ring — visible when chat is open */}
            <span
                className={`absolute inset-0 rounded-full pointer-events-none transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0'}`}
                style={isOpen ? { animation: 'launcherPulse 2s ease-in-out infinite', border: `2px solid ${primaryColor}` } : undefined}
            />

            {/* Main Button — bot icon always visible */}
            <button
                onClick={() => { setShowGreeting(false); toggleChat(); }}
                aria-label={isOpen ? 'Close chat' : launcherName}
                aria-expanded={isOpen}
                className="relative w-14 h-14 rounded-full bg-white text-white flex items-center justify-center shadow-lg overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                style={{ '--tw-ring-color': primaryColor }}
            >
                {renderBotIcon()}

                {/* Minimize badge — appears at bottom-right when chat is open */}
                <span
                    className={`absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full flex items-center justify-center shadow-md transition-all duration-300 ${isOpen ? 'opacity-100 scale-100' : 'opacity-0 scale-0 pointer-events-none'}`}
                    style={{ backgroundColor: primaryColor }}
                >
                    <ChevronDown size={12} className="text-white" />
                </span>
            </button>
        </div>
    );
};

export default Launcher;
