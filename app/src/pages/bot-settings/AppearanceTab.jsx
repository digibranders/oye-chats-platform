import { useRef } from 'react';
import { HexColorPicker } from 'react-colorful';
import { Upload, Trash2, Image as ImageIcon, Palette, Sparkles, Check, RefreshCw, Bot } from 'lucide-react';
import { ColorPickerControl } from './shared';
import BrandingTab from './BrandingTab';

/**
 * AppearanceTab — visual identity.
 *
 * Merges three legacy sources: the General-tab colors (brand + user-bubble +
 * website-extracted recommendations), the Avatar tab (upload / orb / mascot),
 * and the Custom Brand tab (`BrandingTab` — branding text + URL) composed as a
 * sub-section.
 *
 * @param {object} props
 * @param {object} props.draft - Editable bot fields.
 * @param {(field: string, value: unknown) => void} props.set - Single-field updater.
 * @param {boolean} props.isUploading - Whether an avatar upload is in flight.
 * @param {(file: File) => void} props.onFile - Opens the shell's crop modal for a file.
 * @param {() => void} props.onRemoveLogo - Clears the uploaded avatar.
 */
export default function AppearanceTab({ draft, set, isUploading, onFile, onRemoveLogo }) {
    const inputRef = useRef(null);
    const recommendedColors = Array.isArray(draft.recommended_colors) ? draft.recommended_colors : [];

    // Adapt BrandingTab's legacy `{ settings, onSettingsChange }` contract to
    // the draft/set surface so the sub-section keeps its existing markup.
    const brandingOnChange = (updates) => {
        Object.entries(updates).forEach(([key, value]) => set(key, value));
    };

    return (
        <div className="flex flex-col gap-10">
            {/* ── Colors ── */}
            <div className="space-y-6 animate-fade-in">
                <div>
                    <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                        <Palette className="w-4 h-4 text-primary-500" />
                        Chatbot Colors
                    </h3>
                    <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                        Customize your chatbot interface colors. Match them with your brand.
                    </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-x gap-y-10 bg-surface-100/50 dark:bg-surface-800/50 p-8 rounded-2xl border border-surface-200 dark:border-surface-700">
                    {/* Manual Controls */}
                    <div className="space-y-8">
                        <div>
                            <ColorPickerControl
                                label="Brand Color"
                                color={draft.primary_color}
                                onChange={(c) => set('primary_color', c)}
                            />
                            <p className="text-[11px] text-surface-400 mt-1.5">Launcher button, avatar, accents, links</p>
                        </div>
                        <div>
                            <ColorPickerControl
                                label="User Bubble Color"
                                color={draft.user_bubble_color}
                                onChange={(c) => set('user_bubble_color', c)}
                            />
                            <p className="text-[11px] text-surface-400 mt-1.5">Message bubble background for visitor messages</p>
                        </div>
                    </div>

                    {/* Recommended Colors */}
                    <div className="lg:border-l lg:border-surface-200 dark:lg:border-surface-700 lg:pl-8">
                        {recommendedColors.length > 0 ? (
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 mb-1">
                                    <Sparkles className="w-4 h-4 text-primary-500 animate-pulse" />
                                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">Extracted from your Website</label>
                                </div>
                                <div className="space-y-2.5">
                                    {recommendedColors.slice(0, 6).map((color) => (
                                        <div key={color} className="flex items-center gap-2.5 group">
                                            <div
                                                className="w-8 h-8 rounded-md shadow-sm border border-surface-200 dark:border-surface-700 flex-shrink-0 transition-transform group-hover:scale-110 cursor-pointer"
                                                style={{ backgroundColor: color }}
                                                title={color}
                                            />
                                            <div className="relative w-[100px]">
                                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400 font-mono text-[10px]">#</span>
                                                <div className="w-full h-8 pl-5 pr-2 text-[12px] font-mono text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-md shadow-sm flex items-center">
                                                    {color.replace('#', '').toUpperCase()}
                                                </div>
                                            </div>
                                            <div className="flex gap-1 ml-auto">
                                                <button
                                                    onClick={() => set('primary_color', color)}
                                                    className="px-2 py-1 text-[8px] font-bold bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400 rounded hover:bg-primary-500 hover:text-white transition-all uppercase tracking-wider leading-none"
                                                >Brand</button>
                                                <button
                                                    onClick={() => set('user_bubble_color', color)}
                                                    className="px-2 py-1 text-[8px] font-bold bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400 rounded hover:bg-blue-500 hover:text-white transition-all uppercase tracking-wider leading-none"
                                                >Bubble</button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-center py-10 opacity-50">
                                <Sparkles className="w-8 h-8 mb-2 text-surface-600 dark:text-surface-300" />
                                <p className="text-[10px] font-bold text-surface-500 dark:text-surface-400 uppercase tracking-widest">No brand colors detected</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Avatar ── */}
            <div className="space-y-6 animate-fade-in border-t border-surface-200 dark:border-surface-700 pt-8">
                <div>
                    <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                        <ImageIcon className="w-4 h-4 text-primary-500" />
                        Chatbot Avatar Style
                    </h3>
                    <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">Choose how your chatbot avatar appears to visitors.</p>
                </div>

                {/* Avatar Type Selection Cards */}
                <div className="grid grid-cols-3 gap-3">
                    {[
                        { key: 'upload', label: 'Upload Photo', icon: <Upload className="w-5 h-5" />, desc: 'Custom image' },
                        {
                            key: 'orb', label: 'Orb', icon: (
                                <div className="w-5 h-5 rounded-full" style={{ background: `radial-gradient(circle at 35% 35%, ${(draft.orb_color || draft.primary_color)}88, ${draft.orb_color || draft.primary_color})` }} />
                            ), desc: 'Animated gradient'
                        },
                        { key: 'mascot', label: 'Mascot', icon: <Bot className="w-5 h-5" />, desc: 'Robot character' },
                    ].map((opt) => {
                        const isSelected = draft.avatar_type === opt.key;
                        const hasUpload = opt.key === 'upload' && draft.bot_logo;
                        return (
                            <button
                                key={opt.key}
                                onClick={() => set('avatar_type', opt.key)}
                                className={`relative flex flex-col items-center gap-2 p-5 rounded-xl border-2 transition-all duration-200 ${isSelected
                                    ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-500/10 shadow-sm ring-1 ring-emerald-500/20'
                                    : 'border-surface-200 dark:border-surface-600 hover:border-surface-300 dark:hover:border-surface-500 bg-white dark:bg-surface-900'
                                    }`}
                            >
                                {isSelected && (
                                    <div className="absolute top-2 right-2">
                                        <Check className="w-4 h-4 text-emerald-500" />
                                    </div>
                                )}
                                {!isSelected && hasUpload && (
                                    <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 bg-emerald-100 dark:bg-emerald-500/20 rounded-full">
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                        <span className="text-[8px] font-bold text-emerald-600 dark:text-emerald-400 uppercase">Uploaded</span>
                                    </div>
                                )}
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors overflow-hidden ${isSelected
                                    ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                                    : 'bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400'
                                    }`}>
                                    {opt.key === 'upload' && draft.bot_logo ? (
                                        <img src={draft.bot_logo} alt="avatar" className="w-full h-full object-cover" />
                                    ) : opt.icon}
                                </div>
                                <span className={`text-[13px] font-bold ${isSelected
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : 'text-surface-700 dark:text-surface-300'
                                    }`}>{opt.label}</span>
                                <span className="text-[11px] text-surface-400">{opt.desc}</span>
                            </button>
                        );
                    })}
                </div>

                {/* Conditional content based on avatar type */}
                {draft.avatar_type === 'upload' && (
                    <div className="space-y-3 animate-fade-in">
                        <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">Upload Avatar Image</label>
                        <input
                            ref={inputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                                onFile(e.target.files[0]);
                                e.target.value = '';
                            }}
                        />

                        {!draft.bot_logo ? (
                            <div
                                onClick={() => inputRef.current?.click()}
                                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-primary-500', 'bg-primary-50'); }}
                                onDragLeave={(e) => { e.currentTarget.classList.remove('border-primary-500', 'bg-primary-50'); }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    e.currentTarget.classList.remove('border-primary-500', 'bg-primary-50');
                                    const file = e.dataTransfer.files?.[0];
                                    if (file) onFile(file);
                                }}
                                className="w-full max-w-lg border-2 border-dashed border-surface-200 dark:border-surface-700 rounded-xl p-6 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-primary-400 hover:bg-primary-50/30 dark:hover:bg-primary-900/5 transition-all group"
                            >
                                {isUploading ? (
                                    <div className="flex flex-col items-center gap-2">
                                        <RefreshCw className="w-6 h-6 text-primary-500 animate-spin" />
                                        <span className="text-[13px] font-semibold text-primary-500">Uploading...</span>
                                    </div>
                                ) : (
                                    <>
                                        <div className="w-12 h-12 rounded-full bg-surface-100 dark:bg-surface-800 flex items-center justify-center group-hover:bg-primary-100 dark:group-hover:bg-primary-900/20 transition-colors">
                                            <Upload className="w-5 h-5 text-surface-400 group-hover:text-primary-500 transition-colors" />
                                        </div>
                                        <div className="text-center">
                                            <p className="text-[13px] font-semibold text-surface-700 dark:text-surface-300">
                                                <span className="text-primary-500">Click to upload</span> or drag and drop
                                            </p>
                                            <p className="text-[11px] text-surface-400 mt-0.5">PNG, JPG, SVG up to 2MB</p>
                                        </div>
                                    </>
                                )}
                            </div>
                        ) : (
                            <div className="w-full max-w-lg bg-surface-50/50 dark:bg-surface-800/50 border border-surface-200 dark:border-surface-700 rounded-xl p-4 flex items-center gap-4">
                                <div className="w-14 h-14 rounded-xl bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 flex items-center justify-center overflow-hidden flex-shrink-0 shadow-sm">
                                    <img src={draft.bot_logo} alt="avatar" className="w-full h-full object-cover" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <span className="text-[13px] font-semibold text-surface-900 dark:text-surface-100 truncate">Avatar Active</span>
                                        <span className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/20 rounded-full uppercase">
                                            <Check className="w-2.5 h-2.5" /> Uploaded
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-surface-400">Click below to replace or remove</p>
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                    <button
                                        onClick={() => inputRef.current?.click()}
                                        className="w-8 h-8 rounded-lg bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 flex items-center justify-center hover:border-primary-400 hover:text-primary-500 transition-colors shadow-sm"
                                        title="Replace image"
                                    >
                                        <Upload className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                        onClick={onRemoveLogo}
                                        className="w-8 h-8 rounded-lg bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 flex items-center justify-center hover:border-rose-400 hover:text-rose-500 dark:hover:border-rose-500 dark:hover:text-rose-400 text-surface-400 transition-colors shadow-sm"
                                        title="Remove image"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {draft.avatar_type === 'orb' && (() => {
                    const activeOrbColor = draft.orb_color || draft.primary_color;
                    return (
                        <div className="space-y-5 animate-fade-in">
                            <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">Orb Preview</label>
                            <div className="flex items-center gap-6 p-6 bg-surface-50/50 dark:bg-surface-800/50 border border-surface-200 dark:border-surface-700 rounded-xl">
                                <div
                                    className="w-20 h-20 rounded-full flex-shrink-0"
                                    style={{
                                        background: `radial-gradient(circle at 35% 35%, ${activeOrbColor}44, ${activeOrbColor}bb, ${activeOrbColor})`,
                                        boxShadow: `0 0 20px ${activeOrbColor}55, 0 0 40px ${activeOrbColor}22`,
                                        animation: 'pulse 2.5s ease-in-out infinite',
                                    }}
                                />
                                <div>
                                    <p className="text-[13px] font-semibold text-surface-900 dark:text-surface-100">Animated Orb</p>
                                    <p className="text-[11px] text-surface-400 dark:text-surface-500 mt-1">A pulsing gradient orb. Pick a color below or use your primary color.</p>
                                </div>
                            </div>

                            <div>
                                <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">Orb Color</label>
                                <p className="text-[11px] text-surface-400 dark:text-surface-500 mt-0.5 mb-3">Pick any color for the orb using the picker, or use your primary color.</p>

                                <button
                                    type="button"
                                    onClick={() => set('orb_color', draft.orb_color ? '' : draft.primary_color)}
                                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-[12px] font-semibold transition-all mb-4 ${!draft.orb_color
                                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-500/20'
                                        : 'border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:border-surface-300 dark:hover:border-surface-500'
                                        }`}
                                >
                                    <div className="w-5 h-5 rounded-full border-2 border-white shadow-sm" style={{ backgroundColor: draft.primary_color }} />
                                    {!draft.orb_color ? <><Check className="w-3.5 h-3.5" /> Using Primary Color</> : 'Use Primary Color'}
                                </button>

                                <div className="p-6 bg-surface-50/50 dark:bg-surface-800/50 border border-surface-200 dark:border-surface-700 rounded-xl">
                                    <div className="orb-color-picker">
                                        <HexColorPicker
                                            color={activeOrbColor}
                                            onChange={(color) => set('orb_color', color)}
                                        />
                                    </div>

                                    <div className="flex items-center gap-3 mt-4">
                                        <div
                                            className="w-10 h-10 rounded-lg shadow-sm border border-surface-200 dark:border-surface-700 flex-shrink-0"
                                            style={{ backgroundColor: activeOrbColor }}
                                        />
                                        <div className="relative flex-grow max-w-[140px]">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 font-mono text-xs">#</span>
                                            <input
                                                type="text"
                                                value={activeOrbColor.replace('#', '').toUpperCase()}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    if (val.length <= 6 && /^[0-9A-Fa-f]*$/.test(val)) {
                                                        set('orb_color', '#' + val);
                                                    }
                                                }}
                                                className="w-full h-9 pl-6 pr-3 text-sm font-mono text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-md focus:outline-none focus:border-primary-400 shadow-sm transition-colors"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {draft.avatar_type === 'mascot' && (
                    <div className="space-y-4 animate-fade-in">
                        <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">Mascot Preview</label>
                        <div className="flex items-center gap-6 p-6 bg-surface-50/50 dark:bg-surface-800/50 border border-surface-200 dark:border-surface-700 rounded-xl">
                            <div
                                className="w-20 h-20 rounded-full flex-shrink-0 flex items-center justify-center"
                                style={{ backgroundColor: draft.primary_color }}
                            >
                                <Bot className="w-10 h-10 text-white" />
                            </div>
                            <div>
                                <p className="text-[13px] font-semibold text-surface-900 dark:text-surface-100">Robot Mascot</p>
                                <p className="text-[11px] text-surface-400 dark:text-surface-500 mt-1">A friendly robot icon on your brand color background. Change the brand color above.</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Custom Brand (branding text + URL) ── */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-8">
                <BrandingTab settings={draft} onSettingsChange={brandingOnChange} />
            </div>
        </div>
    );
}
