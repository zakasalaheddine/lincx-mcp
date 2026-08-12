/**
 * tools/_shared.js
 *
 * Reusable input-schema fragments and entity helpers shared across business
 * tools. Centralizing these (T1-4) shrinks the per-request tool-schema payload
 * and keeps list/get tools consistent.
 */

import { z } from 'zod'

import { workApiRequest } from '../services/workApi.js'

/** Standard list-tool input fragment — spread into `z.object({ ...paginationShape }).strict()`. */
export const paginationShape = {
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
  fields: z
    .array(z.string())
    .optional()
    .describe("Extra item fields to include beyond { id, name } plus status fields. Dotted paths are supported and project just the leaf under its dotted key — e.g. ['params.zoneId'] returns { \"params.zoneId\": [...] } without the rest of params, which is the difference between a walkable sweep and an oversized one on rows with large arrays. Any requested field that matched NO row is reported back in the envelope's unknown_fields, so a wrong path is never silently empty. That check is judged against every row FETCHED — which for these endpoints is the whole collection, since the Work API returns the full set and this server windows it client-side — NOT against the returned page. So unknown_fields containing a path means no row anywhere in the collection carries it, and its absence means at least one row does, even if none appear on the page you are looking at. (The only exception is an upstream endpoint that paginates server-side, where the page is all that was fetched; none do today.) Use ['*'] to return full rows (still size-capped).")
}

/**
 * `include[]` fragment for get-by-id tools that can pull related data in one
 * call — replaces the standalone `get_*_parents` tools (T1-2).
 */
export const includeShape = {
  include: z
    .array(z.enum(['parents']))
    .optional()
    .describe("Related data to fetch alongside the entity. 'parents' adds the parent hierarchy under a `parents` key.")
}

/** Read-only tool annotations — the common case for every get/list tool. */
export const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}

/**
 * Fetch a single entity, optionally fanning out to its `/parents` endpoint in
 * parallel. When parents are requested the result is ALWAYS wrapped as
 * `{ entity, parents }` — one stable shape regardless of the entity's own shape
 * (some endpoints wrap in `{ data }`, others don't). Without `include`, the raw
 * entity response is returned unchanged, identical to the old `get_*` behavior.
 */
export async function getEntityWithIncludes (
  session,
  basePath,
  id,
  include
) {
  if (!include?.includes('parents')) {
    return workApiRequest(session, 'GET', `${basePath}/${id}`)
  }
  const [entity, parents] = await Promise.all([
    workApiRequest(session, 'GET', `${basePath}/${id}`),
    workApiRequest(session, 'GET', `${basePath}/${id}/parents`)
  ])
  return { entity, parents }
}
