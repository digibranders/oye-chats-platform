/** The OyeChats chat mark. Its circular silhouette stays still as the dots pulse. */
const LauncherMark = () => (
    <svg
        className="oyechats-launcher-mark"
        viewBox="0 0 64 64"
        width="42"
        height="42"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
    >
        <path d="M56.25 18a28 28 0 1 0 0 28l-8.66-5a18 18 0 0 1-9.59 7.97L32 55v-5a18 18 0 1 1 15.59-27Z" />
        <circle className="oyechats-launcher-dot" cx="23" cy="32" r="3.2" />
        <circle className="oyechats-launcher-dot" cx="32.5" cy="32" r="3.2" />
        <circle className="oyechats-launcher-dot" cx="42" cy="32" r="3.2" />
    </svg>
);

export default LauncherMark;
