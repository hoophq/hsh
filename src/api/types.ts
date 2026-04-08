export interface Connection {
  id: string;
  name: string;
  type: string;
  subtype?: string;
  agent_id?: string;
  status?: string;
  managed_by?: string;
  tags?: Record<string, string>;
  access_mode_runbooks?: string;
  access_mode_exec?: string;
  access_mode_connect?: string;
  access_schema?: AccessSchema;
}

export interface AccessSchema {
  ssh_host?: string;
  ssh_port?: string;
  ssh_user?: string;
  kubernetes_namespace?: string;
  cluster_name?: string;
}

export interface Session {
  id: string;
  connection: string;
  status: string;
  user_email?: string;
  metadata?: Record<string, string>;
  script?: SessionScript;
}

export interface SessionScript {
  data?: string;
}

export interface SessionCreateRequest {
  connection: string;
  type?: string;
  metadata?: Record<string, string>;
  script?: string;
}

export interface ApiError {
  message: string;
  status: number;
}
