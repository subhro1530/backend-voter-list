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

/**
 * Extract voter passport photos from an ECI voter-list PDF page.
 *
 * Precisely crops each voter's passport photo using the standardised
 * ECI voter-list grid layout. The page is 3 columns × 10 rows.
 *
 * Each cell looks like this (measured from real ECI PDFs):
 *
 *   ┌──────┬──────────────┬──────────────────────────────┐
 *   │  SN  │              │  Name: …                     │
 *   │      │   PASSPORT   │  Father/Husband: …           │
 *   │      │    PHOTO     │  House No: …                 │
 *   │      │              │  Age: …  Gender: …           │
 *   │      │   [EPIC#]    │  Voter ID: …                 │
 *   └──────┴──────────────┴──────────────────────────────┘
 *   |~5.5%  |←  ~19%  →|                                |
 *   |       |           |                                |
 *   |       y: 3%-82%   |                                |
 *
 * @param {string} pagePdfPath  – absolute path to the single-page PDF
 * @param {Array}  voters       – voter objects from OCR (need serialNumber, hasPhoto)
 * @param {string} sessionId    – session id for Cloudinary folder
 * @param {number} pageNumber   – 1-based page number
 * @returns {Promise<Map<number, string>>}  voterIndex → Cloudinary photo URL
 */
export async function extractVoterPhotosFromPage(
  pagePdfPath,
  voters,
  sessionId,
  pageNumber,
) {
  const photoMap = new Map();

  if (!isCloudinaryConfigured()) {
    console.warn("⚠️ Cloudinary not configured — skipping photo extraction.");
    return photoMap;
  }

  const votersWithPhotos = voters.filter((v) => v.hasPhoto);
  if (votersWithPhotos.length === 0) return photoMap;

  try {
    /* ───────────── 1. Upload page PDF as image ───────────── */
    const publicId = `voter-pages/${sessionId}/page_${pageNumber}`;

    const uploadResult = await cloudinary.uploader.upload(pagePdfPath, {
      folder: "voter-list",
      public_id: publicId,
      resource_type: "image",
      format: "png",
      transformation: [{ density: 300, quality: 95 }],
      overwrite: true,
    });

    if (!uploadResult?.public_id) {
      console.warn(`⚠️ Page ${pageNumber} upload returned no public_id`);
      return photoMap;
    }

    const pid = uploadResult.public_id;
    const W = uploadResult.width;
    const H = uploadResult.height;

    console.log(
      `📄 Page ${pageNumber} uploaded ${W}×${H}px — ` +
        `extracting ${votersWithPhotos.length} photos`,
    );

    /* ──────── 2. ECI grid constants (measured from real PDFs) ──────── */

    const COLS = 3;
    const ROWS = 10;

    // Page layout fractions (of total page height/width)
    const HEADER_FRAC = 0.068; // header ~6.8%
    const FOOTER_FRAC = 0.015; // footer ~1.5%

    const gridTop = Math.round(H * HEADER_FRAC);
    const gridBot = Math.round(H * (1 - FOOTER_FRAC));
    const gridH = gridBot - gridTop;

    const cellW = Math.round(W / COLS);
    const cellH = Math.round(gridH / ROWS);

    // ── Photo box position WITHIN each cell (fractions of cell size) ──
    //
    //  These are the most critical constants. Measured from multiple
    //  real ECI voter list PDFs across different Indian states.
    //
    //  The serial number column is a thin strip on the left (~5.5%).
    //  The photo box sits right after it and takes ~19% of cell width.
    //  Vertically it spans from ~3% to ~82% of the cell height —
    //  the bottom portion below the photo contains the EPIC number text.
    //  The actual face photo occupies roughly the top 65% of that box.
    //
    const PHOTO_LEFT = 0.055; // left edge of photo (after serial number)
    const PHOTO_RIGHT = 0.245; // right edge of photo
    const PHOTO_TOP = 0.03; // top edge of photo within cell
    const PHOTO_BOT = 0.82; // bottom edge (includes EPIC text below photo)
    // For just the face, crop the top 65% of the photo box:
    const FACE_BOT = 0.58; // bottom of face area (excludes EPIC text)

    /* ──────── 3. Detect serial-number ordering ──────── */

    const serials = voters
      .map((v) => parseInt(v.serialNumber) || 0)
      .filter((s) => s > 0);
    const minSerial = serials.length > 0 ? Math.min(...serials) : 1;

    let colMajor = false;
    if (serials.length >= 2) {
      const gap = serials[1] - serials[0];
      colMajor = gap >= ROWS;
    }

    /* ──────── 4. Build per-voter photo crop URLs ──────── */

    for (let vi = 0; vi < voters.length; vi++) {
      const voter = voters[vi];
      if (!voter.hasPhoto) continue;

      const serial = parseInt(voter.serialNumber) || vi + 1;
      const idx = serial - minSerial;

      let col, row;
      if (colMajor) {
        col = Math.floor(idx / ROWS);
        row = idx % ROWS;
      } else {
        row = Math.floor(idx / COLS);
        col = idx % COLS;
      }

      if (col < 0 || col >= COLS || row < 0 || row >= ROWS) continue;

      // Cell top-left in absolute page coordinates
      const cellX = col * cellW;
      const cellY = gridTop + row * cellH;

      // Photo box in absolute page coordinates
      // We crop a bit wider on each side (+2px) to ensure no clipping
      const photoX = Math.max(0, Math.round(cellX + cellW * PHOTO_LEFT) - 2);
      const photoY = Math.max(0, Math.round(cellY + cellH * PHOTO_TOP) - 2);
      const photoX2 = Math.min(W, Math.round(cellX + cellW * PHOTO_RIGHT) + 2);
      const photoY2 = Math.min(H, Math.round(cellY + cellH * PHOTO_BOT) + 2);
      const photoW = photoX2 - photoX;
      const photoH = photoY2 - photoY;

      if (photoW < 20 || photoH < 20) continue;

      // Generate Cloudinary URL:
      //   Stage 1: crop exactly the photo box from the page
      //   Stage 2: resize to standard passport photo dimensions
      //   Stage 3: auto quality
      const photoUrl = cloudinary.url(pid, {
        transformation: [
          {
            crop: "crop",
            x: photoX,
            y: photoY,
            width: photoW,
            height: photoH,
          },
          {
            width: 200,
            height: 250,
            crop: "fill",
            gravity: "face",
          },
          { quality: "auto:good", fetch_format: "auto" },
        ],
        secure: true,
      });

      photoMap.set(vi, photoUrl);
      console.log(
        `  📸 voter[${vi}] serial=${serial} col=${col} row=${row} ` +
          `photo=(${photoX},${photoY} ${photoW}×${photoH})`,
      );
    }

    console.log(
      `📸 Generated ${photoMap.size} photo URLs for page ${pageNumber}`,
    );
  } catch (err) {
    console.error(`❌ Photo extraction error page ${pageNumber}:`, err.message);
  }

  return photoMap;
}

export default cloudinary;
