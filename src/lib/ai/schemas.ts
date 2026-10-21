import { z } from 'zod';

// =============================================================================
// Extraction Result Zod Schema
// =============================================================================
// Strict schema defining the expected structured JSON extraction from Gemini.

export const extractionResultSchema = z.object({
  title: z
    .string()
    .min(1, 'Title must be at least 1 character')
    .max(120, 'Title cannot exceed 120 characters'),
  shortDescription: z
    .string()
    .min(1, 'Description must be at least 1 character')
    .max(300, 'Description cannot exceed 300 characters'),
  category: z
    .string()
    .min(1, 'Category must be at least 1 character')
    .max(60, 'Category cannot exceed 60 characters'),
  estimatedTags: z
    .array(
      z
        .string()
        .min(1, 'Tag must be at least 1 character')
        .max(30, 'Tag cannot exceed 30 characters')
    )
    .min(1, 'At least 1 tag is required')
    .max(10, 'At most 10 tags allowed'),
})

export type ExtractionResult = z.infer<typeof extractionResultSchema>;

// Compatible responseSchema for @google/genai SDK structured output
export const extractionGeminiResponseSchema = {
  type: 'OBJECT',
  properties: {
    title: {
      type: 'STRING',
      description: 'Product title (1 to 120 characters)',
    },
    shortDescription: {
      type: 'STRING',
      description: 'Concise product description (1 to 300 characters)',
    },
    category: {
      type: 'STRING',
      description: 'Product category (1 to 60 characters)',
    },
    estimatedTags: {
      type: 'ARRAY',
      description: 'Relevant product tags (1 to 10 tags, 1-30 chars each)',
      items: {
        type: 'STRING',
      },
    },
  },
  required: ['title', 'shortDescription', 'category', 'estimatedTags'],
};
