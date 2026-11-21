/** Limits shared by every inbound chat ingress (Slack's, and Telegram's while it exists). */

/** Longest command body accepted. */
export const MAX_COMMAND_LENGTH = 10_000;

/** Largest inbound file accepted, in bytes. */
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Max image dimension (px) for inbound photos. Anthropic's API limits images to
 * 2000px per side in many-image requests (21+), and auto-resizes above 1568px
 * adding latency. We pick the largest variant within this bound.
 */
export const MAX_IMAGE_DIMENSION = 1568;

/** Longest replied-to bot text forwarded as context. */
export const IN_REPLY_TO_MAX_CHARS = 500;
