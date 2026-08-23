import {
  budgetDto,
  budgetPutBody,
  budgetsGetQuery,
  budgetsGetResponse,
  errorEnvelope,
  errorResponse,
} from "@expense/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { monthOfStart } from "../domain/budgets.js";
import { currentUserId } from "../plugins/auth.js";
import { budgetsRepo, type BudgetRecord } from "../repos/budgets.js";

const budgetResponse = z.object({ budget: budgetDto });

/**
 * The repository's DATE and `Date` columns become what the wire speaks:
 * `month_start` is pinned to the 1st, so `YYYY-MM` is the whole of its meaning
 * and the day is not part of the contract.
 */
const toDto = (b: BudgetRecord) => ({
  id: b.id,
  categoryId: b.categoryId,
  month: monthOfStart(b.monthStart),
  amountMinor: b.amountMinor,
  currency: b.currency,
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
});

export const budgetRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (
  app,
  { db },
) => {
  app.get(
    "/",
    {
      preHandler: app.authenticate,
      schema: {
        querystring: budgetsGetQuery,
        response: {
          200: budgetsGetResponse,
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const items = await budgetsRepo.effectiveForMonth(
        db,
        currentUserId(req),
        req.query.month,
      );

      // A category whose budget was *cleared* is an item with a null amount and
      // the month it was cleared in; one that was never budgeted is not an item
      // at all. Both are "unbudgeted" on screen, and the response is what lets a
      // client tell a decision from the absence of one.
      return reply.send({ items });
    },
  );

  app.put(
    "/",
    {
      preHandler: app.authenticate,
      schema: {
        body: budgetPutBody,
        response: {
          200: budgetResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const { categoryId, month, amountMinor } = req.body;
      const result = await budgetsRepo.put(
        db,
        currentUserId(req),
        categoryId,
        month,
        amountMinor,
      );

      if (!result.ok) {
        // The 404 message is the same one `POST /api/expenses` sends for a
        // category it cannot use, and carries no hint of which of the two
        // reasons applies — "not yours" and "not there" are one answer.
        return result.reason === "category_not_found"
          ? reply
              .code(404)
              .send(errorEnvelope("not_found", "Category not found"))
          : // Not 404: the user can see an archived category, they simply
            // cannot budget for one they have retired.
            reply
              .code(400)
              .send(
                errorEnvelope("validation_failed", "Invalid request", [
                  { path: "categoryId", message: "category is archived" },
                ]),
              );
      }

      // 200, not 201: PUT is an upsert at a fixed address, and the client
      // cannot tell — and has no reason to care — which of the two it was.
      return reply.send({ budget: toDto(result.budget) });
    },
  );
};
