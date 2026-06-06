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

  /**
   * Look up a session by id. Returns null on 404 (session truly gone),
   * throws on other failures (network error, 5xx). The 404 vs throw split
   * lets callers distinguish "session deleted from opencode-serve" from
   * "opencode-serve is unreachable."
   */
  async getSession(sessionId: string): Promise<{ id: string; directory: string } | null> {
    const response = await this.fetchFn(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(`getSession failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { id?: string; directory?: string };
    if (!body || !body.id || !body.directory) {
      throw new Error(`getSession response missing id or directory: ${JSON.stringify(body)}`);
    }
    return { id: body.id, directory: body.directory };
  }

  async getSessionInfo(sessionId: string): Promise<{
    id: string;
    title: string;
    directory: string;
    time: { created: number; updated: number };
  } | null> {
    const response = await this.fetchFn(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(`getSessionInfo failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as {
      id?: string;
      title?: string;
      directory?: string;
      time?: { created?: number; updated?: number };
    };

    if (!body || !body.id || !body.directory) {
      throw new Error(`getSessionInfo response missing id or directory: ${JSON.stringify(body)}`);
    }

    return {
      id: body.id,
      title: body.title ?? "",
      directory: body.directory,
      time: {
        created: body.time?.created ?? 0,
        updated: body.time?.updated ?? 0,
      },
    };
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

  async abortSession(sessionId: string): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/session/${sessionId}/abort`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`abortSession failed: ${response.status} ${response.statusText}`);
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

  async mcpStatus(directory?: string): Promise<Record<string, { status: string; error?: string }>> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchFn(`${this.baseUrl}/mcp`, {
      method: "GET",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`mcpStatus failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<Record<string, { status: string; error?: string }>>;
  }

  async mcpConnect(name: string, directory?: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchFn(`${this.baseUrl}/mcp/${encodeURIComponent(name)}/connect`, {
      method: "POST",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    return res.ok;
  }

  async mcpDisconnect(name: string, directory?: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchFn(`${this.baseUrl}/mcp/${encodeURIComponent(name)}/disconnect`, {
      method: "POST",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    return res.ok;
  }

  async listProviders(): Promise<{
    all: Array<{ id: string; models: Record<string, unknown> }>;
    default: Record<string, string>;
    connected: string[];
  }> {
    const res = await this.fetchFn(`${this.baseUrl}/provider`, {
      method: "GET",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`listProviders failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<{
      all: Array<{ id: string; models: Record<string, unknown> }>;
      default: Record<string, string>;
      connected: string[];
    }>;
  }
}
