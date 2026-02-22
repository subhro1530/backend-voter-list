import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";
import fs from "fs/promises";
import path from "path";

// Configure Cloudinary from environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Check if Cloudinary is configured
 */
export function isCloudinaryConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

/**
 * Upload an image buffer to Cloudinary
 * @param {Buffer} imageBuffer - The image data
 * @param {Object} options - Upload options
 * @param {string} options.folder - Cloudinary folder path
 * @param {string} options.publicId - Custom public ID
 * @param {string} options.format - Image format (default: 'jpg')
 * @returns {Promise<Object>} Cloudinary upload result with secure_url
 */
export async function uploadImageBuffer(imageBuffer, options = {}) {
  if (!isCloudinaryConfigured()) {
    console.warn("⚠️ Cloudinary not configured. Skipping image upload.");
    return null;
  }

  const { folder = "voter-list", publicId, format = "jpg" } = options;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        format,
        resource_type: "image",
        transformation: [{ quality: "auto:good" }, { fetch_format: "auto" }],
      },
      (error, result) => {
        if (error) {
          console.error("Cloudinary upload error:", error.message);
          reject(error);
        } else {
          resolve(result);
        }
      },
    );

    // Write buffer to the upload stream
    const readable = new Readable();
    readable.push(imageBuffer);
    readable.push(null);
    readable.pipe(uploadStream);
  });
}

/**
 * Upload an image file to Cloudinary
 * @param {string} filePath - Path to the image file
 * @param {Object} options - Upload options
 * @returns {Promise<Object>} Cloudinary upload result
 */
export async function uploadImageFile(filePath, options = {}) {
  if (!isCloudinaryConfigured()) {
    console.warn("⚠️ Cloudinary not configured. Skipping image upload.");
    return null;
  }

  const { folder = "voter-list", publicId } = options;

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder,
      public_id: publicId,
      resource_type: "image",
      transformation: [{ quality: "auto:good" }, { fetch_format: "auto" }],
    });
    return result;
  } catch (error) {
    console.error("Cloudinary file upload error:", error.message);
    throw error;
  }
}

/**
 * Upload a base64-encoded image to Cloudinary
 * @param {string} base64Data - Base64 encoded image data (with or without data URI prefix)
 * @param {Object} options - Upload options
 * @returns {Promise<Object>} Cloudinary upload result
 */
export async function uploadBase64Image(base64Data, options = {}) {
  if (!isCloudinaryConfigured()) {
    console.warn("⚠️ Cloudinary not configured. Skipping image upload.");
    return null;
  }

  const { folder = "voter-list/photos", publicId } = options;

  // Ensure data URI prefix
  let dataUri = base64Data;
  if (!dataUri.startsWith("data:")) {
    dataUri = `data:image/jpeg;base64,${base64Data}`;
  }

  try {
    const result = await cloudinary.uploader.upload(dataUri, {
      folder,
      public_id: publicId,
      resource_type: "image",
      transformation: [
        { width: 200, height: 250, crop: "fill", gravity: "face" },
        { quality: "auto:good" },
      ],
    });
    return result;
  } catch (error) {
    console.error("Cloudinary base64 upload error:", error.message);
    throw error;
  }
}

/**
 * Delete an image from Cloudinary
 * @param {string} publicId - The public ID of the image to delete
 * @returns {Promise<Object>} Cloudinary deletion result
 */
export async function deleteImage(publicId) {
  if (!isCloudinaryConfigured()) return null;

  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (error) {
    console.error("Cloudinary delete error:", error.message);
    throw error;
  }
}

/**
 * Get a transformed URL for a Cloudinary image
 * @param {string} publicId - Public ID of the image
 * @param {Object} transformations - Cloudinary transformations
 * @returns {string} Transformed image URL
 */
export function getTransformedUrl(publicId, transformations = {}) {
  const defaultTransforms = {
    width: 150,
    height: 180,
    crop: "fill",
    gravity: "face",
    quality: "auto",
    fetch_format: "auto",
  };

  return cloudinary.url(publicId, {
    ...defaultTransforms,
    ...transformations,
    secure: true,
  });
}

export default cloudinary;
