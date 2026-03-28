import { Globe } from 'lucide-react';

/**
 * Renders a platform-specific SVG icon by platform id.
 * Falls back to a Globe icon if no matching icon is found.
 */
export default function PlatformIcon({ id, size = 20, className = '' }) {
    const Icon = iconMap[id];
    if (!Icon) return <Globe size={size} className={className} />;
    return <Icon size={size} className={className} />;
}

// ---------------------------------------------------------------------------
// Individual icon components
// ---------------------------------------------------------------------------

function HtmlIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <path d="M4 3L5.77 19.42L12 21L18.23 19.42L20 3H4Z" fill="#E44D26" />
            <path d="M12 4.5V19.63L17.01 18.27L18.5 4.5H12Z" fill="#F16529" />
            <path d="M8.5 8H12V10.5H9.2L9.4 12.5H12V15L9.6 14.3L9.45 12.5" stroke="white" strokeWidth="0.8" />
            <path d="M15.5 8H12V10.5H15.3L15 12.5H12V15L14.4 14.3L14.55 12.5" stroke="white" strokeWidth="0.8" />
        </svg>
    );
}

function NextjsIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <circle cx="12" cy="12" r="10" fill="black" />
            <path d="M9.5 8V16" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M9.5 8L16 16" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M14.5 8V13" stroke="url(#nextGrad)" strokeWidth="1.5" strokeLinecap="round" />
            <defs>
                <linearGradient id="nextGrad" x1="14.5" y1="8" x2="14.5" y2="13" gradientUnits="userSpaceOnUse">
                    <stop stopColor="white" />
                    <stop offset="1" stopColor="white" stopOpacity="0" />
                </linearGradient>
            </defs>
        </svg>
    );
}

function ReactIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <circle cx="12" cy="12" r="2" fill="#61DAFB" />
            <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#61DAFB" strokeWidth="1" fill="none" />
            <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#61DAFB" strokeWidth="1" fill="none" transform="rotate(60 12 12)" />
            <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#61DAFB" strokeWidth="1" fill="none" transform="rotate(120 12 12)" />
        </svg>
    );
}

function VueIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <path d="M2 3H6L12 13L18 3H22L12 21L2 3Z" fill="#41B883" />
            <path d="M6 3H9.5L12 7.5L14.5 3H18L12 13L6 3Z" fill="#35495E" />
        </svg>
    );
}

function AngularIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <path d="M12 2L3 5.5L4.5 18.5L12 22L19.5 18.5L21 5.5L12 2Z" fill="#DD0031" />
            <path d="M12 2L12 22L19.5 18.5L21 5.5L12 2Z" fill="#C3002F" />
            <path d="M12 5.5L7.5 16H9.5L10.5 13.5H13.5L14.5 16H16.5L12 5.5ZM12 8.5L13 11.5H11L12 8.5Z" fill="white" />
        </svg>
    );
}

function SvelteIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <path d="M19.5 5.2C17.7 2.3 13.9 1.4 11.1 3.1L6.8 5.9C5.5 6.7 4.7 8 4.5 9.4C4.3 10.4 4.5 11.4 4.9 12.3C4.6 12.8 4.4 13.4 4.3 14C4.1 15.5 4.5 17 5.5 18.2C7.3 21.1 11.1 22 13.9 20.3L18.2 17.5C19.5 16.7 20.3 15.4 20.5 14C20.7 13 20.5 12 20.1 11.1C20.4 10.6 20.6 10 20.7 9.4C20.9 7.9 20.5 6.4 19.5 5.2Z" fill="#FF3E00" />
            <path d="M10.3 18.7C8.8 19.2 7.1 18.4 6.5 16.9C6.3 16.3 6.3 15.6 6.5 15L6.6 14.6L6.9 15C7.3 15.5 7.8 15.9 8.4 16.2L8.6 16.3L8.6 16.5C8.6 17 8.8 17.4 9.2 17.7C9.8 18.1 10.6 18 11.1 17.5L15.4 14.7C15.7 14.5 15.9 14.2 15.9 13.8C16 13.4 15.9 13 15.6 12.7C15 12.3 14.2 12.4 13.7 12.9L12.1 13.9C10.8 14.7 9 14.4 8 13.1C7.5 12.4 7.3 11.5 7.5 10.7C7.7 9.9 8.2 9.2 8.9 8.7L13.2 5.9C14.5 5.1 16.3 5.4 17.3 6.7C17.8 7.4 18 8.3 17.8 9.1L17.7 9.5L17.4 9.3C17 8.8 16.5 8.4 15.9 8.1L15.7 8L15.7 7.8C15.7 7.3 15.5 6.9 15.1 6.6C14.5 6.2 13.7 6.3 13.2 6.8L8.9 9.6C8.6 9.8 8.4 10.1 8.4 10.5C8.3 10.9 8.4 11.3 8.7 11.6C9.3 12 10.1 11.9 10.6 11.4L12.2 10.4C13.5 9.6 15.3 9.9 16.3 11.2C16.8 11.9 17 12.8 16.8 13.6C16.6 14.4 16.1 15.1 15.4 15.6L11.1 18.4C10.9 18.5 10.6 18.6 10.3 18.7Z" fill="white" />
        </svg>
    );
}

function WordPressIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <circle cx="12" cy="12" r="10" fill="#21759B" />
            <path d="M3.5 12C3.5 12 6.5 19.5 7 20.5L10.5 9.5C10.5 9.5 9 9.3 9 9C9 8.5 10.5 8.5 10.5 8.5C10.5 8.5 11 6 8.5 6C6.5 6 5 7.5 4.5 8.5" stroke="white" strokeWidth="0.7" fill="none" />
            <text x="7.5" y="15.5" fill="white" fontSize="8" fontWeight="bold" fontFamily="serif">W</text>
        </svg>
    );
}

function ShopifyIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <path d="M17.5 4.5C17.5 4.5 17 4.3 16.5 4.3C16 4.3 15 4.5 14.5 5.5C14.5 5.5 14 4 12.5 4C12.5 4 11 4.2 10 6.5L8 20.5L18.5 22L20 6.5L17.5 4.5Z" fill="#95BF47" />
            <path d="M14.5 5.5C14.5 5.5 13.5 5 12.5 5.5L10.5 6.5L8 20.5L18.5 22L20 6.5L17.5 4.5C17.5 4.5 15 6 14.5 5.5Z" fill="#5E8E3E" />
            <path d="M14.5 8.5L13.5 11.5C13.5 11.5 12.5 11 11.5 11C10 11 10 12 10 12.5C10 14 13.5 14.5 13.5 17.5C13.5 19.5 12 21 10 21C8 21 7 20 7 20L7.5 18C7.5 18 8.5 19 9.5 19C10.5 19 11 18 11 17.5C11 16 8 15.5 8 13C8 10.5 10 8.5 13 8.5C14 8.5 14.5 8.5 14.5 8.5Z" fill="white" />
        </svg>
    );
}

function SquarespaceIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <rect width="24" height="24" rx="4" fill="#121212" />
            <path d="M7 10.5L12 5.5L13.5 7L8.5 12L7 10.5Z" fill="white" />
            <path d="M9 12.5L14 7.5L15.5 9L10.5 14L9 12.5Z" fill="white" opacity="0.7" />
            <path d="M11 14.5L16 9.5L17.5 11L12.5 16L11 14.5Z" fill="white" />
            <path d="M13 16.5L18 11.5L19.5 13L14.5 18L13 16.5Z" fill="white" opacity="0.7" />
        </svg>
    );
}

function WebflowIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <rect width="24" height="24" rx="4" fill="#4353FF" />
            <path d="M17 8C17 8 15.5 12.5 15.3 13.2C15.2 12.4 14 8 14 8C14 8 12 8 11 8C11 8 11 11 11 12.5C11 12.5 9.5 8 9.5 8H7L9.5 16H12L12.5 13C12.7 14.2 13.5 16 13.5 16H16L19 8H17Z" fill="white" />
        </svg>
    );
}

function WixIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <rect width="24" height="24" rx="4" fill="#0C6EFC" />
            <path d="M5 8L7.5 16L9.5 10L11.5 16L14 8" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <path d="M15.5 8V16" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M18 8L19.5 12L21 8" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <path d="M18 16L19.5 12L21 16" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
    );
}

function FramerIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <path d="M6 3H18V9H12L18 15H12V21L6 15V3Z" fill="#0055FF" />
        </svg>
    );
}

function BubbleIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <circle cx="12" cy="10" r="8" fill="#262626" />
            <circle cx="9" cy="9" r="2.5" fill="#3A9BF4" />
            <circle cx="15" cy="9" r="2.5" fill="#40D55E" />
            <circle cx="12" cy="14" r="2.5" fill="#FF6B6B" />
        </svg>
    );
}

function GtmIcon({ size, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
            <path d="M14 2L22 10L12 22L4 14L14 2Z" fill="#8AB4F8" />
            <path d="M12 22L4 14L14 2" fill="#4285F4" />
            <circle cx="7" cy="17" r="2.5" fill="#1A73E8" />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// Icon lookup map
// ---------------------------------------------------------------------------

const iconMap = {
    html: HtmlIcon,
    nextjs: NextjsIcon,
    react: ReactIcon,
    vue: VueIcon,
    angular: AngularIcon,
    svelte: SvelteIcon,
    wordpress: WordPressIcon,
    shopify: ShopifyIcon,
    squarespace: SquarespaceIcon,
    webflow: WebflowIcon,
    wix: WixIcon,
    framer: FramerIcon,
    bubble: BubbleIcon,
    gtm: GtmIcon,
};
