import {
  budgetStatusQuery,
  budgetStatusResponse,
  byCategoryResponse,
  errorResponse,
  reportRangeQuery,
  summaryResponse,
  topExpensesQuery,
  topExpensesResponse,
  trendResponse,
} from "@expense/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Db } from "../db/client.js";
import { currentUserId } from "../plugins/auth.js";
import { reportsRepo } from "../repos/reports.js";

/**
 * The five reports. Each is a query schema, a repository call, and the one
 * translation the route owns: a repository `null` for an aggregated money
 * field becomes an *omitted* field on the wire (design/api.md, "Aggregated
 * money and the exact-integer ceiling"). Not `null` — on the wire `null`
 * already means "unbudgeted" on the budget-status report, and a client must
 * be able to tell "there is no budget" from "there is no exact number".
 *
 * Range validation (`from <= to`, span <= 5 years) is the shared query schema
 * and surfaces as the standard 400 envelope from the app's error handler.
 */

/** `{ k: v }` when `v` is a number, `{}` when it is `null` — the omission. */
const ifExact = <K extends string>(
  key: K,
  value: number | null,
): Partial<Record<K, number>> =>
  value === null ? {} : ({ [key]: value } as Record<K, number>);

const reportErrors = { 400: errorResponse, 401: errorResponse } as const;

export const reportRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (
  app,
  { db },
) => {
  app.get(
    "/summary",
    {
      preHandler: app.authenticate,
      schema: {
        querystring: reportRangeQuery,
        response: { 200: summaryResponse, ...reportErrors },
      },
    },
    async (req, reply) => {
      const { from, to } = req.query;
      const s = await reportsRepo.summary(db, currentUserId(req), from, to);
      return reply.send({
        ...ifExact("totalMinor", s.totalMinor),
        count: s.count,
        avgMinor: s.avgMinor,
        ...ifExact("prevPeriodTotalMinor", s.prevPeriodTotalMinor),
        deltaPct: s.deltaPct,
      });
    },
  );

  app.get(
    "/by-category",
    {
      preHandler: app.authenticate,
      schema: {
        querystring: reportRangeQuery,
        response: { 200: byCategoryResponse, ...reportErrors },
      },
    },
    async (req, reply) => {
      const { from, to } = req.query;
      const rows = await reportsRepo.byCategory(
        db,
        currentUserId(req),
        from,
        to,
      );
      return reply.send({
        items: rows.map((r) => ({
          categoryId: r.categoryId,
          ...ifExact("totalMinor", r.totalMinor),
          share: r.share,
        })),
      });
    },
  );

  app.get(
    "/trend",
    {
      preHandler: app.authenticate,
      schema: {
        querystring: reportRangeQuery,
        response: { 200: trendResponse, ...reportErrors },
      },
    },
    async (req, reply) => {
      const { from, to } = req.query;
      const points = await reportsRepo.trend(db, currentUserId(req), from, to);
      return reply.send({
        items: points.map((p) => ({
          month: p.month,
          ...ifExact("totalMinor", p.totalMinor),
        })),
      });
    },
  );

  app.get(
    "/budget-status",
    {
      preHandler: app.authenticate,
      schema: {
        querystring: budgetStatusQuery,
        response: { 200: budgetStatusResponse, ...reportErrors },
      },
    },
    async (req, reply) => {
      const lines = await reportsRepo.budgetStatus(
        db,
        currentUserId(req),
        req.query.month,
      );
      return reply.send({
        items: lines.map((l) =>
          // `spentMinor` past the ceiling takes `remainingMinor` and `pct`
          // with it: both are derived from it and there is no exact version
          // of either. `budgetMinor` is a stored row and always present.
          l.spentMinor === null
            ? { categoryId: l.categoryId, budgetMinor: l.budgetMinor }
            : {
                categoryId: l.categoryId,
                budgetMinor: l.budgetMinor,
                spentMinor: l.spentMinor,
                remainingMinor: l.remainingMinor,
                pct: l.pct,
              },
        ),
      });
    },
  );

  app.get(
    "/top-expenses",
    {
      preHandler: app.authenticate,
      schema: {
        querystring: topExpensesQuery,
        response: { 200: topExpensesResponse, ...reportErrors },
      },
    },
    async (req, reply) => {
      const { from, to, limit } = req.query;
      const rows = await reportsRepo.topExpenses(
        db,
        currentUserId(req),
        from,
        to,
        limit,
      );
      return reply.send({
        items: rows.map((e) => ({
          ...e,
          createdAt: e.createdAt.toISOString(),
          updatedAt: e.updatedAt.toISOString(),
        })),
      });
    },
  );
};
