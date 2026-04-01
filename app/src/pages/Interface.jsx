import React, { useState, useRef, useEffect, useCallback } from 'react';
import { getAuthState } from '../utils/auth';
import { HexColorPicker } from 'react-colorful';
import Cropper from 'react-easy-crop';
import { Upload, Trash2, CheckCircle, Image as ImageIcon, Settings2, RefreshCw, Palette, ChevronDown, ArrowUp, Bot, Sparkles, Check, AlertCircle, X, ZoomIn, ZoomOut, RotateCw, Paperclip, ThumbsUp, ThumbsDown, Copy, Plus } from 'lucide-react';
import { getClientSettings, updateClientSettings, uploadLogo } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import EmptyState from '../components/ui/EmptyState';

// Helper: create cropped image from canvas (supports rotation)
const getCroppedImg = (imageSrc, pixelCrop, rotation = 0) => {
    return new Promise((resolve) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            const rad = (rotation * Math.PI) / 180;
            const sin = Math.abs(Math.sin(rad));
            const cos = Math.abs(Math.cos(rad));
            const bBoxW = image.width * cos + image.height * sin;
            const bBoxH = image.width * sin + image.height * cos;

            // Draw rotated full image onto temp canvas
            const rotCanvas = document.createElement('canvas');
            rotCanvas.width = bBoxW;
            rotCanvas.height = bBoxH;
            const rotCtx = rotCanvas.getContext('2d');
            rotCtx.translate(bBoxW / 2, bBoxH / 2);
            rotCtx.rotate(rad);
            rotCtx.drawImage(image, -image.width / 2, -image.height / 2);

            // Crop from rotated canvas
            canvas.width = pixelCrop.width;
            canvas.height = pixelCrop.height;
            ctx.drawImage(
                rotCanvas,
                pixelCrop.x, pixelCrop.y,
                pixelCrop.width, pixelCrop.height,
                0, 0,
                pixelCrop.width, pixelCrop.height
            );
            canvas.toBlob((blob) => resolve(blob), 'image/png', 1);
        };
        image.src = imageSrc;
    });
};

const ColorPickerControl = ({ label, color, onChange }) => {
    const [isOpen, setIsOpen] = useState(false);
    const popover = useRef();

    const close = (e) => {
        if (popover.current && !popover.current.contains(e.target)) {
            setIsOpen(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            document.addEventListener('mousedown', close);
            return () => document.removeEventListener('mousedown', close);
        }
    }, [isOpen]);

    return (
        <div className="space-y-2">
            <label className="text-[13px] font-bold text-secondary-700">{label}</label>
            <div className="relative">
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setIsOpen(!isOpen)}
                        className="w-10 h-10 rounded-lg shadow-sm border border-secondary-200 flex-shrink-0 transition-transform hover:scale-105 active:scale-95"
                        style={{ backgroundColor: color || '#000000' }}
                    />
                    <div className="relative flex-grow max-w-[140px]">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary-400 font-mono text-xs">#</span>
                        <input
                            type="text"
                            value={color ? color.replace('#', '').toUpperCase() : ''}
                            onChange={(e) => {
                                const val = e.target.value;
                                if (val.length <= 6 && /^[0-9A-Fa-f]*$/.test(val)) {
                                    onChange('#' + val);
                                }
                            }}
                            className="w-full h-9 pl-6 pr-3 text-sm font-mono text-secondary-600 bg-white border border-secondary-200 rounded-md focus:outline-none focus:border-primary-400 shadow-sm transition-colors"
                        />
                    </div>
                </div>

                {isOpen && (
                    <div
                        ref={popover}
                        className="absolute z-50 mt-2 p-3 bg-white rounded-xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] border border-secondary-200 animate-in fade-in zoom-in duration-200 origin-top-left"
                    >
                        <HexColorPicker color={color || '#000000'} onChange={onChange} />
                    </div>
                )}
            </div>
        </div>
    );
};

