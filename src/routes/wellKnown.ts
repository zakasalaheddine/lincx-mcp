import { Router } from "express";
import { buildAuthServerMetadata, buildResourceMetadata } from "../services/oauth/metadata.js";
import { PUBLIC_BASE_URL } from "../constants.js";

export const wellKnownRouter: Router = Router();

wellKnownRouter.get("/oauth-authorization-server", (_req, res) => {
  res.json(buildAuthServerMetadata(PUBLIC_BASE_URL));
});

// RFC 9728 §3.1: the well-known URI is the suffix "oauth-protected-resource"
// prefixed onto the resource path. Our resource is "<base>/mcp", so spec-
// conformant clients construct "<base>/.well-known/oauth-protected-resource/mcp"
// and ignore the root form. Serve both so every client finds discovery.
wellKnownRouter.get(["/oauth-protected-resource", "/oauth-protected-resource/mcp"], (_req, res) => {
  res.json(buildResourceMetadata(PUBLIC_BASE_URL));
});
