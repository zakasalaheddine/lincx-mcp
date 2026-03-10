export interface Network {
  id: string;
  name: string;
}

export interface Session {
  session_id: string;
  user_id: string;
  email: string;
  auth_token: string;
  networks: Network[];
  active_network: string | null;
}

export interface SessionValidationResult {
  valid: boolean;
  session?: Session;
  error?: string;
}

export interface ApiProject {
  id: string;
  name: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  has_more: boolean;
}
