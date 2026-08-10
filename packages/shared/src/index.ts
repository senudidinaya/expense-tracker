/**
 * The single API contract. Both apps import from here — the API wires these
 * schemas through `fastify-type-provider-zod`, the web app uses the same
 * objects for form resolvers and response parsing, so a rule can only be
 * changed in one place.
 */
export * from "./errors.js";
export * from "./schemas/common.js";
export * from "./schemas/auth.js";
export * from "./schemas/category.js";
export * from "./schemas/expense.js";
export * from "./schemas/budget.js";
export * from "./schemas/recurring.js";
export * from "./schemas/reports.js";
