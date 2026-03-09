# Inbound Image Sizing Design

## Problem

Telegram photos relayed to Claude via R2 can exceed Anthropic's API image size limits. When a conversation has 21+ images, Claude enforces a 2000px-per-dimension limit. Even below that threshold, images above 1568px get server-side resized, adding latency to time-to-first-token.

The worker currently picks the largest Telegram photo variant (`photo[photo.length - 1]`), which can be up to ~2560px or larger.

## Solution

Pick a right-sized Telegram photo variant instead of always picking the largest.

Telegram sends a `photo[]` array sorted ascending by size, typically providing variants at ~90px, ~320px, ~800px, and ~1280px. Change `extractMedia()` to iterate the array and select the largest variant where both `width <= 1568` and `height <= 1568`.

If no variant fits (practically impossible since Telegram always generates small thumbnails), skip the media entirely and deliver only the text command.

## Target: 1568px

- Anthropic's optimal threshold: images above 1568px get server-side resized
- Well under the 2000px multi-image hard limit
- Well under the 8000px single-image hard limit
- Telegram's ~1280px "large" variant typically selected, which is high quality

## Scope

- **Changed**: `extractMedia()` in `packages/worker/src/webhook.ts`
- **Not changed**: document/audio/video/voice (not images), outbound path (Telegram accepts any size), daemon, plugin

## Trade-offs

- We depend on Telegram's pre-generated sizes rather than resizing ourselves. The ~1280px variant may be lower resolution than the original. For most use cases (screenshots, photos of text, diagrams) this is more than sufficient.
- If finer control is ever needed, daemon-side resizing with `sharp` can be layered on without changing this logic.

## Alternatives Considered

1. **Daemon-side resizing with `sharp`**: Full control over dimensions but adds a native dependency, complexity, and latency.
2. **Worker-side WASM resizing**: Right-sized images in R2 but adds ~2MB to worker bundle and complexity.

Both rejected in favor of the simpler approach. Can revisit if the ~1280px Telegram variant proves insufficient.
