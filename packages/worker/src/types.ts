// Env is declared globally for Cloudflare Workers
// See: https://developers.cloudflare.com/workers/configuration/typescript/

declare global {
  interface Env {
    DB: D1Database;
    CCR_API_KEY: string;
    /** Retire the shared key: CSV of machine ids it may no longer act as, or `*` (pigeon-k0qn.8). */
    SHARED_KEY_REFUSED_MACHINES?: string;
    /** "off" sends Slack posts as rich_text instead of markdown blocks (pigeon-4ogz.3). */
    SLACK_MARKDOWN_BLOCKS?: string;
    /**
     * Slack owner-mention categories: comma list of questions, errors, named, alerts. Empty or unset
     * means no mention at all (pushes off). See src/chat/slack-notify.ts.
     */
    SLACK_NOTIFY_OWNER?: string;
    // SLACK_WORKSPACE_<MACHINE> secrets are read by name through a Record cast in
    // src/chat/slack-config.ts: one key per machine, so they cannot be listed here.
    MEDIA: R2Bucket;
  }
}
export {};
