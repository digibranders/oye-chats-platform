import React from 'react';
import { Bot } from 'lucide-react';

const SIZES = {
    sm: { container: 'w-7 h-7', icon: 14, orbShadow: '0 0 6px' },
    header: { container: 'w-8 h-8', icon: 16, orbShadow: '0 0 8px' },
    md: { container: 'w-12 h-12', icon: 24, orbShadow: '0 0 10px' },
    lg: { container: 'w-[72px] h-[72px]', icon: 36, orbShadow: '0 0 20px' },
};

const BotAvatar = ({ settings, size = 'md' }) => {
    const avatarType = settings.avatar_type || 'upload';
    const pc = settings.primary_color || '#2B66BC';
    const s = SIZES[size] || SIZES.md;

    if (avatarType === 'orb') {
        const oc = settings.orb_color || pc;
        return (
            <div
                className={`${s.container} rounded-full flex-shrink-0`}
                style={{
                    background: `radial-gradient(circle at 35% 35%, ${oc}44, ${oc}bb, ${oc})`,
                    boxShadow: `${s.orbShadow} ${oc}55`,
                    animation: 'pulse 2.5s ease-in-out infinite'
                }}
            />
        );
    }

    if (avatarType === 'mascot') {
        return (
            <div className={`${s.container} rounded-full flex items-center justify-center flex-shrink-0`} style={{ backgroundColor: pc }}>
                <Bot size={s.icon} className="text-white" />
            </div>
        );
    }

    // Default: upload
    if (settings.bot_logo && settings.bot_logo !== "null") {
        return <img src={settings.bot_logo} alt={settings.bot_name} className={`${s.container} rounded-full object-cover`} />;
    }

    return (
        <div className={`${s.container} rounded-full flex items-center justify-center`} style={{ backgroundColor: pc }}>
            <Bot size={s.icon} className="text-white" />
        </div>
    );
};

export default BotAvatar;
