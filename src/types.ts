// Worker environment bindings
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  COOKIE_SECRET: string;
  GPTMAIL_API_KEY?: string;
  // Registration-only credentials are environment-managed secrets. API keys are
  // resolved to stable client IDs and are never stored in D1.
  REGISTRATION_API_KEYS?: string;
  REGISTRATION_KR_API_KEY?: string;
  REGISTRATION_US2_API_KEY?: string;
  REGISTRATION_CLAIM_SECRET?: string;
}

// Database row types
export interface SettingRow {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface GroupRow {
  id: number;
  name: string;
  description: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface AccountRow {
  id: number;
  email: string;
  client_id: string;
  refresh_token: string;
  password: string;
  group_id: number;
  remark: string;
  status: string;
  country: string;
  ip_type: string;
  inbox_total: number | null;
  inbox_count_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TempEmailRow {
  id: number;
  email: string;
  source: string;
  remark: string;
  created_at: string;
  updated_at: string;
}

// A background detect / refresh / count job row.
export interface DetectJobRow {
  id: number;
  kind: string;
  scope_ids: string;
  scope_group_id: number | null;
  scope_status: string | null;
  scope_tag_id: number | null;
  scope_label: string;
  total: number;
  cursor_id: number;
  processed: number;
  connected: number;
  failed: number;
  deleted: number;
  state: string;
  last_email: string;
  last_error: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

// A task log row (token refresh / email push / detect / log cleanup).
export interface TaskLogRow {
  id: number;
  task: string;
  level: string;
  message: string;
  created_at: string;
}

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    code: string;
    message: string;
  };
}

// Graph API types
export interface GraphTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface GraphMailMessage {
  id: string;
  subject: string;
  from: {
    emailAddress: {
      name: string;
      address: string;
    };
  };
  toRecipients: Array<{
    emailAddress: {
      name: string;
      address: string;
    };
  }>;
  ccRecipients?: Array<{
    emailAddress: {
      name: string;
      address: string;
    };
  }>;
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  hasAttachments: boolean;
  body?: {
    contentType: string;
    content: string;
  };
  internetMessageHeaders?: Array<{
    name: string;
    value: string;
  }>;
}
