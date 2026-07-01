import { useState, useRef, useEffect } from 'react';
import { HexColorPicker } from 'react-colorful';

/**
 * Shared color-picker control for the Bot Settings tabs.
 *
 * Lifted verbatim from the legacy `Interface.jsx` monolith so the extracted
 * tabs keep identical behaviour and styling. (The image-cropping helper lives
 * in `cropImage.js` to keep this module component-only for Fast Refresh.)
 *
 * A labelled swatch + hex input that opens a popover color picker.
 *
 * @param {{ label: string, color: string, onChange: (hex: string) => void }} props
 */
export const ColorPickerControl = ({ label, color, onChange }) => {
    const [isOpen, setIsOpen] = useState(false);
    const popover = useRef();

    useEffect(() => {
        const close = (e) => {
            if (popover.current && !popover.current.contains(e.target)) {
                setIsOpen(false);
            }
        };
        if (isOpen) {
            document.addEventListener('mousedown', close);
            return () => document.removeEventListener('mousedown', close);
        }
        return undefined;
    }, [isOpen]);

    return (
        <div className="space-y-2">
            <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">{label}</label>
            <div className="relative">
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setIsOpen(!isOpen)}
                        className="w-10 h-10 rounded-lg shadow-sm border border-surface-200 dark:border-surface-700 flex-shrink-0 transition-transform hover:scale-105 active:scale-95"
                        style={{ backgroundColor: color || '#000000' }}
                    />
                    <div className="relative flex-grow max-w-[140px]">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 dark:text-surface-500 font-mono text-xs">#</span>
                        <input
                            type="text"
                            value={color ? color.replace('#', '').toUpperCase() : ''}
                            onChange={(e) => {
                                const val = e.target.value;
                                if (val.length <= 6 && /^[0-9A-Fa-f]*$/.test(val)) {
                                    onChange('#' + val);
                                }
                            }}
                            className="w-full h-9 pl-6 pr-3 text-sm font-mono text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-md focus:outline-none focus:border-primary-400 shadow-sm transition-colors"
                        />
                    </div>
                </div>

                {isOpen && (
                    <div
                        ref={popover}
                        className="absolute z-50 mt-2 p-3 bg-white dark:bg-surface-800 rounded-xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] border border-surface-200 dark:border-surface-700 animate-in fade-in zoom-in duration-200 origin-top-left"
                    >
                        <HexColorPicker color={color || '#000000'} onChange={onChange} />
                    </div>
                )}
            </div>
        </div>
    );
};
