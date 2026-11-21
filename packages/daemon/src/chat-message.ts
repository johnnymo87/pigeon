/**
 * ChatMessage types and ChatMessageBuilder for constructing chat message
 * using the entities API instead of Markdown parse_mode.
 *
 * Offsets and lengths are UTF-16 code unit counts, matching the entities spec of the wire format (Telegram's, kept as the wire shape).
 */

export interface ChatEntity {
  offset: number;
  length: number;
  type: "bold" | "italic" | "code" | "pre";
}

export interface ChatMessage {
  text: string;
  entities: ChatEntity[];
}

export class ChatMessageBuilder {
  private text = "";
  private entities: ChatEntity[] = [];

  append(s: string): this {
    this.text += s;
    return this;
  }

  appendBold(s: string): this {
    return this.appendEntity(s, "bold");
  }

  appendItalic(s: string): this {
    return this.appendEntity(s, "italic");
  }

  appendCode(s: string): this {
    return this.appendEntity(s, "code");
  }

  appendPre(s: string): this {
    return this.appendEntity(s, "pre");
  }

  newline(count = 1): this {
    this.text += "\n".repeat(count);
    return this;
  }

  build(): ChatMessage {
    return { text: this.text, entities: [...this.entities] };
  }

  private appendEntity(s: string, type: ChatEntity["type"]): this {
    const offset = this.text.length;
    this.text += s;
    this.entities.push({ offset, length: s.length, type });
    return this;
  }
}

export function concatMessages(messages: ChatMessage[]): ChatMessage {
  let text = "";
  const entities: ChatEntity[] = [];
  for (const msg of messages) {
    const offset = text.length;
    text += msg.text;
    for (const e of msg.entities) {
      entities.push({ offset: e.offset + offset, length: e.length, type: e.type });
    }
  }
  return { text, entities };
}
