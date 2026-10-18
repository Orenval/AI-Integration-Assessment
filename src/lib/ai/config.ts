// =============================================================================
// AI Integration Configuration
// =============================================================================
// Centralized configuration for AI models, limits, retries, and upload gates.
// This file is strictly client-safe (no Node-only packages or secrets) so client
// components can import upload and file limits directly.

// Selected Flash model: Gemini 3.1 Flash Lite offers low latency and multi-modal image understanding.
// Note: gemini-2.5-flash was retired for new API keys (returns 404), so the current lite model is used.
export const GEMINI_MODEL = 'gemini-3.1-flash-lite';

export const AI_CONFIG = {
  extraction: {
    // 30s timeout provides ample runway for image transmission and multimodal analysis without hanging requests.
    timeoutMs: 30000,
    // 512 tokens accommodates structured JSON metadata (title, shortDescription, category, tags) with zero truncation.
    maxOutputTokens: 512,
    // Low temperature (0.2) ensures deterministic, factual extraction from visual features without hallucinated attributes.
    temperature: 0.2,
    // Thinking budget is set to 0 to prevent thinking tokens from consuming the output token cap and cutting off JSON.
    thinkingBudget: 0,
  },
  expansion: {
    // 30s timeout gives the model enough time to compose a complete 150-250 word descriptive listing.
    timeoutMs: 30000,
    // 800 tokens comfortably fits a full ~250-word product description in natural prose.
    maxOutputTokens: 800,
    // Higher temperature (0.7) encourages engaging, natural-sounding marketing prose while adhering to structured facts.
    temperature: 0.7,
  },
} as const;

// Retry & Concurrency Configuration
export const RETRY_CONFIG = {
  // Maximum number of extraction attempts allowed for transient or timeout failures.
  maxAttempts: 3,
  // Progressive backoff delays (in milliseconds) before attempt 2 and attempt 3.
  backoffDelaysMs: [1000, 3000] as const,
} as const;

// Global queue concurrency ceiling to prevent API rate exhaustion and server memory saturation.
export const MAX_CONCURRENT_JOBS = 2;

// File Upload Constraints
export const UPLOAD_LIMITS = {
  // 5MB per file prevents excessive memory use while allowing high-resolution product photos.
  maxFileSizeBytes: 5 * 1024 * 1024,
  // Allowed MIME types restricted strictly to standard photo formats supported by Gemini.
  allowedMimeTypes: ['image/jpeg', 'image/png'] as const,
  // Allowed file extensions mapping
  allowedExtensions: ['.jpg', '.jpeg', '.png'] as const,
  // Max 10 files per batch upload to keep multipart request payloads manageable.
  maxFilesPerUpload: 10,
} as const;

// Route Rate Limits
export const ROUTE_RATE_LIMITS = {
  upload: {
    // 10 batch upload requests per 10-minute window to curb storage spam and queue flooding.
    maxRequests: 10,
    windowMs: 10 * 60 * 1000,
  },
  expand: {
    // 20 expand requests per 10-minute window allows responsive interaction while controlling token consumption.
    maxRequests: 20,
    windowMs: 10 * 60 * 1000,
  },
} as const;
