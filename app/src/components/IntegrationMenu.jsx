import React, { useState, useRef, useEffect } from 'react';
import { Blocks } from 'lucide-react';
import { WhatsAppIcon, EmailIcon } from './Icons';
import { NavLink } from 'react-router-dom';

const IntegrationMenu = ({ isOpen: sidebarOpen }) => {
    const [isOpen, setIsOpen] = useState(false);
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


    
    // Using a dynamic path because App.jsx route is what matters. In App.jsx I'll mount them at /integrations/*
    const items = [
        { id: 'whatsapp', name: 'WhatsApp', icon: WhatsAppIcon, path: '/integrations/whatsapp' },
        { id: 'email', name: 'Email', icon: EmailIcon, path: '/integrations/email' },
    ];

    return (
        <div className="relative w-full" ref={dropupRef}>
            {/* Dropup Menu */}
            {isOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-full bg-[#1e1e1e] text-white rounded-xl shadow-2xl border border-[#333] z-50">
                    <div className="p-1.5 space-y-0.5">
                        {items.map((item) => {
                            const Icon = item.icon;
                            // Add click handler to close menu after navigation
                            return (
                                <NavLink
                                    key={item.id}
                                    to={item.path}
                                    onClick={() => setIsOpen(false)}
                                    className={({ isActive }) => `w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-left text-sm font-medium ${isActive ? 'bg-[#333] text-white' : 'text-secondary-400 hover:bg-[#333] hover:text-white'}`}
                                >
                                    <div className="p-1.5 rounded-md bg-[#2d2d2d]">
                                        <Icon className="w-[18px] h-[18px]" />
                                    </div>
                                    <span className="flex-1">{item.name}</span>
                                </NavLink>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Integrations Toggle Button */}
            <button
                onClick={() => setIsOpen(prev => !prev)}
                className={`flex items-center gap-3 px-3 rounded-xl transition-all group w-full h-8 ${isOpen
                        ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 font-medium'
                        : 'text-secondary-600 dark:text-secondary-400 hover:bg-secondary-50 dark:hover:bg-secondary-700/50 hover:text-secondary-900 dark:hover:text-secondary-200'
                    }`}
                title={!sidebarOpen ? "Integrations" : undefined}
            >
                <Blocks
                    size={18}
                    className={`flex-shrink-0 transition-colors ${isOpen
                            ? 'text-primary-600 dark:text-primary-400'
                            : 'text-secondary-400 dark:text-secondary-500 group-hover:text-secondary-600 dark:group-hover:text-secondary-300'
                        }`}
                />
                {sidebarOpen && <span className="truncate text-sm">Integrations</span>}
            </button>
        </div>
    );
};

export default IntegrationMenu;
