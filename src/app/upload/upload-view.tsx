'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { DashboardHeader } from '@/app/dashboard/dashboard-header';
import { UPLOAD_LIMITS } from '@/lib/ai/config';
import { JobDto } from '@/lib/ai/types';
import { ensureCsrfToken } from '@/lib/api-client';

function formatPhotoCount(count: number): string {
  if (count === 0) return 'No photos selected';
  return count === 1 ? '1 photo selected' : `${count} photos selected`;
}

const MAX_FILE_SIZE_MB = UPLOAD_LIMITS.maxFileSizeBytes / (1024 * 1024);

function photoIssue(file: File): string | null {
  if (file.size === 0) {
    return 'This photo is empty (0 bytes).';
  }
  if (file.size > UPLOAD_LIMITS.maxFileSizeBytes) {
    return `This photo is larger than ${MAX_FILE_SIZE_MB}MB.`;
  }
  if (
    !UPLOAD_LIMITS.allowedMimeTypes.includes(
      file.type as 'image/jpeg' | 'image/png'
    )
  ) {
    return 'Only JPEG or PNG photos are allowed.';
  }
  return null;
}

function isValidPhoto(file: File): boolean {
  return photoIssue(file) === null;
}

function jobStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Waiting';
    case 'processing':
      return 'Working';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
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
  const [previewUrls, setPreviewUrls] = useState<{ key: string; name: string; url: string }[]>([]);
  const [isListingsExpanded, setIsListingsExpanded] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const [deletingJobIds, setDeletingJobIds] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{
    isOpen: boolean;
    jobIds: string[];
    title?: string;
  } | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

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
        setFetchError('Could not refresh your uploads.');
      }
    } catch {
      setFetchError('Network error. We will try again.');
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

  const COLLAPSED_LISTINGS_LIMIT = 5;
  const visibleJobs = isListingsExpanded ? jobs : jobs.slice(0, COLLAPSED_LISTINGS_LIMIT);
  const hasMoreListings = jobs.length > COLLAPSED_LISTINGS_LIMIT;

  const toggleJobSelection = (id: string) => {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allVisible = new Set(visibleJobs.map((j) => j.id));
      setSelectedJobIds(allVisible);
    } else {
      setSelectedJobIds(new Set());
    }
  };

  const openDeleteConfirm = (jobIds: string[], title?: string) => {
    setDeleteConfirm({
      isOpen: true,
      jobIds,
      title,
    });
  };

  const closeDeleteConfirm = () => {
    if (deletingJobIds.size > 0) return;
    setDeleteConfirm(null);
  };

  const executeDelete = async () => {
    if (!deleteConfirm || deleteConfirm.jobIds.length === 0) return;

    const idsToDelete = [...deleteConfirm.jobIds];
    setDeletingJobIds(new Set(idsToDelete));
    setActionFeedback(null);

    try {
      const csrfToken = await ensureCsrfToken();
      let res: Response;

      if (idsToDelete.length === 1) {
        res = await fetch(`/api/jobs/${idsToDelete[0]}`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
          },
        });
      } else {
        res = await fetch('/api/jobs', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
          },
          body: JSON.stringify({ ids: idsToDelete }),
        });
      }

      const data = await res.json();

      if (res.ok && data.success) {
        setJobs((prev) => prev.filter((j) => !idsToDelete.includes(j.id)));
        setSelectedJobIds((prev) => {
          const next = new Set(prev);
          for (const id of idsToDelete) {
            next.delete(id);
          }
          return next;
        });
        setActionFeedback({
          type: 'success',
          text: data.message || 'Listing removed successfully',
        });
        setDeleteConfirm(null);
      } else {
        setActionFeedback({
          type: 'error',
          text: data.message || 'Could not remove listing. Please try again.',
        });
      }
    } catch {
      setActionFeedback({
        type: 'error',
        text: 'Network error. Could not remove listing.',
      });
    } finally {
      setDeletingJobIds(new Set());
    }
  };

  // Automatically dismiss action feedback snackbar after 3 seconds
  useEffect(() => {
    if (!actionFeedback) return;

    const timer = setTimeout(() => {
      setActionFeedback(null);
    }, 3000);

    return () => clearTimeout(timer);
  }, [actionFeedback]);

  useEffect(() => {
    if (!hasActiveJobs) return;

    const intervalId = setInterval(() => {
      void fetchJobs();
    }, 2000);

    return () => clearInterval(intervalId);
  }, [hasActiveJobs, fetchJobs]);

  // Local blob previews for valid photos only. Links live in state and are
  // revoked on every list change and on unmount. Nothing is sent to the server.
  useEffect(() => {
    const entries = selectedFiles
      .filter(isValidPhoto)
      .map((file) => ({
        key: `${file.name}:${file.size}:${file.lastModified}`,
        name: file.name,
        url: URL.createObjectURL(file),
      }));

    // eslint-disable-next-line react-hooks/set-state-in-effect -- blob URLs must live in state so the cleanup can revoke them; creating them during render is not allowed.
    setPreviewUrls(entries);

    return () => {
      for (const entry of entries) {
        URL.revokeObjectURL(entry.url);
      }
    };
  }, [selectedFiles]);

  const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

  const validateFiles = (files: File[]): string[] => {
    const errors: string[] = [];

    for (const file of files) {
      const issue = photoIssue(file);
      if (issue) {
        errors.push(`"${file.name}": ${issue}`);
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
      setClientErrors(['Network error. Please check your connection and try again.']);
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
            Turn photos into listings
          </h1>

        </div>

        {/* Upload Form Card */}
        <section
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '16px',
            border: '1px solid #e2e8f0',
            boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
            padding: '19px',
            marginBottom: '40px',
          }}
        >
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: '#0f172a', marginBottom: '4px' }}>
            New listings
          </h2>

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
              {previewUrls.length > 0 ? (
                <div style={{ width: '100%' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview, not optimisable */}
                  <img
                    src={previewUrls[0].url}
                    alt={`Preview of ${previewUrls[0].name}`}
                    style={{
                      display: 'block',
                      margin: '0 auto',
                      maxHeight: '280px',
                      maxWidth: '100%',
                      objectFit: 'contain',
                      borderRadius: '8px',
                    }}
                  />

                  {previewUrls.length > 1 && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '8px',
                        justifyContent: 'center',
                        marginTop: '12px',
                      }}
                    >
                      {previewUrls.slice(1).map((preview) => (
                        // eslint-disable-next-line @next/next/no-img-element -- local blob preview, not optimisable
                        <img
                          key={preview.key}
                          src={preview.url}
                          alt={`Preview of ${preview.name}`}
                          style={{
                            width: '64px',
                            height: '64px',
                            objectFit: 'cover',
                            borderRadius: '8px',
                          }}
                        />
                      ))}
                    </div>
                  )}

                  <p style={{ fontSize: '12px', color: '#475569', marginTop: '12px' }}>
                    Choose again to add more photos. Use the X to remove one.
                  </p>
                </div>
              ) : (
                <>
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
                    Drop photos or click to browse
                  </span>
                  <span style={{ fontSize: '13px', color: '#475569' }}>
                    {UPLOAD_LIMITS.allowedMimeTypes.includes('image/jpeg') && UPLOAD_LIMITS.allowedMimeTypes.includes('image/png')
                      ? 'JPEG or PNG'
                      : UPLOAD_LIMITS.allowedMimeTypes.map((type) => type.replace('image/', '').toUpperCase()).join(' or ')}
                    {`. Max ${(UPLOAD_LIMITS.maxFileSizeBytes / (1024 * 1024)).toFixed(0)}MB each. Up to ${UPLOAD_LIMITS.maxFilesPerUpload} photos.`}
                  </span>
                </>
              )}
            </label>

            {/* Selection summary */}
            {selectedFiles.length > 0 && (
              <div style={{ marginTop: '16px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#475569', marginBottom: '8px' }}>
                  {formatPhotoCount(selectedFiles.length)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {selectedFiles.map((file) => {
                    const key = fileKey(file);
                    const issue = photoIssue(file);
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
                            display: 'flex',
                            flexDirection: 'column',
                            minWidth: 0,
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
                          {issue && (
                            <span style={{ color: '#b91c1c', marginTop: '2px' }}>
                              {issue}
                            </span>
                          )}
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
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>Please fix these before uploading:</div>
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
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>These files were not added:</div>
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
                {isUploading ? 'Processing...' : 'Generate listings'}
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b' }}>
                  Your listings
                </h2>
                {jobs.length > 0 && (
                  <span
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: '#475569',
                      backgroundColor: '#f1f5f9',
                      padding: '2px 8px',
                      borderRadius: '9999px',
                    }}
                  >
                    {!isListingsExpanded && hasMoreListings
                      ? `5 of ${jobs.length}`
                      : `${jobs.length}`}
                  </span>
                )}
              </div>
              {hasActiveJobs && (
                <span style={{ fontSize: '13px', color: '#2563eb', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                  <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#2563eb' }} />
                   Working on your photos. This updates on its own.
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {selectedJobIds.size > 0 && (
                <button
                  id="remove-selected-listings-btn"
                  type="button"
                  onClick={() => openDeleteConfirm(Array.from(selectedJobIds))}
                  disabled={deletingJobIds.size > 0}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 14px',
                    fontSize: '13px',
                    fontWeight: 600,
                    color: '#dc2626',
                    backgroundColor: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '6px',
                    cursor: deletingJobIds.size > 0 ? 'not-allowed' : 'pointer',
                    transition: 'background-color 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#fee2e2';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#fef2f2';
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  </svg>
                  Remove selected ({selectedJobIds.size})
                </button>
              )}

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
                {isRefreshing ? 'Refreshing...' : 'Update status'}
              </button>
            </div>
          </div>

          {actionFeedback && (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                marginBottom: '16px',
                borderRadius: '8px',
                fontSize: '13.5px',
                backgroundColor: actionFeedback.type === 'success' ? '#ecfdf5' : '#fef2f2',
                border: `1px solid ${actionFeedback.type === 'success' ? '#a7f3d0' : '#fecaca'}`,
                color: actionFeedback.type === 'success' ? '#065f46' : '#991b1b',
              }}
            >
              <span>{actionFeedback.text}</span>
              <button
                type="button"
                onClick={() => setActionFeedback(null)}
                aria-label="Dismiss message"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: '14px',
                  padding: '0 4px',
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
          )}

          {fetchError && (
            <div style={{ padding: '10px 14px', backgroundColor: '#fef2f2', color: '#991b1b', borderRadius: '6px', fontSize: '13px', marginBottom: '16px' }}>
              {fetchError}
            </div>
          )}

          {isLoadingJobs && jobs.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: '#64748b', fontSize: '14px' }}>
               Loading your uploads...
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
                  No listings yet
                </h3>
                <p style={{ fontSize: '14px', color: '#475569' }}>
                  Upload a photo to create your first listing.
                </p>
            </div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#475569' }}>
                    <th style={{ width: '38px', padding: '12px 12px 12px 16px' }} />
                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Photo</th>
                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Status</th>
                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Tries</th>
                    <th style={{ padding: '12px 16px', fontWeight: 600 }}>Result</th>
                    <th style={{ padding: '12px 16px', fontWeight: 600, textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.map((job) => {
                    const isSelected = selectedJobIds.has(job.id);
                    const isDeletingThis = deletingJobIds.has(job.id);

                    return (
                      <tr
                        key={job.id}
                        style={{
                          borderBottom: '1px solid #f1f5f9',
                          backgroundColor: isSelected ? '#f8fafc' : 'transparent',
                          transition: 'background-color 0.1s ease',
                          opacity: isDeletingThis ? 0.45 : 1,
                        }}
                      >
                        {/* Row Selection Checkbox */}
                        <td style={{ padding: '14px 12px 14px 16px', verticalAlign: 'middle' }}>
                          <input
                            type="checkbox"
                            aria-label={`Select listing for ${job.originalFileName}`}
                            checked={isSelected}
                            onChange={() => toggleJobSelection(job.id)}
                            style={{
                              width: '16px',
                              height: '16px',
                              accentColor: '#2563eb',
                              cursor: 'pointer',
                            }}
                          />
                        </td>

                        {/* File Name */}
                        <td style={{ padding: '14px 16px', verticalAlign: 'middle' }}>
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
                        <td style={{ padding: '14px 16px', verticalAlign: 'middle' }}>
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
                            {jobStatusLabel(job.status)}
                          </span>
                        </td>

                        {/* Attempts */}
                        <td style={{ padding: '14px 16px', verticalAlign: 'middle', color: '#64748b', fontSize: '13px' }}>
                          {job.attempts}
                        </td>

                        {/* Result / Action details */}
                        <td style={{ padding: '14px 16px', verticalAlign: 'middle' }}>
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
                              View listing
                            </Link>
                          )}

                          {job.status === 'failed' && (
                            <div style={{ fontSize: '13px', color: '#b91c1c' }}>
                              <div>{job.errorMessage || 'Something went wrong.'}</div>
                              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '2px' }}>
                                Something went wrong. Upload the photo again to retry.
                              </div>
                            </div>
                          )}

                          {(job.status === 'pending' || job.status === 'processing') && (
                            <span style={{ fontSize: '13px', color: '#64748b', fontStyle: 'italic' }}>
                              {jobStatusLabel(job.status)}
                            </span>
                          )}
                        </td>

                        {/* Individual Remove Button */}
                        <td style={{ padding: '14px 16px', verticalAlign: 'middle', textAlign: 'right' }}>
                          <button
                            type="button"
                            onClick={() => openDeleteConfirm([job.id], job.originalFileName)}
                            disabled={isDeletingThis || deletingJobIds.size > 0}
                            aria-label={`Remove listing for ${job.originalFileName}`}
                            title="Remove listing"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '32px',
                              height: '32px',
                              padding: 0,
                              color: '#64748b',
                              backgroundColor: 'transparent',
                              border: '1px solid transparent',
                              borderRadius: '6px',
                              cursor: isDeletingThis || deletingJobIds.size > 0 ? 'not-allowed' : 'pointer',
                              transition: 'color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease',
                            }}
                            onMouseEnter={(e) => {
                              if (!isDeletingThis && deletingJobIds.size === 0) {
                                e.currentTarget.style.color = '#dc2626';
                                e.currentTarget.style.backgroundColor = '#fef2f2';
                                e.currentTarget.style.borderColor = '#fecaca';
                              }
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.color = '#64748b';
                              e.currentTarget.style.backgroundColor = 'transparent';
                              e.currentTarget.style.borderColor = 'transparent';
                            }}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M3 6h18" />
                              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                              <line x1="10" y1="11" x2="10" y2="17" />
                              <line x1="14" y1="11" x2="14" y2="17" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {hasMoreListings && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  paddingTop: '16px',
                  marginTop: '12px',
                  borderTop: '1px solid #f1f5f9',
                }}
              >
                <button
                  id="toggle-listings-expand"
                  type="button"
                  onClick={() => setIsListingsExpanded((prev) => !prev)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '13.5px',
                    fontWeight: 600,
                    color: '#2563eb',
                    backgroundColor: 'transparent',
                    border: 'none',
                    padding: '8px 16px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s ease, color 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#eff6ff';
                    e.currentTarget.style.color = '#1d4ed8';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = '#2563eb';
                  }}
                >
                  {isListingsExpanded ? (
                    <>
                      <span>See less</span>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m18 15-6-6-6 6" />
                      </svg>
                    </>
                  ) : (
                    <>
                      <span>See more ({jobs.length - COLLAPSED_LISTINGS_LIMIT} more)</span>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </>
                  )}
                </button>
              </div>
            )}
          </>
        )}
        </section>

        {/* Delete Confirmation Modal */}
        {deleteConfirm && deleteConfirm.isOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(15, 23, 42, 0.45)',
              backdropFilter: 'blur(3px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 9999,
              padding: '16px',
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget && deletingJobIds.size === 0) {
                closeDeleteConfirm();
              }
            }}
          >
            <div
              style={{
                backgroundColor: '#ffffff',
                borderRadius: '16px',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
                border: '1px solid #e2e8f0',
                maxWidth: '440px',
                width: '100%',
                padding: '24px',
                position: 'relative',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', marginBottom: '16px' }}>
                <div
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '50%',
                    backgroundColor: '#fee2e2',
                    color: '#dc2626',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                </div>
                <div style={{ flex: 1 }}>
                  <h3
                    id="delete-dialog-title"
                    style={{ fontSize: '18px', fontWeight: 600, color: '#0f172a', marginBottom: '6px' }}
                  >
                    {deleteConfirm.jobIds.length === 1 ? 'Remove listing?' : `Remove ${deleteConfirm.jobIds.length} listings?`}
                  </h3>
                  <p style={{ fontSize: '14px', color: '#64748b', lineHeight: 1.5 }}>
                    {deleteConfirm.jobIds.length === 1
                      ? `Are you sure you want to remove the listing for "${deleteConfirm.title || 'this item'}"? The photo and generated data will be permanently deleted.`
                      : `Are you sure you want to remove the ${deleteConfirm.jobIds.length} selected listings? All photos and generated data will be permanently deleted.`}
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                <button
                  type="button"
                  onClick={closeDeleteConfirm}
                  disabled={deletingJobIds.size > 0}
                  style={{
                    padding: '9px 16px',
                    fontSize: '13.5px',
                    fontWeight: 500,
                    color: '#475569',
                    backgroundColor: '#ffffff',
                    border: '1px solid #cbd5e1',
                    borderRadius: '8px',
                    cursor: deletingJobIds.size > 0 ? 'not-allowed' : 'pointer',
                    transition: 'background-color 0.15s ease',
                  }}
                >
                  Cancel
                </button>
                <button
                  id="confirm-remove-listing-btn"
                  type="button"
                  onClick={() => void executeDelete()}
                  disabled={deletingJobIds.size > 0}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '9px 18px',
                    fontSize: '13.5px',
                    fontWeight: 600,
                    color: '#ffffff',
                    backgroundColor: deletingJobIds.size > 0 ? '#f87171' : '#dc2626',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: deletingJobIds.size > 0 ? 'not-allowed' : 'pointer',
                    transition: 'background-color 0.15s ease',
                    boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
                  }}
                >
                  {deletingJobIds.size > 0
                    ? 'Removing...'
                    : deleteConfirm.jobIds.length === 1
                    ? 'Remove listing'
                    : `Remove ${deleteConfirm.jobIds.length} listings`}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
