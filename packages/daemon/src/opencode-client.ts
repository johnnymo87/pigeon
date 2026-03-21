interface OpencodeClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
}

export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpencodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/global/health`, {
        method: "GET",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async createSession(directory: string): Promise<{ id: string }> {
    const response = await this.fetchFn(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
    });

    if (!response.ok) {
      throw new Error(`createSession failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<{ id: string }>;
  }

  async sendPrompt(sessionId: string, directory: string, prompt: string): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: {
        "x-opencode-directory": directory,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
    });

    if (!response.ok) {
      throw new Error(`sendPrompt failed: ${response.status} ${response.statusText}`);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/session/${sessionId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(`deleteSession failed: ${response.status} ${response.statusText}`);
    }
  }

  async getSessionMessages(sessionId: string): Promise<unknown[]> {
    const res = await this.fetchFn(`${this.baseUrl}/session/${sessionId}/message`, {
      method: "GET",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`getSessionMessages failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  async summarize(sessionId: string, providerID: string, modelID: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/session/${sessionId}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID, modelID, auto: false }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`summarize failed (${res.status}): ${body}`);
    }
  }
}
