/**
 * Shared TypeScript types for the MCP server.
 */

export interface Session {
  session_id: string;
  user_id: string;
  email: string;
  auth_token: string;
  networks: Array<{ id: string; name: string }>;
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
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  has_more: boolean;
}
