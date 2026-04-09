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
