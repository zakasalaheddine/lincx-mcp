import { Router } from "express";
import { consumeAuthCode } from "../services/oauth/codes.js";
import { issueTokens, refreshTokens } from "../services/oauth/tokens.js";
import { verifyPkce } from "../services/oauth/pkce.js";
import { getClient } from "../services/oauth/clients.js";

export const oauthTokenRouter         = Router();

oauthTokenRouter.post("/token", async (req, res) => {
  const { grant_type } = req.body ?? {};

  if (grant_type === "authorization_code") {
    const { code, redirect_uri, client_id, code_verifier } = req.body;

    if (!code || !redirect_uri || !client_id || !code_verifier) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const client = await getClient(client_id);
    if (!client) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    const authCode = await consumeAuthCode(code);
    if (!authCode) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    if (authCode.client_id !== client_id) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    if (authCode.redirect_uri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    if (!verifyPkce(code_verifier, authCode.code_challenge, "S256")) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    const tokens = await issueTokens({
      client_id,
      lincx_session_id: authCode.lincx_session_id,
    });
    res.json(tokens);
    return;
  }

  if (grant_type === "refresh_token") {
    const { refresh_token, client_id } = req.body;
    if (!refresh_token || !client_id) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const tokens = await refreshTokens(refresh_token, client_id);
    if (!tokens) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    res.json(tokens);
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});
