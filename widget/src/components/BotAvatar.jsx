import React from 'react';
import { Bot } from 'lucide-react';
import { sanitizeColor, sanitizeImageUrl } from '../services/sanitize';
import PremiumOrb from './PremiumOrb';

const SIZES = {
    xs:     { container: 'w-5 h-5',           icon: 10, orbPx: 20 },
    sm:     { container: 'w-7 h-7',           icon: 14, orbPx: 28 },
    header: { container: 'w-8 h-8',           icon: 16, orbPx: 32 },
    md:     { container: 'w-12 h-12',         icon: 24, orbPx: 48 },
    lg:     { container: 'w-[72px] h-[72px]', icon: 36, orbPx: 72 },
};

const BotAvatar = ({ settings, size = 'md' }) => {
    const avatarType = settings.avatar_type || 'upload';
    const pc = sanitizeColor(settings.primary_color);
    const s = SIZES[size] || SIZES.md;

    if (avatarType === 'orb') {
        const oc = sanitizeColor(settings.orb_color, pc);
        return <PremiumOrb color={oc} size={s.orbPx} />;
    }

    if (avatarType === 'mascot') {
        return (
            <div className={`${s.container} rounded-full flex items-center justify-center flex-shrink-0`} style={{ backgroundColor: pc }}>
                <Bot size={s.icon} className="text-white" />
            </div>
        );
    }

    // Default: upload
    const safeLogo = sanitizeImageUrl(settings.bot_logo);
    if (safeLogo && settings.bot_logo !== "null") {
        return <img src={safeLogo} alt={settings.bot_name} className={`${s.container} rounded-full object-cover`} />;
    }

    return (
        <div className={`${s.container} rounded-full flex items-center justify-center`} style={{ backgroundColor: pc }}>
            <Bot size={s.icon} className="text-white" />
        </div>
    );
};

export default BotAvatar;
