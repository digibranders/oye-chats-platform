import React, { useState, useRef, useEffect } from 'react';
import { Settings, MessageCircle } from 'lucide-react';
import FeedbackModal from './FeedbackModal';

const SettingsDropup = ({ isOpen: sidebarOpen }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [isFeedbackModalOpen, setIsFeedbackModalOpen] = useState(false);
    const dropupRef = useRef(null);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropupRef.current && !dropupRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleFeedbackSubmit = async (text) => {
        console.log("Submitting feedback:", text);
        return new Promise(resolve => setTimeout(resolve, 800));
    };

    return (
        <>
            <div className="relative w-full" ref={dropupRef}>

                {/* Dropup Menu */}
                {isOpen && (
                    <div className="absolute bottom-full left-0 mb-2 w-full bg-[#1e1e1e] text-white rounded-xl shadow-2xl border border-[#333] z-50">
                        <div className="p-1.5 space-y-0.5">
                            {/* Send Feedback */}
                            <button
                                onClick={() => {
                                    setIsFeedbackModalOpen(true);
                                    setIsOpen(false);
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
                    onClick={() => setIsOpen(prev => !prev)}
                    className={`flex items-center gap-3 px-3 rounded-xl transition-all group w-full h-8 ${isOpen
                            ? 'bg-primary-50 text-primary-700 font-medium'
                            : 'text-secondary-600 hover:bg-secondary-50 hover:text-secondary-900'
                        }`}
                    title={!sidebarOpen ? "Settings" : undefined}
                >
                    <Settings
                        size={18}
                        className={`flex-shrink-0 transition-colors ${isOpen
                                ? 'text-primary-600'
                                : 'text-secondary-400 group-hover:text-secondary-600'
                            }`}
                    />
                    {sidebarOpen && <span className="truncate text-sm">Settings</span>}
                </button>
            </div>

            <FeedbackModal
                isOpen={isFeedbackModalOpen}
                onClose={() => setIsFeedbackModalOpen(false)}
                onSubmit={handleFeedbackSubmit}
            />
        </>
    );
};

export default SettingsDropup;
