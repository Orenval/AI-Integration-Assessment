import { GoogleGenAI } from '@google/genai';
import { GEMINI_MODEL, AI_CONFIG } from './config';
import { extractionResultSchema, extractionGeminiResponseSchema, ExtractionResult } from './schemas';
import { EXTRACTION_SYSTEM_PROMPT, EXPANSION_SYSTEM_PROMPT, STRICT_RETRY_SUFFIX } from './prompts';
import {
  ProviderTimeoutError,
  ProviderTransientError,
  ProviderPermanentError,
  ValidationError,
} from './errors';
import { RawModelOutput } from './types';

export {
  ProviderTimeoutError,
  ProviderTransientError,
  ProviderPermanentError,
  ValidationError,
};

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ProviderPermanentError('GEMINI_API_KEY is not configured in environment variables');
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Classifies an unknown error into the appropriate typed AI provider error.
 */
function classifyProviderError(error: unknown): Error {
  if (
    error instanceof ProviderTimeoutError ||
    error instanceof ProviderTransientError ||
    error instanceof ProviderPermanentError ||
    error instanceof ValidationError
  ) {
    return error;
  }

  const err = error as {
    name?: string;
    message?: string;
    status?: number;
    statusCode?: number;
    code?: string;
  };

  const message = err?.message || 'Unknown error occurred during AI processing';
  const status = err?.status || err?.statusCode;
  const code = err?.code;

  if (err?.name === 'AbortError' || code === 'ABORT_ERR' || message.toLowerCase().includes('timeout') || message.toLowerCase().includes('aborted')) {
    return new ProviderTimeoutError('AI service request timed out');
  }

  // Transient status codes (429 rate limit, 5xx server errors, network dropouts)
  if (
    status === 429 ||
    (status && status >= 500 && status < 600) ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('overloaded') ||
    message.includes('Resource has been exhausted')
  ) {
    return new ProviderTransientError(`Transient AI provider error: ${message}`, status);
  }

  // Permanent status codes (400 bad request, 401 unauth, 403 forbidden, safety blocks)
  return new ProviderPermanentError(`Permanent AI provider error: ${message}`, status);
}

/**
 * Executes a promise with an AbortController timeout.
 */
async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const result = await fn(controller.signal);
    clearTimeout(timer);
    return result;
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new ProviderTimeoutError(`AI request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * Role 1: Extracts structured product catalog data from an image buffer.
 */
export async function extractListing(
  imageBytes: Buffer | Uint8Array,
  mimeType: string,
  isRetry = false
): Promise<{ result: ExtractionResult; rawModelOutput: RawModelOutput }> {
  const client = getGeminiClient();
  const base64Data = Buffer.from(imageBytes).toString('base64');

  const systemInstruction = isRetry
    ? `${EXTRACTION_SYSTEM_PROMPT}${STRICT_RETRY_SUFFIX}`
    : EXTRACTION_SYSTEM_PROMPT;

  try {
    const response = await withTimeout(async (signal) => {
      return await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
              {
                text: 'Extract product catalog metadata from this product photo.',
              },
            ],
          },
        ],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: extractionGeminiResponseSchema,
          temperature: AI_CONFIG.extraction.temperature,
          maxOutputTokens: AI_CONFIG.extraction.maxOutputTokens,
          thinkingConfig: {
            thinkingBudget: AI_CONFIG.extraction.thinkingBudget,
          },
          abortSignal: signal,
        },
      });
    }, AI_CONFIG.extraction.timeoutMs);

    const rawText = response.text || '';
    const finishReason = response.candidates?.[0]?.finishReason;

    if (finishReason && ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(finishReason)) {
      throw new ProviderPermanentError(`Content generation blocked by provider safety policy (${finishReason})`);
    }

    const rawModelOutput: RawModelOutput = {
      rawResponseText: rawText,
      usageMetadata: response.usageMetadata
        ? {
            promptTokenCount: response.usageMetadata.promptTokenCount,
            candidatesTokenCount: response.usageMetadata.candidatesTokenCount,
            totalTokenCount: response.usageMetadata.totalTokenCount,
          }
        : null,
      model: GEMINI_MODEL,
      finishReason,
    };

    if (!rawText.trim()) {
      throw new ValidationError('AI returned empty response text');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      throw new ValidationError('AI response could not be parsed as valid JSON');
    }

    const validation = extractionResultSchema.safeParse(parsedJson);
    if (!validation.success) {
      throw new ValidationError(
        `AI output failed schema validation: ${validation.error.issues.map((i) => i.message).join('; ')}`,
        validation.error.issues
      );
    }

    return {
      result: validation.data,
      rawModelOutput,
    };
  } catch (error) {
    throw classifyProviderError(error);
  }
}

/**
 * Role 2: Generates an expanded natural-language listing description from structured data.
 */
export async function expandListing(
  result: ExtractionResult
): Promise<{ expandedText: string; rawModelOutput: RawModelOutput }> {
  const client = getGeminiClient();

  try {
    const response = await withTimeout(async (signal) => {
      return await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Generate a product listing description based strictly on the following structured data:\n${JSON.stringify(
                  result,
                  null,
                  2
                )}`,
              },
            ],
          },
        ],
        config: {
          systemInstruction: EXPANSION_SYSTEM_PROMPT,
          temperature: AI_CONFIG.expansion.temperature,
          maxOutputTokens: AI_CONFIG.expansion.maxOutputTokens,
          abortSignal: signal,
        },
      });
    }, AI_CONFIG.expansion.timeoutMs);

    const rawText = response.text || '';
    const finishReason = response.candidates?.[0]?.finishReason;

    if (finishReason && ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(finishReason)) {
      throw new ProviderPermanentError(`Expansion blocked by provider safety policy (${finishReason})`);
    }

    const rawModelOutput: RawModelOutput = {
      rawResponseText: rawText,
      usageMetadata: response.usageMetadata
        ? {
            promptTokenCount: response.usageMetadata.promptTokenCount,
            candidatesTokenCount: response.usageMetadata.candidatesTokenCount,
            totalTokenCount: response.usageMetadata.totalTokenCount,
          }
        : null,
      model: GEMINI_MODEL,
      finishReason,
    };

    if (!rawText.trim()) {
      throw new ValidationError('AI returned empty response text during expansion');
    }

    return {
      expandedText: rawText.trim(),
      rawModelOutput,
    };
  } catch (error) {
    throw classifyProviderError(error);
  }
}
