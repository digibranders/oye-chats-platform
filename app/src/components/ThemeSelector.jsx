/* eslint-disable react-refresh/only-export-components */
import React, { useState } from 'react';
import { Layout, Smartphone, Cloud, Check, Eye, X } from 'lucide-react';
import ChatWindow from '../../../Frontend/src/components/ChatWindow';

export const themes = [
    {
        id: 'classic',
        name: 'Classic Indigo',
        icon: Layout,
        color: 'bg-[#3A0CA3]',
        previewBg: 'bg-indigo-50',
        gradientFrom: 'from-indigo-500',
        gradientTo: 'to-violet-600',
    },
    {
        id: 'modern',
        name: 'Modern Glass',
        icon: Smartphone,
        color: 'bg-[#4361EE]',
        previewBg: 'bg-slate-900',
        gradientFrom: 'from-blue-500',
        gradientTo: 'to-cyan-400',
    },
    {
        id: 'minimalist',
        name: 'Minimalist Mono',
        icon: Cloud,
        color: 'bg-gray-800',
        previewBg: 'bg-gray-100',
        gradientFrom: 'from-gray-700',
        gradientTo: 'to-gray-500',
    }
];

export default function ThemeSelector({ selectedTheme, onSelect }) {
    const [previewTheme, setPreviewTheme] = useState(null);

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {themes.map((theme) => {
                const Icon = theme.icon;
                const isSelected = selectedTheme === theme.id;

                return (
                    <div
                        key={theme.id}
                        onClick={() => onSelect(theme.id)}
                        className={`group relative cursor-pointer rounded-lg border-2 transition-all duration-300 overflow-hidden ${isSelected
                                ? 'border-primary-500 ring-4 ring-primary-500/15'
                                : 'border-surface-200 dark:border-surface-700 hover:border-primary-300'
                            }`}
                    >
                        {/* Card Visual Area */}
                        <div className={`h-36 bg-gradient-to-br ${theme.gradientFrom} ${theme.gradientTo} flex items-center justify-center relative`}>
                            {/* Decorative dots */}
                            <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)', backgroundSize: '18px 18px' }}></div>
                            <div className="w-14 h-14 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-lg border border-white/30">
                                <Icon className="w-7 h-7 text-white" />
                            </div>
                            {/* Selected badge */}
                            {isSelected && (
                                <div className="absolute top-3 right-3 w-7 h-7 bg-white rounded-full flex items-center justify-center shadow-lg">
                                    <Check className="w-4 h-4 text-primary-600" />
                                </div>
                            )}
                        </div>

                        {/* Card Footer */}
                        <div className="p-4 bg-white dark:bg-surface-900 flex items-center justify-between border-t border-surface-200 dark:border-surface-700">
                            <div>
                                <h3 className="font-semibold text-sm text-surface-900 dark:text-surface-100">{theme.name}</h3>
                                {isSelected && (
                                    <span className="text-[10px] font-bold text-primary-600 uppercase tracking-widest">Active</span>
                                )}
                            </div>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setPreviewTheme(theme.id);
                                }}
                                className="flex items-center gap-1.5 px-3 h-8 rounded-md bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-primary-500 hover:text-white transition-all text-xs font-semibold"
                            >
                                <Eye className="w-3.5 h-3.5" />
                                Preview
                            </button>
                        </div>
                    </div>
                );
            })}

            {/* Glassmorphism Preview Modal */}
            {previewTheme && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
                    {/* Backdrop */}
                    <div
                        className="absolute inset-0 bg-black/70 backdrop-blur-lg"
                        onClick={() => setPreviewTheme(null)}
                    ></div>

                    {/* Modal Content */}
                    <div className="relative z-10 w-full max-w-2xl bg-white/10 backdrop-blur-2xl rounded-[3rem] border border-white/20 shadow-[0_32px_120px_-15px_rgba(0,0,0,0.6)] flex flex-col items-center p-10 overflow-hidden">
                        {/* Glass accents */}
                        <div className="absolute -top-32 -left-32 w-72 h-72 bg-primary-500/20 rounded-full blur-[100px] pointer-events-none"></div>
                        <div className="absolute -bottom-32 -right-32 w-72 h-72 bg-cyan-500/20 rounded-full blur-[100px] pointer-events-none"></div>

                        <button
                            onClick={() => setPreviewTheme(null)}
                            className="absolute top-6 right-6 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all border border-white/15"
                        >
                            <X className="w-5 h-5" />
                        </button>

                        <div className="mb-8 text-center">
                            <h2 className="text-3xl font-black text-white tracking-tight mb-1">
                                {themes.find(t => t.id === previewTheme)?.name}
                            </h2>
                            <p className="text-white/50 text-sm font-medium">Live chatbot preview</p>
                        </div>

                        <div className="relative shadow-[0_20px_60px_rgba(0,0,0,0.5)] rounded-3xl overflow-hidden">
                            <ChatWindow theme={previewTheme} onClose={() => setPreviewTheme(null)} />
                        </div>

                        <div className="mt-8">
                            <button
                                onClick={() => {
                                    onSelect(previewTheme);
                                    setPreviewTheme(null);
                                }}
                                className="px-8 py-3.5 bg-white text-surface-900 rounded-2xl font-bold text-base hover:bg-primary-50 transition-all shadow-xl"
                            >
                                Use this Theme
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
