interface OpencodeClientOptions {
  baseUrl: string;
  password?: string;
  fetchFn?: typeof fetch;
}

export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly password: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpencodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.password = options.password;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.password !== undefined) {
      headers["Authorization"] = "Basic " + btoa(`opencode:${this.password}`);
    }
    return headers;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/global/health`, {
        method: "GET",
        headers: this.buildHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async createSession(directory: string): Promise<{ id: string }> {
    const response = await this.fetchFn(`${this.baseUrl}/session`, {
      method: "POST",
      headers: this.buildHeaders({ "x-opencode-directory": directory }),
    });

    if (!response.ok) {
      throw new Error(`createSession failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<{ id: string }>;
  }

  async sendPrompt(sessionId: string, directory: string, prompt: string): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: this.buildHeaders({
        "x-opencode-directory": directory,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
    });

    if (!response.ok) {
      throw new Error(`sendPrompt failed: ${response.status} ${response.statusText}`);
    }
  }
}
