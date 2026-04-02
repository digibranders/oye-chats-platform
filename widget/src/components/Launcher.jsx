import { useState, useEffect, useRef } from 'react';
import { Bot, ChevronDown } from 'lucide-react';

const Launcher = ({ isOpen, toggleChat, settings }) => {
    const launcherName = settings?.launcher_name || "Have Questions?";
    const launcherLogo = settings?.launcher_logo;
    const avatarType = settings?.avatar_type || 'upload';
    const primaryColor = settings?.primary_color || '#2B66BC';
    const [isScrolling, setIsScrolling] = useState(false);
    const scrollTimer = useRef(null);

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

    const showTooltip = !isOpen && !isScrolling;

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

    return (
        <div className="relative flex flex-col items-end">
            {/* Tooltip — hidden when chat is open */}
            <div className={`absolute bottom-full mb-4 mr-2 bg-white px-4 py-2 rounded-xl shadow-lg border border-gray-100 transition-opacity duration-200 whitespace-nowrap ${showTooltip ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                <div className="text-sm font-medium text-gray-700">
                    <b>{launcherName}</b>
                </div>
                <div className="absolute -bottom-2 right-6 w-4 h-4 bg-white transform rotate-45 border-r border-b border-gray-100"></div>
            </div>

            {/* Pulse ring — visible when chat is open */}
            <span
                className={`absolute inset-0 rounded-full pointer-events-none transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0'}`}
                style={isOpen ? { animation: 'launcherPulse 2s ease-in-out infinite', border: `2px solid ${primaryColor}` } : undefined}
            />

            {/* Main Button — bot icon always visible */}
            <button
                onClick={toggleChat}
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
