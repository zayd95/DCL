
import imageCompression from 'browser-image-compression';

export const compressImage = async (file: File) => {
  const options = {
    maxSizeMB: 0.5, // 500KB is plenty for OCR and mobile viewing
    maxWidthOrHeight: 1200,
    useWebWorker: true,
  };
  try {
    return await imageCompression(file, options);
  } catch (error) {
    console.error('Image compression failed:', error);
    return file; // Fallback to original
  }
};
