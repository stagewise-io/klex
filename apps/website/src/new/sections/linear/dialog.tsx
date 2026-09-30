import './dialog.css';

type LinearIssueDialogProps = {
  title?: string;
  description?: string;
  assignee?: string;
  /** Issue identifier shown once the issue has been created. */
  createdAs?: string;
};

export function LinearIssueDialog({
  title,
  description,
  assignee,
  createdAs,
}: LinearIssueDialogProps) {
  return (
    <article
      className="linear-issue-dialog"
      aria-label="Linear new issue preview"
    >
      <header className="linear-issue-header">
        <span className="linear-issue-team">
          <span aria-hidden="true">☁</span> PRODUCT
        </span>
        <span className="linear-issue-chevron" aria-hidden="true">
          ›
        </span>
        <span className="linear-issue-heading">{createdAs ?? 'New issue'}</span>
        <span className="linear-issue-window-actions" aria-hidden="true">
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
            <path d="M9.5 2.75h3.75V6.5m0-3.75L9 7M6.5 13.25H2.75V9.5m0 3.75L7 9" />
          </svg>
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
            <path d="m3.5 3.5 9 9m0-9-9 9" />
          </svg>
        </span>
      </header>

      <div className="linear-issue-fields">
        <p
          className={
            title ? 'linear-issue-title' : 'linear-issue-title is-placeholder'
          }
        >
          {title || 'Issue title'}
        </p>
        <p
          className={
            description
              ? 'linear-issue-description'
              : 'linear-issue-description is-placeholder'
          }
        >
          {description || 'Add description...'}
        </p>
      </div>

      <div className="linear-issue-properties">
        <span className="linear-issue-pill is-active">
          <svg
            className="linear-issue-status-icon"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="7"
              cy="7"
              r="6"
              strokeWidth="2"
              strokeDasharray="1.57 1.57"
            />
          </svg>
          Backlog
        </span>
        <span className="linear-issue-pill">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path
              d="M1.5 7.25h3v1.5h-3zm5 0h3v1.5h-3zm5 0h3v1.5h-3z"
              stroke="none"
            />
          </svg>
          Priority
        </span>
        <span
          className={
            assignee ? 'linear-issue-pill is-active' : 'linear-issue-pill'
          }
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" strokeDasharray="1.5 3.4" />
            <circle
              cx="8"
              cy="6.75"
              r="2.25"
              fill="currentColor"
              stroke="none"
            />
            <path d="M3.75 12.25c1.5-2.75 7-2.75 8.5 0" />
          </svg>
          {assignee || 'Assignee'}
        </span>
        <span className="linear-issue-pill">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m8 1.75 5.5 3.125v6.25L8 14.25l-5.5-3.125v-6.25L8 1.75Zm0 6.5 5.5-3.375M8 8.25V14M8 8.25 2.5 4.875" />
          </svg>
          Project
        </span>
        <span className="linear-issue-pill">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 3.75h7A2.25 2.25 0 0 1 14.25 6v4A2.25 2.25 0 0 1 12 12.25H5L1.5 8 5 3.75Z" />
            <circle cx="6.5" cy="8" r="1" fill="currentColor" stroke="none" />
          </svg>
          Labels
        </span>
        <span
          className="linear-issue-pill linear-issue-more"
          role="img"
          aria-label="More properties"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="8" r="1.5" stroke="none" />
            <circle cx="8" cy="8" r="1.5" stroke="none" />
            <circle cx="13" cy="8" r="1.5" stroke="none" />
          </svg>
        </span>
      </div>

      <footer className="linear-issue-footer">
        <span
          className="linear-issue-attachment"
          role="img"
          aria-label="Attachment"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m13.1 8.2-3.7 3.7c-1.8 1.8-4.4 2-5.7.6s-1.2-3.9.6-5.7l3.4-3.4c1.2-1.2 2.9-1.3 3.8-.4s.8 2.6-.4 3.8L7.7 10.2c-.7.7-1.6.7-2 .3s-.4-1.3.3-2l3.1-3.1" />
          </svg>
        </span>
        <div className="linear-issue-footer-right">
          <span className="linear-issue-toggle" aria-hidden="true">
            <i />
          </span>
          <span className="linear-issue-create-more">Create more</span>
          <span
            className={
              createdAs ? 'linear-issue-submit is-done' : 'linear-issue-submit'
            }
          >
            {createdAs ? 'Created' : 'Create issue'}
          </span>
        </div>
      </footer>
    </article>
  );
}
