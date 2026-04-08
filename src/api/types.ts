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

export interface CredentialsRequest {
  access_duration_sec: number;
}

export interface CredentialsResponse {
  id: string;
  connection_name: string;
  connection_type: string;
  connection_sub_type: string;
  session_id: string;
  has_review: boolean;
  review_id?: string;
  created_at: string;
  expire_at: string;
  connection_credentials?: SSHCredentials | HttpProxyCredentials;
}

export interface SSHCredentials {
  hostname: string;
  port: string;
  username: string;
  password: string;
  command: string;
}

export interface HttpProxyCredentials {
  hostname: string;
  port: string;
  proxy_token: string;
  command: string;
}

export interface ApiError {
  message: string;
  status: number;
}
