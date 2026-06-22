/**
 * OyeChatsMark — the brand glyph.
 *
 * The source PNG (`/public/oye.png`) is the full lockup (icon + wordmark).
 * We scale the image up and translate it so only the planet+bubble glyph
 * sits inside the bounding box.
 */
export default function OyeChatsMark({ size = 36, className = '' }) {
    return (
        <div
            role="img"
            aria-label="OyeChats"
            className={`relative overflow-hidden ${className}`}
            style={{ width: size, height: size }}
        >
            <img
                src="/oye_final.png"
                alt=""
                draggable={false}
                className="absolute left-1/2 top-1/2 pointer-events-none select-none max-w-none"
                style={{
                    width: size * 3.2,
                    height: size * 3.2,
                    transform: 'translate(-50%, -42%)',
                }}
            />
        </div>
    );
}
