import React, { useState, useRef, useEffect } from 'react';
import { Settings, Sun, Moon, Monitor, MessageCircle, ChevronRight } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import FeedbackModal from './FeedbackModal';

const SettingsDropup = ({ isOpen: sidebarOpen }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [showThemeSubmenu, setShowThemeSubmenu] = useState(false);
    const [submenuPos, setSubmenuPos] = useState({ top: 0, left: 0 });
    const [isFeedbackModalOpen, setIsFeedbackModalOpen] = useState(false);
    const { theme, setTheme } = useTheme();
    const dropupRef = useRef(null);
    const themeRowRef = useRef(null);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            // Check if click is inside the dropup OR the fixed submenu
            const submenuEl = document.getElementById('theme-submenu-fixed');
            if (
                dropupRef.current && !dropupRef.current.contains(event.target) &&
                !(submenuEl && submenuEl.contains(event.target))
            ) {
                setIsOpen(false);
                setShowThemeSubmenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const themes = [
        { id: 'light', name: 'Light', icon: Sun },
        { id: 'dark', name: 'Dark', icon: Moon },
        { id: 'system', name: 'System', icon: Monitor },
    ];

    const handleThemeRowClick = () => {
        if (!showThemeSubmenu && themeRowRef.current) {
            const rect = themeRowRef.current.getBoundingClientRect();
            setSubmenuPos({
                top: rect.top,
                left: rect.right + 6,
            });
        }
        setShowThemeSubmenu(prev => !prev);
    };

    const handleThemeSelect = (themeId) => {
        setTheme(themeId);
        setShowThemeSubmenu(false);
        setIsOpen(false);
    };

    const handleFeedbackSubmit = async (text) => {
        console.log("Submitting feedback:", text);
        return new Promise(resolve => setTimeout(resolve, 800));
    };

    const CurrentThemeIcon = themes.find(t => t.id === theme)?.icon || Sun;

    return (
        <>
            <div className="relative w-full" ref={dropupRef}>

                {/* Dropup Menu */}
                {isOpen && (
                    <div className="absolute bottom-full left-0 mb-2 w-full bg-[#1e1e1e] text-white rounded-xl shadow-2xl border border-[#333] z-50">
                        <div className="p-1.5 space-y-0.5">

                            {/* Theme Row */}
                            <button
                                ref={themeRowRef}
                                onClick={handleThemeRowClick}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-left text-sm font-medium ${showThemeSubmenu ? 'bg-[#333]' : 'hover:bg-[#333]'}`}
                            >
                                <div className="p-1.5 rounded-md bg-[#2d2d2d]">
                                    <CurrentThemeIcon size={16} className="text-secondary-400" />
                                </div>
                                <span className="flex-1">Theme</span>
                                <ChevronRight size={14} className="text-secondary-500" />
                            </button>

                            {/* Send Feedback */}
                            <button
                                onClick={() => {
                                    setIsFeedbackModalOpen(true);
                                    setIsOpen(false);
                                    setShowThemeSubmenu(false);
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[#333] transition-colors text-left text-sm font-medium"
                            >
                                <div className="p-1.5 rounded-md bg-[#2d2d2d]">
                                    <MessageCircle size={16} className="text-secondary-400" />
                                </div>
                                <span className="flex-1">Send feedback</span>
                            </button>
                        </div>
                    </div>
                )}

                {/* Settings Toggle Button */}
                <button
                    onClick={() => {
                        setIsOpen(prev => !prev);
                        if (isOpen) setShowThemeSubmenu(false);
                    }}
                    className={`flex items-center gap-3 px-3 rounded-xl transition-all group w-full h-8 ${isOpen
                            ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 font-medium'
                            : 'text-secondary-600 dark:text-secondary-400 hover:bg-secondary-50 dark:hover:bg-secondary-700/50 hover:text-secondary-900 dark:hover:text-secondary-200'
                        }`}
                    title={!sidebarOpen ? "Settings" : undefined}
                >
                    <Settings
                        size={18}
                        className={`flex-shrink-0 transition-colors ${isOpen
                                ? 'text-primary-600 dark:text-primary-400'
                                : 'text-secondary-400 dark:text-secondary-500 group-hover:text-secondary-600 dark:group-hover:text-secondary-300'
                            }`}
                    />
                    {sidebarOpen && <span className="truncate text-sm">Settings</span>}
                </button>
            </div>

            {/* Theme submenu — rendered via fixed position to escape sidebar overflow clipping */}
            {showThemeSubmenu && (
                <div
                    id="theme-submenu-fixed"
                    style={{ position: 'fixed', top: submenuPos.top, left: submenuPos.left, zIndex: 9999 }}
                    className="w-44 bg-[#1e1e1e] border border-[#333] rounded-xl shadow-2xl p-1.5 space-y-0.5"
                >
                    {themes.map((t) => {
                        const Icon = t.icon;
                        const isActive = theme === t.id;
                        return (
                            <button
                                key={t.id}
                                onClick={() => handleThemeSelect(t.id)}
                                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm ${isActive ? 'bg-[#333] text-white' : 'text-secondary-400 hover:bg-[#2d2d2d] hover:text-white'
                                    }`}
                            >
                                {/* Radio indicator */}
                                <div className="w-3.5 h-3.5 rounded-full border border-secondary-500 flex items-center justify-center flex-shrink-0">
                                    {isActive && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                                </div>
                                <Icon size={15} className="flex-shrink-0" />
                                <span>{t.name}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            <FeedbackModal
                isOpen={isFeedbackModalOpen}
                onClose={() => setIsFeedbackModalOpen(false)}
                onSubmit={handleFeedbackSubmit}
            />
        </>
    );
};

export default SettingsDropup;
