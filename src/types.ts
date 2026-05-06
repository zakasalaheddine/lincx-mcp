export interface Network {
  id: string;
  name: string;
  owner: string;
  members: string[];
  observers: string[];
  dateCreated: string;
  dateUpdated: string;
  userUpdated: string;
  customDimensions: Array<{ name: string; dateCreated: string }>;
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

// ── OAuth ────────────────────────────────────────────────────────────────────

export interface OauthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
}

export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  lincx_session_id: string;
  expires_at: number;
}

export interface AccessToken {
  token: string;
  client_id: string;
  lincx_session_id: string;
  expires_at: number;
}

export interface RefreshToken {
  token: string;
  client_id: string;
  lincx_session_id: string;
  expires_at: number;
}
