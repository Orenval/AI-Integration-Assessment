'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { DashboardHeader } from '@/app/dashboard/dashboard-header';
import { UPLOAD_LIMITS } from '@/lib/ai/config';
import { JobDto } from '@/lib/ai/types';
import { ensureCsrfToken } from '@/lib/api-client';

function formatFileCount(count: number): string {
  if (count === 0) return 'No files selected';
  return count === 1 ? '1 file selected' : `${count} files selected`;
}

interface UploadViewProps {
  user: {
    fullName: string;
    email: string;
  };
}

interface RejectedFile {
  name: string;
  reason: string;
}

export function UploadView({ user }: UploadViewProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [rejectedList, setRejectedList] = useState<RejectedFile[]>([]);
  const [jobs, setJobs] = useState<JobDto[]>([]);
  const [isLoadingJobs, setIsLoadingJobs] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const isPollingRef = useRef(false);

  // Fetch the latest 20 jobs for the user
  const fetchJobs = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;
    setIsRefreshing(true);

    try {
      const res = await fetch('/api/jobs', {
        headers: {
          Accept: 'application/json',
        },
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.jobs)) {
          setJobs(data.jobs);
          setFetchError(null);
        }
      } else {
        setFetchError('Failed to refresh recent jobs');
      }
    } catch {
      setFetchError('Network error while checking job status');
    } finally {
      setIsLoadingJobs(false);
      setIsRefreshing(false);
      isPollingRef.current = false;
    }
  }, []);

  // Initial load
  useEffect(() => {
    let mounted = true;

    const loadInitialData = async () => {
      await ensureCsrfToken();
      if (mounted) {
        await fetchJobs();
      }
    };

    void loadInitialData();

    return () => {
      mounted = false;
    };
  }, [fetchJobs]);

  // Polling condition: active only when at least one job is pending or processing
  const hasActiveJobs = jobs.some((j) => j.status === 'pending' || j.status === 'processing');

  useEffect(() => {
    if (!hasActiveJobs) return;

    const intervalId = setInterval(() => {
      void fetchJobs();
    }, 2000);

    return () => clearInterval(intervalId);
  }, [hasActiveJobs, fetchJobs]);

  const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

  const validateFiles = (files: File[]): string[] => {
    const errors: string[] = [];

    for (const file of files) {
      if (file.size === 0) {
        errors.push(`"${file.name}" is empty (0 bytes).`);
      } else if (file.size > UPLOAD_LIMITS.maxFileSizeBytes) {
        errors.push(
          `"${file.name}" exceeds the 5MB limit (${(file.size / (1024 * 1024)).toFixed(2)}MB).`
        );
      }

      if (!UPLOAD_LIMITS.allowedMimeTypes.includes(file.type as 'image/jpeg' | 'image/png')) {
        errors.push(`"${file.name}" has an unsupported format (${file.type || 'unknown'}). Only JPEG and PNG are allowed.`);
      }
    }

    return errors;
  };

  const processFiles = (incoming: File[]) => {
    setRejectedList([]);

    // An empty selection (e.g. the picker was cancelled) must not clear the
    // files already chosen.
    if (incoming.length === 0) return;

    // Accumulate with the current selection, skipping files already picked.
    const seen = new Set(selectedFiles.map(fileKey));
    const merged = [...selectedFiles];
    for (const file of incoming) {
      const key = fileKey(file);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(file);
    }

    // Enforce the batch ceiling without discarding the whole selection.
    const capped = merged.slice(0, UPLOAD_LIMITS.maxFilesPerUpload);

    setClientErrors(validateFiles(capped));
    setSelectedFiles(capped);
  };

  const removeFile = (key: string) => {
    const next = selectedFiles.filter((file) => fileKey(file) !== key);
    setRejectedList([]);
    setClientErrors(validateFiles(next));
    setSelectedFiles(next);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    // Reset the native input so re-selecting files (even the same ones) always
    // fires onChange; the File objects are already captured above.
    e.target.value = '';
    processFiles(files);
  };

  const handleDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    if (!isUploading) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (isUploading) return;
    processFiles(Array.from(e.dataTransfer.files || []));
  };

  const handleUploadSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (selectedFiles.length === 0 || clientErrors.length > 0 || isUploading) return;

    setIsUploading(true);
    setRejectedList([]);

    try {
      const csrfToken = await ensureCsrfToken();
      const formData = new FormData();
      for (const file of selectedFiles) {
        formData.append('files', file);
      }

      const res = await fetch('/api/jobs/upload', {
        method: 'POST',
        headers: {
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        body: formData,
      });

      const data = await res.json();

      if (data.rejected && Array.isArray(data.rejected) && data.rejected.length > 0) {
        setRejectedList(data.rejected);
      }

      if (res.status === 201 || res.ok) {
        // Reset file input
        setSelectedFiles([]);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        await fetchJobs();
      } else {
        if (!data.rejected || data.rejected.length === 0) {
          setClientErrors([data.message || 'Upload failed. Please try again.']);
        }
      }
    } catch {
      setClientErrors(['Network error during upload. Please check your connection.']);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f8fafc', color: '#0f172a' }}>
      <DashboardHeader user={user} />

      <main style={{ maxWidth: '960px', margin: '0 auto', padding: '32px 20px 64px' }}>
        {/* Navigation Breadcrumb */}
        <div style={{ marginBottom: '24px' }}>
          <Link
            href="/dashboard"
            aria-label="Back to Dashboard"
            title="Back to Dashboard"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#3b82f6',
              textDecoration: 'none',
              outline: 'none',
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
          </Link>
        </div>

        {/* Header Title */}
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', color: '#0f172a', marginBottom: '8px' }}>
            Product Photo Extraction
          </h1>
          <p style={{ color: '#475569', fontSize: '15px', lineHeight: 1.5 }}>
            Upload product photos (JPEG or PNG, up to 5MB each, max 10 photos). Gemini will extract structured catalog details in the background.
          </p>
        </div>

        {/* Upload Form Card */}
        <section
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '16px',
            border: '1px solid #e2e8f0',
            boxShadow:
              '0 1px 2px 0 rgba(15, 23, 42, 0.04), 0 16px 40px -24px rgba(15, 23, 42, 0.25)',
            padding: '19px',
            marginBottom: '40px',
          }}
        >
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: '#0f172a', marginBottom: '2px' }}>
            Upload Photos
          </h2>
            <p style={{ fontSize: '14px', color: '#475569', lineHeight: 1.5, marginBottom: '12px' }}>
              JPEG or PNG, up to 5MB each, max 10 photos.
            </p>

          <form onSubmit={handleUploadSubmit} noValidate>
            <input
              id="product-photo-upload"
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png"
              onChange={handleFileChange}
              disabled={isUploading}
              style={{ display: 'none' }}
            />

            <label
              htmlFor="product-photo-upload"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '26px 29px',
                textAlign: 'center',
                border: `2px dashed ${isDragging ? '#2563eb' : '#cbd5e1'}`,
                borderRadius: '14px',
                backgroundColor: isDragging ? '#eff6ff' : '#f8fafc',
                cursor: isUploading ? 'not-allowed' : 'pointer',
                transition: 'border-color 0.15s ease, background-color 0.15s ease',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '43px',
                  height: '43px',
                  borderRadius: '50%',
                  backgroundColor: isDragging ? '#dbeafe' : '#e0e7ff',
                  color: '#2563eb',
                }}
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
              </span>

              <span style={{ fontSize: '15px', fontWeight: 600, color: '#1e293b' }}>
                Click to upload or drag and drop
              </span>
              <span style={{ fontSize: '13px', color: '#475569' }}>
                You can select multiple product images
              </span>
            </label>

            {/* Selection summary */}
            {selectedFiles.length > 0 && (
              <div style={{ marginTop: '16px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '8px' }}>
                  {formatFileCount(selectedFiles.length)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {selectedFiles.map((file) => {
                    const key = fileKey(file);
                    return (
                      <div
                        key={key}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '12px',
                          padding: '10px 14px',
                          backgroundColor: '#f8fafc',
                          border: '1px solid #e2e8f0',
                          borderRadius: '10px',
                          fontSize: '13px',
                        }}
                      >
                        <span
                          style={{
                            color: '#334155',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {file.name}
                        </span>
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            flexShrink: 0,
                          }}
                        >
                          <span style={{ color: '#475569' }}>
                            {(file.size / (1024 * 1024)).toFixed(2)} MB
                          </span>
                          <button
                            type="button"
                            onClick={() => removeFile(key)}
                            disabled={isUploading}
                            aria-label={`Remove ${file.name}`}
                            title="Remove"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '24px',
                              height: '24px',
                              padding: 0,
                              color: '#475569',
                              backgroundColor: 'transparent',
                              border: 'none',
                              borderRadius: '6px',
                              cursor: isUploading ? 'not-allowed' : 'pointer',
                              transition: 'color 0.15s ease, background-color 0.15s ease',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.color = '#ef4444';
                              e.currentTarget.style.backgroundColor = '#fef2f2';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.color = '#475569';
                              e.currentTarget.style.backgroundColor = 'transparent';
                            }}
                          >
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </svg>
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Client-side validation errors */}
            {clientErrors.length > 0 && (
              <div
                role="alert"
                style={{
                  marginTop: '16px',
                  padding: '12px 16px',
                  backgroundColor: '#fef2f2',
                  border: '1px solid #fecaca',
                  borderRadius: '10px',
                  color: '#991b1b',
                  fontSize: '13.5px',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>Please resolve the following issues:</div>
                <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                  {clientErrors.map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Server-side rejected files alert */}
            {rejectedList.length > 0 && (
              <div
                role="alert"
                style={{
                  marginTop: '16px',
                  padding: '12px 16px',
                  backgroundColor: '#fffbeb',
                  border: '1px solid #fde68a',
                  borderRadius: '10px',
                  color: '#92400e',
                  fontSize: '13.5px',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>Some files could not be processed:</div>
                <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                  {rejectedList.map((item, idx) => (
                    <li key={idx}>
                      <strong>{item.name}</strong>: {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
              <button
                type="submit"
                disabled={selectedFiles.length === 0 || clientErrors.length > 0 || isUploading}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '11px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  color: '#ffffff',
                  backgroundColor:
                    selectedFiles.length === 0 || clientErrors.length > 0 || isUploading
                      ? '#94a3b8'
                      : 'var(--color-primary, #2563eb)',
                  border: 'none',
                  borderRadius: '10px',
                  cursor:
                    selectedFiles.length === 0 || clientErrors.length > 0 || isUploading
                      ? 'not-allowed'
                      : 'pointer',
                  boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
                  transition: 'background-color 0.15s ease',
                }}
              >
                {isUploading ? 'Uploading & Enqueuing...' : 'Upload & Process'}
              </button>
            </div>
          </form>
        </section>

        {/* Processing Jobs List Section */}
        <section
          aria-live="polite"
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            border: '1px solid #e2e8f0',
            boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
            padding: '28px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b' }}>
                Recent Processing Jobs
              </h2>
              {hasActiveJobs && (
                <span style={{ fontSize: '13px', color: '#2563eb', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                  <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#2563eb' }} />
                  Processing active jobs in queue (polling every 2s)...
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => void fetchJobs()}
              disabled={isRefreshing}
              style={{
                padding: '6px 14px',
                fontSize: '13px',
                fontWeight: 500,
                color: '#475569',
                backgroundColor: '#f1f5f9',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                cursor: isRefreshing ? 'not-allowed' : 'pointer',
              }}
            >
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          {fetchError && (
            <div style={{ padding: '10px 14px', backgroundColor: '#fef2f2', color: '#991b1b', borderRadius: '6px', fontSize: '13px', marginBottom: '16px' }}>
              {fetchError}
            </div>
          )}

          {isLoadingJobs && jobs.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: '#64748b', fontSize: '14px' }}>
              Loading recent jobs...
            </div>
          ) : jobs.length === 0 ? (
            /* Empty state */
            <div
              style={{
                padding: '48px 24px',
                textAlign: 'center',
                backgroundColor: '#f8fafc',
                borderRadius: '8px',
                border: '1px dashed #cbd5e1',
              }}
            >
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>📷</div>
              <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
                No jobs found
              </h3>
               <p style={{ fontSize: '14px', color: '#475569' }}>
                 You have not uploaded any product photos yet. Select photos above to begin extraction.
               </p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#475569' }}>
                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>File Name</th>
                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Status</th>
                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Attempts</th>
                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Details / Action</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => {
                    return (
                      <tr
                        key={job.id}
                        style={{
                          borderBottom: '1px solid #f1f5f9',
                          transition: 'background-color 0.1s ease',
                        }}
                      >
                        {/* File Name */}
                        <td style={{ padding: '14px 16px', verticalAlign: 'top' }}>
                          <div style={{ fontWeight: 500, color: '#1e293b' }}>
                            {job.originalFileName}
                          </div>
                          {job.resultTitle && (
                            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                              {job.resultTitle}
                            </div>
                          )}
                        </td>

                        {/* Status Badge */}
                        <td style={{ padding: '14px 16px', verticalAlign: 'top' }}>
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              padding: '4px 10px',
                              borderRadius: '9999px',
                              fontSize: '12px',
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                               backgroundColor:
                                 job.status === 'done'
                                   ? '#dcfce7'
                                   : job.status === 'failed'
                                   ? '#fee2e2'
                                   : job.status === 'processing'
                                   ? '#e0e7ff'
                                   : '#f1f5f9',
                               color:
                                 job.status === 'done'
                                   ? '#166534'
                                   : job.status === 'failed'
                                   ? '#b91c1c'
                                   : job.status === 'processing'
                                   ? '#4338ca'
                                   : '#475569',
                            }}
                          >
                            {job.status}
                          </span>
                        </td>

                        {/* Attempts */}
                        <td style={{ padding: '14px 16px', verticalAlign: 'top', color: '#64748b', fontSize: '13px' }}>
                          {job.attempts}
                        </td>

                        {/* Action / Error Details */}
                        <td style={{ padding: '14px 16px', verticalAlign: 'top' }}>
                          {job.status === 'done' && (
                            <Link
                              href={`/jobs/${job.id}`}
                              style={{
                                display: 'inline-block',
                                padding: '6px 12px',
                                backgroundColor: '#2563eb',
                                color: '#ffffff',
                                borderRadius: '6px',
                                fontSize: '13px',
                                fontWeight: 500,
                                textDecoration: 'none',
                              }}
                            >
                              View Result →
                            </Link>
                          )}

                          {job.status === 'failed' && (
                            <div style={{ fontSize: '13px', color: '#b91c1c' }}>
                              <div>{job.errorMessage || 'An error occurred.'}</div>
                              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '2px' }}>
                                Upload the photo again to retry.
                              </div>
                            </div>
                          )}

                          {(job.status === 'pending' || job.status === 'processing') && (
                            <span style={{ fontSize: '13px', color: '#64748b', fontStyle: 'italic' }}>
                              {job.status === 'processing' ? 'Analyzing with Gemini...' : 'Waiting in queue...'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