export default function Interface({ embedded = false }) {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const { isBotManager } = getAuthState();
    const [logo, setLogo] = useState(null); // base64 data URL
    const [isSaving, setIsSaving] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [botName, setBotName] = useState('AI Assistant');
    const [launcherName, setLauncherName] = useState('Have Questions?');
    const [launcherLogo, setLauncherLogo] = useState(null);
    const [primaryColor, setPrimaryColor] = useState('#ba68c8');
    const [userBubbleColor, setUserBubbleColor] = useState('#DBE9FF');
    const [recommendedColors, setRecommendedColors] = useState([]);
    const [bantEnabled, setBantEnabled] = useState(true);
    const [avatarType, setAvatarType] = useState('upload');
    const [orbColor, setOrbColor] = useState('');
    const [leadFormEnabled, setLeadFormEnabled] = useState(false);
    const [leadFormFields, setLeadFormFields] = useState([
        { field: 'name', required: true },
        { field: 'email', required: true },
    ]);
    const [notificationEmail, setNotificationEmail] = useState('');
    const [emailOnQualified, setEmailOnQualified] = useState(true);
    const [emailOnHandoff, setEmailOnHandoff] = useState(true);
    const [liveChatEnabled, setLiveChatEnabled] = useState(true);
    const [activeTab, setActiveTab] = useState('General');
    const inputRef = useRef(null);

    // Crop state
    const [showCropModal, setShowCropModal] = useState(false);
    const [cropImage, setCropImage] = useState(null);
    const [cropFileName, setCropFileName] = useState('');
    const [crop, setCrop] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

    const onCropComplete = useCallback((croppedArea, croppedAreaPx) => {
        setCroppedAreaPixels(croppedAreaPx);
    }, []);

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const settings = await getClientSettings(selectedBot?.id);
                setBotName(settings.bot_name || 'AI Assistant');
                setLauncherName(settings.launcher_name || 'Have Questions?');
                setPrimaryColor(settings.primary_color || '#ba68c8');
                setUserBubbleColor(settings.user_bubble_color || '#DBE9FF');
                setRecommendedColors(settings.recommended_colors || []);
                setBantEnabled(settings.bant_enabled ?? true);
                setAvatarType(settings.avatar_type || 'upload');
                setOrbColor(settings.orb_color || '');
                setLeadFormEnabled(settings.lead_form_enabled ?? false);
                if (settings.lead_form_fields) setLeadFormFields(settings.lead_form_fields);
                setNotificationEmail(settings.notification_email || '');
                setEmailOnQualified(settings.email_on_qualified ?? true);
                setEmailOnHandoff(settings.email_on_handoff ?? true);
                setLiveChatEnabled(settings.live_chat_enabled ?? true);
                if (settings.bot_logo) {
                    setLogo(settings.bot_logo);
                } else {
                    setLogo(null);
                }
                if (settings.launcher_logo) {
                    setLauncherLogo(settings.launcher_logo);
                } else {
                    setLauncherLogo(null);
                }
            } catch (error) {
                console.error("Error fetching settings:", error);
                showToast('error', error.message || 'Failed to load widget settings');
            }
        };
        fetchSettings();
    }, [selectedBot?.id]);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Appearance" description="Create a chatbot first, then customize its colors, logo, and appearance here." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    const tabs = ['General', 'Avatar', 'Leads Form', 'Custom Brand'];

    const handleFile = (file) => {
        if (!isBotManager) return;
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            alert('Please upload an image file.');
            return;
        }
        // Open crop modal instead of uploading directly
        const reader = new FileReader();
        reader.onload = () => {
            setCropImage(reader.result);
            setCropFileName(file.name);
            setCrop({ x: 0, y: 0 });
            setZoom(1);
            setRotation(0);
            setShowCropModal(true);
        };
        reader.readAsDataURL(file);
    };

    const handleCropConfirm = async () => {
        if (!isBotManager) return;
        if (!croppedAreaPixels || !cropImage) return;
        setShowCropModal(false);
        setIsUploading(true);
        try {
            const croppedBlob = await getCroppedImg(cropImage, croppedAreaPixels, rotation);
            const croppedFile = new File([croppedBlob], cropFileName || 'avatar.png', { type: 'image/png' });
            const result = await uploadLogo(croppedFile);
            const publicUrl = result.url;

            setLogo(publicUrl);
            setLauncherLogo(publicUrl);
        } catch (error) {
            console.error("Error uploading logo:", error);
            alert("Failed to upload logo: " + (error.detail || error));
        } finally {
            setIsUploading(false);
            setCropImage(null);
        }
    };

    const handleSave = async () => {
        if (!isBotManager) return;
        setIsSaving(true);
        setSaveError(null);
        try {
            const payload = {
                bot_name: botName,
                bot_logo: logo,
                launcher_name: launcherName,
                launcher_logo: launcherLogo,
                primary_color: primaryColor,
                user_bubble_color: userBubbleColor,
                background_color: '#ffffff',
                bant_enabled: bantEnabled,
                avatar_type: avatarType,
                orb_color: orbColor || null,
                lead_form_enabled: leadFormEnabled,
                lead_form_fields: leadFormFields,
                notification_email: notificationEmail || null,
                email_on_qualified: emailOnQualified,
                email_on_handoff: emailOnHandoff,
                live_chat_enabled: liveChatEnabled
            };
            console.log('[Interface] Saving settings:', payload, 'botId:', selectedBot?.id);
            await updateClientSettings(payload, selectedBot?.id);
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (error) {
            console.error("Error saving settings:", error);
            const msg = typeof error === 'string' ? error : error?.detail || error?.message || 'Failed to save settings';
            setSaveError(msg);
            setTimeout(() => setSaveError(null), 5000);
        } finally {
            setIsSaving(false);
        }
    };

    const handleRemove = () => {
        if (!isBotManager) return;
        setLogo(null);
        setLauncherLogo(null);
    };

    return (
        <div className="max-w-6xl mx-auto space-y-6 animate-fade-in pb-20">
            {/* Error Toast */}
            {saveError && (
                <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-5 py-3 rounded-xl shadow-lg border bg-error-50 border-error-500/20 text-error-600 animate-fade-in">
                    <AlertCircle size={18} />
                    <span className="text-sm font-medium">{saveError}</span>
                    <button onClick={() => setSaveError(null)} className="ml-2 p-0.5 rounded hover:bg-black/10:bg-white/10 transition-colors">
                        <X size={14} />
                    </button>
                </div>
            )}
            {/* Page Header */}
            {!embedded && (
                <div>
                    <h1 className="text-2xl font-bold text-secondary-900 tracking-tight">Appearance</h1>
                    <p className="text-secondary-500 mt-1 text-sm">Customize how your chatbot looks</p>
                    {!isBotManager && (
                        <p className="mt-2 text-sm text-secondary-500">
                            You have read-only access to this bot configuration.
                        </p>
                    )}
                </div>
            )}

            {/* Tab Navigation Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-secondary-200 w-full">
                <div className="flex items-center gap-1 bg-secondary-100 p-1 rounded-xl w-full max-w-4xl overflow-x-auto no-scrollbar">
                    {tabs.map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`flex-1 min-w-max px-3 py-2 text-[12px] rounded-lg transition-all ${activeTab === tab
                                    ? 'bg-white text-secondary-900 shadow-sm font-semibold'
                                    : 'text-secondary-500 font-medium hover:text-secondary-700:text-secondary-200'
                                }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>

                <button
                    onClick={handleSave}
                    disabled={!isBotManager || isSaving || saved}
                    className={`group relative flex items-center gap-2 px-5 h-10 rounded-xl shadow-sm transition-all font-medium text-sm disabled:opacity-70 overflow-hidden ${saved
                        ? 'bg-success-500 hover:bg-success-600 text-white'
                        : 'bg-primary-600 hover:bg-primary-700 text-white'
                        }`}
                >
                    <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
                    {saved ? (
                        <>
                            <CheckCircle className="w-4 h-4 relative z-10" />
                            <span className="relative z-10">Saved!</span>
                        </>
                    ) : isSaving ? (
                        <>
                            <RefreshCw className="w-4 h-4 relative z-10 animate-spin" />
                            <span className="relative z-10">Saving...</span>
                        </>
                    ) : (
                        <>
                            <CheckCircle className="w-4 h-4 relative z-10" />
                            <span className="relative z-10">Save Configuration</span>
                        </>
                    )}
                </button>
            </div>

            <div className="flex flex-col lg:flex-row gap-8 items-start w-full">
                {/* Left Side: 60% Configuration Column */}
                <div className="w-full lg:w-[60%] flex flex-col gap-10 lg:pr-6">
                    {activeTab === 'General' ? (
                        <>
                            {/* Chatbot Display Name Section */}
                            <div className="space-y-3 animate-fade-in">
                                <div>
                                    <h3 className="text-[15px] font-bold text-secondary-900 flex items-center gap-2">
                                        <Bot className="w-4 h-4 text-primary-500" />
                                        Chatbot Display Name
                                    </h3>
                                    {/* <p className="text-[13px] text-secondary-500 mt-0.5">This name is seen by those who interact with your chat (e.g. customers)</p> */}
                                </div>
                                <input
                                    type="text"
                                    value={botName}
                                    onChange={(e) => setBotName(e.target.value)}
                                    maxLength={40}
                                    placeholder="e.g. AI Assistant, Support Bot..."
                                    className="w-full max-w-lg h-10 px-3 rounded-md border border-secondary-200 bg-white text-sm text-secondary-900 placeholder-secondary-400 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 transition-all shadow-sm"
                                />
                            </div>

                            {/* Launcher Customization Section */}
                            {/* <div className="space-y-6 animate-fade-in" style={{ animationDelay: '0.07s' }}>
                                <div className="pt-4 border-t border-secondary-100">
                                    <h3 className="text-[15px] font-bold text-secondary-900 flex items-center gap-2">
                                        <Settings2 className="w-4 h-4 text-primary-500" />
                                        Launcher Customization
                                    </h3>
                                    <p className="text-[13px] text-secondary-500 mt-0.5">Customize how your chatbot launcher looks to visitors</p>
                                </div>

                                <div className="space-y-4">
                                    <div className="space-y-2">
                                        <label className="text-[13px] font-bold text-secondary-700">Launcher Tooltip Text</label>
                                        <input
                                            type="text"
                                            value={launcherName}
                                            onChange={(e) => setLauncherName(e.target.value)}
                                            maxLength={50}
                                            placeholder="e.g. Have Questions? I'm here to help!"
                                            className="w-full max-w-lg h-10 px-3 rounded-md border border-secondary-200 bg-white text-sm text-secondary-900 placeholder-secondary-400 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 transition-all shadow-sm"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-[13px] font-bold text-secondary-700">Launcher Image</label>
                                        <div className="flex items-center w-full max-w-lg">
                                            <input
                                                id="launcher-input"
                                                type="file"
                                                accept="image/*"
                                                className="hidden"
                                                onChange={(e) => handleFile(e.target.files[0], 'launcher')}
                                            />
                                            <div 
                                                onClick={() => document.getElementById('launcher-input').click()}
                                                className="w-full min-h-[40px] px-3 py-2 flex items-center justify-between rounded-md border border-secondary-200 bg-white cursor-pointer hover:border-primary-400 transition-colors shadow-sm"
                                            >
                                                <span className={`text-[13px] ${launcherLogo ? 'text-secondary-900 font-medium' : 'text-secondary-400'}`}>
                                                    {launcherLogo ? launcherLogoName || 'Custom Launcher Active' : 'Choose Launcher Image'}
                                                </span>
                                                {launcherLogo && (
                                                    <img src={launcherLogo} alt="launcher preview" className="w-8 h-8 object-cover rounded-full flex-shrink-0 bg-secondary-50 border border-secondary-200" />
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <button 
                                                onClick={() => document.getElementById('launcher-input').click()}
                                                className="px-4 h-8 rounded-md border border-secondary-200 bg-white text-secondary-700 text-[12px] font-bold tracking-wide hover:bg-secondary-50:bg-secondary-700/50 transition-colors shadow-sm"
                                            >
                                                Upload Launcher Image
                                            </button>
                                            {launcherLogo && (
                                                <button
                                                    onClick={() => handleRemove('launcher')}
                                                    className="text-[12px] font-bold text-red-500 hover:text-red-600 transition-colors flex items-center gap-1"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" /> Remove
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div> */}

                            {/* Chatbot Colors */}
                            <div className="space-y-6 animate-fade-in" style={{ animationDelay: '0.1s' }}>
                                <div>
                                    <h3 className="text-[15px] font-bold text-secondary-900 flex items-center gap-2">
                                        <Palette className="w-4 h-4 text-primary-500" />
                                        Chatbot Colors
                                    </h3>
                                    <p className="text-[13px] text-secondary-500 mt-0.5">
                                        Customize your chatbot interface colors. Match them with your brand.
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-x gap-y-10 bg-secondary-50/50 p-8 rounded-2xl border border-secondary-200 animate-fade-in" style={{ animationDelay: '0.1s' }}>
                                    {/* Left Column: Manual Controls */}
                                    <div className="space-y-8">
                                        <div>
                                            <ColorPickerControl
                                                label="Brand Color"
                                                color={primaryColor}
                                                onChange={setPrimaryColor}
                                            />
                                            <p className="text-[11px] text-secondary-400 mt-1.5">Launcher button, avatar, accents, links</p>
                                        </div>
                                        <div>
                                            <ColorPickerControl
                                                label="User Bubble Color"
                                                color={userBubbleColor}
                                                onChange={setUserBubbleColor}
                                            />
                                            <p className="text-[11px] text-secondary-400 mt-1.5">Message bubble background for visitor messages</p>
                                        </div>
                                    </div>

                                    {/* Right Column: Recommended Colors Section */}
                                    <div className="lg:border-l lg:border-secondary-200 lg: lg:pl-8">
                                        {recommendedColors.length > 0 ? (
                                            <div className="space-y-4">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Sparkles className="w-4 h-4 text-primary-500 animate-pulse" />
                                                    <label className="text-[13px] font-bold text-secondary-700">Extracted from your Website</label>
                                                </div>
                                                <div className="space-y-2.5">
                                                    {recommendedColors.slice(0, 6).map((color) => (
                                                        <div key={color} className="flex items-center gap-2.5 group">
                                                            <div
                                                                className="w-8 h-8 rounded-md shadow-sm border border-secondary-200 flex-shrink-0 transition-transform group-hover:scale-110 cursor-pointer"
                                                                style={{ backgroundColor: color }}
                                                                title={color}
                                                            />
                                                            <div className="relative w-[100px]">
                                                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-secondary-400 font-mono text-[10px]">#</span>
                                                                <div className="w-full h-8 pl-5 pr-2 text-[12px] font-mono text-secondary-600 bg-white border border-secondary-200 rounded-md shadow-sm flex items-center">
                                                                    {color.replace('#', '').toUpperCase()}
                                                                </div>
                                                            </div>
                                                            <div className="flex gap-1 ml-auto">
                                                                <button
                                                                    onClick={() => setPrimaryColor(color)}
                                                                    className="px-2 py-1 text-[8px] font-bold bg-secondary-100 text-secondary-500 rounded hover:bg-primary-500 hover:text-white transition-all uppercase tracking-wider leading-none"
                                                                >Brand</button>
                                                                <button
                                                                    onClick={() => setUserBubbleColor(color)}
                                                                    className="px-2 py-1 text-[8px] font-bold bg-secondary-100 text-secondary-500 rounded hover:bg-blue-500 hover:text-white transition-all uppercase tracking-wider leading-none"
                                                                >Bubble</button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-center justify-center h-full text-center py-10 opacity-50">
                                                <Sparkles className="w-8 h-8 mb-2 text-secondary-300" />
                                                <p className="text-[10px] font-bold text-secondary-500 uppercase tracking-widest">No brand colors detected</p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : activeTab === 'Avatar' ? (
                        <div className="space-y-6 animate-fade-in">
                            <div>
                                <h3 className="text-[15px] font-bold text-secondary-900 flex items-center gap-2">
                                    <ImageIcon className="w-4 h-4 text-primary-500" />
                                    Chatbot Avatar Style
                                </h3>
                                <p className="text-[13px] text-secondary-500 mt-0.5">Choose how your chatbot avatar appears to visitors.</p>
                            </div>

                            {/* Avatar Type Selection Cards */}
                            <div className="grid grid-cols-3 gap-3">
                                {[
                                    { key: 'upload', label: 'Upload Photo', icon: <Upload className="w-5 h-5" />, desc: 'Custom image' },
                                    {
                                        key: 'orb', label: 'Orb', icon: (
                                            <div className="w-5 h-5 rounded-full" style={{ background: `radial-gradient(circle at 35% 35%, ${(orbColor || primaryColor)}88, ${orbColor || primaryColor})` }} />
                                        ), desc: 'Animated gradient'
                                    },
                                    { key: 'mascot', label: 'Mascot', icon: <Bot className="w-5 h-5" />, desc: 'Robot character' },
                                ].map((opt) => {
                                    const isSelected = avatarType === opt.key;
                                    const hasUpload = opt.key === 'upload' && logo;
                                    return (
                                        <button
                                            key={opt.key}
                                            onClick={() => setAvatarType(opt.key)}
                                            className={`relative flex flex-col items-center gap-2 p-5 rounded-xl border-2 transition-all duration-200 ${isSelected
                                                    ? 'border-green-500 bg-green-50/50 shadow-sm ring-1 ring-green-500/20'
                                                    : 'border-secondary-200 hover:border-secondary-300:border-secondary-600 bg-white'
                                                }`}
                                        >
                                            {isSelected && (
                                                <div className="absolute top-2 right-2">
                                                    <Check className="w-4 h-4 text-green-500" />
                                                </div>
                                            )}
                                            {/* Show uploaded badge on Upload Photo card even when not selected */}
                                            {!isSelected && hasUpload && (
                                                <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 bg-green-100 rounded-full">
                                                    <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                                                    <span className="text-[8px] font-bold text-green-600 uppercase">Uploaded</span>
                                                </div>
                                            )}
                                            <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors overflow-hidden ${isSelected
                                                    ? 'bg-green-100 text-green-600'
                                                    : 'bg-secondary-100 text-secondary-500'
                                                }`}>
                                                {/* Show thumbnail on Upload card if image exists */}
                                                {opt.key === 'upload' && logo ? (
                                                    <img src={logo} alt="avatar" className="w-full h-full object-cover" />
                                                ) : opt.icon}
                                            </div>
                                            <span className={`text-[13px] font-bold ${isSelected
                                                    ? 'text-green-700'
                                                    : 'text-secondary-700'
                                                }`}>{opt.label}</span>
                                            <span className="text-[11px] text-secondary-400">{opt.desc}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            {/* Conditional content based on avatar type */}
                            {avatarType === 'upload' && (
                                <div className="space-y-3 animate-fade-in">
                                    <label className="text-[13px] font-bold text-secondary-700">Upload Avatar Image</label>
                                    <input
                                        ref={inputRef}
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={(e) => {
                                            handleFile(e.target.files[0]);
                                            e.target.value = '';
                                        }}
                                    />

                                    {!logo ? (
                                        <div
                                            onClick={() => inputRef.current?.click()}
                                            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-primary-500', 'bg-primary-50', ''); }}
                                            onDragLeave={(e) => { e.currentTarget.classList.remove('border-primary-500', 'bg-primary-50', ''); }}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                e.currentTarget.classList.remove('border-primary-500', 'bg-primary-50', '');
                                                const file = e.dataTransfer.files?.[0];
                                                if (file) handleFile(file);
                                            }}
                                            className="w-full max-w-lg border-2 border-dashed border-secondary-200 rounded-xl p-6 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-primary-400 hover:bg-primary-50/30:bg-primary-900/5 transition-all group"
                                        >
                                            {isUploading ? (
                                                <div className="flex flex-col items-center gap-2">
                                                    <RefreshCw className="w-6 h-6 text-primary-500 animate-spin" />
                                                    <span className="text-[13px] font-semibold text-primary-500">Uploading...</span>
                                                </div>
                                            ) : (
                                                <>
                                                    <div className="w-12 h-12 rounded-full bg-secondary-100 flex items-center justify-center group-hover:bg-primary-100:bg-primary-900/20 transition-colors">
                                                        <Upload className="w-5 h-5 text-secondary-400 group-hover:text-primary-500 transition-colors" />
                                                    </div>
                                                    <div className="text-center">
                                                        <p className="text-[13px] font-semibold text-secondary-700">
                                                            <span className="text-primary-500">Click to upload</span> or drag and drop
                                                        </p>
                                                        <p className="text-[11px] text-secondary-400 mt-0.5">PNG, JPG, SVG up to 2MB</p>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="w-full max-w-lg bg-secondary-50/50 border border-secondary-200 rounded-xl p-4 flex items-center gap-4">
                                            <div className="w-14 h-14 rounded-xl bg-white border border-secondary-200 flex items-center justify-center overflow-hidden flex-shrink-0 shadow-sm">
                                                <img src={logo} alt="avatar" className="w-full h-full object-cover" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-0.5">
                                                    <span className="text-[13px] font-semibold text-secondary-900 truncate">Avatar Active</span>
                                                    <span className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold text-green-600 bg-green-100 rounded-full uppercase">
                                                        <Check className="w-2.5 h-2.5" /> Uploaded
                                                    </span>
                                                </div>
                                                <p className="text-[11px] text-secondary-400">Click below to replace or remove</p>
                                            </div>
                                            <div className="flex items-center gap-2 flex-shrink-0">
                                                <button
                                                    onClick={() => inputRef.current?.click()}
                                                    className="w-8 h-8 rounded-lg bg-white border border-secondary-200 flex items-center justify-center hover:border-primary-400 hover:text-primary-500 transition-colors shadow-sm"
                                                    title="Replace image"
                                                >
                                                    <Upload className="w-3.5 h-3.5" />
                                                </button>
                                                <button
                                                    onClick={handleRemove}
                                                    className="w-8 h-8 rounded-lg bg-white border border-secondary-200 flex items-center justify-center hover:border-red-400 hover:text-red-500 text-secondary-400 transition-colors shadow-sm"
                                                    title="Remove image"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {avatarType === 'orb' && (() => {
                                const activeOrbColor = orbColor || primaryColor;
                                return (
                                    <div className="space-y-5 animate-fade-in">
                                        {/* Orb Preview */}
                                        <label className="text-[13px] font-bold text-secondary-700">Orb Preview</label>
                                        <div className="flex items-center gap-6 p-6 bg-secondary-50/50 border border-secondary-200 rounded-xl">
                                            <div
                                                className="w-20 h-20 rounded-full flex-shrink-0"
                                                style={{
                                                    background: `radial-gradient(circle at 35% 35%, ${activeOrbColor}44, ${activeOrbColor}bb, ${activeOrbColor})`,
                                                    boxShadow: `0 0 20px ${activeOrbColor}55, 0 0 40px ${activeOrbColor}22`,
                                                    animation: 'pulse 2.5s ease-in-out infinite'
                                                }}
                                            />
                                            <div>
                                                <p className="text-[13px] font-semibold text-secondary-900">Animated Orb</p>
                                                <p className="text-[11px] text-secondary-400 mt-1">A pulsing gradient orb. Pick a color below or use your primary color.</p>
                                            </div>
                                        </div>

                                        {/* Orb Color Picker */}
                                        <div>
                                            <label className="text-[13px] font-bold text-secondary-700">Orb Color</label>
                                            <p className="text-[11px] text-secondary-400 mt-0.5 mb-3">Pick any color for the orb using the picker, or use your primary color.</p>

                                            {/* Use Primary toggle */}
                                            <button
                                                type="button"
                                                onClick={() => setOrbColor(orbColor ? '' : primaryColor)}
                                                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-[12px] font-semibold transition-all mb-4 ${!orbColor
                                                        ? 'border-green-500 bg-green-50 text-green-700 ring-1 ring-green-500/20'
                                                        : 'border-secondary-200 text-secondary-600 hover:border-secondary-300'
                                                    }`}
                                            >
                                                <div className="w-5 h-5 rounded-full border-2 border-white shadow-sm" style={{ backgroundColor: primaryColor }} />
                                                {!orbColor ? <><Check className="w-3.5 h-3.5" /> Using Primary Color</> : 'Use Primary Color'}
                                            </button>

                                            {/* HexColorPicker - full saturation/brightness square + hue slider */}
                                            <div className="p-6 bg-secondary-50/50 border border-secondary-200 rounded-xl">
                                                <div className="orb-color-picker">
                                                    <HexColorPicker
                                                        color={activeOrbColor}
                                                        onChange={(color) => setOrbColor(color)}
                                                    />
                                                </div>

                                                {/* Hex input row */}
                                                <div className="flex items-center gap-3 mt-4">
                                                    <div
                                                        className="w-10 h-10 rounded-lg shadow-sm border border-secondary-200 flex-shrink-0"
                                                        style={{ backgroundColor: activeOrbColor }}
                                                    />
                                                    <div className="relative flex-grow max-w-[140px]">
                                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary-400 font-mono text-xs">#</span>
                                                        <input
                                                            type="text"
                                                            value={activeOrbColor.replace('#', '').toUpperCase()}
                                                            onChange={(e) => {
                                                                const val = e.target.value;
                                                                if (val.length <= 6 && /^[0-9A-Fa-f]*$/.test(val)) {
                                                                    setOrbColor('#' + val);
                                                                }
                                                            }}
                                                            className="w-full h-9 pl-6 pr-3 text-sm font-mono text-secondary-600 bg-white border border-secondary-200 rounded-md focus:outline-none focus:border-primary-400 shadow-sm transition-colors"
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}

                            {avatarType === 'mascot' && (
                                <div className="space-y-4 animate-fade-in">
                                    <label className="text-[13px] font-bold text-secondary-700">Mascot Preview</label>
                                    <div className="flex items-center gap-6 p-6 bg-secondary-50/50 border border-secondary-200 rounded-xl">
                                        <div
                                            className="w-20 h-20 rounded-full flex-shrink-0 flex items-center justify-center"
                                            style={{ backgroundColor: primaryColor }}
                                        >
                                            <Bot className="w-10 h-10 text-white" />
                                        </div>
                                        <div>
                                            <p className="text-[13px] font-semibold text-secondary-900">Robot Mascot</p>
                                            <p className="text-[11px] text-secondary-400 mt-1">A friendly robot icon on your primary color background. Change the color in the General tab.</p>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : activeTab === 'Leads Form' ? (
                        <div className="space-y-6 animate-fade-in">
                            {/* BANT Qualification Toggle */}
                            <div>
                                <h3 className="text-[15px] font-bold text-secondary-900 flex items-center gap-2">
                                    <Bot className="w-4 h-4 text-primary-500" />
                                    <span>BANT</span> Lead Qualification
                                </h3>
                                <p className="text-[13px] text-secondary-500 mt-0.5">
                                    AI will subtly ask qualifying questions (Budget, Authority, Need, Timeline) when the user shows buying intent.
                                </p>
                            </div>
                            <div className="bg-white p-5 rounded-2xl border border-secondary-200 shadow-sm flex items-center justify-between">
                                <div>
                                    <h4 className="text-[14px] font-semibold text-secondary-900">Enable BANT Qualification</h4>
                                    <p className="text-[12px] text-secondary-500 mt-1">Qualify leads automatically during chat.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" className="sr-only peer" checked={bantEnabled} onChange={(e) => setBantEnabled(e.target.checked)} />
                                    <div className="w-11 h-6 bg-secondary-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
                                </label>
                            </div>

                            {/* Pre-Chat Lead Capture Form */}
                            <div className="border-t border-secondary-200 pt-6">
                                <h3 className="text-[15px] font-bold text-secondary-900 flex items-center gap-2">
                                    <Sparkles className="w-4 h-4 text-primary-500" />
                                    Pre-Chat Lead Capture
                                </h3>
                                <p className="text-[13px] text-secondary-500 mt-0.5">
                                    Show a form before chat starts to capture visitor contact details.
                                </p>
                            </div>

                            <div className="bg-white p-5 rounded-2xl border border-secondary-200 shadow-sm flex items-center justify-between">
                                <div>
                                    <h4 className="text-[14px] font-semibold text-secondary-900">Enable Lead Form</h4>
                                    <p className="text-[12px] text-secondary-500 mt-1">New visitors fill out a form before chatting.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" className="sr-only peer" checked={leadFormEnabled} onChange={(e) => setLeadFormEnabled(e.target.checked)} />
                                    <div className="w-11 h-6 bg-secondary-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
                                </label>
                            </div>

                            {leadFormEnabled && (
                                <div className="bg-white p-5 rounded-2xl border border-secondary-200 shadow-sm space-y-3">
                                    <h4 className="text-[14px] font-semibold text-secondary-900">Form Fields</h4>
                                    <p className="text-[12px] text-secondary-500">Select which fields to show and mark as required.</p>
                                    {['name', 'email', 'phone', 'company'].map((fieldName) => {
                                        const existing = leadFormFields.find(f => f.field === fieldName);
                                        const isEnabled = !!existing;
                                        const isRequired = existing?.required ?? false;
                                        const labels = { name: 'Name', email: 'Email', phone: 'Phone', company: 'Company' };

                                        return (
                                            <div key={fieldName} className="flex items-center justify-between py-2 border-b border-secondary-100 last:border-0">
                                                <div className="flex items-center gap-3">
                                                    <label className="relative inline-flex items-center cursor-pointer">
                                                        <input
                                                            type="checkbox"
                                                            className="sr-only peer"
                                                            checked={isEnabled}
                                                            onChange={(e) => {
                                                                if (e.target.checked) {
                                                                    setLeadFormFields(prev => [...prev, { field: fieldName, required: false }]);
                                                                } else {
                                                                    setLeadFormFields(prev => prev.filter(f => f.field !== fieldName));
                                                                }
                                                            }}
                                                        />
                                                        <div className="w-9 h-5 bg-secondary-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                                                    </label>
                                                    <span className="text-[13px] font-medium text-secondary-700">{labels[fieldName]}</span>
                                                </div>
                                                {isEnabled && (
                                                    <label className="flex items-center gap-2 cursor-pointer">
                                                        <input
                                                            type="checkbox"
                                                            className="w-4 h-4 text-primary-600 rounded border-secondary-300 focus:ring-primary-500"
                                                            checked={isRequired}
                                                            onChange={(e) => {
                                                                setLeadFormFields(prev => prev.map(f =>
                                                                    f.field === fieldName ? { ...f, required: e.target.checked } : f
                                                                ));
                                                            }}
                                                        />
                                                        <span className="text-[12px] text-secondary-500">Required</span>
                                                    </label>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Email Notifications */}
                            <div className="border-t border-secondary-200 pt-6">
                                <h3 className="text-[15px] font-bold text-secondary-900 flex items-center gap-2">
                                    <Settings2 className="w-4 h-4 text-primary-500" />
                                    Email Notifications
                                </h3>
                                <p className="text-[13px] text-secondary-500 mt-0.5">
                                    Get notified when leads are qualified or request live support.
                                </p>
                            </div>

                            <div className="bg-white p-5 rounded-2xl border border-secondary-200 shadow-sm space-y-4">
                                <div className="space-y-2">
                                    <label className="text-[13px] font-bold text-secondary-700">Notification Email</label>
                                    <input
                                        type="email"
                                        value={notificationEmail}
                                        onChange={(e) => setNotificationEmail(e.target.value)}
                                        placeholder="sales@yourcompany.com"
                                        className="w-full h-10 px-3 text-sm text-secondary-600 bg-white border border-secondary-200 rounded-lg focus:outline-none focus:border-primary-400"
                                    />
                                </div>
                                <div className="flex items-center justify-between py-2">
                                    <span className="text-[13px] text-secondary-700">Email on qualified lead</span>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" className="sr-only peer" checked={emailOnQualified} onChange={(e) => setEmailOnQualified(e.target.checked)} />
                                        <div className="w-9 h-5 bg-secondary-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                                    </label>
                                </div>
                                <div className="flex items-center justify-between py-2">
                                    <span className="text-[13px] text-secondary-700">Email on live chat request</span>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" className="sr-only peer" checked={emailOnHandoff} onChange={(e) => setEmailOnHandoff(e.target.checked)} />
                                        <div className="w-9 h-5 bg-secondary-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                                    </label>
                                </div>
                                <div className="flex items-center justify-between py-2">
                                    <span className="text-[13px] text-secondary-700">Enable live chat (show &quot;Talk to a human&quot; in widget)</span>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" className="sr-only peer" checked={liveChatEnabled} onChange={(e) => setLiveChatEnabled(e.target.checked)} />
                                        <div className="w-9 h-5 bg-secondary-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                                    </label>
                                </div>
                            </div>
                        </div>
                    ) : activeTab === 'Custom Brand' ? (
                        <div className="space-y-6 animate-fade-in">
                            <div className="bg-gradient-to-br from-primary-50 to-indigo-50 p-8 rounded-2xl border border-primary-200 shadow-sm">
                                <div className="flex items-start gap-4">
                                    <div className="w-12 h-12 rounded-xl bg-primary-100 flex items-center justify-center flex-shrink-0">
                                        <Settings2 className="w-6 h-6 text-primary-600" />
                                    </div>
                                    <div>
                                        <h3 className="text-[16px] font-bold text-secondary-900 mb-1">
                                            Need <span className="font-bold">Personalized</span> Customization?
                                        </h3>
                                        <p className="text-[13px] text-secondary-600 leading-relaxed mb-4">
                                            If you'd like to add <span className="font-semibold text-secondary-700">custom branding</span>, <span className="font-semibold text-secondary-700">unique themes</span>, or any <span className="font-semibold text-secondary-700">personalized features</span> to your chatbot, our development team is here to help!
                                        </p>
                                        <div className="bg-white px-5 py-4 rounded-xl border border-secondary-200 inline-flex items-center gap-3">
                                            <span className="text-[13px] text-secondary-500">Email us at:</span>
                                            <a
                                                href="mailto:developer@oyechats.com"
                                                className="text-[14px] font-bold text-primary-600 hover:underline"
                                            >
                                                developer@oyechats.com
                                            </a>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center p-12 text-center border-2 border-dashed border-secondary-200 rounded-2xl bg-secondary-50/50 animate-fade-in">
                            <Settings2 className="w-10 h-10 text-secondary-300 mb-4" />
                            <h3 className="text-secondary-900 font-bold mb-2">Content for {activeTab}</h3>
                            <p className="text-sm text-secondary-500 max-w-sm">
                                This section is currently under construction. Settings for "{activeTab}" will appear here when ready.
                            </p>
                        </div>
                    )}
                </div>

                {/* Right Side: 40% Live Preview Column (Sticky) */}
                <div className="lg:w-[40%] flex flex-col items-center sticky top-8 animate-fade-in" style={{ animationDelay: '0.15s' }}>
                    <div className="flex items-center justify-between w-full max-w-[360px] mb-4 px-2">
                        <span className="text-[11px] font-black uppercase tracking-widest text-secondary-400">Live Preview</span>
                        <div className="flex gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-red-400/30" />
                            <div className="w-2 h-2 rounded-full bg-amber-400/30" />
                            <div className="w-2 h-2 rounded-full bg-green-400/30" />
                        </div>
                    </div>

                    {/* Chat Window Preview Wrapper — matches widget classic theme */}
                    <div className="w-full max-w-[360px] bg-white rounded-2xl overflow-hidden shadow-[0_20px_40px_-15px_rgba(0,0,0,0.15)] flex flex-col border border-[#BBE7FF]/30 transition-colors">

                        {/* 1. Header — white bg, dark text (matches widget classic theme) */}
                        <div className="bg-white px-5 py-3.5 flex items-center justify-between shrink-0 border-b border-gray-100">
                            <div className="flex items-center gap-3">
                                {avatarType === 'orb' ? (
                                    <div
                                        className="w-10 h-10 rounded-full flex-shrink-0"
                                        style={{
                                            background: `radial-gradient(circle at 35% 35%, ${orbColor || primaryColor}44, ${orbColor || primaryColor}bb, ${orbColor || primaryColor})`,
                                            boxShadow: `0 0 10px ${orbColor || primaryColor}55`,
                                            animation: 'pulse 2.5s ease-in-out infinite'
                                        }}
                                    />
                                ) : avatarType === 'mascot' ? (
                                    <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: primaryColor }}>
                                        <Bot className="w-5 h-5 text-white" />
                                    </div>
                                ) : logo ? (
                                    <img src={logo} alt="logo" className="w-10 h-10 rounded-full object-cover" />
                                ) : (
                                    <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: primaryColor }}>
                                        <Bot className="w-5 h-5 text-white" />
                                    </div>
                                )}
                                <span className="font-semibold text-sm text-[#16202C]">
                                    {botName || 'AI Assistant'}
                                </span>
                            </div>
                            <div className="flex items-center gap-1">
                                <div className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400">
                                    <Plus className="w-4 h-4" />
                                </div>
                                <div className="w-7 h-7 flex items-center justify-center text-gray-400">
                                    <X className="w-5 h-5" />
                                </div>
                            </div>
                        </div>

                        {/* 2. Messages Area — white bg, gap-5 (matches widget) */}
                        <div className="flex-grow px-5 py-4 flex flex-col gap-5 overflow-y-auto no-scrollbar transition-colors duration-200 min-h-[380px] bg-white">

                            {/* Timestamp pill (matches widget) */}
                            <div className="text-center">
                                <span className="inline-block px-3 rounded-full text-[11px]" style={{ backgroundColor: 'rgba(0,0,0,0.05)', color: '#999' }}>
                                    Today &middot; {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                            </div>

                            {/* Bot Message 1 — plain text, no bubble */}
                            <div className="flex flex-col items-start w-full">
                                <div className="max-w-[85%] text-[14px] leading-relaxed text-[#16202C]">
                                    How can we help you today?
                                </div>
                                <div className="flex items-center gap-1.5 mt-2">
                                    <Copy className="w-3.5 h-3.5 text-gray-400" />
                                    <ThumbsUp className="w-3.5 h-3.5 text-gray-400" />
                                    <ThumbsDown className="w-3.5 h-3.5 text-gray-400" />
                                </div>
                            </div>

                            {/* User Message 1 — dynamic bubble color, dark text */}
                            <div className="flex flex-col items-end">
                                <div className="max-w-[85%] text-[#16202C] rounded-2xl px-4 py-3 text-[14px] leading-relaxed" style={{ backgroundColor: userBubbleColor }}>
                                    Tell me about your services.
                                </div>
                            </div>

                            {/* Bot Message 2 — plain text, no bubble */}
                            <div className="flex flex-col items-start w-full">
                                <div className="max-w-[85%] text-[14px] leading-relaxed text-[#16202C]">
                                    I&apos;m exploring the new customization options!
                                </div>
                                <div className="flex items-center gap-1.5 mt-2">
                                    <Copy className="w-3.5 h-3.5 text-gray-400" />
                                    <ThumbsUp className="w-3.5 h-3.5 text-gray-400" />
                                    <ThumbsDown className="w-3.5 h-3.5 text-gray-400" />
                                </div>
                            </div>
                        </div>

                        {/* 3. Input Area — rounded box with paperclip + send icon */}
                        <div className="px-4 pb-4 pt-2 shrink-0 bg-white">
                            <div className="rounded-2xl border border-[#BBE7FF]/50 bg-white px-4 pt-3 pb-2 shadow-sm">
                                <div className="text-[14px] text-gray-400">Ask anything?</div>
                                <div className="flex items-center justify-between mt-2">
                                    <Paperclip className="w-5 h-5 text-[#16202C]" />
                                    <svg width="20" height="20" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-[#BBE7FF]">
                                        <path d="M29.0178 16.0651L28.5877 16.4951L2.66773 29.7851C1.93773 30.1551 1.07772 30.0051 0.537723 29.4551C0.00772303 28.9251 -0.172253 28.0851 0.187747 27.3651L5.28772 17.1651L17.4377 14.9951L5.25775 12.7751L0.207767 2.67508C-0.162233 1.93508 -0.022277 1.09507 0.537723 0.535067C1.06772 0.00506717 1.91775 -0.174899 2.62775 0.195101L28.5577 13.4551L29.0277 13.9251C29.4377 14.6151 29.4377 15.3851 29.0277 16.0751L29.0178 16.0651Z" fill="currentColor" />
                                    </svg>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Crop Modal */}
            {showCropModal && cropImage && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-secondary-900/70 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-secondary-200 overflow-hidden">
                        {/* Header */}
                        <div className="px-5 py-4 border-b border-secondary-200 flex items-center justify-between">
                            <div>
                                <h3 className="text-base font-bold text-secondary-900">Crop Avatar</h3>
                                <p className="text-[11px] text-secondary-400 mt-0.5">Drag to reposition, scroll to zoom</p>
                            </div>
                            <button
                                onClick={() => { setShowCropModal(false); setCropImage(null); }}
                                className="p-1.5 rounded-lg text-secondary-400 hover:text-secondary-600:text-secondary-200 hover:bg-secondary-100:bg-secondary-700 transition-colors"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Crop Area */}
                        <div className="relative w-full h-64 bg-secondary-900">
                            <Cropper
                                image={cropImage}
                                crop={crop}
                                zoom={zoom}
                                rotation={rotation}
                                aspect={1}
                                cropShape="round"
                                showGrid={false}
                                onCropChange={setCrop}
                                onZoomChange={setZoom}
                                onCropComplete={onCropComplete}
                            />
                        </div>

                        {/* Controls */}
                        <div className="px-5 py-4 space-y-3">
                            {/* Zoom */}
                            <div className="flex items-center gap-3">
                                <ZoomOut size={14} className="text-secondary-400 flex-shrink-0" />
                                <input
                                    type="range"
                                    min={1}
                                    max={3}
                                    step={0.05}
                                    value={zoom}
                                    onChange={(e) => setZoom(Number(e.target.value))}
                                    className="flex-1 h-1.5 bg-secondary-200 rounded-full appearance-none cursor-pointer accent-primary-500"
                                />
                                <ZoomIn size={14} className="text-secondary-400 flex-shrink-0" />
                            </div>

                            {/* Rotate */}
                            <div className="flex items-center gap-3">
                                <RotateCw size={14} className="text-secondary-400 flex-shrink-0" />
                                <input
                                    type="range"
                                    min={0}
                                    max={360}
                                    step={1}
                                    value={rotation}
                                    onChange={(e) => setRotation(Number(e.target.value))}
                                    className="flex-1 h-1.5 bg-secondary-200 rounded-full appearance-none cursor-pointer accent-primary-500"
                                />
                                <span className="text-[11px] font-mono text-secondary-400 w-8 text-right">{rotation}°</span>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="px-5 py-3 border-t border-secondary-200 flex items-center justify-end gap-3">
                            <button
                                onClick={() => { setShowCropModal(false); setCropImage(null); }}
                                className="px-4 py-2 text-sm font-medium text-secondary-600 bg-secondary-100 hover:bg-secondary-200:bg-secondary-600 rounded-xl transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCropConfirm}
                                className="px-4 py-2 text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700:bg-primary-600 rounded-xl shadow-lg shadow-primary-500/25 transition-all flex items-center gap-2"
                            >
                                <Check size={14} />
                                Apply & Upload
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
