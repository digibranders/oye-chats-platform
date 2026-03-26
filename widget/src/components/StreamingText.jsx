import React, { useState, useEffect } from 'react';

const StreamingText = ({ text, onComplete }) => {
    const [displayed, setDisplayed] = useState('');
    const [done, setDone] = useState(false);

    useEffect(() => {
        if (!text) return;
        let i = 0;
        setDisplayed('');
        setDone(false);
        const speed = Math.max(8, Math.min(25, 800 / text.length));
        const timer = setInterval(() => {
            i++;
            setDisplayed(text.slice(0, i));
            if (i >= text.length) {
                clearInterval(timer);
                setDone(true);
                if (onComplete) onComplete();
            }
        }, speed);
        return () => clearInterval(timer);
    }, [text, onComplete]);

    if (done) return null;
    return <span style={{ whiteSpace: 'pre-wrap' }}>{displayed}<span className="animate-pulse">▌</span></span>;
};

export default StreamingText;
