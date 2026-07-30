'use strict';

/**
 * Single shared HTML email template, reused across all three trigger types
 * with different subject/copy (TODO.md #10, Phase 3). Kept intentionally
 * simple: table-based layout with INLINE styles as the baseline (many email
 * clients strip <style> blocks or class names entirely), plus a small
 * <style>/`prefers-color-scheme` block layered on top for clients that do
 * honor it (Apple Mail, Outlook desktop, etc.) so the card doesn't look like
 * a stark white rectangle in an otherwise-dark inbox. Gmail's own apps don't
 * read that media query, but they auto-invert light-styled emails reasonably
 * well on their own, so the inline light styling is a safe universal
 * fallback either way.
 */

const COPY = {
  startingSoon: { subjectPrefix: 'Starting soon', heading: 'A task is starting soon' },
  overdue: { subjectPrefix: 'Overdue', heading: 'A task is overdue' },
  dueToday: { subjectPrefix: 'Due today', heading: 'A task is due today' },
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * @param {'startingSoon'|'overdue'|'dueToday'} type
 * @param {{title: string}} task
 * @param {string} detailLine - plain-English specifics, e.g. "Starts at 14:00" / "Was due 2026-07-29" / "Due date is today"
 * @returns {{subject: string, html: string}}
 */
function buildNotificationEmail(type, task, detailLine) {
  const copy = COPY[type];
  const title = escapeHtml(task.title);
  const subject = `${copy.subjectPrefix}: ${title}`;

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <style>
      @media (prefers-color-scheme: dark) {
        .tf-bg { background: #18181b !important; }
        .tf-card { background: #232326 !important; }
        .tf-heading, .tf-title { color: #f4f4f5 !important; }
        .tf-detail { color: #a1a1aa !important; }
        .tf-footer-cell { background: #1c1c1f !important; border-top-color: #3f3f46 !important; }
        .tf-footer-text { color: #71717a !important; }
      }
    </style>
  </head>
  <body class="tf-bg" style="margin:0;padding:0;background:#f4f4f5;">
    <span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(detailLine)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="tf-bg" style="background:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="tf-card" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 24px 8px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                <p style="margin:0 0 4px;font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#6366f1;">TaskFlow</p>
                <h1 class="tf-heading" style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#18181b;">${copy.heading}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                <p class="tf-title" style="margin:0 0 8px;font-size:16px;color:#18181b;font-weight:600;">${title}</p>
                <p class="tf-detail" style="margin:0;font-size:14px;color:#52525b;">${escapeHtml(detailLine)}</p>
              </td>
            </tr>
            <tr>
              <td class="tf-footer-cell" style="padding:16px 24px;background:#fafafa;border-top:1px solid #e4e4e7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                <p class="tf-footer-text" style="margin:0;font-size:12px;color:#a1a1aa;">
                  You're receiving this because email notifications are enabled in TaskFlow's Settings &rarr; Notifications. Turn this off any time from there.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html };
}

module.exports = { buildNotificationEmail };
