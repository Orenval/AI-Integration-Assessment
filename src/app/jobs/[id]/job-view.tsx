'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { DashboardHeader } from '@/app/dashboard/dashboard-header';
import { JobDetailDto } from '@/lib/ai/types';
import { ExtractionResult } from '@/lib/ai/schemas';
import { ensureCsrfToken } from '@/lib/api-client';

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

interface JobDetailViewProps {
  jobId: string;
  user: {
    fullName: string;
    email: string;
  };
}

export function JobDetailView({ jobId, user }: JobDetailViewProps) {
  const [job, setJob] = useState<JobDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [expandedText, setExpandedText] = useState<string | null>(null);

  const fetchJobStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/status`, {
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        if (res.status === 404) {
          setError('Job not found or access denied.');
        } else {
          setError('Could not load this listing.');
        }
        return;
      }

      const data = await res.json();
      if (data.success && data.job) {
        setJob(data.job);
        if (data.job.expandedResult) {
          setExpandedText(data.job.expandedResult);
        }
      }
    } catch {
      setError('Network error. We could not load this listing.');
    } finally {
      setIsLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    let mounted = true;

    const loadInitialData = async () => {
      await ensureCsrfToken();
      if (mounted) {
        await fetchJobStatus();
      }
    };

    void loadInitialData();

    return () => {
      mounted = false;
    };
  }, [fetchJobStatus]);

  const handleExpandClick = async () => {
    if (isExpanding) return;

    setIsExpanding(true);
    setExpandError(null);

    try {
      const csrfToken = await ensureCsrfToken();
      const res = await fetch(`/api/jobs/${jobId}/expand`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
      });

      const data = await res.json();

      if (res.ok && data.success && data.expandedResult) {
        setExpandedText(data.expandedResult);
      } else {
        setExpandError(data.message || 'Please try again.');
      }
    } catch {
      setExpandError('Network error. Please try again.');
    } finally {
      setIsExpanding(false);
    }
  };

  const extraction = job?.result as ExtractionResult | undefined;

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f8fafc', color: '#0f172a' }}>
      <DashboardHeader user={user} />

      <main style={{ maxWidth: '840px', margin: '0 auto', padding: '32px 20px 64px' }}>
        {/* Navigation Breadcrumb */}
        <div style={{ marginBottom: '24px' }}>
          <Link
            href="/upload"
            aria-label="Back to upload"
            title="Back to upload"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#2563eb',
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

        {isLoading ? (
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              border: '1px solid #e2e8f0',
              padding: '48px 24px',
              textAlign: 'center',
              color: '#64748b',
            }}
          >
            Loading your listing...
          </div>
        ) : error ? (
          <div
            role="alert"
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              border: '1px solid #fecaca',
              padding: '32px 24px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '28px', marginBottom: '8px' }}>⚠️</div>
            <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#991b1b', marginBottom: '8px' }}>
              {error}
            </h2>
            <Link
              href="/upload"
              style={{
                display: 'inline-block',
                marginTop: '12px',
                padding: '8px 16px',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Return to uploads
            </Link>
          </div>
        ) : job?.status !== 'done' ? (
          /* Non-done job state */
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              border: '1px solid #e2e8f0',
              padding: '36px 28px',
              textAlign: 'center',
            }}
          >
            <div style={{ marginBottom: '16px' }}>
              <span
                style={{
                  display: 'inline-block',
                  padding: '6px 14px',
                  borderRadius: '9999px',
                  fontSize: '13px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  backgroundColor: job?.status === 'failed' ? '#fee2e2' : '#e0e7ff',
                  color: job?.status === 'failed' ? '#b91c1c' : '#4338ca',
                }}
              >
                Status: {job?.status ? jobStatusLabel(job.status) : ''}
              </span>
            </div>

            <h2 style={{ fontSize: '20px', fontWeight: 600, color: '#1e293b', marginBottom: '8px' }}>
              {job?.originalFileName}
            </h2>

            {job?.status === 'failed' ? (
              <div>
                <p style={{ color: '#b91c1c', fontSize: '15px', marginBottom: '8px' }}>
                  {job.errorMessage || 'AI extraction failed for this photo.'}
                </p>
                <p style={{ color: '#64748b', fontSize: '14px', marginBottom: '20px' }}>
                   Something went wrong. Upload the photo again to retry.
                </p>
                <Link
                  href="/upload"
                  style={{
                    display: 'inline-block',
                    padding: '8px 18px',
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontWeight: 500,
                    textDecoration: 'none',
                  }}
                >
                   Go to upload page
                </Link>
              </div>
            ) : (
              <div>
                <p style={{ color: '#475569', fontSize: '15px', marginBottom: '16px' }}>
                  Still working on this photo.
                </p>
                <button
                  type="button"
                  onClick={() => void fetchJobStatus()}
                  style={{
                    padding: '8px 18px',
                    backgroundColor: '#f1f5f9',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Check Status Again
                </button>
              </div>
            )}
          </div>
        ) : (
          /* Done state with structured result and expand action */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
            {/* Structured Result Card */}
            <section
              style={{
                backgroundColor: '#ffffff',
                borderRadius: '12px',
                border: '1px solid #e2e8f0',
                boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
                padding: '28px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', gap: '16px' }}>
                <div>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '4px 10px',
                       backgroundColor: '#dcfce7',
                       color: '#166534',
                       borderRadius: '9999px',
                      fontSize: '12px',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      marginBottom: '8px',
                    }}
                  >
                    Done
                  </span>
                  <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#0f172a', letterSpacing: '-0.02em' }}>
                    {extraction?.title || job.originalFileName}
                  </h1>
                </div>

                <span style={{ fontSize: '13px', color: '#64748b', whiteSpace: 'nowrap' }}>
                  Source: {job.originalFileName}
                </span>
              </div>

              {/* Category */}
              <div style={{ marginBottom: '18px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '4px' }}>
                  Category
                </span>
                <div style={{ fontSize: '15px', fontWeight: 500, color: '#334155' }}>
                  {extraction?.category || 'Uncategorized'}
                </div>
              </div>

              {/* Short Description */}
              <div style={{ marginBottom: '22px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '4px' }}>
                   Description
                 </span>
                <p style={{ fontSize: '15px', lineHeight: 1.6, color: '#1e293b' }}>
                  {extraction?.shortDescription}
                </p>
              </div>

              {/* Estimated Tags */}
              <div>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '8px' }}>
                   Tags
                 </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {extraction?.estimatedTags && extraction.estimatedTags.length > 0 ? (
                    extraction.estimatedTags.map((tag, idx) => (
                      <span
                        key={idx}
                        style={{
                          display: 'inline-block',
                          padding: '4px 12px',
                          backgroundColor: '#f1f5f9',
                          color: '#334155',
                          borderRadius: '6px',
                          fontSize: '13px',
                          fontWeight: 500,
                          border: '1px solid #e2e8f0',
                        }}
                      >
                        #{tag}
                      </span>
                    ))
                  ) : (
                     <span style={{ fontSize: '14px', color: '#475569' }}>No tags available</span>
                  )}
                </div>
              </div>
            </section>

            {/* Expansion Card / Action */}
            <section
              style={{
                backgroundColor: '#ffffff',
                borderRadius: '12px',
                border: '1px solid #e2e8f0',
                boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
                padding: '28px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div>
                  <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#1e293b' }}>
                    Extended listing
                  </h2>
                  <p style={{ color: '#64748b', fontSize: '14px', marginTop: '2px' }}>
                    Write a longer description using only the facts from the extraction.
                  </p>
                </div>
              </div>

              {expandError && (
                <div
                  role="alert"
                  style={{
                    padding: '12px 16px',
                    backgroundColor: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '8px',
                    color: '#991b1b',
                    fontSize: '14px',
                    marginBottom: '16px',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>We could not write the listing. Please try again.</div>
                  <div>{expandError}</div>
                </div>
              )}

              {expandedText ? (
                <div
                  style={{
                    backgroundColor: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '20px',
                    fontSize: '15px',
                    lineHeight: 1.7,
                    color: '#1e293b',
                    whiteSpace: 'pre-line',
                  }}
                >
                  {expandedText}
                </div>
              ) : (
                <div>
                  <button
                    type="button"
                    onClick={handleExpandClick}
                    disabled={isExpanding}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '10px 20px',
                      backgroundColor: isExpanding ? '#94a3b8' : 'var(--color-primary, #2563eb)',
                      color: '#ffffff',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: 600,
                      border: 'none',
                      cursor: isExpanding ? 'not-allowed' : 'pointer',
                      transition: 'background-color 0.15s ease',
                    }}
                  >
                     {isExpanding ? 'Writing your listing' : 'Write a longer listing'}
                  </button>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
