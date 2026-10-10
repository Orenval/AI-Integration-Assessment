// =============================================================================
// AI Types & Job Status Union
// =============================================================================

export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface RawModelOutput {
  rawResponseText?: string | null;
  usageMetadata?: UsageMetadata | null;
  model?: string;
  finishReason?: string;
  [key: string]: unknown;
}

export interface JobDto {
  id: string;
  status: JobStatus;
  attempts: number;
  errorMessage?: string | null;
  originalFileName: string;
  createdAt: string;
  resultTitle?: string | null;
}

export interface JobDetailDto {
  id: string;
  status: JobStatus;
  attempts: number;
  errorMessage?: string | null;
  originalFileName: string;
  result?: unknown;
  expandedResult?: string | null;
  createdAt: string;
  updatedAt: string;
}
