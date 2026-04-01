import React from 'react';

const OyeChatsLogo = ({ className }) => {
    return (
        <div className={`${className} flex items-center justify-center bg-white overflow-hidden`}>
            <svg
                viewBox="0 0 100 100"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="w-full h-full"
            >
                <rect width="100" height="100" fill="#E0A98F" />
                <path
                    d="M30 30 H70 C75 30 75 35 70 35 H40 V45 H60 C65 45 65 50 60 50 H40 V70 C40 75 35 75 30 70 V30 Z"
                    fill="white"
                />
                {/* Abstract shape */}
                <path d="M76.9999 21.0001H31.9999C23.0001 21.0001 22.9999 37.0001 31.9999 37.0001H46.9999V43.0001H31.9999C23.0001 43.0001 22.9999 59.0001 31.9999 59.0001H46.9999V79.0001H61.9999V59.0001H76.9999V43.0001H61.9999V37.0001H76.9999V21.0001Z" fill="white" />
            </svg>
        </div>
    );
};

const OyeChatsLogoSVG = ({ className }) => (
    <svg
        viewBox="0 0 200 200"
        className={className}
        xmlns="http://www.w3.org/2000/svg"
    >
        <rect width="200" height="200" rx="40" fill="#E8A87C" />
        <path d="M60 60 H140 V90 H90 V100 H130 V130 H90 V160 H60 V60 Z" fill="white" />
    </svg>
);

export default OyeChatsLogoSVG;
