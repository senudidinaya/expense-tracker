import {
  createExpenseBody,
  errorEnvelope,
  errorResponse,
  expenseDto,
  listExpensesResponse,
  patchExpenseBody,
  uuid,
} from "@expense/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { currentUserId } from "../plugins/auth.js";
import { expensesRepo, type ExpenseRecord } from "../repos/expenses.js";

const expenseResponse = z.object({ expense: expenseDto });

const idParams = z.object({ id: uuid });

/** `Date` columns become ISO strings at the HTTP boundary; the rest already match the wire. */
const toDto = (e: ExpenseRecord) => ({
  ...e,
  createdAt: e.createdAt.toISOString(),
  updatedAt: e.updatedAt.toISOString(),
});

/**
 * The failure half of an `ExpenseResult`, as a reply.
 *
 * Both 404s carry the same message for the same resource, so "not yours" and
 * "not there" are one answer: `PATCH` and `DELETE` on another user's id must be
 * byte-identical to the same call on an id that never existed, or the pair is an
 * existence oracle.
 */
function sendFailure(
  reply: FastifyReply,
  reason: "not_found" | "category_not_found" | "category_archived",
) {
  switch (reason) {
    case "not_found":
      return reply
        .code(404)
        .send(errorEnvelope("not_found", "Expense not found"));
    case "category_not_found":
      return reply
        .code(404)
        .send(errorEnvelope("not_found", "Category not found"));
    case "category_archived":
      // Not 404: the user can see this category, they simply cannot file new
      // spending under an archived one.
      return reply
        .code(400)
        .send(
          errorEnvelope("validation_failed", "Invalid request", [
            { path: "categoryId", message: "category is archived" },
          ]),
        );
  }
}

export const expenseRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (
  app,
  { db },
) => {
  app.get(
    "/",
    {
      preHandler: app.authenticate,
      schema: { response: { 200: listExpensesResponse, 401: errorResponse } },
    },
    async (req, reply) => {
      const items = await expensesRepo.list(db, currentUserId(req));
      // Task 9 adds the filters, the keyset cursor and the first-page totals.
      return reply.send({ items: items.map(toDto), nextCursor: null });
    },
  );

  app.post(
    "/",
    {
      preHandler: app.authenticate,
      schema: {
        body: createExpenseBody,
        response: {
          201: expenseResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const result = await expensesRepo.create(
        db,
        currentUserId(req),
        req.body,
      );
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.code(201).send({ expense: toDto(result.expense) });
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: app.authenticate,
      schema: {
        params: idParams,
        body: patchExpenseBody,
        response: {
          200: expenseResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const result = await expensesRepo.patch(
        db,
        currentUserId(req),
        req.params.id,
        req.body,
      );
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.send({ expense: toDto(result.expense) });
    },
  );

  app.delete(
    "/:id",
    {
      preHandler: app.authenticate,
      schema: {
        params: idParams,
        response: {
          // Declared so the type provider admits `reply.code(204)` at all; the
          // payload is `null` because a 204 carries no body by definition, and
          // fastify drops it on the way out.
          204: z.null(),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const deleted = await expensesRepo.delete(
        db,
        currentUserId(req),
        req.params.id,
      );
      if (!deleted) return sendFailure(reply, "not_found");
      return reply.code(204).send(null);
    },
  );
};
