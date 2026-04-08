import type { Connection, Session, SessionCreateRequest, ApiError } from "./types.ts";

export class HoopApiClient {
  private apiUrl: string;
  private token: string;

  constructor(apiUrl: string, token: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      let message = `API error: ${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) {
          message = body.message;
        }
      } catch {
        // ignore parse errors
      }
      const err: ApiError = { message, status: response.status };
      throw err;
    }

    return response.json() as Promise<T>;
  }

  async listConnections(): Promise<Connection[]> {
    return this.request<Connection[]>("/api/connections");
  }

  async getConnection(name: string): Promise<Connection> {
    return this.request<Connection>(`/api/connections/${encodeURIComponent(name)}`);
  }

  async createSession(req: SessionCreateRequest): Promise<Session> {
    return this.request<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async getSession(id: string): Promise<Session> {
    return this.request<Session>(`/api/sessions/${encodeURIComponent(id)}`);
  }
}

export function createClient(apiUrl: string, token: string): HoopApiClient {
  return new HoopApiClient(apiUrl, token);
}
