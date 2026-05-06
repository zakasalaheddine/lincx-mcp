import { Router } from "express";
import { buildAuthServerMetadata, buildResourceMetadata } from "../services/oauth/metadata.js";
import { PUBLIC_BASE_URL } from "../constants.js";

export const wellKnownRouter: Router = Router();

wellKnownRouter.get("/oauth-authorization-server", (_req, res) => {
  res.json(buildAuthServerMetadata(PUBLIC_BASE_URL));
});

wellKnownRouter.get("/oauth-protected-resource", (_req, res) => {
  res.json(buildResourceMetadata(PUBLIC_BASE_URL));
});
