import {
  createRecurringBody,
  errorEnvelope,
  errorResponse,
  patchRecurringBody,
  recurringRuleDto,
  recurringRulesResponse,
  uuid,
} from "@expense/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { todayUtc } from "../lib/dates.js";
import { currentUserId } from "../plugins/auth.js";
import {
  recurringRepo,
  type RecurringFailure,
  type RecurringRecord,
} from "../repos/recurring.js";

const ruleResponse = z.object({ rule: recurringRuleDto });

const idParams = z.object({ id: uuid });

/** `Date` columns become ISO strings at the HTTP boundary; the rest already match the wire. */
const toDto = (r: RecurringRecord) => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * The failure half of a `RecurringResult`, as a reply — the same shape as
 * `routes/expenses.ts` so the three shared mappings cannot diverge.
 *
 * Both 404s carry the same message for the same resource, so "not yours" and
 * "not there" are one answer: `PATCH` and `DELETE` on another user's id must be
 * byte-identical to the same call on an id that never existed, or the pair is
 * an existence oracle.
 */
function sendFailure(reply: FastifyReply, reason: RecurringFailure) {
  switch (reason) {
    case "not_found":
      return reply
        .code(404)
        .send(errorEnvelope("not_found", "Recurring rule not found"));
    case "category_not_found":
      return reply
        .code(404)
        .send(errorEnvelope("not_found", "Category not found"));
    case "category_archived":
      // Not 404: the user can see this category, they simply cannot schedule
      // new spending under an archived one.
      return reply
        .code(400)
        .send(
          errorEnvelope("validation_failed", "Invalid request", [
            { path: "categoryId", message: "category is archived" },
          ]),
        );
    case "end_before_start":
      // The same message as the shared schema's refinement: to the client this
      // is one rule, whichever side of the wire caught it.
      return reply.code(400).send(
        errorEnvelope("validation_failed", "Invalid request", [
          {
            path: "endDate",
            message: "endDate must not be before startDate",
          },
        ]),
      );
  }
}

export const recurringRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (
  app,
  { db },
) => {
  app.get(
    "/",
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: recurringRulesResponse,
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const rules = await recurringRepo.list(db, currentUserId(req));
      return { items: rules.map(toDto) };
    },
  );

  app.post(
    "/",
    {
      preHandler: app.authenticate,
      schema: {
        body: createRecurringBody,
        response: {
          201: ruleResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      // The route reads the clock, the repo takes it as an argument — UTC,
      // because the generator runs from a UTC cron and the creator and the
      // generator must agree on what "today" is.
      const result = await recurringRepo.create(
        db,
        currentUserId(req),
        req.body,
        todayUtc(),
      );
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.code(201).send({ rule: toDto(result.rule) });
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: app.authenticate,
      schema: {
        params: idParams,
        body: patchRecurringBody,
        response: {
          200: ruleResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const result = await recurringRepo.patch(
        db,
        currentUserId(req),
        req.params.id,
        req.body,
        todayUtc(),
      );
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.send({ rule: toDto(result.rule) });
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
      const deleted = await recurringRepo.delete(
        db,
        currentUserId(req),
        req.params.id,
      );
      if (!deleted) return sendFailure(reply, "not_found");
      return reply.code(204).send(null);
    },
  );
};
