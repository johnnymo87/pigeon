/**
 * TgMessage types and TgMessageBuilder for constructing Telegram messages
 * using the entities API instead of Markdown parse_mode.
 *
 * Offsets and lengths are UTF-16 code unit counts, matching the Telegram Bot API spec.
 */

export interface TgEntity {
  offset: number;
  length: number;
  type: "bold" | "italic" | "code" | "pre";
}

export interface TgMessage {
  text: string;
  entities: TgEntity[];
}

export class TgMessageBuilder {
  private text = "";
  private entities: TgEntity[] = [];

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

  build(): TgMessage {
    return { text: this.text, entities: [...this.entities] };
  }

  private appendEntity(s: string, type: TgEntity["type"]): this {
    const offset = this.text.length;
    this.text += s;
    this.entities.push({ offset, length: s.length, type });
    return this;
  }
}

export function concatMessages(messages: TgMessage[]): TgMessage {
  let text = "";
  const entities: TgEntity[] = [];
  for (const msg of messages) {
    const offset = text.length;
    text += msg.text;
    for (const e of msg.entities) {
      entities.push({ offset: e.offset + offset, length: e.length, type: e.type });
    }
  }
  return { text, entities };
}
