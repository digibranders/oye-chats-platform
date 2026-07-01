/**
 * Image-cropping helper for the Bot Settings avatar uploader.
 *
 * Lifted verbatim from the legacy `Interface.jsx` monolith. Lives in its own
 * non-component module so `shared.jsx` can export only React components (the
 * `react-refresh/only-export-components` rule).
 */

/**
 * Creates a cropped image blob from a source data URL, honouring rotation.
 *
 * @param {string} imageSrc - Source image as a data URL.
 * @param {{ x: number, y: number, width: number, height: number }} pixelCrop
 *   Crop rectangle in source-pixel coordinates.
 * @param {number} [rotation=0] - Rotation in degrees applied before cropping.
 * @returns {Promise<Blob>} The cropped PNG blob.
 */
export const getCroppedImg = (imageSrc, pixelCrop, rotation = 0) => {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onerror = () => reject(new Error('Failed to load image for cropping'));
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
