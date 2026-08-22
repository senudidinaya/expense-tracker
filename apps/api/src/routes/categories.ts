import {
  categoriesResponse,
  categoryDto,
  createCategoryBody,
  errorEnvelope,
  errorResponse,
  patchCategoryBody,
  uuid,
} from "@expense/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { currentUserId } from "../plugins/auth.js";
import { categoriesRepo, type CategoryRecord } from "../repos/categories.js";

const categoryResponse = z.object({ category: categoryDto });

/** The only path parameter these routes take. A non-uuid is a 400, not a lookup. */
const idParams = z.object({ id: uuid });

/**
 * The repository's `Date` columns become the wire's ISO strings here, at the
 * HTTP boundary — `categoryDto` declares them as `z.iso.datetime`.
 */
const toDto = (c: CategoryRecord) => ({
  id: c.id,
  name: c.name,
  archivedAt: c.archivedAt === null ? null : c.archivedAt.toISOString(),
  createdAt: c.createdAt.toISOString(),
});

/**
 * Handlers are thin — parse, one repo call, reply. All SQL lives in `repos/`,
 * and so does the `user_id` scoping; what happens here is the translation of a
 * repository result into a status code.
 */
export const categoryRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (
  app,
  { db },
) => {
  app.get(
    "/",
    {
      preHandler: app.authenticate,
      schema: { response: { 200: categoriesResponse, 401: errorResponse } },
    },
    async (req, reply) => {
      const items = await categoriesRepo.listAll(db, currentUserId(req));
      // Active and archived together, each flagged by `archivedAt`:
      // design/api.md keeps archived categories usable in filters and reports.
      return reply.send({ items: items.map(toDto) });
    },
  );

  app.post(
    "/",
    {
      preHandler: app.authenticate,
      schema: {
        body: createCategoryBody,
        response: {
          201: categoryResponse,
          400: errorResponse,
          401: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const result = await categoriesRepo.create(
        db,
        currentUserId(req),
        req.body.name,
      );
      if (!result.ok) {
        return reply
          .code(409)
          .send(
            errorEnvelope(
              "conflict",
              "You already have an active category with that name",
            ),
          );
      }
      return reply.code(201).send({ category: toDto(result.category) });
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: app.authenticate,
      schema: {
        params: idParams,
        body: patchCategoryBody,
        response: {
          200: categoryResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const result = await categoriesRepo.patch(
        db,
        currentUserId(req),
        req.params.id,
        req.body,
      );

      if (!result.ok) {
        // One message for "no such category" and for "someone else's category".
        // A different word in either case would confirm the id exists.
        return result.reason === "not_found"
          ? reply
              .code(404)
              .send(errorEnvelope("not_found", "Category not found"))
          : reply
              .code(409)
              .send(
                errorEnvelope(
                  "conflict",
                  "You already have an active category with that name",
                ),
              );
      }

      return reply.send({ category: toDto(result.category) });
    },
  );
};
