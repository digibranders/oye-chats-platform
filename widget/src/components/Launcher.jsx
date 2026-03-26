import { useState, useEffect, useRef } from 'react';
import { Bot } from 'lucide-react';

const Launcher = ({ isOpen, toggleChat, settings }) => {
    const launcherName = settings?.launcher_name || "Have Questions?";
    const launcherLogo = settings?.launcher_logo;
    const avatarType = settings?.avatar_type || 'upload';
    const primaryColor = settings?.primary_color || '#3A0CA3';
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

    return (
        <div className="relative flex flex-col items-end">
            {/* Tooltip */}
            <div className={`absolute bottom-full mb-4 mr-2 bg-white px-4 py-2 rounded-xl shadow-lg border border-gray-100 transform transition-all duration-300 origin-bottom-right whitespace-nowrap ${showTooltip ? 'scale-100 opacity-100' : 'scale-0 opacity-0 pointer-events-none'}`}>
                <div className="text-sm font-medium text-gray-700">
                    <b>{launcherName}</b>
                </div>
                <div className="absolute -bottom-2 right-6 w-4 h-4 bg-white transform rotate-45 border-r border-b border-gray-100"></div>
            </div>

            {/* Main Button Container with Zoom/Pulse Animation */}
            <div className={`${!isOpen ? 'animate-zoom-pulse' : ''}`}>
                <button
                    onClick={toggleChat}
                    className="relative w-14 h-14 rounded-full bg-white text-white flex items-center justify-center shadow-lg hover:scale-110 transition-transform duration-300 overflow-hidden"
                >
                    {avatarType === 'orb' ? (() => {
                        const oc = settings?.orb_color || primaryColor;
                        return (
                        <div
                            className="w-full h-full rounded-full"
                            style={{
                                background: `radial-gradient(circle at 35% 35%, ${oc}44, ${oc}bb, ${oc})`,
                                boxShadow: `0 0 12px ${oc}55`,
                                animation: 'pulse 2.5s ease-in-out infinite'
                            }}
                        />
                        );
                    })() : avatarType === 'mascot' ? (
                        <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: primaryColor }}>
                            <Bot size={28} className="text-white" />
                        </div>
                    ) : launcherLogo && launcherLogo !== "null" ? (
                        <img
                            src={launcherLogo}
                            alt="Launcher"
                            className="w-full h-full object-cover"
                        />
                    ) : (
                        <div className="w-full h-full bg-[#3A0CA3] flex items-center justify-center">
                            <Bot size={28} />
                        </div>
                    )}
                </button>
            </div>
        </div>
    );
};

export default Launcher;
